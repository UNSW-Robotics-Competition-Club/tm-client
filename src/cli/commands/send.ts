/**
 * `tm-cli send <fieldSetId> <cmd>` — issue one field set command.
 *
 * All eight commands, no confirmation gate: this was an explicit product
 * decision, because the Stream Deck plugin and the LED controller both need
 * full parity and a prompt in a CLI is worked around within a day anyway. The
 * safety that IS here is argument validation — a `start` with no `--field`
 * fails at exit code 2 before a socket is even opened, rather than sending TM a
 * command with an undefined field.
 */

import type { Command } from "commander";
import { TmConfigError } from "../../errors.js";
import { FieldsetSocket } from "../../fieldset-socket.js";
import {
	FieldsetAudienceDisplay,
	FieldsetQueueSkillsType,
	type FieldsetCommand,
	type FieldsetCommandType,
} from "../../types.js";
import { requireInteger, TmFailure, unwrap, type GlobalOptions, type Run } from "./context.js";

/** Which flag each command needs. Drives both validation and the help text. */
const REQUIREMENTS = {
	start: "field",
	endEarly: "field",
	abort: "field",
	reset: "field",
	queuePrevMatch: null,
	queueNextMatch: null,
	queueSkills: "skillsId",
	setAudienceDisplay: "display",
} as const satisfies Record<FieldsetCommandType, "field" | "skillsId" | "display" | null>;

export const COMMAND_NAMES = Object.keys(REQUIREMENTS) as readonly FieldsetCommandType[];

const DISPLAY_NAMES = Object.values(FieldsetAudienceDisplay);

export interface SendFlags {
	field?: string | undefined;
	skillsId?: string | undefined;
	display?: string | undefined;
}

/** Matched case-insensitively — the wire spelling is camelCase and easy to mistype. */
function parseCommandName(raw: string): FieldsetCommandType {
	const found = COMMAND_NAMES.find((name) => name.toLowerCase() === raw.trim().toLowerCase());
	if (found === undefined) {
		throw new TmConfigError(
			`Unknown command "${raw}". Expected one of: ${COMMAND_NAMES.join(", ")}.`,
		);
	}
	return found;
}

/** `1`/`2`, or the names TM's own UI uses. */
function parseSkillsId(raw: string): FieldsetQueueSkillsType {
	const normalised = raw.trim().toLowerCase();
	if (normalised === "1" || normalised === "programming" || normalised === "prog") {
		return FieldsetQueueSkillsType.Programming;
	}
	if (normalised === "2" || normalised === "driver") {
		return FieldsetQueueSkillsType.Driver;
	}
	throw new TmConfigError(`--skills-id must be 1 (programming) or 2 (driver), not ${raw}.`);
}

function parseDisplay(raw: string): FieldsetAudienceDisplay {
	const wanted = raw.trim().toUpperCase();
	const found = DISPLAY_NAMES.find((display) => display === wanted);
	if (found === undefined) {
		throw new TmConfigError(
			`Unknown audience display "${raw}". Expected one of: ${DISPLAY_NAMES.join(", ")}.`,
		);
	}
	return found;
}

/**
 * Builds the wire command, or throws a `TmConfigError` (exit 2) naming the flag
 * that is missing. Pure, so the validation table can be tested directly.
 */
export function buildCommand(name: FieldsetCommandType, flags: SendFlags): FieldsetCommand {
	switch (name) {
		case "start":
		case "endEarly":
		case "abort":
		case "reset": {
			if (flags.field === undefined) {
				throw new TmConfigError(
					`\`${name}\` requires --field <id>. List them with \`tm-cli fields <fieldSetId>\`.`,
				);
			}
			return { cmd: name, fieldID: requireInteger("--field", flags.field) };
		}
		case "queuePrevMatch":
		case "queueNextMatch":
			return { cmd: name };
		case "queueSkills": {
			if (flags.skillsId === undefined) {
				throw new TmConfigError(
					"`queueSkills` requires --skills-id <1|2> (1 programming, 2 driver).",
				);
			}
			return { cmd: name, skillsID: parseSkillsId(flags.skillsId) };
		}
		case "setAudienceDisplay": {
			if (flags.display === undefined) {
				throw new TmConfigError(
					`\`setAudienceDisplay\` requires --display <NAME>. Valid names: ${DISPLAY_NAMES.join(", ")}.`,
				);
			}
			return { cmd: name, display: parseDisplay(flags.display) };
		}
	}
}

/**
 * Flags that mean nothing for the chosen command are a warning, not an error: a
 * wrapper script that always passes `--field` should not break when it queues
 * the next match, but a typo'd command name should still be visible.
 */
export function extraneousFlags(name: FieldsetCommandType, flags: SendFlags): string[] {
	const required = REQUIREMENTS[name];
	const supplied: [keyof SendFlags, string][] = [
		["field", "--field"],
		["skillsId", "--skills-id"],
		["display", "--display"],
	];
	return supplied
		.filter(([key]) => flags[key] !== undefined && key !== required)
		.map(([, flag]) => flag);
}

export function registerSendCommand(program: Command, run: Run): void {
	program
		.command("send")
		.description("Send one command to a field set")
		.argument("<fieldSetId>", "field set ID, from `tm-cli fieldsets`")
		.argument("<cmd>", COMMAND_NAMES.join(" | "))
		.option("--field <id>", "field ID, for start, endEarly, abort and reset")
		.option("--skills-id <n>", "1 programming or 2 driver, for queueSkills")
		.option(
			"--display <name>",
			`audience display, for setAudienceDisplay: ${DISPLAY_NAMES.join(", ")}`,
		)
		.action(async (fieldSetId: string, cmd: string, options: SendFlags, command: Command) => {
			await run(command.optsWithGlobals() as GlobalOptions, async ({ client, out }) => {
				const name = parseCommandName(cmd);
				const payload = buildCommand(name, options);
				for (const flag of extraneousFlags(name, options)) {
					out.note(`warning: ${flag} has no meaning for \`${name}\` and was ignored`);
				}

				const socket = new FieldsetSocket({
					http: client.http,
					fieldSetId: requireInteger("fieldSetId", fieldSetId),
				});
				unwrap(await socket.connect());
				try {
					// `send()` QUEUES rather than fails when the socket is down, and
					// returns ok either way. For a long-lived consumer that is the right
					// behaviour; for a one-shot CLI that tears the socket down on the
					// next line it would drop the command and still print "sent". So
					// check the socket is actually up, and say so plainly when it is not.
					if (!socket.connected) {
						throw new TmFailure({
							code: "ws_closed",
							message: `The field set socket dropped before ${name} could be sent, so TM did not receive it.`,
						});
					}
					unwrap(await socket.send(payload));
					out.line(`sent ${JSON.stringify(payload)}`);
				} finally {
					// Always tear the socket down, or the reconnect ladder keeps the
					// process alive after a failed send.
					socket.disconnect();
				}
			});
		});
}
