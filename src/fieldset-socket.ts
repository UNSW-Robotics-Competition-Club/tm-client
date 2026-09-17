/**
 * The field set event socket: TM's only push channel, and the one part of this
 * package that cannot run in a browser.
 *
 * TM signs the websocket UPGRADE with the same `Authorization` / `x-tm-date` /
 * `x-tm-signature` headers it requires on REST, and the WebSocket spec forbids
 * setting request headers from a browser. So this module owns the state machine
 * and takes the transport as an injected `WebSocketFactory`; `./node` ships the
 * `ws`-backed one. Resolution happens at `connect()` time rather than import
 * time so a bundler targeting the browser never pulls `ws` into the graph.
 *
 * Ports three pieces of prior art:
 *   - vex-tm-client `src/Fieldset.ts` — the event reducer and the 8 commands.
 *   - streamdeck-vextm `src/tm/connection.ts` — the reconnect ladder and the
 *     401-invalidates-the-bearer fix.
 *   - obs-plugin `src/tm/field-set-socket.cpp` — the outbox, and the rule that
 *     only a connection which actually held up resets the ladder.
 *
 * Isomorphic: `EventTarget`/`CustomEvent`, never `node:events`. No `node:*` and
 * no `ws` import appears in this file — the Node branch hides both behind a
 * dynamic `import()` one module further out, in `src/ws/node.ts`.
 */

import { err, ok, type Result } from "./errors.js";
import {
	FieldsetActiveMatchType,
	FieldsetAudienceDisplay,
	FieldsetQueueState,
	type FieldsetCommand,
	type FieldsetEvent,
	type FieldsetQueueSkillsType,
	type FieldsetState,
	type MatchTuple,
} from "./types.js";
import { WS_OPEN, type WebSocketFactory, type WebSocketLike } from "./ws/types.js";
import type { TmHttpClient } from "./http.js";

// ---------------------------------------------------------------------------
// State reduction (pure)

export const INITIAL_FIELDSET_STATE: FieldsetState = {
	match: { type: FieldsetActiveMatchType.None },
	audienceDisplay: FieldsetAudienceDisplay.Blank,
};

/**
 * A TIMEOUT arrives as a `fieldMatchAssigned` whose `match` object is empty —
 * there is no type tag for it anywhere on the wire. Count the keys; never
 * inspect the fields, because a future TM could add one and every field-based
 * check would still pass while live timeouts silently became matches.
 */
function isPopulatedTuple(match: MatchTuple | Record<string, never>): match is MatchTuple {
	return Object.keys(match).length > 0;
}

/**
 * Applies one TM event to the derived field set state.
 *
 * Pure: the input state is never mutated, so callers can hold on to prior
 * states and diff them. Ports `Fieldset.updateState()`, which mutated in place.
 */
export function reduceFieldsetState(state: FieldsetState, event: FieldsetEvent): FieldsetState {
	switch (event.type) {
		case "audienceDisplayChanged":
			return { ...state, audienceDisplay: event.display };

		case "fieldMatchAssigned": {
			// TM clears the queue with an empty match object AND a null field.
			const fieldID = event.fieldID;
			if (fieldID === null) return { ...state, match: { type: FieldsetActiveMatchType.None } };
			return {
				...state,
				match: isPopulatedTuple(event.match)
					? {
							type: FieldsetActiveMatchType.Match,
							state: FieldsetQueueState.Unplayed,
							match: event.match,
							fieldID,
							active: false,
						}
					: {
							type: FieldsetActiveMatchType.Timeout,
							state: FieldsetQueueState.Unplayed,
							fieldID,
							active: false,
						},
			};
		}

		case "fieldActivated": {
			// A field going active with nothing queued is a timeout run straight
			// from the TM UI — there was no assignment event in front of it.
			if (state.match.type === FieldsetActiveMatchType.None) {
				return {
					...state,
					match: {
						type: FieldsetActiveMatchType.Timeout,
						state: FieldsetQueueState.Unplayed,
						fieldID: event.fieldID,
						active: true,
					},
				};
			}
			return { ...state, match: { ...state.match, fieldID: event.fieldID, active: true } };
		}

		case "matchStarted": {
			if (state.match.type === FieldsetActiveMatchType.None) {
				return {
					...state,
					match: {
						type: FieldsetActiveMatchType.Timeout,
						state: FieldsetQueueState.Running,
						fieldID: event.fieldID,
						active: false,
					},
				};
			}
			return {
				...state,
				match: { ...state.match, state: FieldsetQueueState.Running, fieldID: event.fieldID },
			};
		}

		case "matchStopped": {
			// Nothing queued means nothing to stop.
			if (state.match.type === FieldsetActiveMatchType.None) return state;
			return { ...state, match: { ...state.match, state: FieldsetQueueState.Stopped } };
		}
	}
}

