import { afterEach, describe, expect, it, vi } from "vitest";

import { ok, err, type Result } from "../../src/errors.js";
import {
	DEFAULT_BACKOFF_MS,
	FieldsetSocket,
	resolveWebSocketFactory,
	type FieldsetHttp,
} from "../../src/fieldset-socket.js";
import {
	FieldsetActiveMatchType,
	FieldsetAudienceDisplay,
	FieldsetQueueSkillsType,
	type FieldsetEvent,
} from "../../src/types.js";
import { WS_OPEN, type WebSocketFactory, type WebSocketLike } from "../../src/ws/types.js";

// ---------------------------------------------------------------------------
// Fakes. No real socket, no mock server: this file is about the state machine.

const CONNECTING = 0;
const CLOSED = 3;

class FakeSocket implements WebSocketLike {
	readyState = CONNECTING;
	readonly sent: string[] = [];
	closeCalls = 0;

	readonly #listeners = new Map<string, ((arg: never) => void)[]>();

	addEventListener(type: "open", listener: () => void): void;
	addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
	addEventListener(type: "error", listener: (event: unknown) => void): void;
	addEventListener(
		type: "close",
		listener: (event: { code?: number; reason?: string }) => void,
	): void;
	addEventListener(type: string, listener: (arg: never) => void): void {
		const listeners = this.#listeners.get(type) ?? [];
		listeners.push(listener);
		this.#listeners.set(type, listeners);
	}

	send(data: string): void {
		if (this.readyState !== WS_OPEN) throw new Error("socket is not open");
		this.sent.push(data);
	}

	close(): void {
		this.closeCalls += 1;
		if (this.readyState === CLOSED) return;
		this.readyState = CLOSED;
		this.#dispatch("close", { code: 1000, reason: "normal closure" });
	}

	// -- test drivers --

	openNow(): void {
		this.readyState = WS_OPEN;
		this.#dispatch("open", undefined);
	}

	/** An ungraceful drop — what a yanked network cable looks like. */
	drop(reason = "connection lost"): void {
		this.readyState = CLOSED;
		this.#dispatch("close", { code: 1006, reason });
	}

	fail(message: string): void {
		this.#dispatch("error", new Error(message));
	}

	receive(frame: unknown): void {
		this.#dispatch("message", { data: JSON.stringify(frame) });
	}

	receiveRaw(data: unknown): void {
		this.#dispatch("message", { data });
	}

