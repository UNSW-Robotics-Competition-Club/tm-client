/**
 * Tests for the mock, not for the client.
 *
 * Everything else in this suite eventually asserts "the client did the right
 * thing" by asking the mock. That is only worth anything if the mock itself is
 * strict — a mock that waves a bad signature through turns every downstream
 * test into a test of nothing. So: prove it accepts a correct signature,
 * rejects a wrong one, answers each scenario with its documented status, and
 * speaks enough RFC 6455 to round trip a command and an event.
 */

import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import { buildAuthHeaders, signTmRequest } from "../../src/signing.js";
import type { Ranking, SkillsRanking } from "../../src/types.js";
import {
	API_KEY,
	CERBERUS_KEY,
	LAST_MODIFIED,
	startMockTmServer,
	type MockScenario,
	type MockTmServer,
} from "../mocks/mock-tm-server.js";

const BUILD = "0.9.0/test";

let servers: MockTmServer[] = [];

async function start(options: Parameters<typeof startMockTmServer>[0] = {}) {
	const server = await startMockTmServer(options);
	servers.push(server);
	return server;
}

afterEach(async () => {
	const open = servers;
	servers = [];
	await Promise.all(open.map((server) => server.close()));
});

async function mintToken(tm: MockTmServer): Promise<string> {
	const response = await fetch(`${tm.url}/v1/token`, {
		method: "POST",
		headers: { Authorization: `Bearer ${CERBERUS_KEY}`, "x-cerberus-build": BUILD },
	});
	const body = (await response.json()) as { access_token?: string; error?: string };
	if (!body.access_token) throw new Error(`token mint failed: ${response.status} ${body.error}`);
	return body.access_token;
}

/** A correctly signed GET, the way the shipped client will make one. */
async function signedGet(
	tm: MockTmServer,
	path: string,
	token: string,
	extra: Record<string, string> = {},
): Promise<Response> {
	const url = new URL(tm.url + path);
	const headers = await buildAuthHeaders(url, { token, apiKey: API_KEY });
	// Host is a forbidden header name in fetch and would be dropped anyway; the
	// transport puts the same authority on the wire, which is what was signed.
	const sendable: Record<string, string> = { ...headers };
	delete sendable["Host"];
	return fetch(url, { headers: { ...sendable, ...extra } });
}

describe("signature validation", () => {
	it("accepts a correctly signed request", async () => {
		const tm = await start();
		const token = await mintToken(tm);

		const response = await signedGet(tm, "/api/event", token);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({ event: { name: expect.any(String) } });
		expect(response.headers.get("last-modified")).toBe(LAST_MODIFIED.toUTCString());
	});

	it("rejects a signature computed with the wrong API key", async () => {
		const tm = await start();
		const token = await mintToken(tm);
		const url = new URL(`${tm.url}/api/event`);
		const tmDate = new Date().toUTCString();

		const response = await fetch(url, {
			headers: {
				Authorization: `Bearer ${token}`,
				"x-tm-date": tmDate,
				"x-tm-signature": await signTmRequest({
					method: "GET",
					url,
					token,
					tmDate,
					apiKey: "WRONGKEY",
				}),
			},
		});

		expect(response.status).toBe(401);
		await expect(response.json()).resolves.toMatchObject({ error: "bad_signature" });
	});

	it("rejects a signature that is missing the trailing newline", async () => {
		// The mistake the whole golden-vector suite exists to catch. If the mock
		// let this through, no downstream test could catch it either.
		const tm = await start();
		const token = await mintToken(tm);
		const url = new URL(`${tm.url}/api/event`);
		const tmDate = new Date().toUTCString();
		const canonical = `GET\n/api/event\ntoken:${token}\nhost:${url.host}\nx-tm-date:${tmDate}\n`;

		const { createHmac } = await import("node:crypto");
		const truncated = createHmac("sha256", API_KEY).update(canonical.slice(0, -1)).digest("hex");

		const response = await fetch(url, {
			headers: {
				Authorization: `Bearer ${token}`,
				"x-tm-date": tmDate,
				"x-tm-signature": truncated,
			},
		});

		expect(response.status).toBe(401);
		await expect(response.json()).resolves.toMatchObject({ error: "bad_signature" });
	});

	it("rejects a request with no auth headers at all", async () => {
		const tm = await start();

		const response = await fetch(`${tm.url}/api/event`);

		expect(response.status).toBe(401);
		await expect(response.json()).resolves.toMatchObject({ error: "missing_token" });
	});

	it("rejects a token this server never issued", async () => {
		const tm = await start();

		const response = await signedGet(tm, "/api/event", "not-a-real-token");

		expect(response.status).toBe(401);
		await expect(response.json()).resolves.toMatchObject({ error: "unknown_token" });
	});

	it("rejects an x-tm-date more than five minutes out", async () => {
		const tm = await start();
		const token = await mintToken(tm);
		const url = new URL(`${tm.url}/api/event`);
		const tmDate = new Date(Date.now() + 10 * 60_000).toUTCString();

		const response = await fetch(url, {
			headers: {
				Authorization: `Bearer ${token}`,
				"x-tm-date": tmDate,
				"x-tm-signature": await signTmRequest({ method: "GET", url, token, tmDate, apiKey: API_KEY }),
			},
		});

		expect(response.status).toBe(401);
		await expect(response.json()).resolves.toMatchObject({ error: "clock_skew" });
	});
});