const AUDIENCE_DISPLAYS: ReadonlySet<string> = new Set(Object.values(FieldsetAudienceDisplay));

function isAudienceDisplay(value: unknown): value is FieldsetAudienceDisplay {
	return typeof value === "string" && AUDIENCE_DISPLAYS.has(value);
}

function parseJson(raw: string): unknown {
	try {
		return JSON.parse(raw) as unknown;
	} catch {
		// A non-JSON frame is a TM or proxy fault, not something a caller can act
		// on. `null` here becomes "ignore the frame" at the call site.
		return null;
	}
}

/**
 * Validates one TM frame, accepting either the raw JSON text or an already
 * parsed value.
 *
 * Returns `null` — rather than throwing — for anything unrecognised, because TM
 * is free to add event types in a point release and an unknown type must not
 * take the socket down.
 */
export function parseFieldsetEvent(raw: unknown): FieldsetEvent | null {
	const value = typeof raw === "string" ? parseJson(raw) : raw;
	if (typeof value !== "object" || value === null) return null;

	const record = value as Record<string, unknown>;
	const type = record["type"];

	switch (type) {
		case "fieldMatchAssigned": {
			const match = record["match"];
			if (typeof match !== "object" || match === null || Array.isArray(match)) return null;
			const fieldID = record["fieldID"];
			if (fieldID !== null && typeof fieldID !== "number") return null;
			return { type, fieldID, match: match as MatchTuple | Record<string, never> };
		}

		case "fieldActivated":
		case "matchStarted":
		case "matchStopped": {
			const fieldID = record["fieldID"];
			if (typeof fieldID !== "number") return null;
			return { type, fieldID };
		}

		case "audienceDisplayChanged": {
			const display = record["display"];
			if (!isAudienceDisplay(display)) return null;
			return { type, display };
		}

		default:
			return null;
	}
}

// ---------------------------------------------------------------------------
// Transport resolution

/**
 * Runtime detection, behind an interface so the header-less path can be tested
 * without a header-less runtime to test it in.
 */
export interface RuntimeProbe {
	isNode(): boolean;
	isBun(): boolean;
}

export const defaultRuntimeProbe: RuntimeProbe = {
	isNode: () => typeof globalThis.process?.versions?.node === "string",
	isBun: () => typeof (globalThis as { Bun?: unknown }).Bun !== "undefined",
};

/** Bun's `WebSocket` takes a non-standard options object as its second argument. */
type BunWebSocketConstructor = new (
	url: string,
	options: { headers: Record<string, string> },
) => unknown;

/**
 * Picks a transport: explicit factory, then Node, then Bun, then fail.
 *
 * Never throws. A runtime that cannot sign the handshake is an operator problem
 * with three concrete remedies (see `remedy("ws_headers_unsupported")`), not an
 * exception for a caller to guess at.
 */
