/**
 * @unsw-rcc/tm-client — isomorphic client for the VEX Tournament Manager Public API.
 *
 * Everything exported here runs anywhere `fetch`, `URL` and `crypto.subtle`
 * exist: Node, Bun, Deno, Cloudflare Workers, and browsers.
 *
 * The one exception is the field set websocket. TM signs the socket's HTTP
 * upgrade with the same headers it requires on REST, and browsers cannot set
 * headers on a WebSocket handshake — the spec forbids it. So `FieldsetSocket` is
 * exported here, but it ships no default transport: under Node or Bun it finds
 * one itself, and anywhere else you pass a `WebSocketFactory` or it returns
 * `ws_headers_unsupported`. Node users can import the ready-made factory from
 * `@unsw-rcc/tm-client/node`.
 *
 *     import { TmClient, createCerberusAuth } from "@unsw-rcc/tm-client";
 *
 *     const auth = createCerberusAuth({
 *       endpoint: "https://tm.unswrobotics.com",
 *       apiKey: process.env.TM_CERBERUS_KEY,
 *       build: { version: "0.1.0" },
 *     });
 *     const tm = new TmClient({ baseUrl: "http://192.168.1.50", apiKey, auth });
 *
 *     const event = await tm.getEvent();
 *     if (!event.ok) console.error(event.error.message, remedy(event.error.code));
 */

// Errors and the Result contract every fallible call returns.
export {
	remedy,
	shouldInvalidateBearer,
	TmConfigError,
	ok,
	err,
} from "./errors.js";
export type { Result, TmError, TmErrorCode } from "./errors.js";

// Request signing. Exported because it is genuinely useful on its own — the
// `tm-cli sign` command and anyone debugging a bare 401 need it.
export {
	stringToSign,
	signTmRequest,
	hmacSha256Hex,
	formatTmDate,
	buildAuthHeaders,
} from "./signing.js";
export type { SignInput, StringToSignInput, AuthHeaders } from "./signing.js";

// Authentication.
export { createCerberusAuth, createDwabAuth } from "./auth/index.js";
export type {
	AuthProvider,
	BearerToken,
	CerberusAuth,
	CerberusAuthOptions,
	DwabAuthOptions,
} from "./auth/index.js";

// HTTP transport and the eight REST resources.
export { TmHttpClient } from "./http.js";
export type { TmHttpClientOptions } from "./http.js";
export { TmClient } from "./client.js";
export type { TmClientOptions } from "./client.js";
export {
	getEvent,
	getDivisions,
	getTeams,
	getMatches,
	getRankings,
	getSkills,
	getFieldSets,
	getFields,
} from "./resources.js";

// Field set websocket.
export {
	FieldsetSocket,
	reduceFieldsetState,
	parseFieldsetEvent,
	resolveWebSocketFactory,
	defaultRuntimeProbe,
	INITIAL_FIELDSET_STATE,
	DEFAULT_BACKOFF_MS,
	DEFAULT_HEALTHY_MS,
} from "./fieldset-socket.js";
export type {
	FieldsetSocketOptions,
	FieldsetHttp,
	RuntimeProbe,
} from "./fieldset-socket.js";
export type { WebSocketFactory, WebSocketLike } from "./ws/types.js";
export { WS_OPEN } from "./ws/types.js";

// Wire types for every TM entity.
export * from "./types.js";
