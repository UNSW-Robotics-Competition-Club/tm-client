/**
 * Mock VEX Tournament Manager Public API server.
 *
 * Ported from `obs-plugin/test/mock-tm-server.mjs`, which is the only mock in
 * the prior art that *actually validates the HMAC*. The streamdeck-vextm mock's
 * sole auth control is a blanket reject toggle, so a signer regression sails
 * straight through it; this one rebuilds the canonical string and compares the
 * digest, which means a client that passes here should pass against real TM.
 *
 * It validates using our own `src/signing.ts`, so the mock and the shipped
 * signer cannot drift apart. Cerberus's `POST /v1/token` is served inline, so
 * one file replaces a separate mock-cerberus.
 *
 * The RFC 6455 framing below was ported by adding types and nothing else. Node
 * ships a WebSocket client but no server, and the point of this file is to have
 * no dependencies. A behavioural diff in that section means a bug, not a
 * cleanup.
 *
 * ## Usage
 *
 * ```ts
 * import { startMockTmServer, API_KEY, CERBERUS_KEY } from "../mocks/mock-tm-server.js";
 *
 * const tm = await startMockTmServer();          // ephemeral port, scenario "ok", silent
 * try {
 *   // tm.url      -> http://127.0.0.1:53124
 *   // tm.wsUrl    -> ws://127.0.0.1:53124
 *   // tm.port     -> 53124
 *
 *   tm.scenario("api-disabled");                 // every /api/* answers 503
 *   tm.scenario("ok");
 *
 *   tm.refuse(429, "rate_limited", "slow down"); // ad-hoc failure, any endpoint
 *   tm.refuse(503, "upstream", undefined, "token"); // ...or just Cerberus
 *   tm.allow();
 *
 *   await tm.waitForClient(1);                   // a field set socket attached
 *   tm.emit(1, { type: "matchStarted", fieldID: 1 });
 *   tm.commands;                                 // [{ fieldSetId, command }, ...]
 *   tm.connections;                              // one entry per accepted upgrade
 *
 *   tm.dropAll();                                // yanked cable: no close frame
 *   tm.closeAll();                               // polite close frame
 * } finally {
 *   await tm.close();
 * }
 * ```
 *
 * Credentials are fixtures, not secrets: `API_KEY`, `CERBERUS_KEY` and
 * `CLIENT_SECRET` are exported so tests can hand them to the client under test.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import type { Duplex } from "node:stream";

import { signTmRequest } from "../../src/signing.js";

// ---------------------------------------------------------------------------
// Fixed credentials. Test fixtures, not secrets: the real ones are per-event
// and never live in a repo.
// ---------------------------------------------------------------------------

export const CLIENT_SECRET = "mock-client-secret";
export const API_KEY = "TESTAPIKEY0123456789";

/** A well formed Cerberus key: `ctm_<16 hex>_<48 hex>`. */
export const CERBERUS_KEY = "ctm_0123456789abcdef_" + "0123456789abcdef".repeat(3);

/** Cerberus refuses builds below a floor, which is why the client sends its version at all. */
export const MIN_BUILD = "0.1.0";

const TOKEN_TTL_SECONDS = 7200; // real TM tokens last ~2h
const MAX_CLOCK_SKEW_SECONDS = 300;

/** How far ahead the clock-skew scenario pretends the server's clock is. */
const SKEW_SCENARIO_OFFSET_SECONDS = 3600;

// ---------------------------------------------------------------------------
// Scenarios: force a specific failure so the client's error mapping is testable.
// ---------------------------------------------------------------------------

export const SCENARIOS = {
	ok: "Everything works.",
	"api-disabled":
		"Event Partner never ticked Enable Local TM API: /api/* is 503, as real TM answers.",
	"api-disabled-404":
		"The same thing, but answered 404. Older TM builds, and a defensive second shape.",
	"bad-signature": "Every signature is rejected, as with a wrong TM API key.",
	"token-expired": "Tokens are issued already expired, forcing a refresh path.",
	"cerberus-invalid-key": "Sign-in rejects this build's client key (unknown, malformed, or revoked).",
	"cerberus-upgrade-required": "Sign-in refuses this build as older than the supported minimum.",
	"cerberus-rate-limited": "Sign-in is rate limiting this key.",
	"cerberus-credentials-invalid":
		"Sign-in reached DWAB and DWAB rejected SRA's own credential. Not the operator's fault, " +
		"and deliberately not a 401.",
	"cerberus-upstream": "Sign-in could not reach DWAB at all.",
	"clock-skew":
		"The server's clock reads an hour ahead, so requests are rejected the way real TM " +
		"rejects a client whose clock has drifted.",
} as const;

