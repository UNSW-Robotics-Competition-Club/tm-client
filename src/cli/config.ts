/**
 * CLI configuration: where TM is, which API key signs requests, and how the
 * bearer is obtained.
 *
 * `resolveConfig` is deliberately PURE — it takes flags, environment and file
 * contents as plain objects and returns a value. Reading `process.env` or the
 * disk happens in the thin impure wrappers at the bottom. A config precedence
 * bug is the kind that only shows up at a venue, so it has to be testable
 * without mutating the real environment.
 *
 * Auth precedence mirrors streamdeck-vextm's `src/tm/settings.ts` (cerberus,
 * then DWAB direct) minus the dev-token branch, which this package does not
 * ship. A consumer that wants a fixed bearer implements `AuthProvider` itself.
 */

import { readFileSync } from "node:fs";
import { TmConfigError } from "../errors.js";

/** Plain HTTP on the event LAN; TM's web server is not TLS. */
export const DEFAULT_ADDRESS = "http://127.0.0.1";

/** SRA's public broker. Anyone running their own overrides it. */
export const DEFAULT_CERBERUS_ENDPOINT = "https://tm.unswrobotics.com";

/**
 * Reported to Cerberus, which refuses builds older than its floor. Kept as a
 * constant rather than read from package.json at runtime: the bin is bundled to
 * `dist/cli/main.js` and resolving a sibling package.json from there is a
 * different path in the repo than in an installed node_modules tree.
 */
export const CLI_BUILD_VERSION = "0.1.0";

/**
 * DWAB reports credential expiry in MILLISECONDS. A 10-digit seconds value
 * reads as 1970 and reports a perfectly good credential as expired before it
 * ever calls DWAB, so anything implausibly small is rejected by name.
 */
const MIN_PLAUSIBLE_EXPIRATION_MS = 1_000_000_000_000;

/**
 * One layer of configuration, before precedence is applied. Every field is
 * optional and `undefined`-permitting so layers can be merged field by field.
 * `expirationDateMs` is left unparsed here because env and JSON disagree about
 * whether it arrives as a string or a number, and the error message is better
 * when the raw value is still available.
 */
export interface RawConfig {
	address?: string | undefined;
	apiKey?: string | undefined;
	cerberusEndpoint?: string | undefined;
	cerberusKey?: string | undefined;
	clientId?: string | undefined;
	clientSecret?: string | undefined;
	expirationDateMs?: string | number | undefined;
}

export interface ConfigSources {
	/** Command-line flags. Highest precedence. */
	flags?: RawConfig | undefined;
	/** Raw environment, e.g. `process.env`. */
	env?: Record<string, string | undefined> | undefined;
	/** Parsed contents of `--config <file>`. Untrusted: validated, not cast. */
	file?: unknown;
}

export type CliAuthConfig =
	| { readonly mode: "cerberus"; readonly endpoint: string; readonly apiKey: string }
	| {
			readonly mode: "dwab";
			readonly clientId: string;
			readonly clientSecret: string;
			readonly expirationDateMs: number;
	  };

export interface CliConfig {
	/** Base URL of TM's web server, no trailing slash. */
	readonly address: string;
	/** The event's TM API key — the HMAC signing secret. */
	readonly apiKey: string;
	readonly auth: CliAuthConfig;
}

export type ConfigResult =
	| { readonly ok: true; readonly config: CliConfig }
	| { readonly ok: false; readonly error: TmConfigError };

/**
 * How each value can be supplied, for error messages. Naming both spellings
 * matters: the operator who hit the error is usually using one of them and
 * looking for the other.
 */
const SOURCES = {
	address: "--address or TM_ADDRESS",
	apiKey: "--api-key or TM_API_KEY",
	cerberusEndpoint: "--cerberus-endpoint or TM_CERBERUS_ENDPOINT",
	cerberusKey: "--cerberus-key or TM_CERBERUS_KEY",
	clientId: "--client-id or TM_CLIENT_ID",
	clientSecret: "--client-secret or TM_CLIENT_SECRET",
	expirationDateMs: "--expiration-date-ms or TM_EXPIRATION_DATE_MS",
} as const satisfies Record<keyof RawConfig, string>;

/** Blank strings are treated as absent — an unset shell variable often is one. */
function trimmed(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const text = value.trim();
	return text === "" ? undefined : text;
}

/** The documented environment variables, mapped onto config fields. */
export function configFromEnv(env: Record<string, string | undefined>): RawConfig {
	return {
		address: trimmed(env["TM_ADDRESS"]),
		apiKey: trimmed(env["TM_API_KEY"]),
		cerberusEndpoint: trimmed(env["TM_CERBERUS_ENDPOINT"]),
		cerberusKey: trimmed(env["TM_CERBERUS_KEY"]),
		clientId: trimmed(env["TM_CLIENT_ID"]),
		clientSecret: trimmed(env["TM_CLIENT_SECRET"]),
		expirationDateMs: trimmed(env["TM_EXPIRATION_DATE_MS"]),
	};
}

/**
 * Validates a parsed `--config` JSON document. Unknown keys are ignored (a
 * shared config file may carry settings for other tools), but a known key of
 * the wrong type is an error rather than a silent coercion.
 */
