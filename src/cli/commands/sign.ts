/**
 * `tm-cli sign` — print the canonical string and signature for given inputs.
 *
 * This is step one of triaging TM's bare, unexplained 401. The canonical string
 * has five lines and a MANDATORY trailing newline, and a missing trailing
 * newline is the single most common cause; since it is invisible in normal
 * output, this command prints an escaped form alongside the raw one and states
 * the byte length, so the difference is something you can actually see.
 *
 * It talks to nothing. No TM, no DWAB, no Cerberus — every input is supplied on
 * the command line, so it works from a laptop that cannot reach the venue.
 */

import type { Command } from "commander";
import { TmConfigError } from "../../errors.js";
import { formatTmDate, hmacSha256Hex, stringToSign } from "../../signing.js";
import type { GlobalOptions, Report } from "./context.js";

interface SignOptions {
	method?: string;
	url?: string;
	token?: string;
	date?: string;
}

/** `\n` made visible, so a missing trailing newline shows up as a missing `\n`. */
export function escapeCanonical(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/\r/g, "\\r").replace(/\n/g, "\\n");
}

function required(value: string | undefined, flag: string): string {
	if (value === undefined || value.trim() === "") {
		throw new TmConfigError(`${flag} is required for \`tm-cli sign\`.`);
	}
	return value;
}

export function registerSignCommand(program: Command, report: Report): void {
	program
		.command("sign")
		.description("Print the canonical string and x-tm-signature for given inputs (no network)")
		.option("--method <verb>", "HTTP method", "GET")
		.option("--url <url>", "the full request URL, including port and query string")
		.option("--token <bearer>", "the bearer access token, without the `Bearer ` prefix")
		.option("--date <rfc1123>", "x-tm-date value; defaults to now")
		.action(async (options: SignOptions, command: Command) => {
			const globals = command.optsWithGlobals() as GlobalOptions & SignOptions;
			await report(globals, async (out) => {
				const apiKey = required(globals.apiKey, "--api-key");
				const rawUrl = required(options.url, "--url");
				const token = required(options.token, "--token");
				const method = (options.method ?? "GET").toUpperCase();
				const tmDate = options.date ?? formatTmDate();

				let url: URL;
				try {
					url = new URL(rawUrl);
				} catch {
					throw new TmConfigError(
						`--url is not a valid absolute URL: ${rawUrl}. It must include the scheme, e.g. http://127.0.0.1:8080/api/event.`,
					);
				}

				const canonical = stringToSign({ method, url, token, tmDate });
				const signature = await hmacSha256Hex(apiKey, canonical);
				const byteLength = new TextEncoder().encode(canonical).length;

				if (out.json) {
					out.jsonOut({
						method,
						// The signed path is `pathname + search`, and getting the query
						// string wrong here is the second most common 401 cause.
						signedPath: url.pathname + url.search,
						host: url.host,
						tmDate,
						stringToSign: canonical,
						stringToSignEscaped: escapeCanonical(canonical),
						byteLength,
						signature,
					});
					return;
				}

				out.line(`escaped:    ${escapeCanonical(canonical)}`);
				out.line(`bytes:      ${byteLength}`);
				out.line(
					`trailing newline: ${canonical.endsWith("\n") ? "present" : "MISSING — TM will answer 401"}`,
				);
				out.line("");
				out.line("--- begin canonical string ---");
				out.line(canonical.replace(/\n$/, ""));
				out.line("--- end canonical string ---");
				out.line("");
				out.line(`signature:  ${signature}`);
			});
		});
}
