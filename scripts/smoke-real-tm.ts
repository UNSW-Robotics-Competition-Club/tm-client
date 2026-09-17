/**
 * Smoke test against a real Tournament Manager instance.
 *
 * Deliberately NOT part of `pnpm test`. It needs LAN access to a specific
 * machine and real credentials, and in its last phase it can drive a live field
 * set. It is a manually-triggered entry point, gated on env vars, and it skips
 * cleanly rather than failing when they are absent.
 *
 *     TM_SMOKE_ADDRESS=http://192.168.1.50 \
 *     TM_SMOKE_API_KEY=<from TM: Tools > Options > Web Publishing> \
 *     TM_SMOKE_CERBERUS_KEY=<ctm_...> \
 *     pnpm smoke
 *
 * Three phases, in this order on purpose:
 *
 *   1. READ-ONLY. Every REST resource, then a field set socket that only
 *      listens. Zero mutation risk, so it runs unconditionally.
 *   2. CLOCK SKEW. Reports the measured offset from TM's own Date header.
 *      Diagnostic only — it never changes what gets signed.
 *   3. COMMANDS. Off unless TM_SMOKE_ALLOW_COMMANDS=yes. Sends the most
 *      harmless command that still proves the write path works, and nothing
 *      else. A broker that can start a match is a broker that can start one by
 *      accident; the same goes for a smoke script.
 *
 * Never run phase 3 against a field with robots on it. Use a throwaway event.
 */

import { createCerberusAuth } from "../src/auth/cerberus.js";
import { createDwabAuth } from "../src/auth/dwab.js";
import type { AuthProvider } from "../src/auth/types.js";
import { TmClient } from "../src/client.js";
import { remedy, type Result } from "../src/errors.js";
import { FieldsetSocket } from "../src/fieldset-socket.js";
import { FieldsetAudienceDisplay, MatchRound } from "../src/types.js";
import { createNodeWebSocketFactory } from "../src/ws/node.js";

const env = process.env;

const ADDRESS = env["TM_SMOKE_ADDRESS"];
const API_KEY = env["TM_SMOKE_API_KEY"];
const ALLOW_COMMANDS = env["TM_SMOKE_ALLOW_COMMANDS"] === "yes";
const LISTEN_SECONDS = Number(env["TM_SMOKE_LISTEN_SECONDS"] ?? 30);

if (!ADDRESS || !API_KEY) {
	console.log(
		"skipped: set TM_SMOKE_ADDRESS and TM_SMOKE_API_KEY to run against a real TM.\n" +
			"This is intentional — absent credentials is a skip, not a failure, so CI stays green.",
	);
	process.exit(0);
}

function buildAuth(): AuthProvider {
	const cerberusKey = env["TM_SMOKE_CERBERUS_KEY"];
	if (cerberusKey) {
		return createCerberusAuth({
			endpoint: env["TM_SMOKE_CERBERUS_ENDPOINT"] ?? "https://tm.unswrobotics.com",
			apiKey: cerberusKey,
			build: { version: "0.1.0-smoke" },
		});
	}

	const clientId = env["TM_SMOKE_CLIENT_ID"];
	const clientSecret = env["TM_SMOKE_CLIENT_SECRET"];
	const expiry = env["TM_SMOKE_EXPIRATION_DATE_MS"];
	if (clientId && clientSecret && expiry) {
		return createDwabAuth({
			clientId,
			clientSecret,
			expirationDateMs: Number(expiry),
		});
	}

	console.error(
		"no auth configured: set TM_SMOKE_CERBERUS_KEY, or all of TM_SMOKE_CLIENT_ID,\n" +
			"TM_SMOKE_CLIENT_SECRET and TM_SMOKE_EXPIRATION_DATE_MS (milliseconds).",
	);
	process.exit(2);
}

let failures = 0;