describe("REST resources", () => {
	it("serves every documented endpoint", async () => {
		const tm = await start();
		const token = await mintToken(tm);

		const paths = [
			"/api/event",
			"/api/divisions",
			"/api/teams",
			"/api/teams/1",
			"/api/matches/1",
			"/api/rankings/1/QUAL",
			"/api/skills",
			"/api/fieldsets",
			"/api/fieldsets/1/fields",
		];

		for (const path of paths) {
			const response = await signedGet(tm, path, token);
			expect(response.status, path).toBe(200);
		}
	});

	it("filters teams by division", async () => {
		const tm = await start();
		const token = await mintToken(tm);

		const response = await signedGet(tm, "/api/teams/2", token);
		const body = (await response.json()) as { teams: { divId: number }[] };

		expect(body.teams.length).toBeGreaterThan(0);
		expect(body.teams.every((t) => t.divId === 2)).toBe(true);
	});

	it("serves rankings in the shape src/types.ts declares", async () => {
		// This fixture was wrong for a while: it carried a top-level `number`,
		// inherited from the obs-plugin mock, which had copied it from the skills
		// shape. Nothing read the field there, so nothing caught it — the CLI
		// found it by throwing on `ranking.alliance.name`. The cast is half the
		// assertion (it fails the build if the fixture loses a declared field);
		// the runtime checks are the other half.
		const tm = await start();
		const token = await mintToken(tm);

		const response = await signedGet(tm, "/api/rankings/1/QUAL", token);
		const body = (await response.json()) as { rankings: Ranking[] };
		const first = body.rankings[0]!;

		expect(first.alliance.teams[0]?.number).toBe("1234A");
		expect(first.alliance.name).toBe("");
		expect(first).not.toHaveProperty("number");
		expect(first.minNumMatches).toBe(true);
	});

	it("serves skills in the shape src/types.ts declares", async () => {
		// The counterpart: skills rankings genuinely DO carry a top-level
		// `number` and no alliance. Pinning both is what keeps the two shapes
		// from being conflated again.
		const tm = await start();
		const token = await mintToken(tm);

		const response = await signedGet(tm, "/api/skills", token);
		const body = (await response.json()) as { skillsRankings: SkillsRanking[] };
		const first = body.skillsRankings[0]!;

		expect(first.number).toBe("1234A");
		expect(first).not.toHaveProperty("alliance");
		expect(first.tie).toBe(false);
	});

	it("404s an unknown resource under /api", async () => {
		const tm = await start();
		const token = await mintToken(tm);

		const response = await signedGet(tm, "/api/nonsense", token);

		expect(response.status).toBe(404);
	});
});

describe("conditional GET", () => {
	it("answers 304 to an If-Modified-Since at or after Last-Modified", async () => {
		const tm = await start();
		const token = await mintToken(tm);

		const first = await signedGet(tm, "/api/event", token);
		const lastModified = first.headers.get("last-modified");
		expect(lastModified).toBe(LAST_MODIFIED.toUTCString());

		const second = await signedGet(tm, "/api/event", token, {
			"If-Modified-Since": lastModified!,
		});

		expect(second.status).toBe(304);
		expect(second.headers.get("last-modified")).toBe(lastModified);
		await expect(second.text()).resolves.toBe("");
	});

	it("answers 200 to an If-Modified-Since from before Last-Modified", async () => {
		const tm = await start();
		const token = await mintToken(tm);

		const response = await signedGet(tm, "/api/event", token, {
			"If-Modified-Since": new Date(LAST_MODIFIED.getTime() - 60_000).toUTCString(),
		});

		expect(response.status).toBe(200);
	});
});

