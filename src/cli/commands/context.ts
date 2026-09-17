/**
 * Turns resolved configuration into a live, signed `TmClient`.
 *
 * Kept apart from `config.ts` so the precedence rules stay unit-testable
 * without dragging the HTTP client and auth providers into the test's import
 * graph.
 */

import process from "node:process";

import { createCerberusAuth, createDwabAuth } from "../../auth/index.js";
import type { AuthProvider } from "../../auth/types.js";
import { TmClient } from "../../client.js";
import { TmConfigError, type Result, type TmError } from "../../errors.js";
import {
	CLI_BUILD_VERSION,
	readConfigFile,
	resolveConfig,
	type CliConfig,
	type RawConfig,
} from "../config.js";
import { createOutput, shouldUseColor, type Output } from "../output.js";

/** The flags every command accepts, as commander hands them over. */
export interface GlobalOptions {
	address?: string;
	apiKey?: string;
	cerberusEndpoint?: string;
	cerberusKey?: string;
	clientId?: string;
	clientSecret?: string;
	expirationDateMs?: string;
	config?: string;
	json?: boolean;
	verbose?: boolean;
}

export interface CliContext {
	readonly config: CliConfig;
	readonly auth: AuthProvider;
	readonly client: TmClient;
	readonly out: Output;
}

export function buildOutput(
	options: GlobalOptions,
	env: Record<string, string | undefined>,
	isTty: boolean,
): Output {
	return createOutput(
		{ out: process.stdout, err: process.stderr },
		{
			json: options.json === true,
			verbose: options.verbose === true,
			color: shouldUseColor(env, isTty),
		},
	);
}

function flagsFrom(options: GlobalOptions): RawConfig {
	return {
		address: options.address,
		apiKey: options.apiKey,
		cerberusEndpoint: options.cerberusEndpoint,
		cerberusKey: options.cerberusKey,
		clientId: options.clientId,
		clientSecret: options.clientSecret,
		expirationDateMs: options.expirationDateMs,
	};
}

/** Throws `TmConfigError`, which `main.ts` maps to exit code 2. */
export function loadConfig(
	options: GlobalOptions,
	env: Record<string, string | undefined>,
): CliConfig {
	let file: unknown;
	if (options.config !== undefined) {
		const read = readConfigFile(options.config);
		if (!read.ok) throw read.error;
		file = read.value;
	}

	const resolved = resolveConfig({ flags: flagsFrom(options), env, file });
	if (!resolved.ok) throw resolved.error;
	return resolved.config;
}

export function createAuthProvider(config: CliConfig): AuthProvider {
	if (config.auth.mode === "cerberus") {
		return createCerberusAuth({
			endpoint: config.auth.endpoint,
			apiKey: config.auth.apiKey,
			build: { version: CLI_BUILD_VERSION },
		});
	}
	return createDwabAuth({
		clientId: config.auth.clientId,
		clientSecret: config.auth.clientSecret,
		expirationDateMs: config.auth.expirationDateMs,
	});
}

/**
 * A `fetch` that reports what is actually on the wire, rather than re-signing a
 * second request to show — a re-signed request carries a different `x-tm-date`
 * and therefore a different signature, which is precisely the value being
 * investigated. `Host` will not appear: `TmHttpClient` strips it before every
 * REST call because Fetch forbids it. The canonical string still signs the
 * URL's host, and `tm-cli sign` prints that.
 */
function verboseFetch(out: Output): typeof fetch {
	const base = globalThis.fetch.bind(globalThis);
	return async (input, init) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const headers: Record<string, string> = {};
		new Headers(init?.headers).forEach((value, name) => {
			headers[name] = value;
		});
		out.debugRequest(init?.method ?? "GET", url, headers);
		return base(input, init);
	};
}

export function buildContext(
	options: GlobalOptions,
	out: Output,
	env: Record<string, string | undefined>,
): CliContext {
	const config = loadConfig(options, env);
	const auth = createAuthProvider(config);
	const client = new TmClient({
		baseUrl: config.address,
		apiKey: config.apiKey,
		auth,
		...(options.verbose === true ? { fetch: verboseFetch(out) } : {}),
	});
	return { config, auth, client, out };
}

/** Rejects a flag that should be a positive integer, by name. */
export function requireInteger(label: string, raw: string): number {
	const value = Number(raw);
	if (!Number.isInteger(value) || value < 0) {
		throw new TmConfigError(`${label} must be a non-negative whole number, not ${raw}.`);
	}
	return value;
}

/**
 * Carries a `TmError` up to `main.ts`, which prints it with its remedy and
 * exits 1. Wrapped in an `Error` rather than thrown bare so a stack trace
 * survives an unexpected escape and linters stay happy.
 */
export class TmFailure extends Error {
	override readonly name = "TmFailure";
	constructor(readonly tmError: TmError) {
		super(tmError.message);
	}
}

export function unwrap<T>(result: Result<T>): T {
	if (result.ok) return result.data;
	throw new TmFailure(result.error);
}

/**
 * How every command body is invoked: resolve config, build the client, run,
 * and let `main.ts` own error reporting and exit codes.
 */
export type Run = (
	options: GlobalOptions,
	body: (context: CliContext) => Promise<void>,
) => Promise<void>;

/**
 * For commands that need no TM connection — `sign` — so they still get error
 * reporting and exit codes without a config resolution they cannot satisfy.
 */
export type Report = (
	options: GlobalOptions,
	body: (out: Output) => Promise<void>,
) => Promise<void>;
