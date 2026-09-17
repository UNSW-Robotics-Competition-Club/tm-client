import { describe, expect, it } from "vitest";

import type { AuthProvider, BearerToken } from "../../src/auth/types.js";
import { TmClient } from "../../src/client.js";
import { ok } from "../../src/errors.js";
import { TmHttpClient } from "../../src/http.js";
import {
	getDivisions,
	getEvent,
	getFields,
	getFieldSets,
	getMatches,
	getRankings,
	getSkills,
	getTeams,
} from "../../src/resources.js";
import { MatchRound } from "../../src/types.js";

const BASE_URL = "http://127.0.0.1:8080";

const staticAuth: AuthProvider = {
	async getBearer() {
		return ok<BearerToken>({ access_token: "t", token_type: "Bearer", expires_in: 3600 });
	},
	invalidate() {},
};

interface Harness {
	http: TmHttpClient;
	client: TmClient;
	paths: string[];
}

/** Answers every request with the same body, recording the path that was asked for. */
function harness(
	body: unknown,
	init: { status?: number; headers?: Record<string, string>; raw?: string } = {},
): Harness {
	const paths: string[] = [];
	const fetchImpl = (async (input: unknown): Promise<Response> => {
		const url = input instanceof URL ? input : new URL(String(input));
		paths.push(url.pathname);
		return new Response(init.raw ?? JSON.stringify(body), {
			status: init.status ?? 200,
			headers: { "Content-Type": "application/json", ...init.headers },
		});
	}) as unknown as typeof fetch;

	const options = { baseUrl: BASE_URL, apiKey: "k", auth: staticAuth, fetch: fetchImpl };
	return { http: new TmHttpClient(options), client: new TmClient(options), paths };
}

describe("resource endpoints", () => {
	it("getEvent hits /api/event and unwraps `event`", async () => {
		const event = { name: "Scrimmage", code: "RE-VRC-26-1234" };
		const h = harness({ event });

		const result = await getEvent(h.http);

		expect(h.paths).toEqual(["/api/event"]);
		expect(result).toEqual({ ok: true, data: event, cached: false });
	});

	it("getDivisions hits /api/divisions and unwraps `divisions`", async () => {
		const divisions = [{ id: 1, name: "Division A" }];
		const h = harness({ divisions });

		const result = await getDivisions(h.http);

		expect(h.paths).toEqual(["/api/divisions"]);
		expect(result).toEqual({ ok: true, data: divisions, cached: false });
	});

	it("getTeams without a division hits /api/teams", async () => {
		const h = harness({ teams: [{ number: "1234A" }] });

		const result = await getTeams(h.http);

		expect(h.paths).toEqual(["/api/teams"]);
		expect(result.ok).toBe(true);
	});

	it("getTeams with a division hits /api/teams/{divisionId}", async () => {
		const h = harness({ teams: [] });

		await getTeams(h.http, 2);

		expect(h.paths).toEqual(["/api/teams/2"]);
	});

	it("getMatches hits /api/matches/{divisionId} and unwraps `matches`", async () => {
		const matches = [{ winningAlliance: -1 }];
		const h = harness({ matches });

		const result = await getMatches(h.http, 3);

		expect(h.paths).toEqual(["/api/matches/3"]);
		expect(result).toEqual({ ok: true, data: matches, cached: false });
	});

	it("getRankings hits /api/rankings/{divisionId}/{round} and unwraps `rankings`", async () => {
		const rankings = [{ rank: 1 }];
		const h = harness({ rankings });

		const result = await getRankings(h.http, 1, MatchRound.Qualification);

		expect(h.paths).toEqual(["/api/rankings/1/QUAL"]);
		expect(result).toEqual({ ok: true, data: rankings, cached: false });
	});

	it("getSkills hits /api/skills and unwraps `skillsRankings`", async () => {
		const skillsRankings = [{ rank: 1, number: "1234A" }];
		const h = harness({ skillsRankings });

		const result = await getSkills(h.http);

		expect(h.paths).toEqual(["/api/skills"]);
		expect(result).toEqual({ ok: true, data: skillsRankings, cached: false });
	});

	it("getFieldSets hits /api/fieldsets and unwraps `fieldSets`", async () => {
		const fieldSets = [{ id: 1, name: "Field Set 1" }];
		const h = harness({ fieldSets });

		const result = await getFieldSets(h.http);

		expect(h.paths).toEqual(["/api/fieldsets"]);
		expect(result).toEqual({ ok: true, data: fieldSets, cached: false });
	});

	it("getFields hits /api/fieldsets/{id}/fields and unwraps `fields`", async () => {
		const fields = [{ id: 1, name: "Field 1" }];
		const h = harness({ fields });

		const result = await getFields(h.http, 4);

		expect(h.paths).toEqual(["/api/fieldsets/4/fields"]);
		expect(result).toEqual({ ok: true, data: fields, cached: false });
	});
});