describe("scenarios", () => {
	const tmScenarios: { scenario: MockScenario; status: number; error?: string }[] = [
		{ scenario: "ok", status: 200 },
		{ scenario: "api-disabled", status: 503, error: "service_unavailable" },
		{ scenario: "api-disabled-404", status: 404, error: "not_found" },
		{ scenario: "bad-signature", status: 401, error: "bad_signature" },
		{ scenario: "clock-skew", status: 401, error: "clock_skew" },
	];

	for (const { scenario, status, error } of tmScenarios) {
		it(`"${scenario}" answers /api/event with ${status}`, async () => {
			const tm = await start();
			const token = await mintToken(tm); // minted while still "ok"
			tm.scenario(scenario);

			const response = await signedGet(tm, "/api/event", token);

			expect(response.status).toBe(status);
			if (error) await expect(response.json()).resolves.toMatchObject({ error });
		});
	}

	it('"clock-skew" advertises the server\'s own time in the Date header', async () => {
		// The Date header is the only thing that lets a client tell a skewed clock
		// from a wrong API key, since TM answers both with a bare 401.
		const tm = await start({ scenario: "clock-skew" });
		const token = await mintToken(tm);

		const response = await signedGet(tm, "/api/event", token);
		const advertised = Date.parse(response.headers.get("date") ?? "");

		expect(Number.isNaN(advertised)).toBe(false);
		expect(advertised - Date.now()).toBeGreaterThan(30 * 60_000);
	});

	it('"token-expired" issues a token that is already dead', async () => {
		const tm = await start({ scenario: "token-expired" });

		const mint = await fetch(`${tm.url}/v1/token`, {
			method: "POST",
			headers: { Authorization: `Bearer ${CERBERUS_KEY}`, "x-cerberus-build": BUILD },
		});
		const body = (await mint.json()) as { access_token: string; expires_in: number };
		expect(body.expires_in).toBeLessThan(0);

		const response = await signedGet(tm, "/api/event", body.access_token);

		expect(response.status).toBe(401);
		await expect(response.json()).resolves.toMatchObject({ error: "expired_token" });
	});

	const cerberusScenarios: { scenario: MockScenario; status: number; error: string }[] = [
		{ scenario: "cerberus-invalid-key", status: 401, error: "invalid_client" },
		{ scenario: "cerberus-upgrade-required", status: 426, error: "upgrade_required" },
		{ scenario: "cerberus-rate-limited", status: 429, error: "rate_limited" },
		{ scenario: "cerberus-credentials-invalid", status: 503, error: "credentials_invalid" },
		{ scenario: "cerberus-upstream", status: 502, error: "upstream_error" },
	];

	for (const { scenario, status, error } of cerberusScenarios) {
		it(`"${scenario}" answers /v1/token with ${status} ${error}`, async () => {
			const tm = await start({ scenario });

			const response = await fetch(`${tm.url}/v1/token`, {
				method: "POST",
				headers: { Authorization: `Bearer ${CERBERUS_KEY}`, "x-cerberus-build": BUILD },
			});

			expect(response.status).toBe(status);
			await expect(response.json()).resolves.toMatchObject({ error });
		});
	}

	it("mints a bearer for a good key and refuses a bad one", async () => {
		const tm = await start();

		const good = await fetch(`${tm.url}/v1/token`, {
			method: "POST",
			headers: { Authorization: `Bearer ${CERBERUS_KEY}`, "x-cerberus-build": BUILD },
		});
		expect(good.status).toBe(200);
		await expect(good.json()).resolves.toMatchObject({ token_type: "Bearer", expires_in: 7200 });

		const bad = await fetch(`${tm.url}/v1/token`, {
			method: "POST",
			headers: { Authorization: "Bearer ctm_wrong", "x-cerberus-build": BUILD },
		});
		expect(bad.status).toBe(401);
	});

	it("refuses a build header it cannot read", async () => {
		const tm = await start();

		const response = await fetch(`${tm.url}/v1/token`, {
			method: "POST",
			headers: { Authorization: `Bearer ${CERBERUS_KEY}` },
		});

		expect(response.status).toBe(426);
	});
});