export type MockScenario = keyof typeof SCENARIOS;

// ---------------------------------------------------------------------------
// Payloads, verbatim in shape from the API guide.
// ---------------------------------------------------------------------------

const EVENT = { event: { name: "SRA Mock Scrimmage", code: "RE-V5RC-25-0000" } };

const DIVISIONS = {
	divisions: [
		{ name: "Division 1", id: 1 },
		{ name: "Division 2", id: 2 },
	],
};

const FIELD_SETS = {
	fieldSets: [
		{ id: 1, name: "Match Field Set" },
		{ id: 2, name: "Skills Field Set" },
	],
};

const FIELDS: Record<number, { fields: { id: number; name: string }[] }> = {
	1: {
		fields: [
			{ id: 1, name: "Field 1" },
			{ id: 2, name: "Field 2" },
		],
	},
	2: { fields: [{ id: 3, name: "Skills 1" }] },
};

const TEAMS = {
	teams: [
		{
			number: "1234A",
			name: "Mock Robotics A",
			school: "SRA",
			city: "Sydney",
			region: "NSW",
			country: "Australia",
			ageGroup: "HIGH_SCHOOL",
			divId: 1,
			checkedIn: true,
		},
		{
			number: "1234B",
			name: "Mock Robotics B",
			school: "SRA",
			city: "Sydney",
			region: "NSW",
			country: "Australia",
			ageGroup: "HIGH_SCHOOL",
			divId: 1,
			checkedIn: true,
		},
		{
			number: "5678C",
			name: "Test Team C",
			school: "Other",
			city: "Melbourne",
			region: "VIC",
			country: "Australia",
			ageGroup: "HIGH_SCHOOL",
			divId: 1,
			checkedIn: false,
		},
		{
			number: "5678D",
			name: "Test Team D",
			school: "Other",
			city: "Melbourne",
			region: "VIC",
			country: "Australia",
			ageGroup: "HIGH_SCHOOL",
			divId: 2,
			checkedIn: true,
		},
	],
};

function match(
	round: string,
	number: number,
	state: string,
	red: string[],
	blue: string[],
	score: [number, number] | null,
) {
	return {
		finalScore: score ?? [0, 0],
		winningAlliance: score ? (score[0] > score[1] ? 0 : score[0] < score[1] ? 1 : -1) : -1,
		matchInfo: {
			timeScheduled: 1786418040 + number * 360,
			state,
			alliances: [
				{ teams: red.map((number) => ({ number })) },
				{ teams: blue.map((number) => ({ number })) },
			],
			matchTuple: { session: 0, division: 1, round, instance: 1, match: number },
		},
	};
}

const MATCHES: Record<number, { matches: unknown[] }> = {
	1: {
		matches: [
			match("QUAL", 1, "SCORED", ["1234A", "1234B"], ["5678C", "5678D"], [42, 31]),
			match("QUAL", 2, "SCORED", ["5678C", "1234A"], ["1234B", "5678D"], [15, 88]),
			match("QUAL", 3, "UNPLAYED", ["1234A", "5678D"], ["1234B", "5678C"], null),
		],
	},
	2: { matches: [] },
};

// A ranking identifies its team through `alliance`, NOT through a top-level
// `number`. The obs-plugin mock this file was ported from had `number` — copied
// from the skills shape, which does use it — and nothing there ever read the
// field, so the error was invisible. The guide (Rankings Resource) and
// `Ranking` in src/types.ts both say `alliance`. `name` is empty for the
// one-team alliances qualification rankings produce, exactly as the guide shows.
const RANKINGS = {
	rankings: [
		{
			rank: 1,
			tied: false,
			alliance: { name: "", teams: [{ number: "1234A" }] },
			wins: 2,
			losses: 0,
			ties: 0,
			wp: 4,
			ap: 12,
			sp: 31,
			avgPoints: 42.0,
			totalPoints: 84,
			highScore: 42,
			numMatches: 2,
			minNumMatches: true,
		},
		{
			rank: 2,
			tied: false,
			alliance: { name: "", teams: [{ number: "5678D" }] },
			wins: 1,
			losses: 1,
			ties: 0,
			wp: 2,
			ap: 8,
			sp: 20,
			avgPoints: 30.0,
			totalPoints: 60,
			highScore: 88,
			numMatches: 2,
			minNumMatches: true,
		},
	],
};

