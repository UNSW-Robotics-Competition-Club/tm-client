// Globals are declared for eslint rather than configured away: this file is
// deliberately outside the TS program (it must run under deno and bun too), so
// it is linted as a plain script with no ambient lib.
/* global console, crypto, URL, TextEncoder */

// Tier 0: zero-dependency, cross-runtime smoke test for the pure signing core.
//
// Runs identically under all three:
//
//     node test/tier0.mjs
//     bun  test/tier0.mjs
//     deno run --allow-read test/tier0.mjs
//
// No test framework, because the point is to prove the core behaves the same on
// three runtimes, and a framework would only prove that the framework is
// portable. The vitest suite in test/unit/ is the thorough one; this is the one
// that can be pointed at a runtime nobody has tried yet.
//
// It cannot import TypeScript, so the two functions under test are inlined
// below. That copy is not a second source of truth: it is asserted against the
// same test/fixtures/signer-vectors.json the real implementation is asserted
// against, so if it ever drifts from src/signing.ts, one of the two fails its
// vectors and the drift is visible immediately.
//
// Deliberately pure ASCII. The non-ASCII inputs live in the fixture, read as
// UTF-8 at runtime, so a runtime's source-file decoding can never be what makes
// this pass or fail.

import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Inlined from src/signing.ts. Keep byte-compatible; the vectors enforce it.
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

function stringToSign({ method, url, token, tmDate }) {
	return (
		[
			method.toUpperCase(),
			url.pathname + url.search,
			`token:${token}`,
			`host:${url.host}`,
			`x-tm-date:${tmDate}`,
		].join("\n") + "\n"
	);
}

async function hmacSha256Hex(key, message) {
	const cryptoKey = await crypto.subtle.importKey(
		"raw",
		encoder.encode(key),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(message));
	return Array.from(new Uint8Array(signature), (b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** `process.exit` under Node and Bun, `Deno.exit` under Deno. */
function exit(code) {
	if (typeof globalThis.process?.exit === "function") globalThis.process.exit(code);
	else if (typeof globalThis.Deno?.exit === "function") globalThis.Deno.exit(code);
	else if (code !== 0) throw new Error(`tier0 failed with code ${code}`);
}

function runtimeName() {
	if (globalThis.Deno?.version?.deno) return `deno ${globalThis.Deno.version.deno}`;
	if (globalThis.Bun?.version) return `bun ${globalThis.Bun.version}`;
	if (globalThis.process?.versions?.node) return `node ${globalThis.process.versions.node}`;
	return "unknown runtime";
}

const fixtureUrl = new URL("./fixtures/signer-vectors.json", import.meta.url);
const { vectors } = JSON.parse(readFileSync(fixtureUrl, "utf8"));

let failures = 0;

function check(label, actual, expected) {
	if (actual === expected) return true;
	failures++;
	console.log(`    ${label}`);
	console.log(`      expected ${JSON.stringify(expected)}`);
	console.log(`      actual   ${JSON.stringify(actual)}`);
	return false;
}

console.log(`tier0: signing core on ${runtimeName()}`);
console.log(`  ${vectors.length} golden vectors from ${fixtureUrl.pathname}`);

for (const vector of vectors) {
	const before = failures;

	const canonical = stringToSign({
		method: vector.method,
		url: new URL(vector.url),
		token: vector.token,
		tmDate: vector.tmDate,
	});
	check("stringToSign", canonical, vector.stringToSign);

	const signature = await hmacSha256Hex(vector.apiKey, canonical);
	check("signature", signature, vector.expectedSignature);

	console.log(`  ${failures === before ? "ok  " : "FAIL"} ${vector.name}`);
}

// The trailing newline is load-bearing and invisible in every log and hex dump
// an operator will ever look at, so prove it matters rather than trusting the
// vectors to have captured it.
{
	const before = failures;
	const canonical = vectors[0].stringToSign;
	const truncated = canonical.slice(0, -1);
	const key = vectors[0].apiKey;

	if ((await hmacSha256Hex(key, truncated)) === (await hmacSha256Hex(key, canonical))) {
		failures++;
		console.log("    dropping the trailing newline did not change the signature");
	}
	console.log(`  ${failures === before ? "ok  " : "FAIL"} trailing newline is significant`);
}

if (failures > 0) {
	console.log(`\ntier0 FAILED: ${failures} assertion(s)`);
	exit(1);
} else {
	console.log(`\ntier0 passed: ${vectors.length} vectors + 1 mutation check`);
	exit(0);
}