	#dispatch(type: string, arg: unknown): void {
		for (const listener of [...(this.#listeners.get(type) ?? [])]) {
			(listener as (value: unknown) => void)(arg);
		}
	}
}

const AUTH_HEADERS: Record<string, string> = {
	Authorization: "Bearer test-token",
	"x-tm-date": "Tue, 11 Aug 2026 03:14:00 GMT",
	"x-tm-signature": "deadbeef",
	Host: "tm.local:8080",
};

interface HarnessOptions {
	base?: string;
	fieldSetId?: number;
	/** Runs on every socket the factory creates; `index` is its attempt number. */
	behaviour?: (socket: FakeSocket, index: number) => void;
	headers?: () => Result<Record<string, string>>;
	backoffMs?: readonly number[];
	healthyMs?: number;
}

function createHarness(options: HarnessOptions = {}) {
	const sockets: FakeSocket[] = [];
	const factoryCalls: { url: URL; headers: Record<string, string> }[] = [];
	const headerRequests: { url: URL; method: string | undefined }[] = [];
	let invalidations = 0;
	const base = options.base ?? "http://tm.local:8080";

	const http: FieldsetHttp = {
		resolve: (path) => new URL(path, base),
		authHeadersFor: (url, method) => {
			headerRequests.push({ url, method });
			return Promise.resolve(options.headers ? options.headers() : ok(AUTH_HEADERS));
		},
		invalidateBearer: () => {
			invalidations += 1;
		},
	};

	const webSocketFactory: WebSocketFactory = (url, headers) => {
		factoryCalls.push({ url, headers });
		const socket = new FakeSocket();
		sockets.push(socket);
		options.behaviour?.(socket, sockets.length - 1);
		return socket;
	};

	const socket = new FieldsetSocket({
		http,
		fieldSetId: options.fieldSetId ?? 1,
		webSocketFactory,
		...(options.backoffMs ? { backoffMs: options.backoffMs } : {}),
		...(options.healthyMs === undefined ? {} : { healthyMs: options.healthyMs }),
	});

	return {
		socket,
		sockets,
		factoryCalls,
		headerRequests,
		invalidations: () => invalidations,
	};
}

/** The transport only ever settles on a later tick, so neither does the fake. */
const openNextTick = (socket: FakeSocket): void => {
	void Promise.resolve().then(() => socket.openNow());
};

const dropNextTick = (socket: FakeSocket): void => {
	void Promise.resolve().then(() => socket.drop());
};

function at(sockets: FakeSocket[], index: number): FakeSocket {
	const socket = sockets[index];
	if (!socket) throw new Error(`expected a socket at attempt ${index}, saw ${sockets.length}`);
	return socket;
}

function detailsOf(socket: FieldsetSocket, type: string): unknown[] {
	const seen: unknown[] = [];
	socket.addEventListener(type, (event) => seen.push((event as CustomEvent<unknown>).detail));
	return seen;
}

afterEach(() => {
	vi.useRealTimers();
});

// ---------------------------------------------------------------------------

describe("FieldsetSocket connect", () => {
	it("signs the http form and opens the ws form of the same URL", async () => {
		const harness = createHarness({ behaviour: openNextTick });

		const result = await harness.socket.connect();

		expect(result.ok).toBe(true);
		expect(harness.socket.connected).toBe(true);
		// Signed against http: ws and wss share http and https's default ports,
		// so the signed authority survives the scheme swap.
		expect(harness.headerRequests[0]?.url.href).toBe("http://tm.local:8080/api/fieldsets/1");
		expect(harness.headerRequests[0]?.method).toBe("GET");
		expect(harness.factoryCalls[0]?.url.href).toBe("ws://tm.local:8080/api/fieldsets/1");
	});

	it("carries the signed headers into the handshake", async () => {
		const harness = createHarness({ behaviour: openNextTick });

		await harness.socket.connect();

		expect(harness.factoryCalls[0]?.headers).toEqual(AUTH_HEADERS);
	});

	it("uses wss when the TM address is https", async () => {
		const harness = createHarness({ base: "https://tm.example.org", behaviour: openNextTick });

		await harness.socket.connect();

		expect(harness.factoryCalls[0]?.url.href).toBe("wss://tm.example.org/api/fieldsets/1");
	});

	it("reports a bearer failure without opening a socket", async () => {
		const harness = createHarness({
			headers: () => err("cerberus_unreachable", "no route to the broker"),
		});

		const result = await harness.socket.connect();

		expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: "cerberus_unreachable" }) });
		expect(harness.sockets).toHaveLength(0);
	});

	it("collapses concurrent connect() calls onto one handshake", async () => {
		const harness = createHarness({ behaviour: openNextTick });

		const [first, second] = await Promise.all([
			harness.socket.connect(),
			harness.socket.connect(),
		]);

		expect(first.ok).toBe(true);
		expect(second.ok).toBe(true);
		expect(harness.sockets).toHaveLength(1);
	});
});