describe("envelope validation", () => {
	it("reports a missing key as malformed rather than passing undefined on", async () => {
		const h = harness({ divisions: [] });

		const result = await getEvent(h.http);

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("malformed_response");
		expect(result.error.message).toContain('"event"');
	});

	it("rejects an array where an object is expected", async () => {
		const h = harness({ event: [] });

		const result = await getEvent(h.http);

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("malformed_response");
	});

	it("rejects an object where an array is expected", async () => {
		const h = harness({ teams: { number: "1234A" } });

		const result = await getTeams(h.http);

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("malformed_response");
	});

	it("rejects a body that is not an object at all", async () => {
		const h = harness(null, { raw: "[1,2,3]" });

		const result = await getEvent(h.http);

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("malformed_response");
	});

	it("passes a transport failure through instead of relabelling it malformed", async () => {
		const h = harness({}, { status: 503, raw: "{}" });

		const result = await getDivisions(h.http);

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("local_api_disabled");
	});

	it("preserves the cached flag through unwrapping", async () => {
		const paths: string[] = [];
		let call = 0;
		const fetchImpl = (async (input: unknown): Promise<Response> => {
			const url = input instanceof URL ? input : new URL(String(input));
			paths.push(url.pathname);
			call += 1;
			if (call === 1) {
				return new Response(JSON.stringify({ divisions: [{ id: 1, name: "A" }] }), {
					status: 200,
					headers: { "Last-Modified": "Tue, 11 Aug 2026 03:00:00 GMT" },
				});
			}
			return new Response(null, { status: 304 });
		}) as unknown as typeof fetch;

		const http = new TmHttpClient({
			baseUrl: BASE_URL,
			apiKey: "k",
			auth: staticAuth,
			fetch: fetchImpl,
		});

		await getDivisions(http);
		const second = await getDivisions(http);

		expect(second).toEqual({ ok: true, data: [{ id: 1, name: "A" }], cached: true });
	});
});

describe("TmClient facade", () => {
	it("routes each method to the matching resource over one shared transport", async () => {
		const h = harness({
			event: { name: "Scrimmage", code: "RE-VRC-26-1234" },
			divisions: [],
			teams: [],
			matches: [],
			rankings: [],
			skillsRankings: [],
			fieldSets: [],
			fields: [],
		});

		await h.client.getEvent();
		await h.client.getDivisions();
		await h.client.getTeams();
		await h.client.getTeams(2);
		await h.client.getMatches(3);
		await h.client.getRankings(1, MatchRound.Final);
		await h.client.getSkills();
		await h.client.getFieldSets();
		await h.client.getFields(4);

		expect(h.paths).toEqual([
			"/api/event",
			"/api/divisions",
			"/api/teams",
			"/api/teams/2",
			"/api/matches/3",
			"/api/rankings/1/F",
			"/api/skills",
			"/api/fieldsets",
			"/api/fieldsets/4/fields",
		]);
	});

	it("exposes the transport for the field set socket to sign with", async () => {
		const h = harness({ event: {} });

		expect(h.client.http).toBeInstanceOf(TmHttpClient);
		expect(h.client.http.resolve("/api/event").toString()).toBe("http://127.0.0.1:8080/api/event");
	});
});
