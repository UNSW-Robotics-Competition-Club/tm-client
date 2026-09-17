import { describe, expect, it } from "vitest";

import { createDwabAuth } from "../../src/auth/dwab.js";
import { TmConfigError, type Result, type TmError, type TmErrorCode } from "../../src/errors.js";

const TOKEN_URL = "https://auth.vextm.dwabtech.com/oauth2/token";
const NOW = 1_700_000_000_000;
/** A year past `NOW`, in milliseconds, as DWAB reports credential expiry. */
const EXPIRES = NOW + 365 * 24 * 60 * 60 * 1000;

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

function clock(start = NOW) {
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

describe("createDwabAuth expirationDateMs guard", () => {
	const secondsShaped = [Math.floor(EXPIRES / 1000), 0, 1_700_000_000, 999_999_999_999, -1];

	for (const value of secondsShaped) {
		it(`throws TmConfigError at construction for ${value}`, () => {
			expect(() =>
				createDwabAuth({ clientId: "id", clientSecret: "secret", expirationDateMs: value }),
			).toThrow(TmConfigError);
		});
	}

	it("throws for a non-finite expiry", () => {
		expect(() =>
			createDwabAuth({ clientId: "id", clientSecret: "secret", expirationDateMs: Number.NaN }),
		).toThrow(TmConfigError);
	});

	it("accepts a millisecond-shaped expiry", () => {
		expect(() =>
			createDwabAuth({ clientId: "id", clientSecret: "secret", expirationDateMs: EXPIRES }),
		).not.toThrow();
	});

	it("reports an expired credential without calling DWAB", async () => {
		const { fetchStub, calls } = stubFetch(() => tokenResponse("never", 3600));
		const auth = createDwabAuth({
			clientId: "id",
			clientSecret: "secret",
			expirationDateMs: NOW - 1,
			fetch: fetchStub,
			now: () => NOW,
		});

		const error = expectErr(await auth.getBearer());

		expect(error.code).toBe<TmErrorCode>("dwab_credentials_expired");
		expect(calls).toHaveLength(0);
	});
});

describe("createDwabAuth request shape", () => {
	it("posts form-encoded client credentials to the DWAB token endpoint", async () => {
		const { fetchStub, calls } = stubFetch(() => tokenResponse("t", 3600));
		const auth = createDwabAuth({
			clientId: "the-id",
			clientSecret: "the-secret",
			expirationDateMs: EXPIRES,
			fetch: fetchStub,
			now: () => NOW,
		});

		const bearer = expectOk(await auth.getBearer());

		expect(bearer).toEqual({ access_token: "t", token_type: "Bearer", expires_in: 3600 });
		expect(calls[0]?.url).toBe(TOKEN_URL);
		expect(calls[0]?.init?.method).toBe("POST");
		const headers = (calls[0]?.init?.headers ?? {}) as Record<string, string>;
		expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded; charset=UTF-8");

		const body = calls[0]?.init?.body as URLSearchParams;
		expect(body).toBeInstanceOf(URLSearchParams);
		expect(body.get("client_id")).toBe("the-id");
		expect(body.get("client_secret")).toBe("the-secret");
		expect(body.get("grant_type")).toBe("client_credentials");
	});
});

describe("createDwabAuth failure mapping", () => {
	it("maps invalid_client to dwab_invalid_client", async () => {
		const { fetchStub } = stubFetch(() => json(401, { error: "invalid_client" }));
		const auth = createDwabAuth({
			clientId: "id",
			clientSecret: "secret",
			expirationDateMs: EXPIRES,
			fetch: fetchStub,
			now: () => NOW,
		});

		const error = expectErr(await auth.getBearer());

		expect(error.code).toBe<TmErrorCode>("dwab_invalid_client");
		expect(error.httpStatus).toBe(401);
	});

	it("maps other non-200 statuses to dwab_unreachable with the body as detail", async () => {
		const { fetchStub } = stubFetch(() => json(502, { error: "server_error" }));
		const auth = createDwabAuth({
			clientId: "id",
			clientSecret: "secret",
			expirationDateMs: EXPIRES,
			fetch: fetchStub,
			now: () => NOW,
		});

		const error = expectErr(await auth.getBearer());

		expect(error.code).toBe<TmErrorCode>("dwab_unreachable");
		expect(error.httpStatus).toBe(502);
		expect(error.detail).toEqual({ error: "server_error" });
	});

	it("maps a thrown fetch to dwab_unreachable", async () => {
		const { fetchStub } = stubFetch(() => {
			throw new TypeError("fetch failed");
		});
		const auth = createDwabAuth({
			clientId: "id",
			clientSecret: "secret",
			expirationDateMs: EXPIRES,
			fetch: fetchStub,
			now: () => NOW,
		});

		const error = expectErr(await auth.getBearer());

		expect(error.code).toBe<TmErrorCode>("dwab_unreachable");
		expect(error.detail).toBeInstanceOf(TypeError);
	});

	it("refuses a 200 that is not a token rather than caching a NaN expiry", async () => {
		const { fetchStub } = stubFetch(() => new Response("<html>captive portal</html>", { status: 200 }));
		const auth = createDwabAuth({
			clientId: "id",
			clientSecret: "secret",
			expirationDateMs: EXPIRES,
			fetch: fetchStub,
			now: () => NOW,
		});

		expect(expectErr(await auth.getBearer()).code).toBe<TmErrorCode>("malformed_response");
	});
});

describe("createDwabAuth caching", () => {
	it("makes exactly one request for N concurrent callers", async () => {
		const { fetchStub, calls } = stubFetch(async () => {
			await Promise.resolve();
			return tokenResponse("shared", 3600);
		});
		const auth = createDwabAuth({
			clientId: "id",
			clientSecret: "secret",
			expirationDateMs: EXPIRES,
			fetch: fetchStub,
			now: () => NOW,
		});

		const results = await Promise.all([
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
		const auth = createDwabAuth({
			clientId: "id",
			clientSecret: "secret",
			expirationDateMs: EXPIRES,
			fetch: fetchStub,
			now: time.now,
		});

		expect(expectOk(await auth.getBearer()).expires_in).toBe(3600);

		time.advance(90_000);
		expect(expectOk(await auth.getBearer()).expires_in).toBe(3510);
		expect(calls).toHaveLength(1);
	});

	it("re-mints once the remaining life falls inside the margin", async () => {
		const time = clock();
		const { fetchStub, calls } = stubFetch((_call, index) => tokenResponse(`t${index}`, 3600));
		const auth = createDwabAuth({
			clientId: "id",
			clientSecret: "secret",
			expirationDateMs: EXPIRES,
			marginMs: 300_000,
			fetch: fetchStub,
			now: time.now,
		});

		expect(expectOk(await auth.getBearer()).access_token).toBe("t0");

		time.advance(3600_000 - 301_000);
		expect(expectOk(await auth.getBearer()).access_token).toBe("t0");
		expect(calls).toHaveLength(1);

		time.advance(2_000);
		expect(expectOk(await auth.getBearer()).access_token).toBe("t1");
		expect(calls).toHaveLength(2);
	});

	it("re-mints after invalidate()", async () => {
		const { fetchStub, calls } = stubFetch((_call, index) => tokenResponse(`t${index}`, 3600));
		const auth = createDwabAuth({
			clientId: "id",
			clientSecret: "secret",
			expirationDateMs: EXPIRES,
			fetch: fetchStub,
			now: () => NOW,
		});

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
		const auth = createDwabAuth({
			clientId: "id",
			clientSecret: "secret",
			expirationDateMs: EXPIRES,
			fetch: fetchStub,
			now: () => NOW,
		});

		const inflight = auth.getBearer();
		auth.invalidate();
		release();
		expect(expectOk(await inflight).access_token).toBe("t0");
		expect(calls).toHaveLength(1);

		expect(expectOk(await auth.getBearer()).access_token).toBe("t1");
		expect(calls).toHaveLength(2);
	});

	it("keeps serving a still-valid token when a margin refresh fails", async () => {
		const time = clock();
		const { fetchStub } = stubFetch((_call, index) => {
			if (index === 0) return tokenResponse("t0", 3600);
			throw new TypeError("fetch failed");
		});
		const auth = createDwabAuth({
			clientId: "id",
			clientSecret: "secret",
			expirationDateMs: EXPIRES,
			marginMs: 300_000,
			fetch: fetchStub,
			now: time.now,
		});

		await auth.getBearer();
		time.advance(3600_000 - 200_000);

		const stillGood = expectOk(await auth.getBearer());
		expect(stillGood.access_token).toBe("t0");
		expect(stillGood.expires_in).toBe(200);

		time.advance(200_000);
		expect(expectErr(await auth.getBearer()).code).toBe<TmErrorCode>("dwab_unreachable");
	});
});
