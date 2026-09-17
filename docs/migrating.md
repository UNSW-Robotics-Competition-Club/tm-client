# Migrating from `vex-tm-client`

`vex-tm-client@1.5.3` was unpublished from npm on 2026-08-26 and its GitHub repository went
with it. No fork carries the name, so `npm install` cannot resolve it at any version. Three
projects in this repo set depend on it — one directly, two through vendored copies that had
already started to drift from each other — and this package is the single implementation
they move onto.

| Project | What it depends on today | Urgency |
|---|---|---|
| `streamdeck-vextm` | the npm package itself | **Highest.** A fresh clone cannot install. |
| `LED-Field-Controller` | `packages/tm-client`, a vendored copy | Works, but read-only and untested. |
| `vtournament-ops` | `apps/lan-broker/src/tmclient.ts`, another vendored copy | Works, with one live bug (below). |

The `obs-plugin` is C++ and is not affected; it shares the golden signing vectors, so a
divergence between the two implementations fails a test rather than an event.

## Install

```bash
npm install @unsw-robotics-competition-club/tm-client
npm install ws          # only where the field set socket is used
npm uninstall vex-tm-client
```

During development against a checkout, a `file:` dependency works and is what
`streamdeck-vextm` already uses:

```json
{ "dependencies": { "@unsw-robotics-competition-club/tm-client": "file:../TM-Auth" } }
```

For the two vendored copies, migration means **deleting the vendored file** and importing
from the package instead. Resist the temptation to keep it as a fallback; two copies is how
this situation arose.

## The shape of the change

Four things reach your call sites. Everything else is a rename.

1. **Signing is async**, because it now uses WebCrypto rather than `node:crypto`. Invisible
   unless you called the signer directly, but `getAuthorizationHeaders()` was synchronous
   and its replacement is not.
2. **`APIResult` becomes `Result`**, with `ok` in place of `success` and a structured
   `error` object in place of a string enum.
3. **The field set socket is an `EventTarget`, not an `EventEmitter`.** `.on(...)` becomes
   `addEventListener(...)` and the payload moves into `event.detail`.
4. **The socket needs a transport under anything that is not Node or Bun.**

## API map

### Construction and auth

```ts
// before
const client = new Client({
  address: "http://192.168.1.50",
  clientAPIKey: apiKey,
  bearerMargin: 300_000,
  authorization: {
    client_id, client_secret,
    grant_type: "client_credentials",
    expiration_date,          // milliseconds
  },
});
await client.connect();       // mints the bearer, probes TM

// after
const tm = new TmClient({
  baseUrl: "http://192.168.1.50",
  apiKey,
  auth: createDwabAuth({
    clientId, clientSecret,
    expirationDateMs: expiration_date,
    marginMs: 300_000,
  }),
});
// no connect(): the first call that needs a bearer mints one
```

| Before | After |
|---|---|
| `address` | `baseUrl` |
| `clientAPIKey` | `apiKey` |
| `bearerMargin` | `marginMs`, on the auth provider |
| `authorization: { client_id, client_secret, grant_type, expiration_date }` | `auth: createDwabAuth({ clientId, clientSecret, expirationDateMs })` |
| `manualAuthorization: { getBearer }` | `auth: <your AuthProvider>` |
| `client.connect()` | nothing; or `tm.getEvent()` as an explicit pre-flight |
| `client.bearerToken = null; client.bearerExpiration = null` | `tm.http.invalidateBearer()` |
| `client.getAuthorizationHeaders(url, method)` → `Headers` | `await tm.http.authHeadersFor(url, method)` → `Result<Record<string, string>>` |

`connect()` has no replacement because there is nothing for it to do: the bearer is minted
lazily, cached, and shared by every call including the websocket upgrade. Where you want an
explicit "are we good?" step before an event starts, call `getEvent()` and check the
`Result` — that exercises the bearer, the signature and TM's reachability in one go.

