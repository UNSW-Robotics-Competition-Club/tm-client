/**
 * The facade most consumers use.
 *
 * Holds one `TmHttpClient` — so the conditional-GET cache and the observed clock
 * skew are shared across every endpoint — and exposes the eight read resources as
 * methods, matching `vex-tm-client`'s call sites so the four projects migrating
 * onto this package do not have to rewrite theirs.
 *
 * `http` is public because the field set socket needs the same signed transport
 * to sign its upgrade.
 */

import type { Result } from "./errors.js";
import type { TmHttpClientOptions } from "./http.js";
import { TmHttpClient } from "./http.js";
import {
	getDivisions,
	getEvent,
	getFields,
	getFieldSets,
	getMatches,
	getRankings,
	getSkills,
	getTeams,
} from "./resources.js";
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

export type TmClientOptions = TmHttpClientOptions;

export class TmClient {
	private readonly transport: TmHttpClient;

	constructor(options: TmClientOptions) {
		this.transport = new TmHttpClient(options);
	}

	/** The signed transport, for the field set socket and for callers needing raw paths. */
	get http(): TmHttpClient {
		return this.transport;
	}

	getEvent(): Promise<Result<EventInfo>> {
		return getEvent(this.transport);
	}

	getDivisions(): Promise<Result<Division[]>> {
		return getDivisions(this.transport);
	}

	getTeams(divisionId?: number): Promise<Result<Team[]>> {
		return getTeams(this.transport, divisionId);
	}

	getMatches(divisionId: number): Promise<Result<Match[]>> {
		return getMatches(this.transport, divisionId);
	}

	getRankings(divisionId: number, round: MatchRound): Promise<Result<Ranking[]>> {
		return getRankings(this.transport, divisionId, round);
	}

	getSkills(): Promise<Result<SkillsRanking[]>> {
		return getSkills(this.transport);
	}

	getFieldSets(): Promise<Result<FieldSetInfo[]>> {
		return getFieldSets(this.transport);
	}

	getFields(fieldSetId: number): Promise<Result<Field[]>> {
		return getFields(this.transport, fieldSetId);
	}
}