export function configFromFile(value: unknown): RawConfig | TmConfigError {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return new TmConfigError("The --config file must contain a JSON object.");
	}
	const source = value as Record<string, unknown>;
	const result: RawConfig = {};

	for (const key of [
		"address",
		"apiKey",
		"cerberusEndpoint",
		"cerberusKey",
		"clientId",
		"clientSecret",
	] as const) {
		const entry = source[key];
		if (entry === undefined) continue;
		if (typeof entry !== "string") {
			return new TmConfigError(`The --config file's "${key}" must be a string.`);
		}
		result[key] = trimmed(entry);
	}

	const expiration = source["expirationDateMs"];
	if (expiration !== undefined) {
		if (typeof expiration !== "string" && typeof expiration !== "number") {
			return new TmConfigError(
				`The --config file's "expirationDateMs" must be a number of milliseconds since the epoch.`,
			);
		}
		result.expirationDateMs = expiration;
	}

	return result;
}

/** Later layers win; `undefined` never overwrites a value an earlier layer set. */
function overlay(base: RawConfig, next: RawConfig | undefined): RawConfig {
	if (!next) return base;
	const merged: RawConfig = { ...base };
	for (const [key, value] of Object.entries(next) as [keyof RawConfig, unknown][]) {
		if (value === undefined) continue;
		// The per-key types are disjoint, so a keyed loop needs one assertion.
		(merged as Record<string, unknown>)[key] = value;
	}
	return merged;
}

function parseExpiration(raw: string | number): number | TmConfigError {
	const parsed = typeof raw === "number" ? raw : Number(raw);
	if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
		return new TmConfigError(
			`Expiration date (${SOURCES.expirationDateMs}) must be a whole number of milliseconds since the epoch, not ${JSON.stringify(raw)}.`,
		);
	}
	if (parsed < MIN_PLAUSIBLE_EXPIRATION_MS) {
		return new TmConfigError(
			`Expiration date (${SOURCES.expirationDateMs}) looks like seconds, not milliseconds: ${parsed} is ${new Date(parsed).getUTCFullYear()}. DWAB reports credential expiry in milliseconds — multiply by 1000.`,
		);
	}
	return parsed;
}

/**
 * Applies precedence — flags > env > file > defaults — and resolves the auth
 * mode. Cerberus wins when a key is present because it is the revocable,
 * per-build credential; DWAB direct puts an org-wide secret on a venue laptop
 * and is the fallback for people outside the org.
 */
export function resolveConfig(sources: ConfigSources): ConfigResult {
	let merged: RawConfig = {};

	if (sources.file !== undefined) {
		const fromFile = configFromFile(sources.file);
		if (fromFile instanceof TmConfigError) return { ok: false, error: fromFile };
		merged = overlay(merged, fromFile);
	}
	if (sources.env) merged = overlay(merged, configFromEnv(sources.env));
	merged = overlay(merged, sources.flags);

	const address = (merged.address ?? DEFAULT_ADDRESS).replace(/\/+$/, "");
	const apiKey = merged.apiKey;
	if (apiKey === undefined) {
		return {
			ok: false,
			error: new TmConfigError(
				`Missing the TM API key (${SOURCES.apiKey}). TM shows it under Tools > Options > Web Publishing once the Local TM API is enabled.`,
			),
		};
	}

	const auth = resolveAuth(merged);
	if (auth instanceof TmConfigError) return { ok: false, error: auth };

	return { ok: true, config: { address, apiKey, auth } };
}

function resolveAuth(merged: RawConfig): CliAuthConfig | TmConfigError {
	if (merged.cerberusKey !== undefined) {
		return {
			mode: "cerberus",
			endpoint: (merged.cerberusEndpoint ?? DEFAULT_CERBERUS_ENDPOINT).replace(/\/+$/, ""),
			apiKey: merged.cerberusKey,
		};
	}

	const { clientId, clientSecret, expirationDateMs } = merged;
	if (clientId === undefined && clientSecret === undefined && expirationDateMs === undefined) {
		return new TmConfigError(
			`No auth credentials configured. Supply either a Cerberus key (${SOURCES.cerberusKey}), or all three DWAB values: ${SOURCES.clientId}, ${SOURCES.clientSecret}, ${SOURCES.expirationDateMs}.`,
		);
	}

	// A partially-filled DWAB block is a typo or a half-set shell profile, so say
	// exactly which pieces are missing rather than restating the whole choice.
	const missing: string[] = [];
	if (clientId === undefined) missing.push(SOURCES.clientId);
	if (clientSecret === undefined) missing.push(SOURCES.clientSecret);
	if (expirationDateMs === undefined) missing.push(SOURCES.expirationDateMs);
	if (clientId === undefined || clientSecret === undefined || expirationDateMs === undefined) {
		return new TmConfigError(
			`Incomplete DWAB credentials. Missing: ${missing.join(", ")}. Supply all three, or use a Cerberus key (${SOURCES.cerberusKey}) instead.`,
		);
	}

	const expiry = parseExpiration(expirationDateMs);
	if (expiry instanceof TmConfigError) return expiry;

	return { mode: "dwab", clientId, clientSecret, expirationDateMs: expiry };
}

/**
 * Reads and parses `--config <file>`. Impure, and separate from `resolveConfig`
 * so the precedence rules can be tested without a filesystem.
 */
export function readConfigFile(
	path: string,
): { ok: true; value: unknown } | { ok: false; error: TmConfigError } {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (cause) {
		return {
			ok: false,
			error: new TmConfigError(
				`Could not read the config file ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
			),
		};
	}
	try {
		return { ok: true, value: JSON.parse(text) as unknown };
	} catch (cause) {
		return {
			ok: false,
			error: new TmConfigError(
				`The config file ${path} is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
			),
		};
	}
}

/** Human label for the active auth mode, for `tm-cli token` and `--verbose`. */
export function describeAuthMode(auth: CliAuthConfig): string {
	return auth.mode === "cerberus"
		? `cerberus (${auth.endpoint})`
		: `dwab direct (client ${auth.clientId})`;
}