const SKILLS = {
	skillsRankings: [
		{
			rank: 1,
			tie: false,
			number: "1234A",
			totalScore: 55,
			progHighScore: 25,
			driverHighScore: 30,
			progAttempts: 3,
			driverAttempts: 3,
		},
		{
			rank: 2,
			tie: false,
			number: "5678C",
			totalScore: 40,
			progHighScore: 18,
			driverHighScore: 22,
			progAttempts: 3,
			driverAttempts: 2,
		},
	],
};

/** Fixed so `If-Modified-Since` round trips are reproducible across runs. */
export const LAST_MODIFIED = new Date("2026-08-11T03:00:00Z");

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

function routeApi(pathname: string): unknown {
	if (pathname === "/api/event") return EVENT;
	if (pathname === "/api/divisions") return DIVISIONS;
	if (pathname === "/api/fieldsets") return FIELD_SETS;
	if (pathname === "/api/teams") return TEAMS;
	if (pathname === "/api/skills") return SKILLS;

	let m: RegExpMatchArray | null;
	if ((m = pathname.match(/^\/api\/fieldsets\/(\d+)\/fields$/))) return FIELDS[Number(m[1])] ?? null;
	if ((m = pathname.match(/^\/api\/teams\/(\d+)$/))) {
		const divId = Number(m[1]);
		return { teams: TEAMS.teams.filter((t) => t.divId === divId) };
	}
	if ((m = pathname.match(/^\/api\/matches\/(\d+)$/))) return MATCHES[Number(m[1])] ?? null;
	if ((m = pathname.match(/^\/api\/rankings\/(\d+)\/(\w+)$/))) {
		return MATCHES[Number(m[1])] ? RANKINGS : null;
	}

	return null;
}

