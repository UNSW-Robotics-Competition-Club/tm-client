/**
 * Cerberus token broker auth.
 *
 * Cerberus holds an org-wide DWAB credential and mints hourly bearers for
 * clients that present a revocable `ctm_` key, so the long-lived org secret
 * never ships to a venue laptop. It is not in the TM data path: the TM Client
 * API Key stays local and signs requests here, and the two secrets only ever
 * meet inside a signature.
 *
 * Ported from VEX-TM-Cerberus `packages/client/src/index.ts` (the authoritative
 * copy) with the operator-facing failure sentence from streamdeck-vextm's
 * `src/tm/cerberus.ts` and the stale-token fallback from LED-Field-Controller's.
 */

import { err, ok, remedy, type Result, type TmErrorCode } from "../errors.js";
import type { AuthProvider, BearerToken } from "./types.js";

/**
 * `ctm_<16 hex>_<48 hex>`. Checked locally before any network call: a key
 * mistyped or truncated by a copy-paste is the common failure, and naming it
 * without a round trip is both faster and unambiguous — Cerberus answers a
 * malformed key and a revoked key with the same 401.
 */
const KEY_PATTERN = /^ctm_[0-9a-fA-F]{16}_[0-9a-fA-F]{48}$/;

const DEFAULT_MARGIN_MS = 300_000;

export interface CerberusAuthOptions {
	/** Base URL, e.g. `https://tm.sydneyrobotics.com.au`. */
	endpoint: string;
	/** The client key, `ctm_<16 hex>_<48 hex>`. One per distributed build. */
	apiKey: string;
	/** This build. The version is checked against the server's floor. */
	build: { version: string; hash?: string };
	/** From TM's own `/api/event`. Attribution telemetry, never authorization. */
	event?: { code?: string; name?: string; sku?: string };
	/** Refetch when less than this many ms of life remain. Default 5 minutes. */
	marginMs?: number;
	/** Injectable for tests. */
	fetch?: typeof fetch;
	now?: () => number;
}

export interface CerberusAuth extends AuthProvider {
	/**
	 * Why the last mint was refused, in a sentence an operator can act on, or
	 * null when healthy. `TmError.code` is what callers switch on; this is what
	 * they put on screen.
	 */
	lastFailure(): string | null;
	/** Late-binds the event, once TM has been asked which one it is running. */
	setEvent(event: { code?: string; name?: string; sku?: string }): void;
	/** Late-binds the build hash, which is often read from disk asynchronously. */
	setBuildHash(hash: string): void;
}

