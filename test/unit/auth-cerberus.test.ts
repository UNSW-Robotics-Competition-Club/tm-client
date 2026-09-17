import { describe, expect, it } from "vitest";

import { createCerberusAuth } from "../../src/auth/cerberus.js";
import type { TmError, TmErrorCode, Result } from "../../src/errors.js";

const ENDPOINT = "https://cerberus.example.test";
const KEY = `ctm_${"0123456789abcdef"}_${"a".repeat(48)}`;
const BUILD = { version: "1.4.2" };

interface Call {
	url: string;
	init: RequestInit | undefined;
}

function stubFetch(responder: (call: Call, index: number) => Response | Promise<Response>) {
	const calls: Call[] = [];
	const fetchStub = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const call: Call = { url: String(input), init };
		calls.push(call);
		return responder(call, calls.length - 1);
	}) as typeof fetch;
	return { fetchStub, calls };
}

function tokenResponse(accessToken: string, expiresIn: number): Response {
	return json(200, { access_token: accessToken, token_type: "Bearer", expires_in: expiresIn });
}

function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function clock(start = 1_700_000_000_000) {
	let t = start;
	return {
		now: () => t,
		advance(ms: number) {
			t += ms;
		},
	};
}

function expectOk<T>(result: Result<T>): T {
	if (!result.ok) throw new Error(`expected ok, got ${result.error.code}: ${result.error.message}`);
	return result.data;
}

function expectErr<T>(result: Result<T>): TmError {
	if (result.ok) throw new Error("expected an error result");
	return result.error;
}

function headersOf(call: Call | undefined): Record<string, string> {
	return (call?.init?.headers ?? {}) as Record<string, string>;
}

describe("createCerberusAuth key validation", () => {
	const malformed: Array<[string, string]> = [
		["empty", ""],
		["wrong prefix", `ctn_0123456789abcdef_${"a".repeat(48)}`],
		["short id", `ctm_0123456789abcde_${"a".repeat(48)}`],
		["short secret", `ctm_0123456789abcdef_${"a".repeat(47)}`],
		["non-hex secret", `ctm_0123456789abcdef_${"z".repeat(48)}`],
		["trailing whitespace", `ctm_0123456789abcdef_${"a".repeat(48)} `],
	];

	for (const [name, key] of malformed) {
		it(`rejects a ${name} key without any network call`, async () => {
			const { fetchStub, calls } = stubFetch(() => tokenResponse("never", 3600));
			const auth = createCerberusAuth({ endpoint: ENDPOINT, apiKey: key, build: BUILD, fetch: fetchStub });

			const error = expectErr(await auth.getBearer());

			expect(error.code).toBe<TmErrorCode>("cerberus_key_invalid");
			expect(calls).toHaveLength(0);
			expect(auth.lastFailure()).not.toBeNull();
		});
	}

	it("accepts an uppercase-hex key", async () => {
		const { fetchStub, calls } = stubFetch(() => tokenResponse("t", 3600));
		const auth = createCerberusAuth({
			endpoint: ENDPOINT,
			apiKey: `ctm_0123456789ABCDEF_${"A".repeat(48)}`,
			build: BUILD,
			fetch: fetchStub,
		});

		expect(expectOk(await auth.getBearer()).access_token).toBe("t");
		expect(calls).toHaveLength(1);
	});
});

describe("createCerberusAuth request shape", () => {
	it("posts to /v1/token with the bearer and build headers", async () => {
		const { fetchStub, calls } = stubFetch(() => tokenResponse("t", 3600));
		const auth = createCerberusAuth({
			endpoint: `${ENDPOINT}///`,
			apiKey: KEY,
			build: BUILD,
			fetch: fetchStub,
		});

		await auth.getBearer();

		expect(calls[0]?.url).toBe(`${ENDPOINT}/v1/token`);
		expect(calls[0]?.init?.method).toBe("POST");
		const headers = headersOf(calls[0]);
		expect(headers["Authorization"]).toBe(`Bearer ${KEY}`);
		expect(headers["x-cerberus-build"]).toBe("1.4.2");
		expect(headers["x-cerberus-event"]).toBeUndefined();
		expect(headers["x-cerberus-event-name"]).toBeUndefined();
		expect(headers["x-cerberus-event-sku"]).toBeUndefined();
	});

	it("appends the build hash to the build header", async () => {
		const { fetchStub, calls } = stubFetch(() => tokenResponse("t", 3600));
		const auth = createCerberusAuth({
			endpoint: ENDPOINT,
			apiKey: KEY,
			build: { version: "1.4.2", hash: "deadbeef" },
			fetch: fetchStub,
		});

		await auth.getBearer();

		expect(headersOf(calls[0])["x-cerberus-build"]).toBe("1.4.2/deadbeef");
	});

	it("sends the event attribution headers when an event is set", async () => {
		const { fetchStub, calls } = stubFetch(() => tokenResponse("t", 3600));
		const auth = createCerberusAuth({
			endpoint: ENDPOINT,
			apiKey: KEY,
			build: BUILD,
			event: { code: "RE-VRC-24-1234", name: "Sydney Regional", sku: "RE-VRC-24-1234" },
			fetch: fetchStub,
		});

		await auth.getBearer();

		const headers = headersOf(calls[0]);
		expect(headers["x-cerberus-event"]).toBe("RE-VRC-24-1234");
		expect(headers["x-cerberus-event-name"]).toBe("Sydney Regional");
		expect(headers["x-cerberus-event-sku"]).toBe("RE-VRC-24-1234");
	});

	it("late-binds the event and build hash for the next mint", async () => {
		const { fetchStub, calls } = stubFetch((_call, index) => tokenResponse(`t${index}`, 3600));
		const auth = createCerberusAuth({ endpoint: ENDPOINT, apiKey: KEY, build: BUILD, fetch: fetchStub });

		await auth.getBearer();
		auth.setEvent({ code: "RE-VIQRC-24-9999", name: "Term 3 Scrimmage" });
		auth.setBuildHash("cafe1234");
		auth.invalidate();
		await auth.getBearer();

		const headers = headersOf(calls[1]);
		expect(headers["x-cerberus-build"]).toBe("1.4.2/cafe1234");
		expect(headers["x-cerberus-event"]).toBe("RE-VIQRC-24-9999");
		expect(headers["x-cerberus-event-name"]).toBe("Term 3 Scrimmage");
		expect(headers["x-cerberus-event-sku"]).toBeUndefined();
	});
});

