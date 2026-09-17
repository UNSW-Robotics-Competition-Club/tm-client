/**
 * The Node transport for the field set socket.
 *
 * This is the ONLY file in the package permitted to touch `ws`, and it does so
 * through a dynamic `import()` inside a function — never a top-level import. A
 * bundler resolving the isomorphic `.` entry therefore never has to resolve an
 * optional Node-only dependency, and a browser consumer never pays for one.
 *
 * `ws` is the transport because it is the only Node WebSocket that can set
 * headers on the handshake. Node 22's global `WebSocket` (undici) is
 * spec-compliant and therefore two-argument only, which TM's signed upgrade
 * rules out.
 */

import type { WebSocketFactory, WebSocketLike } from "./types.js";

/**
 * Loads `ws` and returns a factory over it.
 *
 * Rejects when `ws` is not installed — it is an `optionalDependency`, so that
 * is a normal state, not a broken install. Callers turn the rejection into a
 * `ws_headers_unsupported` `Result`; see `resolveWebSocketFactory`.
 */
export async function createNodeWebSocketFactory(): Promise<WebSocketFactory> {
	const { WebSocket } = await import("ws");
	return (url: URL, headers: Record<string, string>): WebSocketLike =>
		// `ws`'s event objects carry a wider `data` type than `WebSocketLike`
		// describes (string | Buffer | ArrayBuffer | Buffer[]), which the socket
		// decodes itself, so the structural overlap needs spelling out.
		new WebSocket(url, { headers }) as unknown as WebSocketLike;
}
