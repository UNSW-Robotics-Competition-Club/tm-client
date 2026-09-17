/**
 * Golden-vector suite for `src/signing.ts`.
 *
 * The vectors come from obs-plugin, where they already pin a C++ signer and a
 * JS reference signer against each other. Asserting them here makes this the
 * third implementation held to the same bytes rather than the third one free to
 * drift.
 *
 * `node:crypto` is imported deliberately. `src/` may not touch `node:*` — that
 * is the isomorphism boundary — but a test that only ever compares WebCrypto to
 * itself proves nothing about whether WebCrypto agrees with the platform HMAC
 * everyone else in the ecosystem uses. Here it is the independent witness.
 */

import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
	buildAuthHeaders,
	formatTmDate,
	hmacSha256Hex,
	signTmRequest,
	stringToSign,
} from "../../src/signing.js";

interface SignerVector {
	name: string;
	method: string;
	url: string;
	token: string;
	tmDate: string;
	apiKey: string;
	stringToSign: string;
	expectedSignature: string;
}

const fixture = JSON.parse(
	readFileSync(new URL("../fixtures/signer-vectors.json", import.meta.url), "utf8"),
) as { vectors: SignerVector[] };

const vectors = fixture.vectors;

describe("golden vectors", () => {
	it("the fixture is the expected size", () => {
		// Six inherited from obs-plugin plus the multi-byte UTF-8 one added here.
		// A change in this number means someone edited a shared fixture.
		expect(vectors).toHaveLength(7);
	});

	for (const vector of vectors) {
		describe(vector.name, () => {
			const input = {
				method: vector.method,
				url: new URL(vector.url),
				token: vector.token,
				tmDate: vector.tmDate,
			};

			it("builds the canonical string", () => {
				expect(stringToSign(input)).toBe(vector.stringToSign);
			});

			it("signs to the expected hex digest", async () => {
				await expect(signTmRequest({ ...input, apiKey: vector.apiKey })).resolves.toBe(
					vector.expectedSignature,
				);
			});

			it("agrees with node:crypto createHmac", async () => {
				const reference = createHmac("sha256", vector.apiKey)
					.update(vector.stringToSign)
					.digest("hex");

				// Pinned against the fixture too, so a bad reference cannot quietly
				// agree with a bad implementation.
				expect(reference).toBe(vector.expectedSignature);
				await expect(hmacSha256Hex(vector.apiKey, vector.stringToSign)).resolves.toBe(reference);
			});
		});
	}
});

describe("canonical string construction", () => {
	const base = {
		method: "GET",
		url: new URL("http://192.168.1.50/api/event"),
		token: "test.token",
		tmDate: "Tue, 11 Aug 2026 03:14:00 GMT",
	};

	it("ends with a trailing newline", () => {
		expect(stringToSign(base).endsWith("\n")).toBe(true);
		expect(stringToSign(base).split("\n")).toHaveLength(6); // five lines, all terminated
	});

	it("changes the signature when the trailing newline is dropped", async () => {
		// The single most common TM integration mistake. TM answers a missing
		// trailing newline with a bare 401 and no explanation, so this assertion
		// is the only thing standing between a future refactor and a day of
		// blaming the API key.
		const canonical = stringToSign(base);
		const truncated = canonical.slice(0, -1);

		expect(truncated).not.toBe(canonical);
		expect(await hmacSha256Hex("key", truncated)).not.toBe(await hmacSha256Hex("key", canonical));
	});

	it("signs a non-default port as part of host, and omits the default port", () => {
		const explicit = stringToSign({ ...base, url: new URL("http://192.168.1.50:8080/api/event") });
		const defaulted = stringToSign({ ...base, url: new URL("http://192.168.1.50:80/api/event") });

		expect(explicit).toContain("host:192.168.1.50:8080\n");
		expect(defaulted).toContain("host:192.168.1.50\n");
		expect(defaulted).not.toContain(":80");
	});

	it("includes the query string in the signed path", () => {
		const signed = stringToSign({
			...base,
			url: new URL("http://tm.local/api/rankings/1/QUAL?foo=bar&baz=1"),
		});

		expect(signed).toContain("\n/api/rankings/1/QUAL?foo=bar&baz=1\n");
	});

	it("upper-cases the method", () => {
		expect(stringToSign({ ...base, method: "get" })).toBe(stringToSign(base));
	});
});

describe("formatTmDate", () => {
	it("produces an RFC 1123 date in GMT", () => {
		const formatted = formatTmDate(new Date(Date.UTC(2026, 7, 11, 3, 14, 0)));

		expect(formatted).toBe("Tue, 11 Aug 2026 03:14:00 GMT");
		expect(formatted).toMatch(
			/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/,
		);
	});

	it("reports a local-zone date in GMT rather than local time", () => {
		// Whatever the test machine's zone is, the wire value must be UTC.
		const instant = new Date(Date.UTC(2026, 0, 1, 12, 0, 0));

		expect(formatTmDate(instant)).toBe("Thu, 01 Jan 2026 12:00:00 GMT");
	});
});

describe("buildAuthHeaders", () => {
	const url = new URL("http://192.168.1.50:8080/api/event");
	const token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test.token";
	const apiKey = "TESTAPIKEY0123456789";
	const now = () => new Date(Date.UTC(2026, 7, 11, 3, 14, 0));

	it("returns all four headers", async () => {
		const headers = await buildAuthHeaders(url, { token, apiKey, now });

		expect(Object.keys(headers).sort()).toEqual([
			"Authorization",
			"Host",
			"x-tm-date",
			"x-tm-signature",
		]);
		expect(headers.Authorization).toBe(`Bearer ${token}`);
		expect(headers["x-tm-date"]).toBe("Tue, 11 Aug 2026 03:14:00 GMT");
		expect(headers.Host).toBe("192.168.1.50:8080");
	});

	it("signs the same string the canonical builder produces", async () => {
		const headers = await buildAuthHeaders(url, { token, apiKey, now });
		const expected = createHmac("sha256", apiKey)
			.update(
				stringToSign({
					method: "GET",
					url,
					token,
					tmDate: "Tue, 11 Aug 2026 03:14:00 GMT",
				}),
			)
			.digest("hex");

		expect(headers["x-tm-signature"]).toBe(expected);
	});

	it("defaults to GET and honours an explicit method", async () => {
		const implicit = await buildAuthHeaders(url, { token, apiKey, now });
		const explicit = await buildAuthHeaders(url, { token, apiKey, now, method: "GET" });
		const post = await buildAuthHeaders(url, { token, apiKey, now, method: "POST" });

		expect(implicit["x-tm-signature"]).toBe(explicit["x-tm-signature"]);
		expect(post["x-tm-signature"]).not.toBe(implicit["x-tm-signature"]);
	});
});