export async function resolveWebSocketFactory(options: {
	explicit?: WebSocketFactory | undefined;
	runtime?: RuntimeProbe;
}): Promise<Result<WebSocketFactory>> {
	if (options.explicit) return ok(options.explicit);
	const runtime = options.runtime ?? defaultRuntimeProbe;

	if (runtime.isNode()) {
		try {
			const { createNodeWebSocketFactory } = await import("./ws/node.js");
			return ok(await createNodeWebSocketFactory());
		} catch (error) {
			return err(
				"ws_headers_unsupported",
				"Running under Node, but the optional `ws` package could not be loaded. Install it, or pass your own webSocketFactory.",
				{ detail: error },
			);
		}
	}

	if (runtime.isBun()) {
		// Via `unknown`: the DOM lib declares the spec-compliant two-argument
		// constructor, which is precisely the one Bun diverges from.
		const constructor = (globalThis as unknown as { WebSocket?: BunWebSocketConstructor })
			.WebSocket;
		if (constructor) {
			// Bun's header support is non-standard and has regressed before
			// (oven-sh/bun #1676, #20807), so it stays its own documented branch
			// rather than sharing a code path with Node.
			return ok((url, headers) => new constructor(url.href, { headers }) as WebSocketLike);
		}
	}

	return err(
		"ws_headers_unsupported",
		"This runtime's WebSocket cannot set headers on the handshake, and TM signs the field set upgrade.",
	);
}

// ---------------------------------------------------------------------------
// The socket

/**
 * The slice of `TmHttpClient` the socket uses.
 *
 * Declared structurally so a test can substitute a fake without standing up a
 * real HTTP client, and so this module does not depend on the rest of the REST
 * surface. `HttpClientSatisfiesFieldsetHttp` keeps the two in step: if the real
 * client's signatures drift, that alias resolves to `never` and every use of it
 * is a compile error.
 */
export interface FieldsetHttp {
	authHeadersFor(url: URL, method?: string): Promise<Result<Record<string, string>>>;
	resolve(path: string): URL;
	invalidateBearer(): void;
}

/**
 * Compile-time proof that the real client still fits the slice above: the
 * constraint is checked where the alias is instantiated, so a signature drift
 * in `TmHttpClient` fails the build here rather than at some call site.
 */
type Assignable<T extends U, U> = T;
export type HttpClientSatisfiesFieldsetHttp = Assignable<TmHttpClient, FieldsetHttp>;

/** Matches both the DOM (`number`) and Node (`Timeout`) handle shapes. */
export type TimerHandle = unknown;
export type SetTimeoutLike = (handler: () => void, ms: number) => TimerHandle;
export type ClearTimeoutLike = (handle: TimerHandle) => void;

/** From streamdeck-vextm's `connection.ts`. The last rung repeats forever. */
export const DEFAULT_BACKOFF_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000];

/** How long a connection must hold up before it is allowed to reset the ladder. */
export const DEFAULT_HEALTHY_MS = 5_000;

export interface FieldsetSocketOptions {
	http: FieldsetHttp;
	fieldSetId: number;
	webSocketFactory?: WebSocketFactory | undefined;
	backoffMs?: readonly number[] | undefined;
	healthyMs?: number | undefined;
	runtime?: RuntimeProbe | undefined;
	setTimeout?: SetTimeoutLike | undefined;
	clearTimeout?: ClearTimeoutLike | undefined;
}

const decoder = new TextDecoder();

/** ws delivers text frames as `Buffer`, browsers as `string`, proxies in chunks. */
function decodeFrame(data: unknown): string | null {
	if (typeof data === "string") return data;
	if (data instanceof ArrayBuffer) return decoder.decode(data);
	if (ArrayBuffer.isView(data)) return decoder.decode(data);
	if (Array.isArray(data)) {
		const parts: (string | null)[] = data.map(decodeFrame);
		return parts.every((part): part is string => part !== null) ? parts.join("") : null;
	}
	return null;
}

/**
 * TM answers a rejected bearer on the upgrade with a bare 401, and the only
 * place that status survives is the transport's error text.
 */
function looksLikeAuthRejection(reason: string): boolean {
	return /\b40[13]\b/.test(reason);
}

function describe(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === "object" && error !== null) {
		const message = (error as { message?: unknown }).message;
		if (typeof message === "string") return message;
	}
	return String(error);
}

