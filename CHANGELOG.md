# Changelog

## 0.1.0 — unreleased

First release. Replaces `vex-tm-client@1.5.3`, which was unpublished from npm and had
its repository deleted on 2026-08-26, along with the three vendored copies and two
duplicated Cerberus clients that had grown up around it.

### Added

- `TmClient` / `TmHttpClient` — signed requests to all eight TM REST resources, with
  `Last-Modified` / `If-Modified-Since` conditional caching.
- `createCerberusAuth` and `createDwabAuth` — token providers with margin-based refresh,
  single-flight minting, and remaining-life recomputation. `AuthProvider` is exported so
  static or baked-key strategies can be supplied by the consumer.
- `FieldsetSocket` — the field set websocket with the full command set, an exponential
  reconnect ladder, and an outbox that survives a reconnect.
- `tm-cli` — twelve commands, including `watch` (NDJSON), `send`, and `sign` for
  diagnosing a bare 401.
- A 19-code error taxonomy with `remedy()`, ported from the C++ implementation in
  obs-plugin, which is finer-grained than any of the TypeScript prior art.
- `pnpm smoke` — a manually-triggered smoke test against a real TM instance, gated on
  `TM_SMOKE_*` env vars and skipping cleanly without them. Commands stay off unless
  `TM_SMOKE_ALLOW_COMMANDS=yes`.

### Fixed

Two bugs confirmed in the surviving upstream source:

- **A 401 no longer leaves a rejected bearer cached.** `Client.ts:460` returned the error
  but kept the token, so one TM had already rejected was retried for up to an hour. A 401
  now invalidates the bearer *and* that URL's conditional-GET entry — otherwise a stale
  body could return via a 304 issued against a dead token.
- **Concurrent cold-start calls mint one token, not N.** `ensureBearer()` at
  `Client.ts:215` had no single-flight guard.

### Changed from `vex-tm-client`

- **Signing is async.** WebCrypto replaces `node:crypto` so the core runs in a browser,
  Bun, Deno and Workers. Invisible unless you called the signer directly.
- **`Ranking.alliance` is an object, not an array**, and `Ranking.tied` is `boolean`, not
  the literal `false`. Upstream's types contradicted the API guide; nothing had noticed
  because no vendored copy read the fields.
- **`FieldsetEventFieldMatchAssigned.fieldID` is `number | null`.** Upstream checked for
  the null at runtime while typing it `number`, so every consumer was one real event away
  from a crash the compiler had promised was impossible.
- **`getFieldSets`** carries a capital S, matching TM's `fieldSets` envelope key. The path
  is still `/api/fieldsets`; TM is inconsistent with itself here.
- **The field set websocket ships no default transport.** TM signs the socket's HTTP
  upgrade and browsers cannot set handshake headers, so the transport is resolved at
  `connect()` time (Node via `ws`, Bun natively) or injected. In a runtime that cannot do
  it, `connect()` returns `ws_headers_unsupported` rather than failing obscurely.

### Known gaps

- **The CLI's SIGINT path is unexercised.** Git Bash cannot deliver a signal a native
  Windows Node process receives. The handler is three lines and also listens for SIGTERM.
- `send()` resolving `ok` means *written to the socket*, not *applied by TM*. Correlating
  an echo back to the command that caused it needs a timeout heuristic that has not been
  written.