describe("refuse / allow", () => {
	it("overrides the scenario for both endpoints, then releases", async () => {
		const tm = await start();
		const token = await mintToken(tm);

		tm.refuse(500, "boom", "forced");
		expect((await signedGet(tm, "/api/event", token)).status).toBe(500);
		expect(
			(
				await fetch(`${tm.url}/v1/token`, {
					method: "POST",
					headers: { Authorization: `Bearer ${CERBERUS_KEY}`, "x-cerberus-build": BUILD },
				})
			).status,
		).toBe(500);

		tm.allow();
		expect((await signedGet(tm, "/api/event", token)).status).toBe(200);
	});

	it("can be scoped to the token endpoint alone", async () => {
		const tm = await start();
		const token = await mintToken(tm);

		tm.refuse(429, "rate_limited", "slow down", "token");

		expect((await signedGet(tm, "/api/event", token)).status).toBe(200);
		expect(
			(
				await fetch(`${tm.url}/v1/token`, {
					method: "POST",
					headers: { Authorization: `Bearer ${CERBERUS_KEY}`, "x-cerberus-build": BUILD },
				})
			).status,
		).toBe(429);
	});
});

// ---------------------------------------------------------------------------
// Field set websocket
// ---------------------------------------------------------------------------

async function openFieldSetSocket(tm: MockTmServer, fieldSetId: number): Promise<WebSocket> {
	const token = await mintToken(tm);
	// Signed against the http form of the same URL — that is what TM hashes.
	const url = new URL(`${tm.url}/api/fieldsets/${fieldSetId}`);
	const headers = await buildAuthHeaders(url, { token, apiKey: API_KEY });

	// Spread rather than passed straight through: `ws` wants an index-signature
	// header bag and `AuthHeaders` is a closed interface.
	return new WebSocket(`${tm.wsUrl}/api/fieldsets/${fieldSetId}`, { headers: { ...headers } });
}

function onceOpen(socket: WebSocket): Promise<void> {
	// Check the state before listening. Callers routinely await something else
	// between constructing a socket and getting here — opening a second socket
	// mints another token, which is a full HTTP round trip — and a `once`
	// listener attached after "open" has already fired waits forever, surfacing
	// as an unexplained test timeout rather than a connection failure.
	//
	// The mock's own waitForClient is guarded the same way and says so; this
	// helper was the one that was not, and it flaked on CI where the mint is
	// slow relative to the handshake.
	if (socket.readyState === WebSocket.OPEN) return Promise.resolve();
	if (socket.readyState === WebSocket.CLOSING || socket.readyState === WebSocket.CLOSED) {
		return Promise.reject(new Error("socket closed before it was awaited"));
	}
	return new Promise((resolve, reject) => {
		socket.once("open", () => resolve());
		socket.once("error", reject);
	});
}

function nextMessage(socket: WebSocket): Promise<unknown> {
	return new Promise((resolve, reject) => {
		socket.once("message", (data: Buffer) => resolve(JSON.parse(data.toString("utf8"))));
		socket.once("error", reject);
	});
}