const defaultSetTimeout: SetTimeoutLike = (handler, ms) => {
	const handle = setTimeout(handler, ms);
	// A pending reconnect must never be the reason a CLI refuses to exit.
	(handle as { unref?: () => void }).unref?.();
	return handle;
};

const defaultClearTimeout: ClearTimeoutLike = (handle) => {
	clearTimeout(handle as ReturnType<typeof setTimeout>);
};

/**
 * A live connection to one field set.
 *
 * Emits a `CustomEvent` per TM event type, a generic `"message"`, `"open"` and
 * `"close"` for the transport, and `"statechange"` whenever the derived `state`
 * changes. The payload is always in `detail`.
 */
export class FieldsetSocket extends EventTarget {
	readonly fieldSetId: number;

	readonly #http: FieldsetHttp;
	readonly #explicitFactory: WebSocketFactory | undefined;
	readonly #runtime: RuntimeProbe | undefined;
	readonly #backoffMs: readonly number[];
	readonly #healthyMs: number;
	readonly #setTimeout: SetTimeoutLike;
	readonly #clearTimeout: ClearTimeoutLike;

	/** Queued command payloads, flushed in order once a socket is open. */
	readonly #outbox: string[] = [];

	#state: FieldsetState = INITIAL_FIELDSET_STATE;
	#factory: WebSocketFactory | null = null;
	#socket: WebSocketLike | null = null;
	#connecting: Promise<Result<void>> | null = null;
	#retry: TimerHandle | null = null;
	#attempt = 0;
	#openedAt: number | null = null;
	/** False before the first `connect()` and after any `disconnect()`. */
	#running = false;

	constructor(options: FieldsetSocketOptions) {
		super();
		this.fieldSetId = options.fieldSetId;
		this.#http = options.http;
		this.#explicitFactory = options.webSocketFactory;
		this.#runtime = options.runtime;
		this.#backoffMs =
			options.backoffMs && options.backoffMs.length > 0 ? options.backoffMs : DEFAULT_BACKOFF_MS;
		this.#healthyMs = options.healthyMs ?? DEFAULT_HEALTHY_MS;
		this.#setTimeout = options.setTimeout ?? defaultSetTimeout;
		this.#clearTimeout = options.clearTimeout ?? defaultClearTimeout;
	}

	get state(): FieldsetState {
		return this.#state;
	}

	get connected(): boolean {
		return this.#socket !== null && this.#socket.readyState === WS_OPEN;
	}

	/** The signed http(s) URL. The socket URL is this with the scheme swapped. */
	get url(): URL {
		return this.#http.resolve(`/api/fieldsets/${this.fieldSetId}`);
	}

	/**
	 * Opens the socket and keeps it open, reconnecting on the backoff ladder
	 * until `disconnect()`.
	 *
	 * Resolves with the result of the *first* attempt; every reconnect after
	 * that is reported through the `"open"` and `"close"` events.
	 */
	connect(): Promise<Result<void>> {
		this.#running = true;
		this.#cancelRetry();
		return this.#connectOnce();
	}

	/** Closes the socket, cancels any pending retry, and stops reconnecting. */
	disconnect(): void {
		this.#running = false;
		this.#cancelRetry();
		// Queued commands can never flush now, and a caller that sends after this
		// deserves to be told so rather than have it buffered forever.
		this.#outbox.length = 0;

		const socket = this.#socket;
		if (!socket) return;
		try {
			socket.close();
		} catch {
			// The transport is already gone; recording the drop is what matters.
		}
		this.#handleDrop(socket, "closed by the caller");
	}

