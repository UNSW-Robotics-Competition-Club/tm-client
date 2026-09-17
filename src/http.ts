/**
 * Signed HTTP transport for the TM Public API.
 *
 * Ports `vex-tm-client`'s `Client.get()` (`src/Client.ts:409-501`, the only
 * surviving copy) and grafts on obs-plugin's finer status classification from
 * `src/tm/tm-api-client.cpp` (`classify()` + `recordClockSkew()`). Two confirmed
 * upstream bugs are fixed here — see `get()` and `recordClockSkew()`.
 *
 * Isomorphic: `fetch`, `URL` and WebCrypto only. Nothing in this file may reach
 * for `node:*`, because the whole package has to bundle for a browser.
 */

import type { AuthProvider } from "./auth/types.js";
import type { Result, TmErrorCode } from "./errors.js";
import { err, ok, shouldInvalidateBearer, TmConfigError } from "./errors.js";
import { buildAuthHeaders } from "./signing.js";

/**
 * Five minutes, matching obs-plugin's default. TM's own tolerance is not
 * documented; this is wide enough that ordinary NTP drift never trips it and
 * narrow enough that a machine with a dead RTC does.
 */
const DEFAULT_MAX_CLOCK_SKEW_MS = 300_000;

export interface TmHttpClientOptions {
	/** e.g. `http://192.168.1.50` or `http://127.0.0.1:8080/`. Either form works. */
	baseUrl: string;
	/** The event's TM API key, from TM's Web Publishing options. */
	apiKey: string;
	auth: AuthProvider;
	fetch?: typeof fetch;
	/** Epoch milliseconds. Injected so tests can drive the clock. */
	now?: () => number;
	maxClockSkewMs?: number;
}

interface CacheEntry {
	readonly data: unknown;
	readonly lastModified: string;
}

export class TmHttpClient {
	private readonly baseUrl: URL;
	private readonly apiKey: string;
	private readonly auth: AuthProvider;
	private readonly fetchImpl: typeof fetch;
	private readonly nowMs: () => number;
	private readonly maxClockSkewMs: number;

	/** Conditional-GET store, keyed by the full URL including its query. */
	private readonly cache = new Map<string, CacheEntry>();

	private skewMs = 0;

	constructor(options: TmHttpClientOptions) {
		// A malformed address is a wiring mistake, not a runtime failure the
		// operator can retry their way out of, so it throws rather than becoming
		// a `TmError` on every subsequent call.
		let baseUrl: URL;
		try {
			baseUrl = new URL(options.baseUrl.endsWith("/") ? options.baseUrl : `${options.baseUrl}/`);
		} catch {
			throw new TmConfigError(
				`baseUrl is not a valid URL: ${options.baseUrl}. Expected something like http://192.168.1.50 or http://127.0.0.1:8080.`,
			);
		}
		this.baseUrl = baseUrl;
		this.apiKey = options.apiKey;
		this.auth = options.auth;

		const fetchImpl = options.fetch ?? globalThis.fetch;
		if (typeof fetchImpl !== "function") {
			throw new TmConfigError(
				"No global fetch in this runtime. Pass a fetch implementation via the `fetch` option.",
			);
		}
		// Bound because an unbound global `fetch` throws "Illegal invocation" when
		// called as a method off `this`.
		this.fetchImpl = fetchImpl === globalThis.fetch ? fetchImpl.bind(globalThis) : fetchImpl;

		this.nowMs = options.now ?? (() => Date.now());
		this.maxClockSkewMs = options.maxClockSkewMs ?? DEFAULT_MAX_CLOCK_SKEW_MS;
	}

	/**
	 * Resolve an API path against the configured address.
	 *
	 * The base is normalised to end in `/` and the path stripped of its leading
	 * `/` so that a base with a sub-path (`http://host/tm`) keeps it instead of
	 * having it silently replaced, and so a trailing slash on the address makes
	 * no difference either way. The port survives both forms — `url.host` is what
	 * gets signed, so losing `:8080` here is an instant 401 with no explanation.
	 */
	resolve(path: string): URL {
		return new URL(path.replace(/^\/+/, ""), this.baseUrl);
	}

	/** Milliseconds this machine's clock is AHEAD of the TM server's. */
	get observedClockSkewMs(): number {
		return this.skewMs;
	}

	invalidateBearer(): void {
		this.auth.invalidate();
	}

	/**
	 * Signed headers for an arbitrary URL and method.
	 *
	 * Exists for the field set websocket, which must sign its HTTP upgrade with
	 * the same four headers but cannot go through `get()`. Includes `Host`; see
	 * `get()` for why the REST path drops it.
	 */
	async authHeadersFor(url: URL, method = "GET"): Promise<Result<Record<string, string>>> {
		const bearer = await this.auth.getBearer();
		if (!bearer.ok) return bearer;

		const headers = await buildAuthHeaders(url, {
			method,
			token: bearer.data.access_token,
			apiKey: this.apiKey,
			now: () => new Date(this.nowMs()),
		});
		return ok({ ...headers });
	}