describe("field set websocket", () => {
	it("accepts a signed upgrade", async () => {
		const tm = await start();
		const socket = await openFieldSetSocket(tm, 1);

		await onceOpen(socket);
		await tm.waitForClient(1);

		expect(tm.clientCount(1)).toBe(1);
		expect(tm.connectionCount(1)).toBe(1);

		socket.close();
	});

	it("refuses an unsigned upgrade", async () => {
		const tm = await start();
		const socket = new WebSocket(`${tm.wsUrl}/api/fieldsets/1`);

		await expect(onceOpen(socket)).rejects.toThrow(/401/);
		expect(tm.connectionCount(1)).toBe(0);
	});

	it("refuses an upgrade signed with the wrong API key", async () => {
		const tm = await start();
		const token = await mintToken(tm);
		const url = new URL(`${tm.url}/api/fieldsets/1`);
		const tmDate = new Date().toUTCString();

		const socket = new WebSocket(`${tm.wsUrl}/api/fieldsets/1`, {
			headers: {
				Authorization: `Bearer ${token}`,
				"x-tm-date": tmDate,
				"x-tm-signature": await signTmRequest({
					method: "GET",
					url,
					token,
					tmDate,
					apiKey: "WRONGKEY",
				}),
			},
		});

		await expect(onceOpen(socket)).rejects.toThrow(/401/);
		expect(tm.connectionCount(1)).toBe(0);
	});

	it("404s an unknown field set", async () => {
		const tm = await start();
		const socket = await openFieldSetSocket(tm, 99);

		await expect(onceOpen(socket)).rejects.toThrow(/404/);
	});

	it("round trips an injected event and a sent command", async () => {
		const tm = await start();
		const socket = await openFieldSetSocket(tm, 1);
		await onceOpen(socket);
		await tm.waitForClient(1);

		const received = nextMessage(socket);
		expect(tm.emit(1, { type: "matchStarted", fieldID: 1 })).toBe(1);
		await expect(received).resolves.toEqual({ type: "matchStarted", fieldID: 1 });

		socket.send(JSON.stringify({ cmd: "start", fieldID: 1 }));
		await expect.poll(() => tm.commands.length).toBe(1);
		expect(tm.commands[0]).toMatchObject({ fieldSetId: 1, command: { cmd: "start", fieldID: 1 } });

		socket.close();
	});

	it("broadcasts a display change back, as TM does", async () => {
		const tm = await start();
		const socket = await openFieldSetSocket(tm, 1);
		await onceOpen(socket);
		await tm.waitForClient(1);

		const received = nextMessage(socket);
		socket.send(JSON.stringify({ cmd: "setAudienceDisplay", display: "INTRO" }));

		await expect(received).resolves.toEqual({ type: "audienceDisplayChanged", display: "INTRO" });

		socket.close();
	});

	it("routes events per field set", async () => {
		const tm = await start();
		// Opened together rather than one after the other: sequentially, the
		// second mint gives the first socket time to finish connecting before
		// anything is listening for it.
		const [one, two] = await Promise.all([
			openFieldSetSocket(tm, 1),
			openFieldSetSocket(tm, 2),
		]);
		await Promise.all([onceOpen(one), onceOpen(two)]);
		await Promise.all([tm.waitForClient(1), tm.waitForClient(2)]);

		expect(tm.emit(1, { type: "fieldActivated", fieldID: 1 })).toBe(1);
		expect(tm.clientCount()).toBe(2);

		one.close();
		two.close();
	});

	it("dropAll yanks the connection without a close frame", async () => {
		const tm = await start();
		const socket = await openFieldSetSocket(tm, 1);
		await onceOpen(socket);
		await tm.waitForClient(1);

		const closed = new Promise<{ code: number }>((resolve) =>
			socket.once("close", (code: number) => resolve({ code })),
		);
		tm.dropAll();

		// 1006 is "abnormal closure": no close frame was ever seen. That is the
		// distinction reconnect logic is being tested against.
		await expect(closed).resolves.toMatchObject({ code: 1006 });
		expect(tm.clientCount()).toBe(0);
	});

	it("closeAll shuts down gracefully", async () => {
		const tm = await start();
		const socket = await openFieldSetSocket(tm, 1);
		await onceOpen(socket);
		await tm.waitForClient(1);

		const closed = new Promise<number>((resolve) => socket.once("close", resolve));
		tm.closeAll();

		await expect(closed).resolves.not.toBe(1006);
		expect(tm.clientCount()).toBe(0);
	});

	it("counts reconnects", async () => {
		const tm = await start();

		const first = await openFieldSetSocket(tm, 1);
		await onceOpen(first);
		await tm.waitForClient(1);
		tm.dropAll();

		const second = await openFieldSetSocket(tm, 1);
		await onceOpen(second);
		await tm.waitForClient(1);

		expect(tm.connectionCount(1)).toBe(2);

		second.close();
	});

	it("refuses the upgrade when the Local API is disabled", async () => {
		const tm = await start({ scenario: "api-disabled" });
		const socket = await openFieldSetSocket(tm, 1);

		await expect(onceOpen(socket)).rejects.toThrow(/503/);
	});
});

describe("request recording", () => {
	it("records requests and upgrades with their headers", async () => {
		const tm = await start();
		const token = await mintToken(tm);
		await signedGet(tm, "/api/event", token);

		const mint = tm.requests.find((r) => r.path === "/v1/token");
		const get = tm.requests.find((r) => r.path === "/api/event");

		expect(mint).toMatchObject({ method: "POST", upgrade: false });
		expect(get?.headers["x-tm-signature"]).toMatch(/^[0-9a-f]{64}$/);
	});
});
