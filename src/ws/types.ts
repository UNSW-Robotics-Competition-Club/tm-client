/**
 * The minimal WebSocket surface the field set socket needs, plus the injection
 * point that keeps this package isomorphic.
 *
 * TM signs the websocket UPGRADE with the same headers it requires on REST.
 * Browsers cannot set headers on a WebSocket handshake — the spec forbids it —
 * so the isomorphic entry point ships no default factory. `./node` supplies one
 * backed by the `ws` package; any other runtime must inject its own.
 */
export interface WebSocketLike {
	readonly readyState: number;
	send(data: string): void;
	close(code?: number, reason?: string): void;
	addEventListener(type: "open", listener: () => void): void;
	addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
	addEventListener(type: "error", listener: (event: unknown) => void): void;
	addEventListener(
		type: "close",
		listener: (event: { code?: number; reason?: string }) => void,
	): void;
}

/** `WebSocket.OPEN`, spelled out so this file needs no DOM lib reference. */
export const WS_OPEN = 1;

export type WebSocketFactory = (url: URL, headers: Record<string, string>) => WebSocketLike;
