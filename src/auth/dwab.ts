/**
 * Direct DWAB client-credentials auth.
 *
 * Ports the `getBearer`/`updateBearer`/`ensureBearer` flow from vex-tm-client's
 * `src/Client.ts` — the only surviving copy of a package that was unpublished
 * from npm — with the two confirmed bugs in it fixed: there is a single-flight
 * guard, and the cached token's remaining life is recomputed on every read
 * instead of the issuer's original `expires_in` being re-served.
 *
 * Use this only where the long-lived org credential can safely live on the
 * machine. Venue laptops should use the Cerberus broker instead.
 */

import { TmConfigError, err, ok, type Result, type TmErrorCode } from "../errors.js";
import type { AuthProvider, BearerToken } from "./types.js";

const DWAB_TOKEN_URL = "https://auth.vextm.dwabtech.com/oauth2/token";

const DEFAULT_MARGIN_MS = 300_000;

/**
 * Any credential expiry earlier than 2001-09-09 is a seconds value that was
 * meant to be milliseconds — DWAB issues this field in ms, and no real
 * credential predates the API.
 */
const MIN_PLAUSIBLE_EXPIRATION_MS = 1_000_000_000_000;

export interface DwabAuthOptions {
	clientId: string;
	clientSecret: string;
	/** When the *credential* (not the token) expires, in ms since the epoch. */
	expirationDateMs: number;
	/** Refetch when less than this many ms of token life remain. Default 5 minutes. */
	marginMs?: number;
	/** Injectable for tests. */
	fetch?: typeof fetch;
	now?: () => number;
}

export function createDwabAuth(o: DwabAuthOptions): AuthProvider {
	// Throws rather than returning a Result: a seconds-shaped expiry is a wiring
	// mistake, and it fails in the most confusing possible way if allowed
	// through — a 10-digit value reads as 1970, so a perfectly good credential is
	// reported expired and DWAB is never called at all. Better to fail loudly at
	// construction, where the offending config is still in view.
	if (!Number.isFinite(o.expirationDateMs) || o.expirationDateMs < MIN_PLAUSIBLE_EXPIRATION_MS) {
		throw new TmConfigError(
			`expirationDateMs must be milliseconds since the epoch; got ${o.expirationDateMs}, ` +
				"which looks like a seconds value. Multiply by 1000.",
		);
	}

	const doFetch = o.fetch ?? globalThis.fetch.bind(globalThis);
	const now = o.now ?? Date.now;
	const marginMs = o.marginMs ?? DEFAULT_MARGIN_MS;

	let cached: { accessToken: string; expiresAtMs: number } | null = null;
	let pending: Promise<Result<BearerToken>> | null = null;
	/**
	 * Bumped by `invalidate()`, so a mint that was already in flight cannot
	 * repopulate the cache the caller just decided it could not trust.
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

	/**
	 * A token that still has life left beats any failure to mint a new one:
	 * DWAB is on the internet, TM is on the LAN, and venues lose the former
	 * routinely. Only TM answering 401 proves a token is actually dead.
	 */
	const staleOr = (result: Result<BearerToken>): Result<BearerToken> => present(0) ?? result;

	const failure = (
		code: TmErrorCode,
		message: string,
		options: { detail?: unknown; httpStatus?: number } = {},
	): Result<BearerToken> => err<BearerToken>(code, message, options);

	async function refresh(): Promise<Result<BearerToken>> {
		const mintedFor = generation;

		let response: Response;
		try {
			response = await doFetch(DWAB_TOKEN_URL, {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
				body: new URLSearchParams({
					client_id: o.clientId,
					client_secret: o.clientSecret,
					grant_type: "client_credentials",
				}),
			});
		} catch (cause) {
			return failure("dwab_unreachable", "Could not reach the DWAB authorization server", {
				detail: cause,
			});
		}

		if (response.status !== 200) {
			const body = await readJsonObject(response);
			const named = body?.["error"];
			if (named === "invalid_client") {
				return failure("dwab_invalid_client", "DWAB rejected the client ID or secret", {
					detail: body,
					httpStatus: response.status,
				});
			}
			return failure("dwab_unreachable", `DWAB returned ${response.status}`, {
				detail: body,
				httpStatus: response.status,
			});
		}

		const body = await readJsonObject(response);
		// A 200 that is not a token must not be cached: an undefined `expires_in`
		// gives an expiry of NaN, which reads as permanently stale, so every TM
		// request would mint again. A captive portal answering 200 with an HTML
		// login page is how this actually happens.
		if (!isTokenBody(body)) {
			return failure("malformed_response", "DWAB returned a response that is not a token", {
				detail: body,
				httpStatus: response.status,
			});
		}

		const expiresAtMs = now() + body.expires_in * 1000;
		if (generation === mintedFor) cached = { accessToken: body.access_token, expiresAtMs };
		return ok(token(body.access_token, expiresAtMs));
	}

	return {
		async getBearer() {
			const fresh = present(marginMs);
			if (fresh) return fresh;

			// Checked before the request, as upstream does: DWAB would only answer
			// an expired credential with a generic rejection anyway, and the local
			// check names the actual problem.
			if (o.expirationDateMs < now()) {
				return staleOr(
					failure("dwab_credentials_expired", "The DWAB credential has passed its expiry date", {
						detail: { expirationDateMs: o.expirationDateMs },
					}),
				);
			}

			// Single-flight. Upstream's `ensureBearer` has no guard, so two calls in
			// the same tick both mint; at match start that is one request per reader.
			pending ??= refresh().finally(() => {
				pending = null;
			});
			const result = await pending;
			return result.ok ? result : staleOr(result);
		},

		invalidate() {
			cached = null;
			generation += 1;
		},
	};
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