describe("FieldsetSocket commands", () => {
	async function connected() {
		const harness = createHarness({ behaviour: openNextTick });
		await harness.socket.connect();
		return harness;
	}

	it("serialises all eight commands to the guide's wire JSON", async () => {
		const harness = await connected();
		const { socket } = harness;

		await socket.startMatch(1);
		await socket.endMatchEarly(1);
		await socket.abortMatch(2);
		await socket.resetTimer(2);
		await socket.queuePreviousMatch();
		await socket.queueNextMatch();
		await socket.queueSkills(FieldsetQueueSkillsType.Programming);
		await socket.setAudienceDisplay(FieldsetAudienceDisplay.Rankings);

		expect(at(harness.sockets, 0).sent).toEqual([
			'{"cmd":"start","fieldID":1}',
			'{"cmd":"endEarly","fieldID":1}',
			'{"cmd":"abort","fieldID":2}',
			'{"cmd":"reset","fieldID":2}',
			'{"cmd":"queuePrevMatch"}',
			'{"cmd":"queueNextMatch"}',
			'{"cmd":"queueSkills","skillsID":1}',
			'{"cmd":"setAudienceDisplay","display":"RANKINGS"}',
		]);
	});

	it("spells the driver skills type as TM does", async () => {
		const harness = await connected();

		await harness.socket.queueSkills(FieldsetQueueSkillsType.Driver);

		expect(at(harness.sockets, 0).sent).toEqual(['{"cmd":"queueSkills","skillsID":2}']);
	});

	it("fails with ws_closed when sent before connect()", async () => {
		const harness = createHarness({ behaviour: openNextTick });

		const result = await harness.socket.startMatch(1);

		expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: "ws_closed" }) });
	});

	it("fails with ws_closed when sent after disconnect()", async () => {
		const harness = await connected();
		harness.socket.disconnect();

		const result = await harness.socket.setAudienceDisplay(FieldsetAudienceDisplay.Blank);

		expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: "ws_closed" }) });
		expect(at(harness.sockets, 0).sent).toEqual([]);
	});
});

describe("FieldsetSocket events", () => {
	it("dispatches the TM event, a generic message, and a statechange", async () => {
		const harness = createHarness({ behaviour: openNextTick });
		await harness.socket.connect();
		const assigned = detailsOf(harness.socket, "fieldMatchAssigned");
		const messages = detailsOf(harness.socket, "message");
		const states = detailsOf(harness.socket, "statechange");

		at(harness.sockets, 0).receive({ type: "fieldMatchAssigned", fieldID: 3, match: {} });

		const event: FieldsetEvent = { type: "fieldMatchAssigned", fieldID: 3, match: {} };
		expect(assigned).toEqual([event]);
		expect(messages).toEqual([event]);
		expect(states).toHaveLength(1);
		expect(harness.socket.state.match).toEqual({
			type: FieldsetActiveMatchType.Timeout,
			state: expect.anything(),
			fieldID: 3,
			active: false,
		});
	});

	it("ignores frames it does not recognise instead of dropping the socket", async () => {
		const harness = createHarness({ behaviour: openNextTick });
		await harness.socket.connect();
		const messages = detailsOf(harness.socket, "message");

		at(harness.sockets, 0).receive({ type: "somethingNewInTM2027", fieldID: 1 });
		at(harness.sockets, 0).receiveRaw("not json at all");

		expect(messages).toEqual([]);
		expect(harness.socket.connected).toBe(true);
	});

	it("decodes binary frames, which is how ws delivers text", async () => {
		const harness = createHarness({ behaviour: openNextTick });
		await harness.socket.connect();
		const messages = detailsOf(harness.socket, "message");

		at(harness.sockets, 0).receiveRaw(
			new TextEncoder().encode('{"type":"matchStarted","fieldID":1}'),
		);

		expect(messages).toEqual([{ type: "matchStarted", fieldID: 1 }]);
	});
});