	async get<T>(path: string): Promise<Result<T>> {
		const url = this.resolve(path);
		const cacheKey = url.toString();

		// No second layer of token caching here: the AuthProvider owns that and
		// knows the token's real remaining life. Two caches means two answers.
		const headers = await this.authHeadersFor(url, "GET");
		if (!headers.ok) return headers;

		const requestHeaders: Record<string, string> = { ...headers.data };
		// `Host` is a forbidden header name in Fetch — browsers drop it silently
		// and undici has flip-flopped on it (nodejs/undici #2319, #2369). It is
		// not part of the canonical string either, so sending it can only cost us.
		// The `ws`/`node:http` paths that do honour it get it from
		// `authHeadersFor()` instead.
		delete requestHeaders["Host"];

		const cached = this.cache.get(cacheKey);
		if (cached) requestHeaders["If-Modified-Since"] = cached.lastModified;

		let response: Response;
		try {
			response = await this.fetchImpl(url, { method: "GET", headers: requestHeaders });
		} catch (cause) {
			return err<T>("host_unreachable", `Could not reach ${url.host}.`, { detail: cause });
		}

		// Before classification, and on every response including the failures:
		// the skew reading is precisely what tells a wrong clock apart from a
		// wrong API key when TM answers a bare 401.
		this.recordClockSkew(response);

		const status = response.status;
		if (status !== 304 && (status < 200 || status >= 300)) {
			const body = await readTextSafely(response);
			const { code, message } = this.classifyFailure(status, isLocalApiPath(path));

			if (shouldInvalidateBearer(code)) {
				// Fixes the second confirmed upstream bug. `Client.ts:460` returns
				// the 401 but keeps both the rejected bearer and this URL's
				// conditional-GET entry, so the next call re-sends the token TM
				// just refused and, on the 304 that follows, hands the caller a
				// stale body as though it were fresh.
				this.invalidateBearer();
				this.cache.delete(cacheKey);
			}

			return err<T>(code, message, { detail: body, httpStatus: status });
		}

		if (status === 304) {
			if (!cached) {
				return err<T>(
					"malformed_response",
					"TM answered 304 Not Modified for a request that carried no If-Modified-Since.",
					{ httpStatus: status },
				);
			}
			return ok(cached.data as T, true);
		}

		let data: unknown;
		try {
			data = await response.json();
		} catch (cause) {
			return err<T>("malformed_response", "TM's response was not valid JSON.", {
				detail: cause,
				httpStatus: status,
			});
		}

		const lastModified = response.headers.get("Last-Modified");
		if (lastModified) this.cache.set(cacheKey, { data, lastModified });

		return ok(data as T, false);
	}

	/**
	 * Record how far this machine's clock is from the server's, and do nothing
	 * else with it.
	 *
	 * Ports obs-plugin's `recordClockSkew()`. Deliberately never corrects the
	 * outgoing `x-tm-date`: auto-correcting would paper over a dead RTC or a
	 * machine with no NTP, which is the one thing the operator actually needs
	 * told, and it would let an untrusted response header steer what we sign.
	 */
	private recordClockSkew(response: Response): void {
		const date = response.headers.get("Date");
		if (!date) return;

		const serverMs = Date.parse(date);
		if (Number.isNaN(serverMs)) return;

		this.skewMs = this.nowMs() - serverMs;
	}

	private classifyFailure(
		status: number,
		isApiPath: boolean,
	): { code: TmErrorCode; message: string } {
		if (status === 503) {
			// What real TM answers when the Event Partner has not ticked Enable
			// Local TM API — the single most common misconfiguration at an event.
			return { code: "local_api_disabled", message: "TM returned 503 for a Local API path." };
		}

		if (status === 404 && isApiPath) {
			// The same condition wearing a different hat: the entire /api/*
			// namespace is absent, so a 404 there means the API is off rather than
			// that one resource is missing. A genuinely absent resource (an unknown
			// division id) lands here too; the response body in `detail` separates
			// them.
			return { code: "local_api_disabled", message: "TM returned 404 for a Local API path." };
		}

		if (status === 401 || status === 403) {
			// A skewed clock and a wrong API key produce the same bare rejection,
			// and TM's body is not something we can lean on. The server's own Date
			// header is, so the measured drift is what tells them apart.
			if (Math.abs(this.skewMs) > this.maxClockSkewMs) {
				const seconds = Math.round(this.skewMs / 1000);
				return {
					code: "clock_skew",
					message: `TM returned ${status}; this machine's clock differs from the server's by ${seconds}s.`,
				};
			}
			return { code: "invalid_signature", message: `TM returned ${status}.` };
		}

		return { code: "http_error", message: `TM returned ${status}.` };
	}
}

/** Whether a 404 on this path means "the Local API is off" rather than "no such resource". */
function isLocalApiPath(path: string): boolean {
	return (path.startsWith("/") ? path : `/${path}`).startsWith("/api/");
}

/**
 * The body of a failed response, for the error's `detail`. A body that cannot be
 * read must not turn a useful 503 into an unhelpful transport error, so this
 * swallows — the status has already told us what went wrong.
 */
async function readTextSafely(response: Response): Promise<string> {
	try {
		return await response.text();
	} catch {
		return "";
	}
}