function report<T>(label: string, result: Result<T>, describe?: (value: T) => string): T | null {
	if (result.ok) {
		const suffix = describe ? ` — ${describe(result.data)}` : "";
		const cached = result.cached ? " (304)" : "";
		console.log(`  ok    ${label}${suffix}${cached}`);
		return result.data;
	}
	failures += 1;
	console.error(`  FAIL  ${label}: [${result.error.code}] ${result.error.message}`);
	console.error(`        ${remedy(result.error.code)}`);
	return null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
	const client = new TmClient({ baseUrl: ADDRESS!, apiKey: API_KEY!, auth: buildAuth() });

	// -----------------------------------------------------------------------
	console.log(`\nPhase 1 — read-only, against ${ADDRESS}\n`);

	report("GET /api/event", await client.getEvent(), (e) => `${e.name} [${e.code}]`);
	const divisions = report(
		"GET /api/divisions",
		await client.getDivisions(),
		(d) => `${d.length} division(s)`,
	);
	report("GET /api/teams", await client.getTeams(), (t) => `${t.length} team(s)`);
	report("GET /api/skills", await client.getSkills(), (s) => `${s.length} ranked`);
	const fieldSets = report(
		"GET /api/fieldsets",
		await client.getFieldSets(),
		(f) => `${f.map((s) => `${s.id}:${s.name}`).join(", ")}`,
	);

	const divisionId = divisions?.[0]?.id;
	if (divisionId !== undefined) {
		report(
			`GET /api/matches/${divisionId}`,
			await client.getMatches(divisionId),
			(m) => `${m.length} match(es)`,
		);
		report(
			`GET /api/rankings/${divisionId}/QUAL`,
			await client.getRankings(divisionId, MatchRound.Qualification),
			(r) => `${r.length} ranked`,
		);
	}

	const fieldSetId = fieldSets?.[0]?.id;
	if (fieldSetId !== undefined) {
		report(
			`GET /api/fieldsets/${fieldSetId}/fields`,
			await client.getFields(fieldSetId),
			(f) => f.map((x) => x.name).join(", "),
		);
	}

	// A second read proves the conditional-GET path against real TM, which is
	// the bit a mock can only approximate — TM decides its own Last-Modified.
	const second = await client.getEvent();
	console.log(
		second.ok && second.cached
			? "  ok    conditional GET — TM answered 304 from If-Modified-Since"
			: "  note  conditional GET — TM re-sent the body (no Last-Modified?)",
	);

	// -----------------------------------------------------------------------
	console.log(`\nPhase 2 — clock skew (diagnostic only)\n`);

	const skewMs = client.http.observedClockSkewMs;
	const skewSeconds = Math.round(skewMs / 1000);
	if (Math.abs(skewMs) > 300_000) {
		failures += 1;
		console.error(`  FAIL  clock is ${skewSeconds}s from TM. Signatures will be rejected.`);
		console.error(`        ${remedy("clock_skew")}`);
	} else if (Math.abs(skewMs) > 30_000) {
		console.log(`  warn  clock is ${skewSeconds}s from TM — inside tolerance, but drifting.`);
	} else {
		console.log(`  ok    clock within ${skewSeconds}s of TM`);
	}

	// -----------------------------------------------------------------------
	if (fieldSetId === undefined) {
		console.log("\nNo field sets configured; skipping the websocket phases.\n");
	} else {
		console.log(`\nPhase 3 — field set ${fieldSetId} socket, listening ${LISTEN_SECONDS}s\n`);

		const socket = new FieldsetSocket({
			http: client.http,
			fieldSetId,
			webSocketFactory: await createNodeWebSocketFactory(),
		});

		socket.addEventListener("message", (e) => {
			console.log(`  event  ${JSON.stringify((e as CustomEvent).detail)}`);
		});
		socket.addEventListener("reconnecting", (e) => {
			const { attempt, delayMs } = (e as CustomEvent).detail;
			console.log(`  ..     reconnecting in ${delayMs}ms (attempt ${attempt})`);
		});

		const opened = await socket.connect();
		if (!opened.ok) {
			failures += 1;
			console.error(`  FAIL  websocket: [${opened.error.code}] ${opened.error.message}`);
			console.error(`        ${remedy(opened.error.code)}`);
		} else {
			console.log("  ok    signed websocket upgrade accepted");
			console.log(`  ..     listening — queue or run a match in TM to see events`);
			await sleep(LISTEN_SECONDS * 1000);
			console.log(`  ..     state: ${JSON.stringify(socket.state)}`);

			// -------------------------------------------------------------------
			if (!ALLOW_COMMANDS) {
				console.log(
					"\nPhase 4 — commands SKIPPED.\n" +
						"  Set TM_SMOKE_ALLOW_COMMANDS=yes to enable, and only on a throwaway event.\n",
				);
			} else {
				console.log("\nPhase 4 — commands (TM_SMOKE_ALLOW_COMMANDS=yes)\n");
				// The most harmless command that still proves the write path: it
				// changes what a screen shows and touches no match state at all.
				const before = socket.state.audienceDisplay;
				const sent = await socket.setAudienceDisplay(FieldsetAudienceDisplay.Logo);
				report("setAudienceDisplay LOGO", sent);
				await sleep(1500);
				console.log(
					socket.state.audienceDisplay === FieldsetAudienceDisplay.Logo
						? "  ok    TM echoed the change back — the write path works end to end"
						: `  note  no echo yet (was ${before}, now ${socket.state.audienceDisplay})`,
				);
				const restored = await socket.setAudienceDisplay(before);
				report(`restore audience display to ${before}`, restored);
			}
		}

		socket.disconnect();
	}

	console.log(
		failures === 0
			? "\nAll phases passed.\n"
			: `\n${failures} check(s) failed. See the remedy lines above.\n`,
	);
	process.exit(failures === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
	console.error("\nsmoke script crashed:", error instanceof Error ? error.message : error);
	process.exit(1);
});