// ---------------------------------------------------------------------------
// WebSocket framing
//
// Ported verbatim from the .mjs, with types added and nothing else touched. The
// only wire subtleties that matter are the accept-key digest and unmasking
// client frames.
//
// Buffer indexing is written with `!` throughout: `noUncheckedIndexedAccess`
// types `buf[0]` as possibly undefined, and asserting is the one annotation
// that leaves the ported expressions byte-for-byte as they were.
// ---------------------------------------------------------------------------

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const OPCODE = { CONTINUATION: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

/** Guards the frame decoder against a client claiming an absurd payload length. */
const MAX_FRAME_BYTES = 1 << 20;

function websocketAccept(key: string): string {
	return createHash("sha1")
		.update(key + WS_GUID)
		.digest("base64");
}

/** Encodes one complete server-to-client frame. Server frames are never masked. */
function encodeFrame(payload: Buffer | string, opcode: number = OPCODE.TEXT): Buffer {
	const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");

	let header: Buffer;
	if (data.length < 126) {
		header = Buffer.alloc(2);
		header[1] = data.length;
	} else if (data.length < 65536) {
		header = Buffer.alloc(4);
		header[1] = 126;
		header.writeUInt16BE(data.length, 2);
	} else {
		header = Buffer.alloc(10);
		header[1] = 127;
		header.writeBigUInt64BE(BigInt(data.length), 2);
	}
	header[0] = 0x80 | opcode; // FIN

	return Buffer.concat([header, data]);
}

interface FrameHandlers {
	message(text: string): void;
	ping(payload: Buffer): void;
	close(): void;
	protocolError(reason: string): void;
}

/**
 * Incremental frame decoder. Feeds whole messages to `handlers.message`.
 *
 * It enforces the rule that client-to-server frames must be masked. That is not
 * pedantry: it is a free check that the client under test speaks the protocol
 * properly, and an unmasked frame would sail past a laxer decoder.
 */
function createFrameDecoder(handlers: FrameHandlers): (chunk: Buffer) => void {
	let pending = Buffer.alloc(0);
	let message = Buffer.alloc(0);

	return function feed(chunk: Buffer) {
		pending = Buffer.concat([pending, chunk]);

		for (;;) {
			if (pending.length < 2) return;

			const fin = (pending[0]! & 0x80) !== 0;
			const opcode = pending[0]! & 0x0f;
			const masked = (pending[1]! & 0x80) !== 0;

			let length = pending[1]! & 0x7f;
			let offset = 2;

			if (length === 126) {
				if (pending.length < offset + 2) return;
				length = pending.readUInt16BE(offset);
				offset += 2;
			} else if (length === 127) {
				if (pending.length < offset + 8) return;
				const wide = pending.readBigUInt64BE(offset);
				if (wide > BigInt(MAX_FRAME_BYTES)) return handlers.protocolError("frame too large");
				length = Number(wide);
				offset += 8;
			}

			if (length > MAX_FRAME_BYTES) return handlers.protocolError("frame too large");

			if (!masked) return handlers.protocolError("client frame was not masked");

			if (pending.length < offset + 4) return;
			const mask = pending.subarray(offset, offset + 4);
			offset += 4;

			if (pending.length < offset + length) return;

			const payload = Buffer.from(pending.subarray(offset, offset + length));
			// `payload[i] ^= mask[i % 4]` in the original; written out longhand only
			// because a compound assignment gives no place to put the assertion.
			for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ mask[i % 4]!;

			pending = pending.subarray(offset + length);

			if (opcode === OPCODE.CLOSE) return handlers.close();
			if (opcode === OPCODE.PING) {
				handlers.ping(payload);
				continue;
			}
			if (opcode === OPCODE.PONG) continue;

			message = Buffer.concat([message, payload]);
			if (fin) {
				const complete = message;
				message = Buffer.alloc(0);
				handlers.message(complete.toString("utf8"));
			}
		}
	};
}

// ---------------------------------------------------------------------------
// Public handle
// ---------------------------------------------------------------------------

export interface RecordedRequest {
	method: string;
	path: string;
	headers: Record<string, string | string[] | undefined>;
	/** True for a websocket upgrade attempt rather than an ordinary request. */
	upgrade: boolean;
	at: number;
}

export interface RecordedCommand {
	fieldSetId: number;
	command: unknown;
	at: number;
}

export interface RecordedConnection {
	fieldSetId: number;
	at: number;
}

/** Which endpoints an ad-hoc `refuse()` applies to. */
export type RefusalTarget = "api" | "token" | "all";

export interface MockTmServerOptions {
	/** 0 (the default) takes an ephemeral port — what tests should use. */
	port?: number;
	scenario?: MockScenario;
	/** Trace every request to stdout. Off by default; the CLI turns it on. */
	log?: boolean;
	host?: string;
}

export interface MockTmServer {
	/** `http://127.0.0.1:<port>` */
	readonly url: string;
	/** `ws://127.0.0.1:<port>` */
	readonly wsUrl: string;
	readonly port: number;

	/** Every request and upgrade attempt, oldest first. */
	readonly requests: RecordedRequest[];
	/** Every command received over a field set socket, oldest first. */
	readonly commands: RecordedCommand[];
	/** One entry per ACCEPTED upgrade. Length > 1 for a field set means a reconnect. */
	readonly connections: RecordedConnection[];

	readonly currentScenario: MockScenario;
	/** Switch scenario mid-test; takes effect on the next request. */
	scenario(name: MockScenario): void;

	/**
	 * Answer the next requests with this failure regardless of scenario. Cheaper
	 * than a scenario when a test needs one specific status once.
	 */
	refuse(status: number, error: string, message?: string, target?: RefusalTarget): void;
	/** Clear any `refuse()`. Does not change the scenario. */
	allow(): void;

	/** Push one event to every socket on a field set. Returns how many got it. */
	emit(fieldSetId: number, event: unknown): number;

	/** Open sockets, for one field set or all of them. */
	clientCount(fieldSetId?: number): number;
	/** Accepted upgrades, for one field set or all of them. */
	connectionCount(fieldSetId?: number): number;

	/** Resolves once a socket is attached; immediately if one already is. */
	waitForClient(fieldSetId?: number, timeoutMs?: number): Promise<void>;

	/**
	 * Yanks the TCP connection with no close frame — a TM restart, a pulled
	 * cable, a slept laptop. This is the case reconnect logic has to survive.
	 */
	dropAll(fieldSetId?: number): void;
	/** Polite shutdown with a close frame. */
	closeAll(fieldSetId?: number): void;

	close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

function sendJson(
	res: ServerResponse,
	status: number,
	body: unknown,
	extraHeaders: Record<string, string> = {},
): void {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(payload),
		...extraHeaders,
	});
	res.end(payload);
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
	const value = req.headers[name];
	return Array.isArray(value) ? value[0] : value;
}

function constantTimeEquals(a: string, b: string): boolean {
	const ab = Buffer.from(a, "utf8");
	const bb = Buffer.from(b, "utf8");
	if (ab.length !== bb.length) return false;
	return timingSafeEqual(ab, bb);
}

