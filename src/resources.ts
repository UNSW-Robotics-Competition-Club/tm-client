/**
 * The eight read endpoints of the TM Public API.
 *
 * Free functions over `TmHttpClient` rather than methods on it, so the transport
 * stays testable without a resource in sight and a consumer can tree-shake the
 * endpoints it never calls. `TmClient` re-exposes all eight as methods for
 * call-site parity with `vex-tm-client`.
 *
 * Every response is wrapped in a single-key envelope (`{ "event": {...} }`), and
 * every function here unwraps it. A missing or wrong-typed key is reported as
 * `malformed_response` rather than handed on as `undefined`: TM version drift is
 * the usual cause, and a caller that gets `undefined` from a typed field finds
 * out about it somewhere far less useful.
 */

import type { Result } from "./errors.js";
import { err, ok } from "./errors.js";
import type { TmHttpClient } from "./http.js";
import type {
	Division,
	EventInfo,
	Field,
	FieldSetInfo,
	Match,
	MatchRound,
	Ranking,
	SkillsRanking,
	Team,
} from "./types.js";

function envelopeValue(body: unknown, key: string): unknown {
	if (typeof body !== "object" || body === null) return undefined;
	return (body as Record<string, unknown>)[key];
}

/** Unwrap `{ [key]: {...} }`. Preserves the `cached` flag from the transport. */
function expectObject<T>(result: Result<unknown>, key: string): Result<T> {
	if (!result.ok) return result;

	const value = envelopeValue(result.data, key);
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return err<T>("malformed_response", `TM's response has no "${key}" object.`, {
			detail: result.data,
		});
	}
	return ok(value as T, result.cached);
}

/** Unwrap `{ [key]: [...] }`. Preserves the `cached` flag from the transport. */
function expectArray<T>(result: Result<unknown>, key: string): Result<T[]> {
	if (!result.ok) return result;

	const value = envelopeValue(result.data, key);
	if (!Array.isArray(value)) {
		return err<T[]>("malformed_response", `TM's response has no "${key}" array.`, {
			detail: result.data,
		});
	}
	return ok(value as T[], result.cached);
}

export async function getEvent(http: TmHttpClient): Promise<Result<EventInfo>> {
	return expectObject<EventInfo>(await http.get<unknown>("/api/event"), "event");
}

export async function getDivisions(http: TmHttpClient): Promise<Result<Division[]>> {
	return expectArray<Division>(await http.get<unknown>("/api/divisions"), "divisions");
}

/** Every team at the event, or only those in one division. */
export async function getTeams(
	http: TmHttpClient,
	divisionId?: number,
): Promise<Result<Team[]>> {
	const path = divisionId === undefined ? "/api/teams" : `/api/teams/${divisionId}`;
	return expectArray<Team>(await http.get<unknown>(path), "teams");
}

export async function getMatches(
	http: TmHttpClient,
	divisionId: number,
): Promise<Result<Match[]>> {
	return expectArray<Match>(await http.get<unknown>(`/api/matches/${divisionId}`), "matches");
}

export async function getRankings(
	http: TmHttpClient,
	divisionId: number,
	round: MatchRound,
): Promise<Result<Ranking[]>> {
	return expectArray<Ranking>(
		await http.get<unknown>(`/api/rankings/${divisionId}/${round}`),
		"rankings",
	);
}

export async function getSkills(http: TmHttpClient): Promise<Result<SkillsRanking[]>> {
	// Note the envelope key: `skillsRankings`, not `skills`.
	return expectArray<SkillsRanking>(await http.get<unknown>("/api/skills"), "skillsRankings");
}

export async function getFieldSets(http: TmHttpClient): Promise<Result<FieldSetInfo[]>> {
	// Note the envelope key: TM spells the path `fieldsets` but the body `fieldSets`.
	return expectArray<FieldSetInfo>(await http.get<unknown>("/api/fieldsets"), "fieldSets");
}

export async function getFields(
	http: TmHttpClient,
	fieldSetId: number,
): Promise<Result<Field[]>> {
	return expectArray<Field>(
		await http.get<unknown>(`/api/fieldsets/${fieldSetId}/fields`),
		"fields",
	);
}
