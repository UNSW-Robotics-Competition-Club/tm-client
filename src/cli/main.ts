#!/usr/bin/env node
/**
 * `tm-cli` — the operator-facing front end for this package.
 *
 * It exists for two jobs the library cannot do on its own: proving a TM laptop
 * is reachable and authenticating before an event starts, and triaging TM's
 * bare 401 when it is not (see `sign` and `--verbose`).
 *
 * `src/cli/**` is the ONLY part of `src/` allowed to import `node:*` or
 * `commander`. Everything else stays isomorphic, and a lint rule enforces it.
 */

import process from "node:process";
import { Command, CommanderError } from "commander";
import { TmConfigError } from "../errors.js";
import { CLI_BUILD_VERSION } from "./config.js";
import { EXIT_OK, EXIT_USAGE, exitCodeFor, isTmError, type Output } from "./output.js";
import {
	buildContext,
	buildOutput,
	TmFailure,
	type CliContext,
	type GlobalOptions,
	type Report,
	type Run,
} from "./commands/context.js";
import { registerResourceCommands } from "./commands/resources.js";
import { registerSendCommand } from "./commands/send.js";
import { registerSignCommand } from "./commands/sign.js";
import { registerTokenCommand } from "./commands/token.js";
import { registerWatchCommand } from "./commands/watch.js";

/**
 * Reports a failure and picks the exit code.
 *
 * The split is what makes `tm-cli` scriptable: 2 means the invocation is wrong
 * and retrying will never help, 1 means TM, DWAB or Cerberus said no and it
 * might. Anything unexpected is treated as a 1 and printed with its stack,
 * because an unhandled throw here is a bug in this package, not in the venue.
 */
function reportFailure(error: unknown, out: Output): number {
	if (error instanceof TmFailure) {
		out.failure(error.tmError);
		return exitCodeFor(error.tmError);
	}
	if (error instanceof TmConfigError) {
		out.usage(error.message);
		return EXIT_USAGE;
	}
	if (isTmError(error)) {
		out.failure(error);
		return exitCodeFor(error);
	}
	out.usage(error instanceof Error ? error.stack ?? error.message : String(error));
	return exitCodeFor(error);
}

export interface MainOptions {
	argv?: readonly string[];
	env?: Record<string, string | undefined>;
	isTty?: boolean;
}

export function buildProgram(env: Record<string, string | undefined>, isTty: boolean): Command {
	const program = new Command();

	program
		.name("tm-cli")
		.description("Read and drive a VEX Tournament Manager event over the Public API")
		.version(CLI_BUILD_VERSION)
		// Commander's own exits would bypass the exit-code contract below.
		.exitOverride()
		.option("--address <url>", "TM web server base URL (env TM_ADDRESS)")
		.option("--api-key <key>", "TM API key from Web Publishing (env TM_API_KEY)")
		.option("--cerberus-endpoint <url>", "Cerberus broker base URL (env TM_CERBERUS_ENDPOINT)")
		.option("--cerberus-key <key>", "Cerberus client key, ctm_... (env TM_CERBERUS_KEY)")
		.option("--client-id <id>", "DWAB client ID (env TM_CLIENT_ID)")
		.option("--client-secret <secret>", "DWAB client secret (env TM_CLIENT_SECRET)")
		.option(
			"--expiration-date-ms <ms>",
			"DWAB credential expiry, MILLISECONDS since the epoch (env TM_EXPIRATION_DATE_MS)",
		)
		.option("--config <file>", "JSON config file; flags and environment override it")
		.option("--json", "emit JSON on stdout and nothing else")
		.option("--verbose", "print signed request headers to stderr, secrets redacted");

	// Shared by every command: build the output sink, then the client, then run.
	// `exitCode` is set rather than `process.exit()` called, so stdout is allowed
	// to flush — a truncated `--json` payload is worse than a slow one.
	const run: Run = async (options, body) => {
		const out = buildOutput(options, env, isTty);
		try {
			const context: CliContext = buildContext(options, out, env);
			await body(context);
		} catch (error) {
			process.exitCode = reportFailure(error, out);
		}
	};

	const report: Report = async (options, body) => {
		const out = buildOutput(options, env, isTty);
		try {
			await body(out);
		} catch (error) {
			process.exitCode = reportFailure(error, out);
		}
	};

	registerResourceCommands(program, run);
	registerWatchCommand(program, run);
	registerSendCommand(program, run);
	registerTokenCommand(program, run);
	registerSignCommand(program, report);

	return program;
}

export async function main(options: MainOptions = {}): Promise<number> {
	const env = options.env ?? process.env;
	const isTty = options.isTty ?? process.stdout.isTTY === true;
	const program = buildProgram(env, isTty);

	try {
		await program.parseAsync([...(options.argv ?? process.argv)]);
	} catch (error) {
		// `--help` and `--version` come through here as successful "errors".
		if (error instanceof CommanderError) {
			// Commander has already written the message; repeating it here just
			// prints every usage error twice. `--help` and `--version` arrive as
			// successful "errors" with exit code 0.
			return error.exitCode === 0 ? EXIT_OK : EXIT_USAGE;
		}
		const globals = program.opts<GlobalOptions>();
		return reportFailure(error, buildOutput(globals, env, isTty));
	}

	return process.exitCode === undefined ? EXIT_OK : Number(process.exitCode);
}

const code = await main();
process.exitCode = code;
