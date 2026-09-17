/**
 * VEX TM Public API request signing.
 *
 * Ports the algorithm from vex-tm-client's `src/Client.ts` (getAuthorizationHeaders)
 * and obs-plugin's `test/tm-sign.mjs`, which is the reference implementation the
 * C++ signer is pinned against. Output must stay byte-identical to both — the
 * golden vectors in `test/fixtures/signer-vectors.json` are shared with them.
 *
 * Isomorphic: WebCrypto only, no `node:crypto`. That makes signing async, which
 * costs nothing (one HMAC per request, not a hot loop) and means the golden
 * vectors prove the one code path that actually ships.
 */

const encoder = new TextEncoder();

export interface StringToSignInput {
	method: string;
	url: URL;
	/** The bearer access token, not the whole `Authorization` header value. */
	token: string;
	/** RFC 1123 / IMF-fixdate, e.g. `Tue, 11 Aug 2026 03:14:00 GMT`. */
	tmDate: string;
}

export interface SignInput extends StringToSignInput {
	/** The event's TM API key, from TM's Web Publishing options. */
	apiKey: string;
}

/**
 * The canonical string TM hashes. Five lines, each terminated by a newline —
 * including the last one. Drop the trailing newline and TM answers a bare 401
 * with no explanation, which is the single most common integration mistake.
 *
 * Note `url.host` and not `url.hostname`: WHATWG keeps the port when it is not
 * the scheme default, so `:8080` is signed and `:80` is not.
 */
export function stringToSign(input: StringToSignInput): string {
	const { method, url, token, tmDate } = input;
	return (
		[
			method.toUpperCase(),
			url.pathname + url.search,
			`token:${token}`,
			`host:${url.host}`,
			`x-tm-date:${tmDate}`,
		].join("\n") + "\n"
	);
}

function toHex(buffer: ArrayBuffer): string {
	return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * HMAC-SHA256 over an arbitrary message, hex-encoded.
 *
 * Byte-identical to Node's `createHmac("sha256", key).update(msg).digest("hex")`:
 * Node encodes a string key as UTF-8 via `Buffer.from`, and `TextEncoder` is
 * UTF-8 by definition, so key and message encode the same on both paths.
 */
export async function hmacSha256Hex(key: string, message: string): Promise<string> {
	const cryptoKey = await crypto.subtle.importKey(
		"raw",
		encoder.encode(key),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(message));
	return toHex(signature);
}

/** The `x-tm-signature` value for a request. */
export async function signTmRequest(input: SignInput): Promise<string> {
	return hmacSha256Hex(input.apiKey, stringToSign(input));
}

/** RFC 1123 date in GMT, the format `x-tm-date` requires. */
export function formatTmDate(date: Date = new Date()): string {
	return date.toUTCString();
}

export interface AuthHeaders {
	Authorization: string;
	"x-tm-date": string;
	"x-tm-signature": string;
	Host: string;
}

/**
 * The four headers every signed TM request carries — REST calls and the field
 * set websocket upgrade alike.
 *
 * `Host` is a forbidden header name in Fetch: browsers drop it silently and
 * undici has flip-flopped on it across versions. Losing it is harmless, because
 * whatever transport sends the request must put the URL's real authority on the
 * wire anyway, and that is exactly the value the signature was built from. It is
 * kept here because the `ws` and `node:http` paths do honour it, which matters
 * if TM is ever reached through a name-based reverse proxy.
 */
export async function buildAuthHeaders(
	url: URL,
	options: { method?: string; token: string; apiKey: string; now?: () => Date },
): Promise<AuthHeaders> {
	const method = options.method ?? "GET";
	const tmDate = formatTmDate(options.now ? options.now() : new Date());
	const signature = await signTmRequest({
		method,
		url,
		token: options.token,
		tmDate,
		apiKey: options.apiKey,
	});
	return {
		Authorization: `Bearer ${options.token}`,
		"x-tm-date": tmDate,
		"x-tm-signature": signature,
		Host: url.host,
	};
}
