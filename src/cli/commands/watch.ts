/**
 * `tm-cli watch <fieldSetId>` — stream a field set's events until Ctrl-C.
 *
 * The stdout/stderr split is the whole design. Events go to stdout, one per
 * line; connection, reconnect and status chatter goes to stderr. That means
 * `tm-cli watch 1 --json | jq` keeps working across a dropped cable, which is
 * exactly when someone is watching it.
 */

import process from "node:process";
import type { Command } from "commander";
import { TmConfigError } from "../../errors.js";
import { FieldsetSocket } from "../../fieldset-socket.js";
import {
	FieldsetActiveMatchType,
	type FieldsetEvent,
	type FieldsetEventType,
	type MatchTuple,
} from "../../types.js";
import { formatMatchTuple } from "./resources.js";
import { requireInteger, unwrap, type GlobalOptions, type Run } from "./context.js";

const EVENT_TYPES: readonly FieldsetEventType[] = [
	"fieldMatchAssigned",
	"fieldActivated",
	"matchStarted",
	"matchStopped",
	"audienceDisplayChanged",
];

/** `HH:MM:SS` local — the clock an operator is comparing against is the venue's. */
function clock(now: Date): string {
	const pad = (value: number): string => String(value).padStart(2, "0");
	return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

/**
 * One event, one line. TM signals a TIMEOUT as a `fieldMatchAssigned` carrying
 * an EMPTY match object rather than a distinct type, so that case is spelled
 * out here instead of being rendered as an assignment to nothing.
 */
export function formatFieldsetEvent(event: FieldsetEvent, now: Date): string {
	// 22 is the longest type name, so pad past it — otherwise the longest name
	// runs straight into its payload with no separator at all.
	const prefix = `${clock(now)}  ${event.type.padEnd(22)}  `;
	switch (event.type) {
		case "fieldMatchAssigned": {
			// An empty object is the only marker TM gives for a timeout, and no
			// count of keys narrows `Record<string, never>` away at the type level.
			// An empty match with a NULL field is the separate "nothing is queued"
			// case, which reads as nonsense if rendered as an assignment.
			const isEmpty = Object.keys(event.match).length === 0;
			if (isEmpty && event.fieldID === null) return `${prefix}nothing queued`;
			const where = event.fieldID === null ? "no field" : `field ${event.fieldID}`;
			const what = isEmpty
				? FieldsetActiveMatchType.Timeout
				: formatMatchTuple(event.match as MatchTuple);
			return `${prefix}${where}  ${what}`;
		}
		case "fieldActivated":
		case "matchStarted":
		case "matchStopped":
			return `${prefix}field ${event.fieldID}`;
		case "audienceDisplayChanged":
			return `${prefix}${event.display}`;
	}
}

function parseFilter(raw: string | undefined): ReadonlySet<FieldsetEventType> | null {
	if (raw === undefined) return null;
	const wanted = raw
		.split(",")
		.map((part) => part.trim())
		.filter((part) => part !== "");
	const unknown = wanted.filter((part) => !EVENT_TYPES.includes(part as FieldsetEventType));
	if (unknown.length > 0) {
		throw new TmConfigError(
			`Unknown event type${unknown.length > 1 ? "s" : ""} in --filter: ${unknown.join(", ")}. Valid types: ${EVENT_TYPES.join(", ")}.`,
		);
	}
	return new Set(wanted as FieldsetEventType[]);
}

function detailOf(event: Event): unknown {
	return (event as CustomEvent<unknown>).detail;
}

export function registerWatchCommand(program: Command, run: Run): void {
	program
		.command("watch")
		.description("Stream a field set's events until interrupted")
		.argument("<fieldSetId>", "field set ID, from `tm-cli fieldsets`")
		.option("--filter <types>", `comma-separated subset of: ${EVENT_TYPES.join(", ")}`)
		.action(async (fieldSetId: string, options: { filter?: string }, command: Command) => {
			await run(command.optsWithGlobals() as GlobalOptions, async ({ client, out }) => {
				const filter = parseFilter(options.filter);
				const socket = new FieldsetSocket({
					http: client.http,
					fieldSetId: requireInteger("fieldSetId", fieldSetId),
				});

				socket.addEventListener("open", (event) => {
					const url = (detailOf(event) as { url?: string } | undefined)?.url ?? "";
					out.note(`connected to ${url}`);
				});
				socket.addEventListener("close", (event) => {
					const reason = (detailOf(event) as { reason?: string } | undefined)?.reason ?? "closed";
					out.note(`disconnected: ${reason}`);
				});
				socket.addEventListener("reconnecting", (event) => {
					const detail = detailOf(event) as { attempt?: number; delayMs?: number } | undefined;
					// Emitted before the wait, so this is still true as it is read.
					out.note(
						`reconnecting in ${Math.round((detail?.delayMs ?? 0) / 1000)}s (attempt ${detail?.attempt ?? 1})`,
					);
				});
				socket.addEventListener("message", (event) => {
					const payload = detailOf(event) as FieldsetEvent;
					if (filter && !filter.has(payload.type)) return;
					if (out.json) out.record(payload);
					else out.line(formatFieldsetEvent(payload, new Date()));
				});

				unwrap(await socket.connect());

				// Ctrl-C is the documented way out, so it is a clean shutdown and a
				// zero exit, not an interruption. `once` per signal leaves a second
				// Ctrl-C able to kill a socket that somehow refuses to close, and
				// SIGTERM is here because a supervisor is as likely to stop this as
				// a person is.
				await new Promise<void>((resolve) => {
					// The socket `.unref()`s its reconnect timers so a one-shot command
					// is never held open by a pending retry. `watch` wants the opposite:
					// if TM goes away, staying up and retrying IS the job. Without a
					// ref'd handle of our own the event loop drains the moment the
					// socket drops and node exits on an unsettled await, which looks
					// like the command silently giving up.
					const keepAlive = setInterval(() => {}, 60_000);
					const stop = (signal: string) => () => {
						out.note(`stopping on ${signal}`);
						clearInterval(keepAlive);
						socket.disconnect();
						resolve();
					};
					process.once("SIGINT", stop("SIGINT"));
					process.once("SIGTERM", stop("SIGTERM"));
				});
			});
		});
}
