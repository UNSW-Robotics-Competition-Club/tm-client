# @unsw-rcc/tm-client

Isomorphic TypeScript client and CLI for the **VEX Tournament Manager Public API**.

Handles both halves of TM's authentication — the OAuth2 client-credentials bearer and
the per-request HMAC-SHA256 signature — plus conditional-GET caching, the field set
websocket with reconnect, and an error taxonomy that tells an operator what to actually
do about each failure.

```ts
import { TmClient, createCerberusAuth, remedy } from "@unsw-rcc/tm-client";

const tm = new TmClient({
  baseUrl: "http://192.168.1.50",       // the TM laptop
  apiKey: process.env.TM_API_KEY,       // from TM: Tools > Options > Web Publishing
  auth: createCerberusAuth({
    endpoint: "https://tm.sydneyrobotics.com.au",
    apiKey: process.env.TM_CERBERUS_KEY,
    build: { version: "0.1.0" },
  }),
});

const event = await tm.getEvent();
if (event.ok) console.log(event.data.name);
else console.error(event.error.message, "\n", remedy(event.error.code));
```

## Why this exists

The reference implementation, `vex-tm-client`, was unpublished from npm and its
repository deleted on 2026-08-26. By then the same logic had been vendored into three
separate projects and reimplemented once in C++, and the copies had begun to drift —
two of them carry comments conceding as much. This package is the one canonical
implementation those projects move onto.

It also fixes two bugs confirmed in the surviving upstream source:

- **A 401 never dropped the cached bearer** (`Client.ts:460`), so a token TM had already
  rejected was retried for up to an hour. Here a 401 invalidates the bearer *and* that
  URL's conditional-GET entry, so a stale body cannot come back via a 304 issued against
  a dead token.
- **`ensureBearer()` had no single-flight guard** (`Client.ts:215`), so concurrent calls
  from a cold cache each minted their own token. Here they share one.

## Install

```bash
npm install @unsw-rcc/tm-client     # add `ws` too if you need the field set websocket
```

## Runtime support

Everything except the field set websocket runs anywhere `fetch`, `URL` and
`crypto.subtle` exist. Signing uses WebCrypto, not `node:crypto`, and the core has zero
dependencies.

The websocket is the exception, and the reason is structural: **TM signs the socket's
HTTP upgrade with the same headers it requires on REST, and browsers cannot set headers
on a WebSocket handshake.** The spec forbids it. There is no workaround.

| Runtime | REST | Field set websocket |
|---|---|---|
| Node 22+ | yes | yes, via the optional `ws` package |
| Bun | yes | yes, via Bun's non-standard `{ headers }` form |
| Deno | yes | no — its `WebSocket` cannot set headers |
| Cloudflare Workers | yes | yes, but you must pass a `WebSocketFactory` using `fetch` + `Upgrade` |
| Browser / Electron renderer | see below | **no, and no workaround exists** |

`FieldsetSocket.connect()` finds a transport itself under Node and Bun. Anywhere else,
pass a `webSocketFactory`, or it returns `ws_headers_unsupported` — a `Result`, never a
throw.

**Browser REST is not recommended.** TM's local API has no documented CORS behaviour, and
an `https://` page reaching `http://192.168.x.x` hits mixed-content blocking and Chrome's
Private Network Access checks. If you need TM data in a browser, put a relay you control
in between.

## Authentication

Two providers ship. Both cache the token, refresh it five minutes before expiry,
single-flight concurrent requests, and report `expires_in` as *remaining* life rather
than re-serving the issuer's original number.

```ts
createCerberusAuth({ endpoint, apiKey, build: { version, hash? }, event?, marginMs? })
createDwabAuth({ clientId, clientSecret, expirationDateMs, marginMs? })
```

`expirationDateMs` is **milliseconds**. A ten-digit seconds value reads as 1970 and would
report a perfectly good credential expired before it ever called DWAB, so
`createDwabAuth` throws `TmConfigError` at construction rather than failing confusingly
later.

Anything else — a static dev token, a build-time baked key — implements `AuthProvider`
directly:

```ts
const auth: AuthProvider = {
  getBearer: async () => ok({ access_token: t, token_type: "Bearer", expires_in: 3600 }),
  invalidate() {},
};
```

## Errors

Fallible calls return `Result<T>` rather than throwing, because TM, DWAB and Cerberus
failures are frequent, expected and operator-actionable — not bugs. Throwing is reserved
for wiring mistakes (`TmConfigError`).