interface Denial {
	status: number;
	code: string;
	message: string;
}

interface Refusal {
	status: number;
	error: string;
	message: string | undefined;
	target: RefusalTarget;
}

export async function startMockTmServer(options: MockTmServerOptions = {}): Promise<MockTmServer> {
	const { port = 0, log = false, host = "127.0.0.1" } = options;
	let scenario: MockScenario = options.scenario ?? "ok";

	if (!(scenario in SCENARIOS)) {
		throw new Error(`Unknown scenario "${scenario}". Known: ${Object.keys(SCENARIOS).join(", ")}`);
	}

	const requests: RecordedRequest[] = [];
	const commands: RecordedCommand[] = [];
	const connections: RecordedConnection[] = [];

	/** token -> expiry, epoch seconds. */
	const issuedTokens = new Map<string, number>();
	let refusal: Refusal | null = null;

	const sockets = new Map<number, Set<Socket>>();
	const clientWaiters: { fieldSetId: number | undefined; resolve: () => void }[] = [];

	function socketsFor(fieldSetId?: number): Socket[] {
		if (fieldSetId === undefined) return [...sockets.values()].flatMap((set) => [...set]);
		return [...(sockets.get(fieldSetId) ?? [])];
	}

	function issueToken(): { token: string; ttl: number } {
		const token = createHmac("sha256", CLIENT_SECRET)
			.update(`${Date.now()}:${Math.random()}`)
			.digest("hex");
		const ttl = scenario === "token-expired" ? -1 : TOKEN_TTL_SECONDS;
		issuedTokens.set(token, Math.floor(Date.now() / 1000) + ttl);
		return { token, ttl };
	}

	/**
	 * Returns null when authorised, or exactly which auth layer rejected the
	 * request. The distinct codes are the whole point: a client has to tell a
	 * wrong API key from a skewed clock from a disabled API, and real TM answers
	 * all three with a bare 401.
	 */
	async function authorise(req: IncomingMessage): Promise<Denial | null> {
		const auth = headerValue(req, "authorization") ?? "";
		const tmDate = headerValue(req, "x-tm-date");
		const signature = headerValue(req, "x-tm-signature");

		if (!auth.startsWith("Bearer ")) {
			return { status: 401, code: "missing_token", message: "Authorization: Bearer <token> required" };
		}
		const token = auth.slice("Bearer ".length);

		const expiry = issuedTokens.get(token);
		if (expiry === undefined) {
			return { status: 401, code: "unknown_token", message: "Token was not issued by this server" };
		}
		if (expiry < Math.floor(Date.now() / 1000)) {
			return { status: 401, code: "expired_token", message: "Access token has expired" };
		}

		if (!tmDate) return { status: 401, code: "missing_date", message: "x-tm-date header required" };
		if (!signature) {
			return { status: 401, code: "missing_signature", message: "x-tm-signature header required" };
		}

		const parsed = Date.parse(tmDate);
		if (Number.isNaN(parsed)) {
			return { status: 401, code: "malformed_date", message: "x-tm-date is not an HTTP date" };
		}
		const skew = Math.abs(Date.now() - parsed) / 1000;
		if (skew > MAX_CLOCK_SKEW_SECONDS) {
			return {
				status: 401,
				code: "clock_skew",
				message: `x-tm-date is ${Math.round(skew)}s from server time (max ${MAX_CLOCK_SKEW_SECONDS}s)`,
			};
		}

		if (scenario === "bad-signature") {
			return { status: 401, code: "bad_signature", message: "Signature rejected (forced by scenario)" };
		}

		// Rebuild the canonical string exactly as the client should have, using
		// the shipped signer. The Host header is what the client signed, so it —
		// not our listen address — is what goes into the URL we reconstruct.
		const reqHost = headerValue(req, "host") ?? "";
		const expected = await signTmRequest({
			method: req.method ?? "GET",
			url: new URL(`http://${reqHost}${req.url ?? "/"}`),
			token,
			tmDate,
			apiKey: API_KEY,
		});

		if (!constantTimeEquals(expected, signature)) {
			return {
				status: 401,
				code: "bad_signature",
				message: "x-tm-signature does not match; check the TM API key",
			};
		}

		return null;
	}

	function appliesTo(target: RefusalTarget, endpoint: "api" | "token"): boolean {
		return target === "all" || target === endpoint;
	}

	const server: Server = createServer((req, res) => {
		void handleRequest(req, res);
	});

	async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = new URL(req.url ?? "/", `http://${headerValue(req, "host") ?? "localhost"}`);
		requests.push({
			method: req.method ?? "GET",
			path: url.pathname,
			headers: { ...req.headers },
			upgrade: false,
			at: Date.now(),
		});

		const trace = (status: number, note?: string) => {
			if (log) console.log(`  ${req.method} ${url.pathname} -> ${status}${note ? ` (${note})` : ""}`);
		};

		// --- Cerberus token endpoint ------------------------------------------
		if (url.pathname === "/v1/token") {
			if (req.method !== "POST") {
				trace(405);
				return sendJson(res, 405, { error: "bad_request", message: "POST only" });
			}

			if (refusal && appliesTo(refusal.target, "token")) {
				trace(refusal.status, "refuse()");
				return sendJson(res, refusal.status, { error: refusal.error, message: refusal.message });
			}

			// Ordering matters and mirrors Cerberus: the key is checked before the
			// build floor, so a revoked key never learns the minimum version.
			const auth = headerValue(req, "authorization") ?? "";
			const key = auth.startsWith("Bearer ") ? auth.slice(7) : "";
			if (scenario === "cerberus-invalid-key" || key !== CERBERUS_KEY) {
				trace(401, "bad client key");
				return sendJson(res, 401, { error: "invalid_client", message: "Invalid or revoked API key" });
			}

			const build = String(headerValue(req, "x-cerberus-build") ?? "").split("/")[0];
			if (scenario === "cerberus-upgrade-required" || !build) {
				trace(426, `build ${build || "(absent)"}`);
				return sendJson(res, 426, {
					error: "upgrade_required",
					message: "Client version below the supported minimum",
					minimum: MIN_BUILD,
				});
			}

			if (scenario === "cerberus-rate-limited") {
				trace(429);
				return sendJson(res, 429, { error: "rate_limited", message: "Too many requests" });
			}
			if (scenario === "cerberus-credentials-invalid") {
				trace(503);
				return sendJson(res, 503, {
					error: "credentials_invalid",
					message: "The DWAB developer credential was rejected.",
				});
			}
			if (scenario === "cerberus-upstream") {
				trace(502);
				return sendJson(res, 502, {
					error: "upstream_error",
					message: "Could not reach the DWAB authorization server",
				});
			}

			const { token, ttl } = issueToken();
			trace(200, `token ttl=${ttl}s`);
			return sendJson(res, 200, { access_token: token, token_type: "Bearer", expires_in: ttl });
		}

		// --- TM REST API ------------------------------------------------------
		if (!url.pathname.startsWith("/api/")) {
			trace(404);
			return sendJson(res, 404, { error: "not_found" });
		}

		if (refusal && appliesTo(refusal.target, "api")) {
			trace(refusal.status, "refuse()");
			return sendJson(res, refusal.status, { error: refusal.error, message: refusal.message });
		}

		// TM only exposes /api/* once the Event Partner enables the Local TM API.
		// Before that it answers 503 — verified against the reference client,
		// which maps exactly that status to "the API is not enabled".
		//
		// Neither status is an auth failure, and reporting it as one sends an
		// operator to re-copy a key that was never the problem.
		if (scenario === "api-disabled") {
			trace(503, "Local TM API not enabled");
			return sendJson(res, 503, { error: "service_unavailable" });
		}
		if (scenario === "api-disabled-404") {
			trace(404, "Local TM API not enabled (404 shape)");
			return sendJson(res, 404, { error: "not_found" });
		}

		// A drifted server clock rejects our x-tm-date and, crucially, advertises
		// its own time in the Date header. That header is the only reliable way a
		// client can tell "your clock is wrong" from "your API key is wrong",
		// since both otherwise present as a bare 401.
		if (scenario === "clock-skew") {
			const serverNow = new Date(Date.now() + SKEW_SCENARIO_OFFSET_SECONDS * 1000);
			trace(401, "clock_skew");
			res.writeHead(401, { "Content-Type": "application/json", Date: serverNow.toUTCString() });
			return void res.end(
				JSON.stringify({ error: "clock_skew", message: "x-tm-date is too far from server time" }),
			);
		}

		const denial = await authorise(req);
		if (denial) {
			trace(denial.status, denial.code);
			return sendJson(res, denial.status, { error: denial.code, message: denial.message });
		}

		const body = routeApi(url.pathname);
		if (body === null) {
			trace(404, "no such resource");
			return sendJson(res, 404, { error: "not_found" });
		}

		// Conditional GET. The guide tells clients to poll at most once a minute
		// and to honour Last-Modified, so the mock rewards a correct client with
		// a 304 and punishes a lazy one with a full body.
		const ims = headerValue(req, "if-modified-since");
		if (ims && !Number.isNaN(Date.parse(ims)) && Date.parse(ims) >= LAST_MODIFIED.getTime()) {
			trace(304);
			res.writeHead(304, { "Last-Modified": LAST_MODIFIED.toUTCString() });
			return void res.end();
		}

		trace(200);
		return sendJson(res, 200, body, { "Last-Modified": LAST_MODIFIED.toUTCString() });
	}

	// --- Field set websocket ------------------------------------------------
	//
	// ws://{server}/api/fieldsets/{id}, upgraded with the same three auth headers
	// as a REST call, checked by exactly the same authorise(). A client that can
	// sign a GET can open a socket; one that cannot, cannot.

	function broadcast(fieldSetId: number, payload: unknown): number {
		const targets = socketsFor(fieldSetId);
		const frame = encodeFrame(typeof payload === "string" ? payload : JSON.stringify(payload));
		for (const client of targets) client.write(frame);
		return targets.length;
	}

	server.on("upgrade", (req: IncomingMessage, socket: Duplex) => {
		void handleUpgrade(req, socket as Socket);
	});

	async function handleUpgrade(req: IncomingMessage, socket: Socket): Promise<void> {
		const url = new URL(req.url ?? "/", `http://${headerValue(req, "host") ?? "localhost"}`);
		requests.push({
			method: req.method ?? "GET",
			path: url.pathname,
			headers: { ...req.headers },
			upgrade: true,
			at: Date.now(),
		});

		const trace = (status: number, note?: string) => {
			if (log) console.log(`  UPGRADE ${url.pathname} -> ${status}${note ? ` (${note})` : ""}`);
		};

		// No response object on an upgrade, so the status line is written by hand.
		// end() rather than destroy(): destroying can discard the bytes we just
		// wrote, and then the client sees a dropped connection instead of the
		// status code that explains why it was refused.
		const refuseUpgrade = (status: number, text: string, note?: string) => {
			trace(status, note);
			socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
		};

		const matched = url.pathname.match(/^\/api\/fieldsets\/(\d+)$/);
		if (!matched) return refuseUpgrade(404, "Not Found", "no such field set socket");

		const fieldSetId = Number(matched[1]);
		if (!FIELDS[fieldSetId]) return refuseUpgrade(404, "Not Found", "unknown field set");

		if (refusal && appliesTo(refusal.target, "api")) {
			return refuseUpgrade(refusal.status, refusal.error, "refuse()");
		}
		if (scenario === "api-disabled") {
			return refuseUpgrade(503, "Service Unavailable", "Local TM API not enabled");
		}
		if (scenario === "api-disabled-404") return refuseUpgrade(404, "Not Found", "Local TM API not enabled");
		if (scenario === "clock-skew") return refuseUpgrade(401, "Unauthorized", "clock_skew");

		const denial = await authorise(req);
		if (denial) return refuseUpgrade(denial.status, "Unauthorized", denial.code);

		const key = headerValue(req, "sec-websocket-key");
		if (!key) return refuseUpgrade(400, "Bad Request", "no Sec-WebSocket-Key");

		socket.write(
			"HTTP/1.1 101 Switching Protocols\r\n" +
				"Upgrade: websocket\r\n" +
				"Connection: Upgrade\r\n" +
				`Sec-WebSocket-Accept: ${websocketAccept(key)}\r\n\r\n`,
		);
		socket.setNoDelay(true);
		trace(101, `field set ${fieldSetId}`);

		const set = sockets.get(fieldSetId) ?? new Set<Socket>();
		set.add(socket);
		sockets.set(fieldSetId, set);
		connections.push({ fieldSetId, at: Date.now() });

		const feed = createFrameDecoder({
			message(text) {
				let parsed: unknown;
				try {
					parsed = JSON.parse(text);
				} catch {
					if (log) console.log(`  ws <- unparseable: ${text}`);
					return;
				}
				if (log) console.log(`  ws <- ${text}`);
				commands.push({ fieldSetId, command: parsed, at: Date.now() });

				// Real TM announces the change to every listener rather than
				// answering the sender privately, so a client learns about a
				// display change it did not make. Mirror that.
				const command = parsed as { cmd?: string; display?: string };
				if (command.cmd === "setAudienceDisplay" && command.display) {
					broadcast(fieldSetId, { type: "audienceDisplayChanged", display: command.display });
				}
			},
			ping(payload) {
				socket.write(encodeFrame(payload, OPCODE.PONG));
			},
			close() {
				socket.write(encodeFrame(Buffer.alloc(0), OPCODE.CLOSE));
				socket.end();
			},
			protocolError(reason) {
				if (log) console.log(`  ws protocol error: ${reason}`);
				socket.destroy();
			},
		});

		socket.on("data", feed);
		socket.on("error", () => set.delete(socket));
		socket.on("close", () => set.delete(socket));

		for (let i = clientWaiters.length - 1; i >= 0; i--) {
			const waiter = clientWaiters[i]!;
			if (waiter.fieldSetId === undefined || waiter.fieldSetId === fieldSetId) {
				clientWaiters.splice(i, 1);
				waiter.resolve();
			}
		}
	}

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, host, () => {
			server.off("error", reject);
			resolve();
		});
	});

	const address = server.address() as AddressInfo | null;
	if (!address) throw new Error("mock TM server bound to no address");
	const boundPort = address.port;

	return {
		url: `http://${host}:${boundPort}`,
		wsUrl: `ws://${host}:${boundPort}`,
		port: boundPort,

		requests,
		commands,
		connections,

		get currentScenario() {
			return scenario;
		},
		scenario(name: MockScenario) {
			if (!(name in SCENARIOS)) {
				throw new Error(`Unknown scenario "${name}". Known: ${Object.keys(SCENARIOS).join(", ")}`);
			}
			scenario = name;
		},

		refuse(status, error, message, target = "all") {
			refusal = { status, error, message, target };
		},
		allow() {
			refusal = null;
		},

		emit(fieldSetId, event) {
			return broadcast(fieldSetId, event);
		},

		clientCount(fieldSetId) {
			return socketsFor(fieldSetId).length;
		},
		connectionCount(fieldSetId) {
			if (fieldSetId === undefined) return connections.length;
			return connections.filter((c) => c.fieldSetId === fieldSetId).length;
		},

		waitForClient(fieldSetId, timeoutMs = 10_000) {
			// Resolves immediately when one is already attached, so there is no
			// race between connecting and waiting.
			if (socketsFor(fieldSetId).length > 0) return Promise.resolve();
			return new Promise<void>((resolve, reject) => {
				const timer = setTimeout(
					() => reject(new Error(`no websocket client after ${timeoutMs}ms`)),
					timeoutMs,
				);
				clientWaiters.push({
					fieldSetId,
					resolve: () => {
						clearTimeout(timer);
						resolve();
					},
				});
			});
		},

		dropAll(fieldSetId) {
			for (const client of socketsFor(fieldSetId)) client.destroy();
			if (fieldSetId === undefined) sockets.clear();
			else sockets.get(fieldSetId)?.clear();
		},

		closeAll(fieldSetId) {
			for (const client of socketsFor(fieldSetId)) {
				client.write(encodeFrame(Buffer.alloc(0), OPCODE.CLOSE));
				client.end();
			}
			if (fieldSetId === undefined) sockets.clear();
			else sockets.get(fieldSetId)?.clear();
		},

		close() {
			// Sockets held open by a field set client keep server.close() pending
			// forever, so drop them first. A test that forgot to disconnect should
			// not hang the suite.
			for (const client of socketsFor()) client.destroy();
			sockets.clear();
			return new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			});
		},
	};
}

/**
 * The event sequence one match produces, in order. Shared by the CLI's --cycle
 * option and the socket integration tests, so both exercise the same script.
 */
export function matchCycle(
	options: { fieldId?: number; matchNumber?: number; round?: string; division?: number } = {},
): unknown[] {
	const { fieldId = 1, matchNumber = 1, round = "QUAL", division = 1 } = options;
	return [
		{
			type: "fieldMatchAssigned",
			fieldID: fieldId,
			match: { division, session: 0, round, match: matchNumber, instance: 1 },
		},
		{ type: "fieldActivated", fieldID: fieldId },
		{ type: "audienceDisplayChanged", display: "INTRO" },
		{ type: "matchStarted", fieldID: fieldId },
		{ type: "audienceDisplayChanged", display: "IN_MATCH" },
		{ type: "matchStopped", fieldID: fieldId },
		{ type: "audienceDisplayChanged", display: "RESULTS" },
	];
}