If you were passing a `manualAuthorization` object with a `getBearer` that returned
`{ success: true, token: {...} }`, the new `AuthProvider` returns
`Result<BearerToken>` — `ok({ access_token, token_type, expires_in })` — and adds an
`invalidate()` method. See [authentication.md](authentication.md#implementing-authprovider-yourself).

### Results

```ts
// before
const res = await client.getEventInfo();
if (!res.success) throw new Error(describe(res.error));   // error: a TMErrors string enum
use(res.data);

// after
const res = await tm.getEvent();
if (!res.ok) throw new Error(`${res.error.message} — ${remedy(res.error.code)}`);
use(res.data);
```

`error` is now `{ code, message, detail?, httpStatus? }`. `code` is a `TmErrorCode` from a
closed union of nineteen, and `remedy(code)` returns the operator-facing fix. The old
`TMErrors` enum collapsed several distinct failures — notably a bad signature, a skewed
clock and a disabled Local API — into strings that read the same to whoever is holding the
laptop. The mapping is roughly:

| `TMErrors` | `TmErrorCode` |
|---|---|
| `CredentialsExpired` | `dwab_credentials_expired` |
| `CredentialsInvalid` | `dwab_invalid_client` |
| `CredentialsError` | `dwab_unreachable` |
| `WebServerConnectionError` | `host_unreachable` |
| `WebServerNotEnabled` | `local_api_disabled` |
| `WebserverInvalidSignature` | `invalid_signature`, or `clock_skew` when the drift explains it |
| `WebServerError` | `http_error`, or `malformed_response` when the body is not the expected shape |
| `WebSocketError` | `ws_connection_error` |
| `WebSocketClosed` | `ws_closed` |
| — | `ws_headers_unsupported` (new: this runtime cannot sign the upgrade) |

There is also a new success detail: `Result` carries `cached: true` when TM answered 304 and
the library served the body it already held. Ignore it if you do not care.

### REST calls

| Before | After |
|---|---|
| `client.getEventInfo()` | `tm.getEvent()` |
| `client.getDivisions()` → `Division[]` (class instances) | `tm.getDivisions()` → `{ id, name }[]` |
| `client.getTeams()` | `tm.getTeams()` |
| `division.getTeams()` | `tm.getTeams(division.id)` |
| `division.getMatches()` | `tm.getMatches(division.id)` |
| `division.getRankings(round)` | `tm.getRankings(division.id, round)` |
| `client.getSkills()` | `tm.getSkills()` |
| `client.getFieldsets()` → `Fieldset[]` (class instances) | `tm.getFieldSets()` → `{ id, name }[]` |
| `fieldset.getFields()` | `tm.getFields(fieldSet.id)` |

Two structural changes here. **`getFieldSets` has a capital S**, matching TM's `fieldSets`
envelope key — the path is still `/api/fieldsets`, TM is inconsistent with itself. And
`Division` and `Fieldset` are no longer classes that carry a client reference; they are
plain data, and the operations that hung off them take an id instead. Code that passed a
`Division` around now passes a number, which is usually a simplification and occasionally a
small refactor.

If you prefer free functions over the facade, all eight are exported and take a
`TmHttpClient`: `getEvent(http)`, `getRankings(http, divisionId, round)`, and so on.
`TmClient` is a thin wrapper over exactly those.

### The field set socket

```ts
// before
const fieldsets = await client.getFieldsets();
const fieldset = fieldsets.data.find((fs) => fs.id === 1)!;
await fieldset.connect();
fieldset.on("message", (event) => handle(event));
fieldset.on("matchStarted", (event) => started(event.fieldID));
fieldset.websocket?.once("close", () => reconnectYourself());
await fieldset.send({ cmd: "start", fieldID: 1 });
fieldset.disconnect();

// after
const socket = new FieldsetSocket({
  http: tm.http,
  fieldSetId: 1,
  webSocketFactory: await createNodeWebSocketFactory(),   // optional under Node
});
socket.addEventListener("message", (e) => handle((e as CustomEvent).detail));
socket.addEventListener("matchStarted", (e) => started((e as CustomEvent).detail.fieldID));
socket.addEventListener("close", (e) => log((e as CustomEvent).detail.reason));  // it reconnects itself
await socket.connect();
await socket.startMatch(1);
socket.disconnect();
```

| Before | After |
|---|---|
| `fieldset.on(type, fn)` / `once` / `off` | `socket.addEventListener(type, fn)` / `{ once: true }` / `removeEventListener` |
| `fn(event)` | `fn(e)` with the payload at `e.detail` |
| `fieldset.websocket` (the raw `ws` socket) | not exposed; listen for `close` and `reconnecting` |
| `fieldset.state` | `socket.state` (same shape, and `statechange` fires on every change) |
| `fieldset.connect()` → `APIResult<WebSocket>` | `socket.connect()` → `Result<void>` |
| `fieldset.send(command)` | `socket.send(command)`, or the eight named helpers |
| your own reconnect ladder | built in |

The socket also needs a transport under anything that is not Node or Bun, and **cannot run
in a browser at all** — TM signs the upgrade and the WebSocket spec forbids handshake
headers. [fieldset-socket.md](fieldset-socket.md) covers the injection point and what the
`ws_headers_unsupported` result means.

### Signing

```ts
// before
const headers = client.getAuthorizationHeaders(url, "GET");          // Headers, sync

// after
const headers = await tm.http.authHeadersFor(url, "GET");            // Result<Record<string,string>>
if (!headers.ok) return headers;
```

Or, if you were building the canonical string yourself:

```ts
import { stringToSign, signTmRequest } from "@unsw-robotics-competition-club/tm-client";

const canonical = stringToSign({ method, url, token, tmDate });      // still synchronous
const signature = await signTmRequest({ method, url, token, tmDate, apiKey });
```

The algorithm is unchanged, down to the trailing newline, and the output is pinned by
golden vectors shared with the C++ implementation. Only the async boundary is new.

## Type changes that will break a build

These are deliberate. In each case the old type contradicted what TM actually sends, and
nothing had noticed because no copy read the field — which is exactly the kind of bug that
surfaces at a venue.

**`Ranking.alliance` is an object, not an array.**

```ts
// before, and wrong
alliance: RankAlliance[];
const team = ranking.alliance?.[0]?.teams?.[0]?.number ?? "";   // always ""

// after
alliance: RankAlliance;              // { name: string; teams: { number: string }[] }
const team = ranking.alliance.teams[0]?.number ?? "";
```

The API guide shows a single object and TM sends one. `vtournament-ops`'s
`apps/lan-broker/src/map.ts` has the first form in `mapRankings`, so every ranking it
publishes carries an empty team name — a real, live bug that this migration fixes by
failing to compile.

**`Ranking.tied` is `boolean`.** The published typings had it as the literal `false`, which
made `if (ranking.tied)` narrow to `never` and quietly dead. The vendored copies had already
widened it by hand.

**`FieldsetEventFieldMatchAssigned.fieldID` is `number | null`.** Upstream checked for the
null at runtime while typing the field `number`, so every consumer was one real event away
from a crash the compiler had promised was impossible. `null` means the queue was cleared.
Anywhere you use it, narrow first:

```ts
if (event.fieldID === null) return;          // queue cleared
const name = fieldNames.get(event.fieldID);
```

**A timeout is still a `fieldMatchAssigned` with an empty `match` object**, detected by key
count. That has not changed, and any code you have doing `Object.keys(event.match).length`
is correct and should stay.

## Behaviour that changes for the better

Two bugs confirmed in the surviving upstream source are fixed here, which means some
failure modes simply stop happening. Both are worth knowing about, because if you had
worked around them the workaround is now redundant.

**A 401 no longer leaves a rejected bearer cached.** Upstream (`Client.ts:460`) returned the
error but kept the token, so a bearer TM had already refused was retried for up to an hour —
a field stuck mid-tournament, failing identically every thirty seconds and blaming the API
key for it. Here a 401 or 403 invalidates the bearer *and* that URL's conditional-GET entry,
so a stale body cannot come back via a 304 issued against a dead token. The socket does the
same when a drop reason mentions 401 or 403.

*How to spot it:* if you had code like `client.bearerToken = null; client.bearerExpiration =
null` in a failure handler — `streamdeck-vextm`'s `TmServer.invalidateBearer()` is exactly
this — delete it. The library now does it, and doing it twice is harmless but misleading.

**Concurrent cold-start calls mint one token, not N.** Upstream's `ensureBearer()`
(`Client.ts:215`) had no single-flight guard, so a client with several readers minted one
token per reader at match start. Here they share one in-flight request.

*How to spot it:* count requests to the token endpoint in a test. The integration suite
asserts exactly this — four calls, three of them concurrent from a cold cache, produce one
mint. If you had staggered your startup reads to avoid a thundering herd, you can stop.

There is also a third, smaller change: `expires_in` on a cached token is now the *remaining*
life, recomputed on every read, rather than the issuer's original number re-served. Code
that logged "token valid for 7200s" forty minutes into an event was being lied to.

## Per project

### `streamdeck-vextm` — do this one first

Its `vex-tm-client` dependency cannot be resolved on a fresh clone, so the repository does
not build for anyone who has not got a stale `node_modules`. The migration is also
partly staged already: `package.json` points at `file:../TM-Auth`, and
`src/tm/cerberus.ts` and `test/cerberus.test.ts` have been deleted — which means
`src/tm/connection.ts` currently imports a file that is not there.

Files importing `vex-tm-client` today:

```
src/actions/audience-display.ts     FieldsetAudienceDisplay
src/actions/match-control.ts        FieldsetCommand
src/actions/queue.ts                FieldsetQueueSkillsType, FieldsetCommand
src/tm/clock.ts                     FieldsetQueueSkillsType, MatchRound
src/tm/connection.ts                Client, TMErrors, Field, Fieldset, FieldsetCommand
src/tm/format.ts                    MatchRound, MatchTuple
src/tm/registry.ts                  Field
src/tm/settings.ts                  FieldsetAudienceDisplay
src/tm/view.ts                      (state and event types)
test/registry.test.ts, test/settings.test.ts, test/view.test.ts
scripts/probe-timeout.ts            Client, Fieldset, FieldsetCommand
```

Most of those are pure type and enum imports where the migration is a one-line change of
specifier — the enum members and wire values are identical. The work is concentrated in two
places:

- **`src/tm/cerberus.ts` is gone; use the package's provider.** Its options differ slightly:
  the local copy took `margin`, the package takes `marginMs`, and — the one that will not
  fail loudly — the local copy exposed `lastFailure` as a *property* while the package
  exposes `lastFailure()` as a *method*. `connection.ts` reads
  `this.cerberus?.lastFailure ?? describe(error)`, which against the new object yields a
  function rather than a string and is therefore always truthy. Add the parentheses.

- **`src/tm/connection.ts` loses most of itself.** `TmConnection`'s reconnect ladder is the
  same `[1s, 2s, 4s, 8s, 15s, 30s]` the library now implements (it was ported from here,
  along with the healthy-connection rule and the 401 handling), and `TmServer.failed()` /
  `invalidateBearer()` duplicate what `TmHttpClient` and `FieldsetSocket` now do. What
  remains worth keeping is the Stream Deck-specific part: the `view` projection, the
  per-action registry, and the single-connection-per-server sharing.

`fieldset.on("message", ...)` becomes `socket.addEventListener("message", ...)` with
`e.detail`, and the `fieldset.websocket?.once("close", ...)` plumbing that drove
reconnection can go — the socket reconnects itself and reports it through `close` and
`reconnecting`.

Keep the baked-key machinery (`src/tm/baked.ts`, `scripts/require-baked-key.mjs`): the
package deliberately ships no helper for build-time keys, and that code feeds a `ctm_` key
into `createCerberusAuth` unchanged.

### `LED-Field-Controller`

Delete `packages/tm-client` — both `tmclient.ts` (the vendored `vex-tm-client` subset) and
`cerberus.ts` (a second, independently drifted broker client) — and point
`apps/controller` at the package instead. Its consumer is
`apps/controller/src/tm/source.ts`, which uses `Client`, `Fieldset`, `CerberusAuth` and
`FieldsetEvent`.

Specific notes:

- `TmClientLike = Pick<Client, "connect" | "getFieldsets">` is a test seam over a
  `connect()` that no longer exists. Narrow it to what you actually use —
  `Pick<TmClient, "getFieldSets">` — or inject a `FieldsetHttp` and drop the seam entirely,
  since `FieldsetSocket` accepts any object with `authHeadersFor`, `resolve` and
  `invalidateBearer`.
- The vendored copy **deliberately omitted the command senders** so that a light controller
  could not start a match by accident. The package ships all eight. If that restriction
  still matters, enforce it in `source.ts` rather than by omission — the constraint is a
  product decision and it deserves to be visible.
- The local `cerberus.ts` already used `marginMs` and `lastFailure()`, so that call site
  moves across unchanged.
- `#closeFieldset()` plus the "Fieldset itself emits no close event, so watch the socket"
  workaround can go; `close` and `reconnecting` are first-class events now.

### `vtournament-ops`

`apps/lan-broker/src/tmclient.ts` is the copy the others were vendored from. Delete it and
import from the package. Its consumers are `src/tm.ts` (the `TmSource` class) and
`src/map.ts` (pure mapping).

Specific notes:

- **Fix `mapRankings` while you are there.** `r.alliance?.[0]?.teams?.[0]?.number ?? ""`
  reads an array that is actually an object, so every published ranking carries an empty
  team name. It becomes `r.alliance.teams[0]?.number ?? ""`, and the compiler will point at
  it.
- `TmSource.ensureConnected()` calls `client.connect()` and branches on `res.origin ===
  "bearer"`. There is no `connect()` and no `origin`; use a first read as the pre-flight and
  branch on `error.code` instead, which distinguishes the bearer cases
  (`dwab_*`, `cerberus_*`) from the TM-side ones by construction.
- `subscribeFieldsets()` opens a socket per field set and registers four `fs.on(...)`
  listeners. Each becomes a `FieldsetSocket` plus `addEventListener`, and the
  `"fieldID" in event ? event.fieldID : null` guard stays — but now also has to handle
  `fieldID === null` on `fieldMatchAssigned`, which the type will insist on.
- The broker's `devToken` path is a `manualAuthorization` with a fixed bearer. That becomes
  a three-line `AuthProvider`; see
  [authentication.md](authentication.md#a-static-token-for-development).
- The broker runs under Bun for its compiled builds (`bun build --compile`). Bun can sign
  the handshake through its non-standard `{ headers }` constructor and the library detects
  it, but Bun's header support has regressed before — if a compiled build fails to open a
  socket while `node src/index.ts` succeeds, pass an explicit `webSocketFactory` rather
  than debugging the runtime.

## Checklist

- [ ] `vex-tm-client` removed from `package.json`; vendored copies deleted, not kept "just in case".
- [ ] `ws` installed wherever a field set socket is opened.
- [ ] `success` → `ok`; error strings → `error.code` + `remedy(error.code)`.
- [ ] `getEventInfo` → `getEvent`, `getFieldsets` → `getFieldSets`.
- [ ] `Division` / `Fieldset` instance methods → id arguments.
- [ ] `client.connect()` removed, or replaced by a `getEvent()` pre-flight.
- [ ] `.on(...)` → `addEventListener(...)`, payloads read from `e.detail`.
- [ ] Hand-rolled reconnect ladders, outboxes and bearer-invalidation handlers deleted.
- [ ] `ranking.alliance` treated as an object.
- [ ] `fieldID === null` handled on `fieldMatchAssigned`.
- [ ] Any direct signing call awaited.
- [ ] Run against `pnpm mock-tm` — it validates signatures properly, and `--scenario`
      forces the failures you are about to rewrite the handling for.

Anything that does not map cleanly is worth raising rather than working around: the point of
this package is that there is one implementation to fix.
