/**
 * The eight read-only resource commands.
 *
 * Column choices favour what an operator actually scans for at a venue — team
 * numbers, match identifiers, ranks — over completeness. Anything omitted is one
 * `--json` away, and `--json` emits the unwrapped payload verbatim so a script
 * never has to parse a table.
 */

import type { Command } from "commander";
import { MatchRound, type Match, type MatchTuple, type Team } from "../../types.js";
import { TmConfigError } from "../../errors.js";
import type { Column } from "../output.js";
import { requireInteger, unwrap, type GlobalOptions, type Run } from "./context.js";

/**
 * TM reports schedule times as epoch SECONDS. Rendered in local time, without a
 * zone suffix, because the only clock that matters at a venue is the one on the
 * wall next to the field.
 */
function formatScheduled(seconds: number): string {
	if (!Number.isFinite(seconds) || seconds <= 0) return "—";
	const date = new Date(seconds * 1000);
	const pad = (value: number): string => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * `QUAL 12`, or `QF 2-1` when the round runs multiple instances. TM's own
 * display drops the instance for the single-instance rounds, so showing it
 * always would read as noise for the qualification matches that dominate a day.
 */
export function formatMatchTuple(tuple: MatchTuple): string {
	return tuple.instance > 1
		? `${tuple.round} ${tuple.instance}-${tuple.match}`
		: `${tuple.round} ${tuple.match}`;
}

function allianceTeams(match: Match, index: number): string {
	return (match.matchInfo.alliances[index]?.teams ?? []).map((team) => team.number).join(" ");
}

function allianceScore(match: Match, index: number): string {
	const score = match.finalScore[index];
	return score === undefined ? "—" : String(score);
}

const TEAM_COLUMNS: readonly Column<Team>[] = [
	{ header: "TEAM", value: (team) => team.number },
	{ header: "NAME", value: (team) => team.name },
	{ header: "ORGANISATION", value: (team) => team.school },
	{
		header: "LOCATION",
		value: (team) => [team.city, team.state, team.country].filter(Boolean).join(", "),
	},
	{ header: "GROUP", value: (team) => team.ageGroup },
	{ header: "DIV", value: (team) => String(team.divId), align: "right" },
	{ header: "IN", value: (team) => (team.checkedIn ? "yes" : "no") },
];

const MATCH_COLUMNS: readonly Column<Match>[] = [
	{ header: "MATCH", value: (match) => formatMatchTuple(match.matchInfo.matchTuple) },
	{ header: "SCHEDULED", value: (match) => formatScheduled(match.matchInfo.timeScheduled) },
	{ header: "STATE", value: (match) => match.matchInfo.state },
	{ header: "RED", value: (match) => allianceTeams(match, 0) },
	{ header: "BLUE", value: (match) => allianceTeams(match, 1) },
	{
		header: "SCORE",
		value: (match) => `${allianceScore(match, 0)}-${allianceScore(match, 1)}`,
		align: "right",
	},
];

/** The round argument accepts TM's own spelling, case-insensitively. */
function parseRound(raw: string): MatchRound {
	const wanted = raw.trim().toUpperCase();
	const match = Object.values(MatchRound).find((round) => round === wanted);
	if (match === undefined) {
		throw new TmConfigError(
			`Unknown round "${raw}". Expected one of: ${Object.values(MatchRound).join(", ")}.`,
		);
	}
	return match;
}

export function registerResourceCommands(program: Command, run: Run): void {
	program
		.command("event")
		.description("Show the event TM is currently running")
		.action(async (_options: unknown, command: Command) => {
			await run(command.optsWithGlobals() as GlobalOptions, async ({ client, out }) => {
				const event = unwrap(await client.getEvent());
				out.fields(
					[
						["Name", event.name],
						["Code", event.code],
					],
					event,
				);
			});
		});

	program
		.command("divisions")
		.description("List the event's divisions")
		.action(async (_options: unknown, command: Command) => {
			await run(command.optsWithGlobals() as GlobalOptions, async ({ client, out }) => {
				const divisions = unwrap(await client.getDivisions());
				out.table(
					[
						{ header: "ID", value: (division) => String(division.id), align: "right" },
						{ header: "NAME", value: (division) => division.name },
					],
					divisions,
				);
			});
		});

	program
		.command("teams")
		.description("List teams, optionally limited to one division")
		.option("--division <id>", "only teams in this division")
		.action(async (options: { division?: string }, command: Command) => {
			await run(command.optsWithGlobals() as GlobalOptions, async ({ client, out }) => {
				const divisionId =
					options.division === undefined
						? undefined
						: requireInteger("--division", options.division);
				const teams = unwrap(await client.getTeams(divisionId));
				out.table(TEAM_COLUMNS, teams);
			});
		});

	program
		.command("matches")
		.description("List a division's match schedule and results")
		.argument("<divisionId>", "division ID, from `tm-cli divisions`")
		.action(async (divisionId: string, _options: unknown, command: Command) => {
			await run(command.optsWithGlobals() as GlobalOptions, async ({ client, out }) => {
				const matches = unwrap(await client.getMatches(requireInteger("divisionId", divisionId)));
				out.table(MATCH_COLUMNS, matches);
			});
		});

	program
		.command("rankings")
		.description("Show a division's rankings for one round")
		.argument("<divisionId>", "division ID, from `tm-cli divisions`")
		.argument("<round>", `round: ${Object.values(MatchRound).join(", ")}`)
		.action(async (divisionId: string, round: string, _options: unknown, command: Command) => {
			await run(command.optsWithGlobals() as GlobalOptions, async ({ client, out }) => {
				const rankings = unwrap(
					await client.getRankings(requireInteger("divisionId", divisionId), parseRound(round)),
				);
				out.table(
					[
						{
							header: "RANK",
							value: (ranking) => `${ranking.rank}${ranking.tied ? "=" : ""}`,
							align: "right",
						},
						// Defensive on `alliance`: TM's ranking payload has changed shape
						// between versions, and a table that renders "—" for one column
						// beats a stack trace over the whole standings.
						// `||`, not `??`: qualification rankings carry an EMPTY alliance
						// name, and a column of blanks reads as a rendering fault.
						{ header: "ALLIANCE", value: (ranking) => ranking.alliance?.name || "—" },
						{
							header: "TEAMS",
							value: (ranking) =>
								(ranking.alliance?.teams ?? []).map((team) => team.number).join(" ") || "—",
						},
						{
							header: "W-L-T",
							value: (ranking) => `${ranking.wins}-${ranking.losses}-${ranking.ties}`,
						},
						{ header: "WP", value: (ranking) => String(ranking.wp), align: "right" },
						{ header: "AP", value: (ranking) => String(ranking.ap), align: "right" },
						{ header: "SP", value: (ranking) => String(ranking.sp), align: "right" },
						{ header: "AVG", value: (ranking) => ranking.avgPoints.toFixed(1), align: "right" },
						{ header: "HIGH", value: (ranking) => String(ranking.highScore), align: "right" },
						{ header: "PLAYED", value: (ranking) => String(ranking.numMatches), align: "right" },
					],
					rankings,
				);
			});
		});

	program
		.command("skills")
		.description("Show the combined skills rankings")
		.action(async (_options: unknown, command: Command) => {
			await run(command.optsWithGlobals() as GlobalOptions, async ({ client, out }) => {
				const skills = unwrap(await client.getSkills());
				out.table(
					[
						{
							header: "RANK",
							value: (entry) => `${entry.rank}${entry.tie ? "=" : ""}`,
							align: "right",
						},
						{ header: "TEAM", value: (entry) => entry.number },
						{ header: "TOTAL", value: (entry) => String(entry.totalScore), align: "right" },
						{ header: "PROG", value: (entry) => String(entry.progHighScore), align: "right" },
						{ header: "ATT", value: (entry) => String(entry.progAttempts), align: "right" },
						{ header: "DRIVER", value: (entry) => String(entry.driverHighScore), align: "right" },
						{ header: "ATT", value: (entry) => String(entry.driverAttempts), align: "right" },
					],
					skills,
				);
			});
		});

	program
		.command("fieldsets")
		.description("List the field sets, with the IDs `watch` and `send` take")
		.action(async (_options: unknown, command: Command) => {
			await run(command.optsWithGlobals() as GlobalOptions, async ({ client, out }) => {
				const fieldSets = unwrap(await client.getFieldSets());
				out.table(
					[
						{ header: "ID", value: (fieldSet) => String(fieldSet.id), align: "right" },
						{ header: "NAME", value: (fieldSet) => fieldSet.name },
					],
					fieldSets,
				);
			});
		});

	program
		.command("fields")
		.description("List the fields in one field set")
		.argument("<fieldSetId>", "field set ID, from `tm-cli fieldsets`")
		.action(async (fieldSetId: string, _options: unknown, command: Command) => {
			await run(command.optsWithGlobals() as GlobalOptions, async ({ client, out }) => {
				const fields = unwrap(await client.getFields(requireInteger("fieldSetId", fieldSetId)));
				out.table(
					[
						{ header: "ID", value: (field) => String(field.id), align: "right" },
						{ header: "NAME", value: (field) => field.name },
					],
					fields,
				);
			});
		});
}