describe("createCerberusAuth failure mapping", () => {
	const cases: Array<{ status: number; error?: string; expected: TmErrorCode }> = [
		{ status: 401, error: "invalid_client", expected: "cerberus_key_invalid" },
		{ status: 401, expected: "cerberus_key_invalid" },
		{ status: 426, error: "upgrade_required", expected: "cerberus_upgrade_required" },
		{ status: 426, expected: "cerberus_upgrade_required" },
		{ status: 429, error: "rate_limited", expected: "cerberus_rate_limited" },
		{ status: 429, expected: "cerberus_rate_limited" },
		{ status: 503, error: "credentials_expired", expected: "cerberus_credentials_invalid" },
		{ status: 503, error: "credentials_invalid", expected: "cerberus_credentials_invalid" },
		{ status: 503, expected: "cerberus_credentials_invalid" },
		{ status: 502, error: "upstream_error", expected: "cerberus_upstream_error" },
		{ status: 502, expected: "cerberus_upstream_error" },
		{ status: 500, expected: "cerberus_upstream_error" },
	];

	for (const testCase of cases) {
		it(`maps ${testCase.status}/${testCase.error ?? "(no error field)"} to ${testCase.expected}`, async () => {
			const body = testCase.error ? { error: testCase.error, message: "nope" } : {};
			const { fetchStub } = stubFetch(() => json(testCase.status, body));
			const auth = createCerberusAuth({ endpoint: ENDPOINT, apiKey: KEY, build: BUILD, fetch: fetchStub });

			const error = expectErr(await auth.getBearer());

			expect(error.code).toBe(testCase.expected);
			expect(error.httpStatus).toBe(testCase.status);
			expect(auth.lastFailure()).not.toBeNull();
		});
	}

	it("maps a thrown fetch to cerberus_unreachable", async () => {
		const { fetchStub } = stubFetch(() => {
			throw new TypeError("fetch failed");
		});
		const auth = createCerberusAuth({ endpoint: ENDPOINT, apiKey: KEY, build: BUILD, fetch: fetchStub });

		const error = expectErr(await auth.getBearer());

		expect(error.code).toBe<TmErrorCode>("cerberus_unreachable");
		expect(error.detail).toBeInstanceOf(TypeError);
	});

	it("refuses a 200 that is not a token rather than caching a NaN expiry", async () => {
		const { fetchStub, calls } = stubFetch(() => new Response("<html>captive portal</html>", { status: 200 }));
		const auth = createCerberusAuth({ endpoint: ENDPOINT, apiKey: KEY, build: BUILD, fetch: fetchStub });

		const error = expectErr(await auth.getBearer());

		expect(error.code).toBe<TmErrorCode>("cerberus_upstream_error");
		expect(calls).toHaveLength(1);
	});

	it("prefers the server's own message for upgrade_required", async () => {
		const { fetchStub } = stubFetch(() =>
			json(426, { error: "upgrade_required", message: "Minimum version is 2.0.0." }),
		);
		const auth = createCerberusAuth({ endpoint: ENDPOINT, apiKey: KEY, build: BUILD, fetch: fetchStub });

		await auth.getBearer();

		expect(auth.lastFailure()).toBe("Minimum version is 2.0.0.");
	});

	it("clears lastFailure once a mint succeeds", async () => {
		const { fetchStub } = stubFetch((_call, index) =>
			index === 0 ? json(429, { error: "rate_limited" }) : tokenResponse("t", 3600),
		);
		const auth = createCerberusAuth({ endpoint: ENDPOINT, apiKey: KEY, build: BUILD, fetch: fetchStub });

		await auth.getBearer();
		expect(auth.lastFailure()).not.toBeNull();

		await auth.getBearer();
		expect(auth.lastFailure()).toBeNull();
	});
});

