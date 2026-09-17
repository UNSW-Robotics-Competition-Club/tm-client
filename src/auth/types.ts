import type { Result } from "../errors.js";

export interface BearerToken {
	access_token: string;
	token_type: "Bearer";
	/**
	 * ALWAYS the REMAINING life in seconds, recomputed on every read — never the
	 * value the issuer returned at grant time. Re-serving the original number
	 * from a cache tells a later caller it has far more time left than it does.
	 */
	expires_in: number;
}

/**
 * The seam every auth strategy implements. Exported so consumers can supply
 * their own; a static dev token is three lines:
 *
 *     const auth: AuthProvider = {
 *       getBearer: async () => ok({ access_token: t, token_type: "Bearer", expires_in: 3600 }),
 *       invalidate() {},
 *     };
 */
export interface AuthProvider {
	getBearer(): Promise<Result<BearerToken>>;
	/** Drop any cached token. Called when TM rejects a request as unauthorized. */
	invalidate(): void;
}
