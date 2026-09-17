/**
 * Wire types for TM entities.
 *
 * Ported from vex-tm-client's `Team.ts`, `Match.ts`, `Ranking.ts` and
 * `Fieldset.ts` — the three surviving vendored copies agree byte-for-byte, so
 * there was nothing to reconcile. Two deliberate divergences from upstream are
 * marked below where upstream contradicts the published API guide.
 */

// ---------------------------------------------------------------------------
// Event, divisions, teams

export interface EventInfo {
	name: string;
	/** The VEX Events SKU, when the event has one configured. */
	code: string;
}

export interface Division {
	id: number;
	name: string;
}

export enum AgeGroup {
	HighSchool = "HIGH_SCHOOL",
	MiddleSchool = "MIDDLE_SCHOOL",
	ElementarySchool = "ELEMENTARY_SCHOOL",
	College = "COLLEGE",
}

export interface Team {
	number: string;
	name: string;
	/** @deprecated The guide says this is not generally used and may be removed. */
	shortName: string;
	/** @deprecated The guide says this is not generally used and may be removed. */
	sponsors: string;
	/** The guide notes this may be renamed to `organization` in a future TM release. */
	school: string;
	/** The guide notes city/state/country may be merged into a single `location` field. */
	city: string;
	state: string;
	country: string;
	ageGroup: AgeGroup;
	divId: number;
	checkedIn: boolean;
}

// ---------------------------------------------------------------------------
// Matches

export enum MatchState {
	Unplayed = "UNPLAYED",
	Scored = "SCORED",
}

export enum MatchRound {
	None = "NONE",
	Practice = "PRACTICE",
	Qualification = "QUAL",
	Quarterfinal = "QF",
	Semifinal = "SF",
	Final = "F",
	RoundOf16 = "R16",
	RoundOf32 = "R32",
	RoundOf64 = "R64",
	RoundOf128 = "R128",
	TopN = "TOP_N",
	RoundRobin = "ROUND_ROBIN",
	Skills = "SKILLS",
	Timeout = "TIMEOUT",
}

export interface MatchAlliance {
	teams: { number: string }[];
}

export interface MatchTuple<R extends MatchRound = MatchRound> {
	session: number;
	division: number;
	round: R;
	instance: number;
	match: number;
}

export interface Match {
	/** 0 red, 1 blue; -1 when no winner is recorded. */
	winningAlliance: number;
	finalScore: number[];
	matchInfo: {
		timeScheduled: number;
		state: MatchState;
		alliances: MatchAlliance[];
		matchTuple: MatchTuple;
	};
}

// ---------------------------------------------------------------------------
// Rankings and skills

export interface RankAlliance {
	name: string;
	teams: { number: string }[];
}

export interface Ranking {
	rank: number;
	/** True when this rank is shared with at least one other alliance. */
	tied: boolean;
	/**
	 * Diverges from vex-tm-client, which typed this `RankAlliance[]`. The API
	 * guide shows a single object and TM sends one; upstream's array type was
	 * never exercised because no vendored copy actually read the field.
	 */
	alliance: RankAlliance;
	wins: number;
	losses: number;
	ties: number;
	wp: number;
	ap: number;
	sp: number;
	avgPoints: number;
	totalPoints: number;
	highScore: number;
	numMatches: number;
	minNumMatches: boolean;
}

export interface SkillsRanking {
	rank: number;
	/** True when this rank is shared with at least one other team. */
	tie: boolean;
	number: string;
	totalScore: number;
	progHighScore: number;
	progAttempts: number;
	driverHighScore: number;
	driverAttempts: number;
}

// ---------------------------------------------------------------------------
// Field sets and fields

export interface FieldSetInfo {
	id: number;
	name: string;
}

export interface Field {
	id: number;
	name: string;
}

// ---------------------------------------------------------------------------
// Field set websocket events

export enum FieldsetAudienceDisplay {
	Blank = "BLANK",
	Logo = "LOGO",
	Intro = "INTRO",
	InMatch = "IN_MATCH",
	SavedMatchResults = "RESULTS",
	Schedule = "SCHEDULE",
	Rankings = "RANKINGS",
	SkillsRankings = "SC_RANKINGS",
	AllianceSelection = "ALLIANCE_SELECTION",
	ElimBracket = "BRACKET",
	Slides = "AWARD",
	Inspection = "INSPECTION",
}

/**
 * Note the capitalisation: TM spells it `fieldID`, not `fieldId`. These are wire
 * shapes, so they use TM's spelling rather than ours.
 *
 * A TIMEOUT arrives as a `fieldMatchAssigned` whose `match` object is EMPTY.
 * There is no type tag for it — see `reduceFieldsetState`.
 *
 * `fieldID` is nullable because TM's "nothing is queued" case is an empty match
 * object AND a null field. vex-tm-client checked for that null at runtime while
 * typing the field `number`, so every consumer of that type was one real event
 * away from a crash the compiler had promised could not happen.
 */
export interface FieldsetEventFieldMatchAssigned {
	readonly type: "fieldMatchAssigned";
	fieldID: number | null;
	match: MatchTuple | Record<string, never>;
}

export interface FieldsetEventFieldActivated {
	readonly type: "fieldActivated";
	fieldID: number;
}

export interface FieldsetEventMatchStarted {
	readonly type: "matchStarted";
	fieldID: number;
}

export interface FieldsetEventMatchStopped {
	readonly type: "matchStopped";
	fieldID: number;
}

export interface FieldsetEventAudienceDisplayChanged {
	readonly type: "audienceDisplayChanged";
	display: FieldsetAudienceDisplay;
}

export type FieldsetEvent =
	| FieldsetEventFieldMatchAssigned
	| FieldsetEventFieldActivated
	| FieldsetEventMatchStarted
	| FieldsetEventMatchStopped
	| FieldsetEventAudienceDisplayChanged;

export type FieldsetEventType = FieldsetEvent["type"];

// ---------------------------------------------------------------------------
// Field set websocket commands

export enum FieldsetQueueSkillsType {
	Programming = 1,
	Driver = 2,
}

export type FieldsetCommand =
	| { cmd: "start"; fieldID: number }
	| { cmd: "endEarly"; fieldID: number }
	| { cmd: "abort"; fieldID: number }
	| { cmd: "reset"; fieldID: number }
	| { cmd: "queuePrevMatch" }
	| { cmd: "queueNextMatch" }
	| { cmd: "queueSkills"; skillsID: FieldsetQueueSkillsType }
	| { cmd: "setAudienceDisplay"; display: FieldsetAudienceDisplay };

export type FieldsetCommandType = FieldsetCommand["cmd"];

// ---------------------------------------------------------------------------
// Derived field set state

export enum FieldsetActiveMatchType {
	None = "NONE",
	Timeout = "TIMEOUT",
	Match = "MATCH",
}

export enum FieldsetQueueState {
	Unplayed = "UNPLAYED",
	Running = "RUNNING",
	Stopped = "STOPPED",
}

export type FieldsetMatch =
	| { type: FieldsetActiveMatchType.None }
	| {
			type: FieldsetActiveMatchType.Timeout;
			state: FieldsetQueueState;
			fieldID: number;
			active: boolean;
	  }
	| {
			type: FieldsetActiveMatchType.Match;
			state: FieldsetQueueState;
			match: MatchTuple;
			fieldID: number;
			active: boolean;
	  };

export interface FieldsetState {
	match: FieldsetMatch;
	audienceDisplay: FieldsetAudienceDisplay;
}
