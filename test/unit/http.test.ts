import { describe, expect, it } from "vitest";

import type { AuthProvider, BearerToken } from "../../src/auth/types.js";
import { err, ok } from "../../src/errors.js";
import { TmHttpClient } from "../../src/http.js";
import { hmacSha256Hex, stringToSign } from "../../src/signing.js";

const API_KEY = "test-api-key";
const FIXED_NOW = Date.parse("2026-08-11T03:14:00.000Z");
const FIXED_NOW_HTTP_DATE = new Date(FIXED_NOW).toUTCString();

// ---------------------------------------------------------------------------
// Harness

interface FakeAuth extends AuthProvider {
	/** How many times a token was actually minted, not how many times it was read. */
	mints: number;
	invalidations: number;
}

/**
 * Caches like a real provider does, so "the next call re-minted" is an assertion
 * about the client's invalidation and not about the fake.
 */
function fakeAuth(): FakeAuth {
	let token: string | null = null;
	const auth: FakeAuth = {
		mints: 0,
		invalidations: 0,
		async getBearer() {
			if (token === null) {
				auth.mints += 1;
				token = `token-${auth.mints}`;
			}
			return ok<BearerToken>({ access_token: token, token_type: "Bearer", expires_in: 3600 });
		},
		invalidate() {
			auth.invalidations += 1;
			token = null;
		},
	};
	return auth;
}

interface Call {
	url: string;
	headers: Record<string, string>;
}

type Handler = (url: URL, headers: Record<string, string>) => Response | Promise<Response>;

/** Handlers are consumed in order; the last one repeats for any further calls. */
function stubFetch(handlers: Handler[]): { fetch: typeof fetch; calls: Call[] } {
	const calls: Call[] = [];
	let index = 0;

	const impl = async (input: unknown, init?: { headers?: unknown }): Promise<Response> => {
		const url = input instanceof URL ? input : new URL(String(input));
		const headers = { ...((init?.headers ?? {}) as Record<string, string>) };
		calls.push({ url: url.toString(), headers });

		const handler = handlers[Math.min(index, handlers.length - 1)];
		index += 1;
		if (!handler) throw new Error("stubFetch: no handlers configured");
		return handler(url, headers);
	};

	return { fetch: impl as unknown as typeof fetch, calls };
}

function jsonResponse(
	body: unknown,
	init: { status?: number; headers?: Record<string, string> } = {},
): Response {
	return new Response(JSON.stringify(body), {
		status: init.status ?? 200,
		headers: { "Content-Type": "application/json", ...init.headers },
	});
}

function nthCall(calls: Call[], index: number): Call {
	const call = calls[index];
	if (!call) throw new Error(`expected at least ${index + 1} fetch calls, saw ${calls.length}`);
	return call;
}

function makeClient(
	handlers: Handler[],
	options: { baseUrl?: string; auth?: FakeAuth; maxClockSkewMs?: number } = {},
): { http: TmHttpClient; calls: Call[]; auth: FakeAuth } {
	const auth = options.auth ?? fakeAuth();
	const { fetch, calls } = stubFetch(handlers);
	const http = new TmHttpClient({
		baseUrl: options.baseUrl ?? "http://127.0.0.1:8080",
		apiKey: API_KEY,
		auth,
		fetch,
		now: () => FIXED_NOW,
		...(options.maxClockSkewMs === undefined ? {} : { maxClockSkewMs: options.maxClockSkewMs }),
	});
	return { http, calls, auth };
}

// ---------------------------------------------------------------------------

describe("TmHttpClient.resolve", () => {
	it("produces the same URL with or without a trailing slash on the address", () => {
		const withSlash = makeClient([], { baseUrl: "http://127.0.0.1:8080/" }).http;
		const withoutSlash = makeClient([], { baseUrl: "http://127.0.0.1:8080" }).http;

		expect(withSlash.resolve("/api/event").toString()).toBe("http://127.0.0.1:8080/api/event");
		expect(withoutSlash.resolve("/api/event").toString()).toBe("http://127.0.0.1:8080/api/event");
	});

	it("keeps a non-default port in host, and omits a default one", () => {
		const ported = makeClient([], { baseUrl: "http://192.168.1.50:8080" }).http;
		const plain = makeClient([], { baseUrl: "http://192.168.1.50" }).http;

		expect(ported.resolve("/api/event").host).toBe("192.168.1.50:8080");
		expect(plain.resolve("/api/event").host).toBe("192.168.1.50");
	});

	it("keeps a sub-path on the address instead of replacing it", () => {
		const http = makeClient([], { baseUrl: "http://tm.local/tm" }).http;
		expect(http.resolve("/api/event").toString()).toBe("http://tm.local/tm/api/event");
	});
});

