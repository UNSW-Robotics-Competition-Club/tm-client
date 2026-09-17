/**
 * The `./node` entry point: everything that needs a Node runtime.
 *
 * Kept separate from `.` so the isomorphic entry stays free of `node:*` and of
 * the optional `ws` dependency. Import this to drive a field set socket:
 *
 * ```ts
 * import { createNodeWebSocketFactory } from "@unsw-rcc/tm-client/node";
 * const socket = new FieldsetSocket({ http, fieldSetId, webSocketFactory: await createNodeWebSocketFactory() });
 * ```
 *
 * Passing the factory explicitly is optional — `connect()` finds this one by
 * itself under Node — but doing it here makes the dependency visible to a
 * bundler and to whoever reads the call site.
 */

export { createNodeWebSocketFactory } from "./ws/node.js";
