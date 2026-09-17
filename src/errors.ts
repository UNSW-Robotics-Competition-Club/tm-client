/**
 * Error taxonomy for the TM Public API.
 *
 * Ported from obs-plugin's `src/tm/tm-types.hpp` (`TmError` + `tmErrorRemedy`),
 * which is the finest-grained of the prior-art implementations. The coarser
 * `TMErrors` enum in vex-tm-client collapses several of these together, which
 * matters because TM answers a bad signature, a skewed clock, and a disabled
 * Local API with responses that look nearly identical to the operator.
 *
 * Fallible TM/DWAB/Cerberus operations return `Result<T>` rather than throwing:
 * these failures are frequent, expected, and operator-actionable, not bugs.
 * Throwing is reserved for programmer/config errors (see `TmConfigError`).
 */

export type TmErrorCode =
	// Transport / reachability
	| "host_unreachable"
	| "local_api_disabled"
	// DWAB direct auth
	| "dwab_invalid_client"
	| "dwab_credentials_expired"
	| "dwab_unreachable"
	// Cerberus broker auth
	| "cerberus_unreachable"
	| "cerberus_key_invalid"
	| "cerberus_upgrade_required"
	| "cerberus_rate_limited"
	| "cerberus_credentials_invalid"
	| "cerberus_upstream_error"
	// Request signing / authorization
	| "invalid_signature"
	| "clock_skew"
	/**
	 * Never produced by this package: TM does not distinguish an expired token
	 * from any other rejected signature, so a 401 becomes `invalid_signature` or
	 * `clock_skew` instead. It is kept as vocabulary for a consumer-written
	 * `AuthProvider` whose own issuer *can* say so, and it invalidates the
	 * cached bearer like the others, so returning it does the right thing.
	 */
	| "token_expired"
	// Generic
	| "http_error"
	| "malformed_response"
	// Field set websocket
	| "ws_headers_unsupported"
	| "ws_connection_error"
	| "ws_closed";

export interface TmError {
	readonly code: TmErrorCode;
	/** Short technical description. `remedy(code)` supplies the operator-facing fix. */
	readonly message: string;
	readonly detail?: unknown;
	readonly httpStatus?: number;
}

export type Result<T> =
	| { readonly ok: true; readonly data: T; readonly cached: boolean }
	| { readonly ok: false; readonly error: TmError };

export function ok<T>(data: T, cached = false): Result<T> {
	return { ok: true, data, cached };
}

export function err<T = never>(
	code: TmErrorCode,
	message: string,
	options: { detail?: unknown; httpStatus?: number } = {},
): Result<T> {
	const error: { -readonly [K in keyof TmError]: TmError[K] } = { code, message };
	if (options.detail !== undefined) error.detail = options.detail;
	if (options.httpStatus !== undefined) error.httpStatus = options.httpStatus;
	return { ok: false, error };
}

/**
 * Config and programmer errors. Unlike a `TmError`, these mean the caller wired
 * something up wrong and no amount of retrying will help, so they throw.
 */
export class TmConfigError extends Error {
	override readonly name = "TmConfigError";
}

/**
 * Operator-facing fix for each failure. The switch is exhaustive: adding a code
 * without a remedy is a compile error, which is the point — an error nobody can
 * act on is barely better than no error at all.
 */
export function remedy(code: TmErrorCode): string {
	switch (code) {
		case "host_unreachable":
			return "Could not reach the TM web server. Check the address and that this machine is on the same network as the TM laptop.";
		case "local_api_disabled":
			return "TM's Local API is off. In TM: Tools > Options > Web Publishing > Enable Local TM API, then save. It must be enabled for each event.";
		case "dwab_invalid_client":
			return "The DWAB client ID or secret was rejected. Check the credentials issued to you by DWAB Technologies.";
		case "dwab_credentials_expired":
			return "The DWAB credential has passed its expiry date. Request a new client ID and secret.";
		case "dwab_unreachable":
			return "Could not reach the DWAB authorization server. Check this machine's internet connection.";
		case "cerberus_unreachable":
			return "Could not reach the Cerberus token broker. Check this machine's internet connection.";
		case "cerberus_key_invalid":
			return "The Cerberus API key was rejected. It may have been revoked, or copied incorrectly.";
		case "cerberus_upgrade_required":
			return "This build is older than the minimum version Cerberus accepts. Update to the current release.";
		case "cerberus_rate_limited":
			return "Too many token requests. Wait for the period given by Retry-After before trying again.";
		case "cerberus_credentials_invalid":
			return "Cerberus's own upstream credential was rejected. This is a server-side problem — contact whoever operates the broker.";
		case "cerberus_upstream_error":
			return "Cerberus could not reach DWAB. Retry shortly; if it persists, contact whoever operates the broker.";
		case "invalid_signature":
			return "TM rejected the request signature. Check, in order: the canonical string ends with a trailing newline; the address you called matches the host that is actually listening (including the port); the API key matches the one TM currently shows.";
		case "clock_skew":
			return "This machine's clock differs from the TM server's by more than the allowed margin, so the signature is rejected. Sync the clock (enable automatic time) and retry.";
		case "token_expired":
			return "The bearer token expired before the request completed. This should recover on retry.";
		case "http_error":
			return "TM returned an unexpected HTTP status. See the detail field for the response body.";
		case "malformed_response":
			return "TM's response could not be parsed as the expected JSON shape. This usually means a TM version mismatch.";
		case "ws_headers_unsupported":
			return "This runtime's WebSocket cannot send the Authorization, x-tm-date and x-tm-signature headers that TM requires on the field set socket. Run under Node or Bun, pass your own webSocketFactory, or proxy through a relay you control. Browsers cannot do this at all.";
		case "ws_connection_error":
			return "The field set websocket failed to connect. Check the field set ID exists and that TM is reachable.";
		case "ws_closed":
			return "The field set websocket is closed. Reconnect before sending commands.";
	}
}

/**
 * Whether a failure means the cached bearer is no longer trustworthy.
 *
 * Ports the `failed()` dispatch in streamdeck-vextm's `src/tm/connection.ts`.
 * The surviving upstream (`vex-tm-client` `Client.ts:460`) gets this wrong: it
 * returns the 401 but leaves the rejected token cached for up to an hour.
 */
export function shouldInvalidateBearer(code: TmErrorCode): boolean {
	switch (code) {
		case "invalid_signature":
		case "token_expired":
		case "clock_skew":
		case "dwab_invalid_client":
		case "dwab_credentials_expired":
		case "cerberus_key_invalid":
		case "cerberus_credentials_invalid":
			return true;
		default:
			return false;
	}
}