`remedy(code)` gives the fix in plain language. It matters most for TM's bare,
unexplained 401, which this package splits into three distinguishable codes in the order
you should actually check them:

1. `invalid_signature` — canonical string wrong (most often a missing trailing newline)
2. `clock_skew` — this machine's clock is too far from TM's
3. `local_api_disabled` — TM's Local API is simply off (503, sometimes 404)

Clock skew is **diagnosed, never corrected**. The observed offset relabels a 401 and is
exposed as `client.http.observedClockSkewMs`, but it never changes the outgoing
`x-tm-date`: auto-correcting would hide a dead RTC or missing NTP, which is exactly what
the operator needs told, and would let an untrusted response header steer what gets signed.

## Field set websocket

```ts
import { FieldsetSocket } from "@unsw-rcc/tm-client";
import { createNodeWebSocketFactory } from "@unsw-rcc/tm-client/node";

const socket = new FieldsetSocket({
  http: tm.http,
  fieldSetId: 1,
  webSocketFactory: await createNodeWebSocketFactory(),
});

socket.addEventListener("fieldMatchAssigned", (e) => console.log(e.detail));
socket.addEventListener("reconnecting", (e) => console.warn(e.detail));  // { attempt, delayMs }
await socket.connect();

await socket.queueNextMatch();
await socket.setAudienceDisplay(FieldsetAudienceDisplay.Rankings);
```

Reconnect backoff is `[1s, 2s, 4s, 8s, 15s, 30s]`, clamped at the last rung and reset
only after a connection that survived five seconds. Commands sent while the socket is
down are queued and flushed in order on reconnect; commands sent after an explicit
`disconnect()` fail immediately rather than queueing forever.

Note that `send()` returning `ok` can mean *queued*, not *delivered*.

**A timeout is a `fieldMatchAssigned` with an empty `match` object.** There is no type
tag for it. `reduceFieldsetState` distinguishes it by key count, as every correct
implementation of this API has had to.

## CLI

```bash
tm-cli event
tm-cli teams --division 1
tm-cli rankings 1 QUAL --json
tm-cli watch 1                 # NDJSON on stdout with --json; status chatter on stderr
tm-cli send 1 queueNextMatch
tm-cli token                   # auth mode and remaining life; never prints the secret
tm-cli sign --method GET --url ... --token ... --date ... --api-key ...
```

Config precedence is flags > env > `--config <file>`. Env: `TM_ADDRESS`, `TM_API_KEY`,
`TM_CERBERUS_ENDPOINT`, `TM_CERBERUS_KEY`, `TM_CLIENT_ID`, `TM_CLIENT_SECRET`,
`TM_EXPIRATION_DATE_MS`. Exit codes: 0 ok, 1 a `TmError`, 2 a usage or config error.

`tm-cli sign` prints the canonical string and its signature, which is the fastest way to
settle step one of a 401 investigation.

## Development

```bash
pnpm install
pnpm test          # 279 tests
pnpm typecheck
pnpm lint
pnpm build
node test/tier0.mjs    # also: bun test/tier0.mjs
pnpm mock-tm           # a mock TM that actually validates signatures
```

The signer is pinned to golden vectors shared with the C++ implementation in the
obs-plugin repo, so a third implementation cannot quietly drift from the other two. One
vector carries multi-byte UTF-8 in the key and token, which is the one input shape where
WebCrypto (which takes bytes) and `node:crypto` (which takes the string) could disagree.

`test/tier0.mjs` is framework-free and runs under node, bun and deno, because proving
cross-runtime behaviour with a test runner mostly proves the runner is portable. Deno is
currently unverified — it is not installed on the development machine.

An eslint rule keeps `node:*` out of the isomorphic core, and
`esbuild --platform=browser` on the built entry point is checked to emit no warnings.

## Migrating

Existing consumers and what they replace:

| Project | Replaces |
|---|---|
| `streamdeck-vextm` | its `vex-tm-client` dependency (unresolvable on a fresh install) and `src/tm/cerberus.ts` |
| `LED-Field-Controller` | `packages/tm-client` — gains the command senders it deliberately omitted, plus tests |
| `vtournament-ops` | `apps/lan-broker/src/tmclient.ts` |
| `obs-plugin` | nothing — it is C++, but it shares the golden vectors |

The main call-site change is that signing is now async, which is invisible unless you
were calling the signer directly. `getFieldSets` is spelled with a capital S to match
TM's `fieldSets` envelope key, though the path remains `/api/fieldsets`.

## Licence

MIT