	/**
	 * Sends a command, queueing it when the socket is down.
	 *
	 * A command issued while reconnecting is held and flushed in order — an
	 * operator pressing Start during a blip expects the match to start, not an
	 * error. After an explicit `disconnect()` there is nothing left to flush
	 * into, so it fails immediately instead.
	 */
	async send(command: FieldsetCommand): Promise<Result<void>> {
		if (!this.#running) {
			return err("ws_closed", "The field set socket is not connected. Call connect() first.");
		}

		const payload = JSON.stringify(command);
		const socket = this.#socket;
		if (!socket || socket.readyState !== WS_OPEN) {
			this.#outbox.push(payload);
			return ok(undefined);
		}

		try {
			socket.send(payload);
			return ok(undefined);
		} catch (error) {
			// The socket died between the readyState check and the write. Queue it
			// so the reconnect delivers it.
			this.#outbox.push(payload);
			return err("ws_connection_error", `Could not send ${command.cmd}: ${describe(error)}`, {
				detail: error,
			});
		}
	}

	startMatch(fieldID: number): Promise<Result<void>> {
		return this.send({ cmd: "start", fieldID });
	}

	endMatchEarly(fieldID: number): Promise<Result<void>> {
		return this.send({ cmd: "endEarly", fieldID });
	}

	abortMatch(fieldID: number): Promise<Result<void>> {
		return this.send({ cmd: "abort", fieldID });
	}

	resetTimer(fieldID: number): Promise<Result<void>> {
		return this.send({ cmd: "reset", fieldID });
	}

	queuePreviousMatch(): Promise<Result<void>> {
		return this.send({ cmd: "queuePrevMatch" });
	}

	queueNextMatch(): Promise<Result<void>> {
		return this.send({ cmd: "queueNextMatch" });
	}

	queueSkills(skillsID: FieldsetQueueSkillsType): Promise<Result<void>> {
		return this.send({ cmd: "queueSkills", skillsID });
	}

	setAudienceDisplay(display: FieldsetAudienceDisplay): Promise<Result<void>> {
		return this.send({ cmd: "setAudienceDisplay", display });
	}

	// -- internals ----------------------------------------------------------

