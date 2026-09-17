/**
 * The whole package against a real server.
 *
 * Every other suite injects a stub `fetch` or a fake socket, which is the right
 * way to test a branch but leaves one thing unproven: that the pieces agree with
 * each other and with a server that actually validates signatures. This suite
 * wires the real Cerberus provider to the real HTTP client to the real websocket
 * over real TCP, and the mock refuses anything it cannot verify — so a signing
 * regression, a header that silently went missing, or a URL built with the port
 * dropped fails here even when every unit test still passes.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createCerberusAuth } from "../../src/auth/cerberus.js";
import { TmClient } from "../../src/client.js";
import { FieldsetSocket } from "../../src/fieldset-socket.js";
import { FieldsetActiveMatchType, FieldsetAudienceDisplay, MatchRound } from "../../src/types.js";
import { createNodeWebSocketFactory } from "../../src/ws/node.js";
import {
	API_KEY,
	CERBERUS_KEY,
	MIN_BUILD,
	matchCycle,
	startMockTmServer,
	type MockTmServer,
} from "../mocks/mock-tm-server.js";

let tm: MockTmServer;

function makeClient(): TmClient {
	return new TmClient({
		baseUrl: tm.url,
		apiKey: API_KEY,
		auth: createCerberusAuth({
			endpoint: tm.url,
			apiKey: CERBERUS_KEY,
			build: { version: MIN_BUILD },
		}),
	});
}

beforeAll(async () => {
	tm = await startMockTmServer();
});

afterAll(async () => {
	await tm.close();
});

beforeEach(() => {
	tm.scenario("ok");
	tm.allow();
});

describe("REST, end to end", () => {
	it("reads every resource through a signed, brokered request", async () => {
		const client = makeClient();

		const event = await client.getEvent();
		expect(event.ok).toBe(true);

		const divisions = await client.getDivisions();
		expect(divisions.ok && divisions.data.length).toBeGreaterThan(0);

		const teams = await client.getTeams();
		expect(teams.ok).toBe(true);

		const fieldSets = await client.getFieldSets();
		expect(fieldSets.ok && fieldSets.data.length).toBeGreaterThan(0);

		if (!divisions.ok || !fieldSets.ok) throw new Error("unreachable");

		const divisionId = divisions.data[0]!.id;
		expect((await client.getTeams(divisionId)).ok).toBe(true);
		expect((await client.getMatches(divisionId)).ok).toBe(true);
		expect((await client.getRankings(divisionId, MatchRound.Qualification)).ok).toBe(true);
		expect((await client.getSkills()).ok).toBe(true);
		expect((await client.getFields(fieldSets.data[0]!.id)).ok).toBe(true);
	});

	it("mints one bearer for many requests", async () => {
		const before = tm.requests.filter((r) => r.path === "/v1/token").length;
		const client = makeClient();

		await Promise.all([client.getEvent(), client.getDivisions(), client.getSkills()]);
		await client.getTeams();

		const minted = tm.requests.filter((r) => r.path === "/v1/token").length - before;
		// Four requests, three of them concurrent from a cold cache. Without the
		// single-flight memo this is 3; without caching at all it is 4.
		expect(minted).toBe(1);
	});

	it("serves a 304 from cache on the second read", async () => {
		const client = makeClient();

		const first = await client.getEvent();
		expect(first.ok && first.cached).toBe(false);

		const second = await client.getEvent();
		expect(second.ok && second.cached).toBe(true);
		expect(second.ok && second.data).toEqual(first.ok ? first.data : null);
	});

	it("names a disabled Local API rather than a bare HTTP error", async () => {
		tm.scenario("api-disabled");
		const result = await makeClient().getEvent();

		expect(result.ok).toBe(false);
		expect(!result.ok && result.error.code).toBe("local_api_disabled");
	});

	it("tells a bad signature apart from a skewed clock", async () => {
		tm.scenario("bad-signature");
		const badSignature = await makeClient().getEvent();
		expect(!badSignature.ok && badSignature.error.code).toBe("invalid_signature");

		tm.scenario("clock-skew");
		const skewed = await makeClient().getEvent();
		expect(!skewed.ok && skewed.error.code).toBe("clock_skew");
	});

	it("re-mints after TM rejects the token, instead of retrying a dead one", async () => {
		const client = makeClient();
		expect((await client.getEvent()).ok).toBe(true);

		const beforeRetry = tm.requests.filter((r) => r.path === "/v1/token").length;
		tm.scenario("bad-signature");
		await client.getEvent();
		tm.scenario("ok");
		expect((await client.getEvent()).ok).toBe(true);

		const minted = tm.requests.filter((r) => r.path === "/v1/token").length - beforeRetry;
		// The surviving upstream leaves the rejected bearer cached for up to an
		// hour, so this would be 0 there. Fixing it is a stated goal of the package.
		expect(minted).toBeGreaterThanOrEqual(1);
	});
});

describe("field set websocket, end to end", () => {
	it("opens a signed socket, follows a match cycle, and sends commands", async () => {
		const client = makeClient();
		const socket = new FieldsetSocket({
			http: client.http,
			fieldSetId: 1,
			webSocketFactory: await createNodeWebSocketFactory(),
		});

		const seen: string[] = [];
		socket.addEventListener("message", (e) => {
			seen.push((e as CustomEvent).detail.type);
		});

		const opened = await socket.connect();
		expect(opened.ok).toBe(true);
		await tm.waitForClient(1);

		for (const event of matchCycle({ fieldId: 1, matchNumber: 7 })) tm.emit(1, event);
		await new Promise((r) => setTimeout(r, 50));

		expect(seen).toContain("fieldMatchAssigned");
		expect(seen).toContain("matchStarted");
		expect(socket.state.match.type).toBe(FieldsetActiveMatchType.Match);
		expect(socket.state.audienceDisplay).toBe(FieldsetAudienceDisplay.SavedMatchResults);

		const before = tm.commands.length;
		expect((await socket.queueNextMatch()).ok).toBe(true);
		expect((await socket.setAudienceDisplay(FieldsetAudienceDisplay.Rankings)).ok).toBe(true);
		await new Promise((r) => setTimeout(r, 50));

		const sent = tm.commands.slice(before).map((c) => c.command);
		expect(sent).toEqual([
			{ cmd: "queueNextMatch" },
			{ cmd: "setAudienceDisplay", display: "RANKINGS" },
		]);

		socket.disconnect();
	});

	it("reconnects after the connection is yanked", async () => {
		const client = makeClient();
		const socket = new FieldsetSocket({
			http: client.http,
			fieldSetId: 2,
			webSocketFactory: await createNodeWebSocketFactory(),
			// Short ladder so the test does not sit through the real one.
			backoffMs: [10, 20],
			healthyMs: 10_000,
		});

		expect((await socket.connect()).ok).toBe(true);
		await tm.waitForClient(2);
		expect(tm.connectionCount(2)).toBe(1);

		// Ungraceful: no close frame, exactly what a slept laptop looks like.
		tm.dropAll(2);
		await tm.waitForClient(2, 5_000);

		expect(tm.connectionCount(2)).toBeGreaterThanOrEqual(2);
		socket.disconnect();
	});
});