export function createCerberusAuth(o: CerberusAuthOptions): CerberusAuth {
	const doFetch = o.fetch ?? globalThis.fetch.bind(globalThis);
	const now = o.now ?? Date.now;
	const marginMs = o.marginMs ?? DEFAULT_MARGIN_MS;
	const endpoint = o.endpoint.replace(/\/+$/, "");

	let event = o.event;
	let buildHash = o.build.hash;
	let cached: { accessToken: string; expiresAtMs: number } | null = null;
	let pending: Promise<Result<BearerToken>> | null = null;
	let lastFailureMessage: string | null = null;
	/**
	 * Bumped by `invalidate()`. A mint that was already in flight when the caller
	 * invalidated must not become the new cache entry: Cerberus caches its DWAB
	 * token server-side, so the response may be the very token TM just rejected.
	 */
	let generation = 0;

	const token = (accessToken: string, expiresAtMs: number): BearerToken => ({
		access_token: accessToken,
		token_type: "Bearer",
		expires_in: Math.floor((expiresAtMs - now()) / 1000),
	});

	/** The cached token restated with its remaining life, or null if too old. */
	const present = (minRemainingMs: number): Result<BearerToken> | null => {
		if (!cached) return null;
		if (cached.expiresAtMs - now() <= minRemainingMs) return null;
		return ok(token(cached.accessToken, cached.expiresAtMs));
	};

	const fail = (
		code: TmErrorCode,
		message: string,
		options: { detail?: unknown; httpStatus?: number; operatorMessage?: string } = {},
	): Result<BearerToken> => {
		lastFailureMessage = options.operatorMessage ?? remedy(code);
		const forward: { detail?: unknown; httpStatus?: number } = {};
		if (options.detail !== undefined) forward.detail = options.detail;
		if (options.httpStatus !== undefined) forward.httpStatus = options.httpStatus;
		return err<BearerToken>(code, message, forward);
	};

	async function refresh(): Promise<Result<BearerToken>> {
		const mintedFor = generation;

		const headers: Record<string, string> = {
			Authorization: `Bearer ${o.apiKey}`,
			"x-cerberus-build": buildHash ? `${o.build.version}/${buildHash}` : o.build.version,
		};
		if (event?.code) headers["x-cerberus-event"] = event.code;
		if (event?.name) headers["x-cerberus-event-name"] = event.name;
		if (event?.sku) headers["x-cerberus-event-sku"] = event.sku;

		let response: Response;
		try {
			response = await doFetch(`${endpoint}/v1/token`, { method: "POST", headers });
		} catch (cause) {
			return fail("cerberus_unreachable", `Could not reach Cerberus at ${endpoint}`, {
				detail: cause,
			});
		}

		if (!response.ok) {
			const body = await readJsonObject(response);
			const named = stringField(body, "error");
			const code = classify(response.status, named);
			const serverMessage = stringField(body, "message");
			const options: { detail?: unknown; httpStatus: number; operatorMessage?: string } = {
				detail: body ?? named,
				httpStatus: response.status,
			};
			// Cerberus names the minimum version it will serve, which is more use to
			// the operator than our generic "update to the current release".
			if (code === "cerberus_upgrade_required" && serverMessage) {
				options.operatorMessage = serverMessage;
			}
			return fail(code, serverMessage ?? `Cerberus returned ${response.status}`, options);
		}

		const body = await readJsonObject(response);
		// A 200 that is not a usable token has to be refused rather than cached.
		// Caching an undefined `expires_in` gives an expiry of NaN, which reads as
		// "always stale", so every TM request would mint again and a venue would
		// rate-limit itself out of its own event. A captive portal answering 200
		// with an HTML login page is how this actually happens.
		if (!isTokenBody(body)) {
			return fail("cerberus_upstream_error", "Cerberus returned a response that is not a token", {
				detail: body,
				httpStatus: response.status,
			});
		}

		const expiresAtMs = now() + body.expires_in * 1000;
		lastFailureMessage = null;
		if (generation === mintedFor) cached = { accessToken: body.access_token, expiresAtMs };
		return ok(token(body.access_token, expiresAtMs));
	}

	return {
		async getBearer() {
			if (!KEY_PATTERN.test(o.apiKey)) {
				return fail(
					"cerberus_key_invalid",
					"Cerberus API key is not of the form ctm_<16 hex>_<48 hex>",
				);
			}

			const fresh = present(marginMs);
			if (fresh) return fresh;

			// Single-flight, for the same reason the server does it: a client with
			// several TM readers should make one token request at match start, not
			// one per reader. The surviving upstream (`Client.ts:215`) has no such
			// guard, so two calls in the same tick both mint.
			pending ??= refresh().finally(() => {
				pending = null;
			});
			const result = await pending;

			// A failed refresh is not a reason to throw away a token that still
			// works. Venues lose their internet constantly while TM stays on the
			// LAN; only TM answering 401 proves the token is actually dead.
			if (!result.ok) return present(0) ?? result;
			return result;
		},

		invalidate() {
			cached = null;
			generation += 1;
		},

		lastFailure() {
			return lastFailureMessage;
		},

		setEvent(next) {
			event = next;
		},

		setBuildHash(next) {
			buildHash = next;
		},
	};
}

/**
 * The named `error` in the body is preferred over the status: Cerberus is
 * explicit about which of the two 503 cases it is in, and a proxy in front of it
 * can rewrite a status without knowing what it meant.
 */
function classify(status: number, named: string | undefined): TmErrorCode {
	switch (named) {
		case "invalid_client":
			return "cerberus_key_invalid";
		case "upgrade_required":
			return "cerberus_upgrade_required";
		case "rate_limited":
			return "cerberus_rate_limited";
		case "credentials_expired":
		case "credentials_invalid":
			return "cerberus_credentials_invalid";
		case "upstream_error":
			return "cerberus_upstream_error";
	}
	switch (status) {
		case 401:
			return "cerberus_key_invalid";
		case 426:
			return "cerberus_upgrade_required";
		case 429:
			return "cerberus_rate_limited";
		case 503:
			return "cerberus_credentials_invalid";
		default:
			return "cerberus_upstream_error";
	}
}

async function readJsonObject(response: Response): Promise<Record<string, unknown> | null> {
	try {
		const parsed: unknown = await response.json();
		return typeof parsed === "object" && parsed !== null
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

function stringField(body: Record<string, unknown> | null, key: string): string | undefined {
	const value = body?.[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isTokenBody(
	body: Record<string, unknown> | null,
): body is { access_token: string; expires_in: number } {
	if (!body) return false;
	const accessToken = body["access_token"];
	const expiresIn = body["expires_in"];
	return (
		typeof accessToken === "string" &&
		accessToken.length > 0 &&
		typeof expiresIn === "number" &&
		Number.isFinite(expiresIn) &&
		expiresIn > 0
	);
}