describe("TmHttpClient.get request headers", () => {
	it("signs the exact URL it fetches, including the port", async () => {
		const { http, calls } = makeClient([() => jsonResponse({ event: {} })]);

		await http.get("/api/event");

		const call = nthCall(calls, 0);
		expect(call.url).toBe("http://127.0.0.1:8080/api/event");
		expect(call.headers["Authorization"]).toBe("Bearer token-1");
		expect(call.headers["x-tm-date"]).toBe(FIXED_NOW_HTTP_DATE);

		const expected = await hmacSha256Hex(
			API_KEY,
			stringToSign({
				method: "GET",
				url: new URL("http://127.0.0.1:8080/api/event"),
				token: "token-1",
				tmDate: call.headers["x-tm-date"] ?? "",
			}),
		);
		expect(call.headers["x-tm-signature"]).toBe(expected);
	});

	it("does not send Host, which Fetch forbids and which is not signed anyway", async () => {
		const { http, calls } = makeClient([() => jsonResponse({ event: {} })]);

		await http.get("/api/event");

		expect(nthCall(calls, 0).headers).not.toHaveProperty("Host");
	});

	it("exposes signed headers for an arbitrary URL, keeping Host for the ws path", async () => {
		const { http } = makeClient([]);

		const result = await http.authHeadersFor(new URL("http://127.0.0.1:8080/api/fieldsets/1"));

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data["Host"]).toBe("127.0.0.1:8080");
		expect(result.data["Authorization"]).toBe("Bearer token-1");
		expect(result.data["x-tm-signature"]).toBeTypeOf("string");
	});
});

describe("TmHttpClient conditional GET", () => {
	it("stores Last-Modified from a 200 and replays it verbatim on the next call", async () => {
		const lastModified = "Tue, 11 Aug 2026 03:00:00 GMT";
		const { http, calls } = makeClient([
			() => jsonResponse({ event: { name: "Scrimmage" } }, { headers: { "Last-Modified": lastModified } }),
			() => new Response(null, { status: 304 }),
		]);

		await http.get("/api/event");
		await http.get("/api/event");

		expect(nthCall(calls, 0).headers).not.toHaveProperty("If-Modified-Since");
		expect(nthCall(calls, 1).headers["If-Modified-Since"]).toBe(lastModified);
	});

	it("does not cache a 200 with no Last-Modified", async () => {
		const { http, calls } = makeClient([() => jsonResponse({ event: {} })]);

		await http.get("/api/event");
		await http.get("/api/event");

		expect(nthCall(calls, 1).headers).not.toHaveProperty("If-Modified-Since");
	});

	it("serves the cached body on a 304 and flags it cached", async () => {
		const body = { event: { name: "Scrimmage", code: "RE-VRC-26-1234" } };
		const { http } = makeClient([
			() => jsonResponse(body, { headers: { "Last-Modified": "Tue, 11 Aug 2026 03:00:00 GMT" } }),
			() => new Response(null, { status: 304 }),
		]);

		const first = await http.get<typeof body>("/api/event");
		const second = await http.get<typeof body>("/api/event");

		expect(first).toEqual({ ok: true, data: body, cached: false });
		expect(second).toEqual({ ok: true, data: body, cached: true });
	});

	it("caches per URL, so one endpoint's entry cannot answer another", async () => {
		const { http, calls } = makeClient([
			() => jsonResponse({ event: {} }, { headers: { "Last-Modified": "Tue, 11 Aug 2026 03:00:00 GMT" } }),
			() => jsonResponse({ divisions: [] }),
		]);

		await http.get("/api/event");
		await http.get("/api/divisions");

		expect(nthCall(calls, 1).headers).not.toHaveProperty("If-Modified-Since");
	});

	it("reports a 304 we never asked for as malformed rather than inventing data", async () => {
		const { http } = makeClient([() => new Response(null, { status: 304 })]);

		const result = await http.get("/api/event");

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("malformed_response");
	});
});

describe("TmHttpClient bearer invalidation (upstream Client.ts:460 regression)", () => {
	it("drops both the bearer and the URL's cache entry on a 401", async () => {
		const lastModified = "Tue, 11 Aug 2026 03:00:00 GMT";
		const { http, calls, auth } = makeClient([
			() => jsonResponse({ event: { name: "first" } }, { headers: { "Last-Modified": lastModified } }),
			() => new Response("unauthorized", { status: 401 }),
			() => jsonResponse({ event: { name: "second" } }, { headers: { "Last-Modified": lastModified } }),
		]);

		await http.get("/api/event");
		const rejected = await http.get("/api/event");
		const recovered = await http.get<{ event: { name: string } }>("/api/event");

		expect(rejected.ok).toBe(false);
		expect(auth.invalidations).toBe(1);

		// The whole point: the third call must re-mint AND must not carry the
		// conditional header, because a 304 answered against a token TM has just
		// rejected would hand back the stale body as though it were fresh.
		expect(auth.mints).toBe(2);
		expect(nthCall(calls, 2).headers["Authorization"]).toBe("Bearer token-2");
		expect(nthCall(calls, 2).headers).not.toHaveProperty("If-Modified-Since");
		expect(recovered).toEqual({ ok: true, data: { event: { name: "second" } }, cached: false });
	});

	it("leaves the bearer alone on a 500", async () => {
		const { http, auth } = makeClient([() => new Response("boom", { status: 500 })]);

		await http.get("/api/event");

		expect(auth.invalidations).toBe(0);
	});
});