	#emit(type: string, detail: unknown): void {
		this.dispatchEvent(new CustomEvent(type, { detail }));
	}

	/** Collapses concurrent callers — and a retry racing a manual reconnect. */
	#connectOnce(): Promise<Result<void>> {
		if (this.#connecting) return this.#connecting;
		if (this.connected) return Promise.resolve(ok(undefined));

		const attempt = this.#open();
		this.#connecting = attempt;
		void attempt.then(() => {
			if (this.#connecting === attempt) this.#connecting = null;
		});
		return attempt;
	}

	/**
	 * Total by construction: every caller either awaits this as a `Result` or
	 * fires it from a timer, and a rejection from the second is an unhandled
	 * rejection that takes the host process down.
	 */
	async #open(): Promise<Result<void>> {
		try {
			return await this.#openAttempt();
		} catch (error) {
			this.#scheduleRetry();
			return err("ws_connection_error", `Field set socket failed: ${describe(error)}`, {
				detail: error,
			});
		}
	}

	async #openAttempt(): Promise<Result<void>> {
		const factory = await this.#ensureFactory();
		if (!factory.ok) {
			// No ladder for this one: no amount of retrying gives a runtime the
			// ability to set handshake headers. Stop the machine outright, so a
			// command issued afterwards fails with `ws_closed` instead of queueing
			// into a socket that can never open.
			this.#running = false;
			return factory;
		}

		const url = this.url;
		let headers: Result<Record<string, string>>;
		try {
			headers = await this.#http.authHeadersFor(url, "GET");
		} catch (error) {
			headers = err("ws_connection_error", describe(error), { detail: error });
		}
		if (!headers.ok) {
			this.#scheduleRetry();
			return headers;
		}

		const socketUrl = new URL(url);
		// ws and wss share http and https's default ports, so the authority the
		// signature was built from survives the swap unchanged.
		socketUrl.protocol = url.protocol === "https:" ? "wss:" : "ws:";

		let socket: WebSocketLike;
		try {
			socket = factory.data(socketUrl, headers.data);
		} catch (error) {
			this.#scheduleRetry();
			return err("ws_connection_error", `Could not open ${socketUrl.href}: ${describe(error)}`, {
				detail: error,
			});
		}

		this.#socket = socket;

		return new Promise<Result<void>>((resolve) => {
			let settled = false;
			const settle = (result: Result<void>): void => {
				if (settled) return;
				settled = true;
				resolve(result);
			};

			socket.addEventListener("open", () => {
				if (this.#socket !== socket) return;
				this.#openedAt = Date.now();
				this.#emit("open", { url: socketUrl.href });
				this.#flushOutbox(socket);
				settle(ok(undefined));
			});

			socket.addEventListener("message", (event) => {
				if (this.#socket !== socket) return;
				this.#handleFrame(event.data);
			});

			socket.addEventListener("error", (event) => {
				const reason = describe(event);
				this.#handleDrop(socket, reason);
				settle(err("ws_connection_error", `Field set socket failed: ${reason}`, { detail: event }));
			});

			socket.addEventListener("close", (event) => {
				const reason = event.reason || `closed with code ${event.code ?? "unknown"}`;
				this.#handleDrop(socket, reason);
				settle(err("ws_closed", `Field set socket ${reason}.`));
			});
		});
	}

	async #ensureFactory(): Promise<Result<WebSocketFactory>> {
		if (this.#factory) return ok(this.#factory);
		const resolved = await resolveWebSocketFactory({
			explicit: this.#explicitFactory,
			...(this.#runtime ? { runtime: this.#runtime } : {}),
		});
		if (resolved.ok) this.#factory = resolved.data;
		return resolved;
	}

	#handleFrame(data: unknown): void {
		const text = decodeFrame(data);
		if (text === null) return;
		const event = parseFieldsetEvent(text);
		// An unrecognised event type is a newer TM, not a fault. Ignore it.
		if (!event) return;

		const next = reduceFieldsetState(this.#state, event);
		const changed = next !== this.#state;
		this.#state = next;

		this.#emit(event.type, event);
		this.#emit("message", event);
		if (changed) this.#emit("statechange", next);
	}

	#handleDrop(socket: WebSocketLike, reason: string): void {
		// `error` is usually followed by `close`; whichever lands first owns the
		// drop and the other is stale.
		if (this.#socket !== socket) return;
		this.#socket = null;

		const openedAt = this.#openedAt;
		this.#openedAt = null;
		this.#emit("close", { reason });

		if (!this.#running) return;

		if (looksLikeAuthRejection(reason)) {
			// Ported from connection.ts: TM blames the API key and the bearer with
			// the same 401, so assume the token might be the bad half. Retrying
			// with a rejected bearer just fails identically for its full hour.
			this.#http.invalidateBearer();
		}

		// Only a connection that actually held up resets the ladder — otherwise a
		// TM that accepts and instantly drops gets hammered at 1s forever.
		if (openedAt !== null && Date.now() - openedAt >= this.#healthyMs) this.#attempt = 0;

		this.#scheduleRetry();
	}

	#scheduleRetry(): void {
		if (!this.#running || this.#retry !== null) return;
		const delay = this.#backoffMs[Math.min(this.#attempt, this.#backoffMs.length - 1)] ?? 0;
		this.#attempt += 1;
		// Announced before the wait, not after it, so a caller rendering status
		// can say how long the gap will be while it is still in front of them.
		this.#emit("reconnecting", { attempt: this.#attempt, delayMs: delay });
		this.#retry = this.#setTimeout(() => {
			this.#retry = null;
			void this.#connectOnce();
		}, delay);
	}

	#cancelRetry(): void {
		if (this.#retry === null) return;
		this.#clearTimeout(this.#retry);
		this.#retry = null;
	}

	#flushOutbox(socket: WebSocketLike): void {
		while (this.#outbox.length > 0) {
			const payload = this.#outbox[0];
			if (payload === undefined) break;
			try {
				socket.send(payload);
			} catch {
				// Still down. Leave the rest queued, in order, for the next open.
				break;
			}
			this.#outbox.shift();
		}
	}
}