describe("FieldsetSocket reconnection", () => {
	it("walks the backoff ladder and clamps at the last rung", async () => {
		vi.useFakeTimers();
		const harness = createHarness({ behaviour: dropNextTick });

		await harness.socket.connect();
		expect(harness.sockets).toHaveLength(1);

		let attempts = 1;
		// The last rung repeats forever, so ask for it twice.
		for (const delay of [...DEFAULT_BACKOFF_MS, 30_000, 30_000]) {
			await vi.advanceTimersByTimeAsync(delay - 1);
			expect(harness.sockets).toHaveLength(attempts);
			await vi.advanceTimersByTimeAsync(1);
			attempts += 1;
			expect(harness.sockets).toHaveLength(attempts);
		}
	});

	it("resets the ladder after a connection that held up", async () => {
		vi.useFakeTimers();
		const harness = createHarness({
			// Two failures to climb the ladder, then one that stays up.
			behaviour: (socket, index) => (index < 2 ? dropNextTick(socket) : openNextTick(socket)),
		});

		await harness.socket.connect();
		await vi.advanceTimersByTimeAsync(1_000);
		await vi.advanceTimersByTimeAsync(2_000);
		expect(harness.sockets).toHaveLength(3);
		expect(harness.socket.connected).toBe(true);

		// Healthy for longer than healthyMs, so the next drop starts over at 1s
		// rather than continuing to 4s.
		await vi.advanceTimersByTimeAsync(6_000);
		at(harness.sockets, 2).drop();

		await vi.advanceTimersByTimeAsync(999);
		expect(harness.sockets).toHaveLength(3);
		await vi.advanceTimersByTimeAsync(1);
		expect(harness.sockets).toHaveLength(4);
	});

	it("does not reset the ladder for a connection that died immediately", async () => {
		vi.useFakeTimers();
		const harness = createHarness({
			behaviour: (socket) => {
				// Accepts the upgrade, then hangs up — the case that would otherwise
				// be hammered at the initial interval forever.
				void Promise.resolve().then(() => {
					socket.openNow();
					socket.drop();
				});
			},
		});

		await harness.socket.connect();
		await vi.advanceTimersByTimeAsync(1_000);
		expect(harness.sockets).toHaveLength(2);

		await vi.advanceTimersByTimeAsync(1_999);
		expect(harness.sockets).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(1);
		expect(harness.sockets).toHaveLength(3);
	});

	it("announces each retry with its attempt number and delay", async () => {
		vi.useFakeTimers();
		const harness = createHarness({ behaviour: dropNextTick });
		const retries = detailsOf(harness.socket, "reconnecting");

		await harness.socket.connect();
		await vi.advanceTimersByTimeAsync(1_000);
		await vi.advanceTimersByTimeAsync(2_000);

		expect(retries).toEqual([
			{ attempt: 1, delayMs: 1_000 },
			{ attempt: 2, delayMs: 2_000 },
			{ attempt: 3, delayMs: 4_000 },
		]);
		harness.socket.disconnect();
	});

	it("cancels a pending retry on disconnect()", async () => {
		vi.useFakeTimers();
		const harness = createHarness({ behaviour: dropNextTick });

		await harness.socket.connect();
		harness.socket.disconnect();
		await vi.advanceTimersByTimeAsync(120_000);

		expect(harness.sockets).toHaveLength(1);
	});

	it("drops the bearer when TM refuses the upgrade with a 401", async () => {
		vi.useFakeTimers();
		const harness = createHarness({
			behaviour: (socket) => {
				void Promise.resolve().then(() => socket.fail("Unexpected server response: 401"));
			},
		});

		await harness.socket.connect();

		expect(harness.invalidations()).toBe(1);
		harness.socket.disconnect();
	});

	it("keeps the bearer when the socket just dies", async () => {
		vi.useFakeTimers();
		const harness = createHarness({ behaviour: dropNextTick });

		await harness.socket.connect();

		expect(harness.invalidations()).toBe(0);
		harness.socket.disconnect();
	});
});