describe("createCerberusAuth caching", () => {
	it("makes exactly one request for N concurrent callers", async () => {
		const { fetchStub, calls } = stubFetch(async () => {
			await Promise.resolve();
			return tokenResponse("shared", 3600);
		});
		const auth = createCerberusAuth({ endpoint: ENDPOINT, apiKey: KEY, build: BUILD, fetch: fetchStub });

		const results = await Promise.all([
			auth.getBearer(),
			auth.getBearer(),
			auth.getBearer(),
			auth.getBearer(),
			auth.getBearer(),
		]);

		expect(calls).toHaveLength(1);
		for (const result of results) expect(expectOk(result).access_token).toBe("shared");
	});

	it("reports remaining life, never the issuer's original expires_in", async () => {
		const time = clock();
		const { fetchStub, calls } = stubFetch(() => tokenResponse("t", 3600));
		const auth = createCerberusAuth({
			endpoint: ENDPOINT,
			apiKey: KEY,
			build: BUILD,
			fetch: fetchStub,
			now: time.now,
		});

		expect(expectOk(await auth.getBearer()).expires_in).toBe(3600);

		time.advance(60_000);
		expect(expectOk(await auth.getBearer()).expires_in).toBe(3540);

		time.advance(1_800_000);
		expect(expectOk(await auth.getBearer()).expires_in).toBe(1740);
		expect(calls).toHaveLength(1);
	});

	it("re-mints once the remaining life falls inside the margin", async () => {
		const time = clock();
		const { fetchStub, calls } = stubFetch((_call, index) => tokenResponse(`t${index}`, 3600));
		const auth = createCerberusAuth({
			endpoint: ENDPOINT,
			apiKey: KEY,
			build: BUILD,
			marginMs: 300_000,
			fetch: fetchStub,
			now: time.now,
		});

		expect(expectOk(await auth.getBearer()).access_token).toBe("t0");

		// One second outside the margin: still the cached token.
		time.advance(3600_000 - 301_000);
		expect(expectOk(await auth.getBearer()).access_token).toBe("t0");
		expect(calls).toHaveLength(1);

		time.advance(2_000);
		expect(expectOk(await auth.getBearer()).access_token).toBe("t1");
		expect(calls).toHaveLength(2);
	});

	it("re-mints after invalidate()", async () => {
		const { fetchStub, calls } = stubFetch((_call, index) => tokenResponse(`t${index}`, 3600));
		const auth = createCerberusAuth({ endpoint: ENDPOINT, apiKey: KEY, build: BUILD, fetch: fetchStub });

		expect(expectOk(await auth.getBearer()).access_token).toBe("t0");
		auth.invalidate();
		expect(expectOk(await auth.getBearer()).access_token).toBe("t1");
		expect(calls).toHaveLength(2);
	});

	it("does not let an in-flight mint repopulate a token invalidated mid-flight", async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { fetchStub, calls } = stubFetch(async (_call, index) => {
			if (index === 0) await gate;
			return tokenResponse(`t${index}`, 3600);
		});
		const auth = createCerberusAuth({ endpoint: ENDPOINT, apiKey: KEY, build: BUILD, fetch: fetchStub });

		const inflight = auth.getBearer();
		auth.invalidate();
		release();
		expect(expectOk(await inflight).access_token).toBe("t0");
		expect(calls).toHaveLength(1);

		// The invalidated token must not have been cached by the late arrival.
		expect(expectOk(await auth.getBearer()).access_token).toBe("t1");
		expect(calls).toHaveLength(2);
	});

	it("keeps serving a still-valid token when a margin refresh fails", async () => {
		const time = clock();
		const { fetchStub } = stubFetch((_call, index) => {
			if (index === 0) return tokenResponse("t0", 3600);
			throw new TypeError("fetch failed");
		});
		const auth = createCerberusAuth({
			endpoint: ENDPOINT,
			apiKey: KEY,
			build: BUILD,
			marginMs: 300_000,
			fetch: fetchStub,
			now: time.now,
		});

		await auth.getBearer();
		time.advance(3600_000 - 200_000);

		const stillGood = expectOk(await auth.getBearer());
		expect(stillGood.access_token).toBe("t0");
		expect(stillGood.expires_in).toBe(200);
		expect(auth.lastFailure()).not.toBeNull();

		// Once it is actually dead, the failure surfaces.
		time.advance(200_000);
		expect(expectErr(await auth.getBearer()).code).toBe<TmErrorCode>("cerberus_unreachable");
	});
});