describe("TmHttpClient status classification", () => {
	it("reports 503 as the Local API being switched off", async () => {
		const { http } = makeClient([() => new Response("{}", { status: 503 })]);

		const result = await http.get("/api/event");

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("local_api_disabled");
		expect(result.error.httpStatus).toBe(503);
	});

	it("reports a 404 under /api/ as the Local API being switched off", async () => {
		const { http } = makeClient([() => new Response("not found", { status: 404 })]);

		const result = await http.get("/api/divisions");

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("local_api_disabled");
	});

	it("reports a 404 outside /api/ as a plain HTTP error", async () => {
		const { http } = makeClient([() => new Response("not found", { status: 404 })]);

		const result = await http.get("/favicon.ico");

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("http_error");
	});

	it("reports a 401 with an in-tolerance clock as a bad signature", async () => {
		const { http } = makeClient([
			() =>
				new Response("nope", {
					status: 401,
					headers: { Date: new Date(FIXED_NOW - 2_000).toUTCString() },
				}),
		]);

		const result = await http.get("/api/event");

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("invalid_signature");
	});

	it("reports a 401 with a badly skewed server Date as clock skew", async () => {
		const { http } = makeClient([
			() =>
				new Response("nope", {
					status: 401,
					headers: { Date: new Date(FIXED_NOW - 600_000).toUTCString() },
				}),
		]);

		const result = await http.get("/api/event");

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("clock_skew");
		expect(result.error.message).toContain("600s");
		expect(http.observedClockSkewMs).toBe(600_000);
	});

	it("treats a 403 the same way as a 401", async () => {
		const { http } = makeClient([() => new Response("nope", { status: 403 })]);

		const result = await http.get("/api/event");

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("invalid_signature");
	});

	it("honours a custom maxClockSkewMs", async () => {
		const { http } = makeClient(
			[
				() =>
					new Response("nope", {
						status: 401,
						headers: { Date: new Date(FIXED_NOW - 30_000).toUTCString() },
					}),
			],
			{ maxClockSkewMs: 10_000 },
		);

		const result = await http.get("/api/event");

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("clock_skew");
	});

	it("carries the body and status on an unexpected HTTP error", async () => {
		const { http } = makeClient([() => new Response("internal boom", { status: 500 })]);

		const result = await http.get("/api/event");

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("http_error");
		expect(result.error.httpStatus).toBe(500);
		expect(result.error.detail).toBe("internal boom");
	});

	it("reports a thrown fetch as an unreachable host", async () => {
		const { http } = makeClient([
			() => {
				throw new TypeError("fetch failed");
			},
		]);

		const result = await http.get("/api/event");

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("host_unreachable");
		expect(result.error.detail).toBeInstanceOf(TypeError);
	});

	it("reports a non-JSON 200 as malformed", async () => {
		const { http } = makeClient([
			() => new Response("<html>TM web server</html>", { status: 200 }),
		]);

		const result = await http.get("/api/event");

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("malformed_response");
	});

	it("propagates an auth failure unchanged and never reaches the network", async () => {
		const failing: AuthProvider = {
			async getBearer() {
				return err("cerberus_unreachable", "no route to broker");
			},
			invalidate() {},
		};
		const { fetch, calls } = stubFetch([() => jsonResponse({ event: {} })]);
		const http = new TmHttpClient({ baseUrl: "http://127.0.0.1:8080", apiKey: API_KEY, auth: failing, fetch });

		const result = await http.get("/api/event");

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("cerberus_unreachable");
		expect(calls).toHaveLength(0);
	});
});

describe("TmHttpClient clock skew", () => {
	it("records skew from a successful response too", async () => {
		const { http } = makeClient([
			() => jsonResponse({ event: {} }, { headers: { Date: new Date(FIXED_NOW - 45_000).toUTCString() } }),
		]);

		expect(http.observedClockSkewMs).toBe(0);
		await http.get("/api/event");
		expect(http.observedClockSkewMs).toBe(45_000);
	});

	it("never corrects the outgoing x-tm-date, however far the server's clock is off", async () => {
		const { http, calls } = makeClient([
			() =>
				jsonResponse({ event: {} }, { headers: { Date: new Date(FIXED_NOW - 3_600_000).toUTCString() } }),
		]);

		await http.get("/api/event");
		await http.get("/api/event");

		// Auto-correcting would hide a dead RTC and would let an untrusted
		// response header steer what we sign.
		expect(nthCall(calls, 1).headers["x-tm-date"]).toBe(FIXED_NOW_HTTP_DATE);
	});

	it("ignores a missing or unparseable Date header", async () => {
		const { http } = makeClient([
			() => jsonResponse({ event: {} }),
			() => jsonResponse({ event: {} }, { headers: { Date: "not a date" } }),
		]);

		await http.get("/api/event");
		await http.get("/api/divisions");

		expect(http.observedClockSkewMs).toBe(0);
	});
});