describe("FieldsetSocket outbox", () => {
	it("queues commands while the socket is down and flushes them in order", async () => {
		vi.useFakeTimers();
		const harness = createHarness({ behaviour: openNextTick });
		await harness.socket.connect();

		at(harness.sockets, 0).drop();
		const queued = await Promise.all([
			harness.socket.queueNextMatch(),
			harness.socket.startMatch(1),
			harness.socket.setAudienceDisplay(FieldsetAudienceDisplay.InMatch),
		]);
		expect(queued.every((result) => result.ok)).toBe(true);
		expect(harness.socket.connected).toBe(false);

		await vi.advanceTimersByTimeAsync(1_000);

		expect(harness.socket.connected).toBe(true);
		expect(at(harness.sockets, 1).sent).toEqual([
			'{"cmd":"queueNextMatch"}',
			'{"cmd":"start","fieldID":1}',
			'{"cmd":"setAudienceDisplay","display":"IN_MATCH"}',
		]);
		harness.socket.disconnect();
	});

	it("does not replay the outbox onto a second reconnect", async () => {
		vi.useFakeTimers();
		const harness = createHarness({ behaviour: openNextTick });
		await harness.socket.connect();

		at(harness.sockets, 0).drop();
		await harness.socket.queueNextMatch();
		await vi.advanceTimersByTimeAsync(1_000);
		// Neither connection held up for healthyMs, so this one is the ladder's
		// second rung rather than its first.
		at(harness.sockets, 1).drop();
		await vi.advanceTimersByTimeAsync(2_000);

		expect(at(harness.sockets, 2).sent).toEqual([]);
		harness.socket.disconnect();
	});

	it("discards the outbox on disconnect()", async () => {
		vi.useFakeTimers();
		const harness = createHarness({ behaviour: openNextTick });
		await harness.socket.connect();

		at(harness.sockets, 0).drop();
		await harness.socket.queueNextMatch();
		harness.socket.disconnect();
		await harness.socket.connect();

		expect(at(harness.sockets, 1).sent).toEqual([]);
		harness.socket.disconnect();
	});
});

describe("resolveWebSocketFactory", () => {
	const headlessRuntime = { isNode: () => false, isBun: () => false };

	it("prefers an explicitly injected factory", async () => {
		const explicit: WebSocketFactory = () => new FakeSocket();

		const result = await resolveWebSocketFactory({ explicit, runtime: headlessRuntime });

		expect(result).toEqual({ ok: true, data: explicit, cached: false });
	});

	it("reports ws_headers_unsupported where the handshake cannot be signed", async () => {
		const result = await resolveWebSocketFactory({ runtime: headlessRuntime });

		expect(result).toEqual({
			ok: false,
			error: expect.objectContaining({ code: "ws_headers_unsupported" }),
		});
	});

	it("finds the Node transport under Node", async () => {
		const result = await resolveWebSocketFactory({
			runtime: { isNode: () => true, isBun: () => false },
		});

		expect(result.ok).toBe(true);
	});
});

describe("FieldsetSocket without a usable transport", () => {
	it("returns ws_headers_unsupported rather than throwing, and never retries", async () => {
		vi.useFakeTimers();
		let resolved = 0;
		const socket = new FieldsetSocket({
			http: {
				resolve: (path) => new URL(path, "http://tm.local:8080"),
				authHeadersFor: () => {
					resolved += 1;
					return Promise.resolve(ok(AUTH_HEADERS));
				},
				invalidateBearer: () => undefined,
			},
			fieldSetId: 1,
			runtime: { isNode: () => false, isBun: () => false },
		});

		const result = await socket.connect();

		expect(result).toEqual({
			ok: false,
			error: expect.objectContaining({ code: "ws_headers_unsupported" }),
		});
		// It fails before minting anything, and no ladder can fix a runtime.
		expect(resolved).toBe(0);
		await vi.advanceTimersByTimeAsync(120_000);
		expect(socket.connected).toBe(false);

		// And a command must not queue into a socket that can never open.
		const sent = await socket.startMatch(1);
		expect(sent).toEqual({ ok: false, error: expect.objectContaining({ code: "ws_closed" }) });
	});
});
