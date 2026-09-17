# API reference

Everything `@unsw-robotics-competition-club/tm-client` exports, organised by module. Names
and defaults here are read from the source; if this file and `src/` ever disagree, `src/`
wins and this file is a bug.

There are two entry points:

| Specifier | Contains |
|---|---|
| `@unsw-robotics-competition-club/tm-client` | everything below. Isomorphic: `fetch`, `URL` and `crypto.subtle` only. |
| `@unsw-robotics-competition-club/tm-client/node` | `createNodeWebSocketFactory` and nothing else. |

The split exists so a bundler targeting a browser never has to resolve the optional `ws`
dependency. Nothing under `.` imports `node:*`, and a lint rule enforces that.

- [The `Result` contract](#the-result-contract)
- [`TmClient`](#tmclient)
- [`TmHttpClient`](#tmhttpclient)
- [Resource functions](#resource-functions)
- [Authentication](#authentication)
- [Request signing](#request-signing)
- [Field set socket](#field-set-socket)
- [Entity types and enums](#entity-types-and-enums)

---

## The `Result` contract

Every fallible operation in this package returns a `Result<T>` instead of throwing. TM,
DWAB and Cerberus failures are frequent, expected and something an operator can act on —
they are not bugs, and a `try`/`catch` around every call reads as though they were.
Throwing is reserved for wiring mistakes, which is `TmConfigError`; see
[errors.md](./errors.md) for the full split.

```ts
type Result<T> =
  | { readonly ok: true; readonly data: T; readonly cached: boolean }
  | { readonly ok: false; readonly error: TmError };
```

You narrow it on `.ok`. TypeScript's discriminated-union narrowing means `data` is only
reachable in the `true` branch and `error` only in the `false` one, so there is no way to
read a field that is not there:

```ts
const event = await tm.getEvent();
if (!event.ok) {
  console.error(event.error.message);
  console.error(remedy(event.error.code));
  return;
}
console.log(event.data.name, event.cached ? "(from cache)" : "");
```

`cached` is `true` when the value came from the conditional-GET store rather than a fresh
body — that is, TM answered `304 Not Modified`. It is on the success branch only, because
a failure has nothing to have been cached.

### `TmError`

```ts
interface TmError {
  readonly code: TmErrorCode;
  readonly message: string;      // short, technical
  readonly detail?: unknown;     // response body, or the thrown cause
  readonly httpStatus?: number;
}
```

`message` describes what happened. It is not the sentence you put in front of an operator
— `remedy(code)` is. `detail` carries the response body on an HTTP failure and the thrown
error on a transport failure, so it is useful in a log and never useful in a UI.

### `ok(data, cached?)` and `err(code, message, options?)`

```ts
function ok<T>(data: T, cached?: boolean): Result<T>;                 // cached defaults to false
function err<T = never>(
  code: TmErrorCode,
  message: string,
  options?: { detail?: unknown; httpStatus?: number },
): Result<T>;
```

Exported so you can build a `Result` in your own `AuthProvider` or `WebSocketFactory`
without reaching for an object literal and getting the field names subtly wrong. `err`
omits `detail` and `httpStatus` from the constructed error entirely when they are
`undefined`, rather than setting them to `undefined`, so `"httpStatus" in error` is a
meaningful test.

### `remedy(code)` and `shouldInvalidateBearer(code)`

```ts
function remedy(code: TmErrorCode): string;
function shouldInvalidateBearer(code: TmErrorCode): boolean;
```

`remedy` returns the operator-facing fix for a code — one sentence or two, naming the
actual thing to change. The switch inside it is exhaustive over `TmErrorCode`, so adding
a code without a remedy fails the build. That is deliberate: an error nobody can act on
is barely better than no error.

`shouldInvalidateBearer` answers whether a failure means the cached token can no longer
be trusted. `TmHttpClient` already calls it for you on every failed response; you need it
only if you are writing your own transport. Both functions are pure, synchronous and take
a code rather than a whole error, so they are usable from a reducer or a render path.

### `TmConfigError`

```ts
class TmConfigError extends Error {
  readonly name: "TmConfigError";
}
```

Thrown — not returned — for the cases where the caller has wired something up wrong and
retrying cannot help: a `baseUrl` that is not a URL, a runtime with no `fetch` and no
`fetch` option, a DWAB `expirationDateMs` that is obviously seconds. All three fail at
construction, while the offending configuration is still in view.

---

## `TmClient`

The facade most consumers use. It holds one `TmHttpClient`, so the conditional-GET cache
and the observed clock skew are shared across every endpoint, and exposes the eight read
resources as methods.

```ts
new TmClient(options: TmClientOptions)
```

`TmClientOptions` is an alias for [`TmHttpClientOptions`](#tmhttpclientoptions) — the same
object, no extra fields.

```ts
import { TmClient, createCerberusAuth, MatchRound, remedy } from "@unsw-robotics-competition-club/tm-client";

const tm = new TmClient({
  baseUrl: "http://192.168.1.50",
  apiKey: process.env.TM_API_KEY!,
  auth: createCerberusAuth({
    endpoint: "https://tm.unswrobotics.com",
    apiKey: process.env.TM_CERBERUS_KEY!,
    build: { version: "0.1.0" },
  }),
});

const rankings = await tm.getRankings(1, MatchRound.Qualification);
if (rankings.ok) {
  for (const row of rankings.data) {
    console.log(`#${row.rank}${row.tied ? "=" : " "} ${row.wp}WP ${row.ap}AP`);
  }
} else {
  console.error(remedy(rankings.error.code));
}
```

| Member | Type |
|---|---|
| `http` | `TmHttpClient` — the signed transport, read-only |
| `getEvent()` | `Promise<Result<EventInfo>>` |
| `getDivisions()` | `Promise<Result<Division[]>>` |
| `getTeams(divisionId?)` | `Promise<Result<Team[]>>` |
| `getMatches(divisionId)` | `Promise<Result<Match[]>>` |
| `getRankings(divisionId, round)` | `Promise<Result<Ranking[]>>` |
| `getSkills()` | `Promise<Result<SkillsRanking[]>>` |
| `getFieldSets()` | `Promise<Result<FieldSetInfo[]>>` |
| `getFields(fieldSetId)` | `Promise<Result<Field[]>>` |

`http` is public because the field set socket needs the same signed transport to sign its
upgrade, and because a caller occasionally needs a raw path. Each method delegates to the
matching free function in [Resource functions](#resource-functions); there is no behaviour
in `TmClient` beyond holding the transport.

---

## `TmHttpClient`

The signed transport. Use it directly when you want one endpoint rather than eight, or
when you are calling a path this package does not model.

```ts
new TmHttpClient(options: TmHttpClientOptions)
```

### `TmHttpClientOptions`

| Option | Type | Default | Notes |
|---|---|---|---|
| `baseUrl` | `string` | — required | `http://192.168.1.50` or `http://127.0.0.1:8080/`. Either form works, and a sub-path (`http://host/tm`) is kept rather than replaced. |
| `apiKey` | `string` | — required | The event's TM API key, from TM's Web Publishing options. This is the HMAC signing secret. |
| `auth` | `AuthProvider` | — required | Supplies the bearer. See [Authentication](#authentication). |
| `fetch` | `typeof fetch` | `globalThis.fetch`, bound | Throws `TmConfigError` at construction if neither is available. |
| `now` | `() => number` | `() => Date.now()` | Epoch milliseconds. Drives `x-tm-date` and the skew calculation. |
| `maxClockSkewMs` | `number` | `300_000` (5 minutes) | Above this, a 401 is reported as `clock_skew` rather than `invalid_signature`. |

A `baseUrl` that `new URL()` rejects throws `TmConfigError` from the constructor. That is
a wiring mistake rather than a runtime failure, and letting it through would turn every
subsequent call into the same error forever.

### `get<T>(path)`

```ts
get<T>(path: string): Promise<Result<T>>
```

Signs and issues one GET, and returns the parsed body. `T` is unchecked — `get` casts —
so prefer the [resource functions](#resource-functions), which validate the envelope
before handing anything back.

What it does, in order: resolves the path against `baseUrl`, asks the `AuthProvider` for a
bearer, builds the four signed headers, drops `Host` (Fetch forbids it, and it is not part
of the canonical string), attaches `If-Modified-Since` if this exact URL has a cached
`Last-Modified`, and fetches. On every response, including failures, it records the clock
skew from the server's `Date` header before classifying anything — the skew reading is
precisely what tells a wrong clock from a wrong API key when TM answers a bare 401.

A failure whose code satisfies `shouldInvalidateBearer` drops both the cached bearer and
this URL's cache entry. Dropping the cache entry matters as much as dropping the token: if
it survived, the next call would re-send a token TM has already refused and, on the 304
that followed, hand back a stale body as though it were fresh.

A `304` with no corresponding cache entry is reported as `malformed_response` rather than
guessed at.

### `resolve(path)`

```ts
resolve(path: string): URL
```

The absolute URL a path will be fetched from. The base is normalised to end in `/` and the
path stripped of its leading `/`, so a trailing slash on the address makes no difference
and a base sub-path survives. The port survives both forms, which matters because
`url.host` is what gets signed — losing `:8080` here is an instant 401 with no explanation.

### `authHeadersFor(url, method?)`

```ts
authHeadersFor(url: URL, method?: string): Promise<Result<Record<string, string>>>
```

`method` defaults to `"GET"`. Returns all four headers **including `Host`**, unlike the
REST path, which strips it. This exists for the field set socket, whose upgrade must be
signed the same way but cannot go through `get()`; the `ws` and `node:http` paths do
honour `Host`, which matters if TM is reached through a name-based reverse proxy.

### `observedClockSkewMs`

```ts
get observedClockSkewMs(): number
```

How many milliseconds this machine's clock is **ahead** of the TM server's, as measured
from the last response's `Date` header. Negative means this machine is behind. It is
diagnosed and never corrected: auto-correcting the outgoing `x-tm-date` would paper over a
dead RTC or a machine with no NTP, which is the one thing the operator needs told, and it
would let an untrusted response header steer what gets signed.

### `invalidateBearer()`

```ts
invalidateBearer(): void
```

Forwards to `auth.invalidate()`. Called for you on an authorization failure; call it
yourself only if you have out-of-band reason to distrust the token.

### The cache

One `Map` per client, keyed by the full URL including its query string, storing the parsed
body and the `Last-Modified` value that came with it. A 200 with no `Last-Modified` is not
cached. Entries are dropped on an authorization failure and never otherwise — the key
space is the set of endpoint URLs you actually call, which is small and fixed.

---

## Resource functions

The eight read endpoints, as free functions over a `TmHttpClient`. They are free functions
rather than methods so the transport stays testable without a resource in sight and so a
consumer can tree-shake the endpoints it never calls. `TmClient` re-exposes all eight as
methods.

```ts
getEvent(http): Promise<Result<EventInfo>>
getDivisions(http): Promise<Result<Division[]>>
getTeams(http, divisionId?): Promise<Result<Team[]>>
getMatches(http, divisionId): Promise<Result<Match[]>>
getRankings(http, divisionId, round): Promise<Result<Ranking[]>>
getSkills(http): Promise<Result<SkillsRanking[]>>
getFieldSets(http): Promise<Result<FieldSetInfo[]>>
getFields(http, fieldSetId): Promise<Result<Field[]>>
```

| Function | Path | Envelope key |
|---|---|---|
| `getEvent` | `/api/event` | `event` |
| `getDivisions` | `/api/divisions` | `divisions` |
| `getTeams` | `/api/teams`, or `/api/teams/{divisionId}` | `teams` |
| `getMatches` | `/api/matches/{divisionId}` | `matches` |
| `getRankings` | `/api/rankings/{divisionId}/{round}` | `rankings` |
| `getSkills` | `/api/skills` | `skillsRankings` |
| `getFieldSets` | `/api/fieldsets` | `fieldSets` |
| `getFields` | `/api/fieldsets/{fieldSetId}/fields` | `fields` |

Two of those envelope keys do not match their paths, and both have caught people out: the
skills body is keyed `skillsRankings` and not `skills`, and the field set body is keyed
`fieldSets` while the path is spelled `fieldsets`. That is why `getFieldSets` has a capital
S and `getFields` does not.

Every TM response is wrapped in a single-key envelope, and each function unwraps it. A
missing key, or a key holding the wrong shape (an array where an object belongs, or the
reverse), is reported as `malformed_response` with the whole body in `detail`, rather than
handed on as `undefined`. TM version drift is the usual cause, and a caller who gets
`undefined` out of a typed field finds out about it somewhere far less useful. The `cached`
flag from the transport is preserved through unwrapping, and a transport failure passes
through unchanged rather than being relabelled.

```ts
import { TmHttpClient, getSkills } from "@unsw-robotics-competition-club/tm-client";

const http = new TmHttpClient({ baseUrl, apiKey, auth });
const skills = await getSkills(http);
if (skills.ok) {
  const leader = skills.data[0];
  if (leader) console.log(`${leader.number}: ${leader.totalScore}`);
}
```

---

## Authentication

TM requires two independent credentials. The **TM API key** is per-event, comes from the
Event Partner's Web Publishing options, and is the HMAC signing secret — it stays on the
local machine and is passed to `TmHttpClient`, not to an auth provider. The **bearer
token** proves your application is approved for API access at all, and is what an
`AuthProvider` supplies.

### `AuthProvider`

```ts
interface AuthProvider {
  getBearer(): Promise<Result<BearerToken>>;
  invalidate(): void;
}

interface BearerToken {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
}
```

This is the documented extension point. The two shipped providers are ordinary
implementations of it with no privileged access to anything, so a third is a peer and not a
workaround.

`invalidate()` must drop any cached token. It is called when TM rejects a request as
unauthorized, and it must take effect even for a mint that is already in flight — otherwise
the response that arrives afterwards can quietly re-cache the very token TM just refused.
Both shipped providers do this with a generation counter.

`expires_in` is a contract, not a field you copy through: it must **always** be the
remaining life in seconds, recomputed on every read, never the number the issuer returned
at grant time. Re-serving the original tells a later caller it has far more time left than
it does, and the caller then skips a refresh it needed.

A static token for development is three lines:

```ts
import { ok, type AuthProvider } from "@unsw-robotics-competition-club/tm-client";

const auth: AuthProvider = {
  getBearer: async () => ok({ access_token: token, token_type: "Bearer", expires_in: 3600 }),
  invalidate() {},
};
```

That provider is honest only if `token` really does have an hour left. If you are baking in
a token with a known expiry, compute the remaining life on each call rather than returning
a constant.

### `createCerberusAuth(options)`

```ts
function createCerberusAuth(options: CerberusAuthOptions): CerberusAuth;
```

Cerberus is a token broker: it holds one organisation-wide DWAB credential server-side and
mints short-lived bearers for clients presenting a revocable `ctm_` key, so the long-lived
secret never ships to a venue laptop. It is not in the TM data path — the TM API key stays
local, and the two secrets only ever meet inside a signature.

| Option | Type | Default | Notes |
|---|---|---|---|
| `endpoint` | `string` | — required | Base URL, e.g. `https://tm.unswrobotics.com`. Trailing slashes are stripped. |
| `apiKey` | `string` | — required | The client key, `ctm_<16 hex>_<48 hex>`. |
| `build` | `{ version: string; hash?: string }` | — required | Sent as `x-cerberus-build`. The version is checked against the server's floor. |
| `event` | `{ code?, name?, sku? }` | none | Attribution telemetry, never authorization. |
| `marginMs` | `number` | `300_000` (5 minutes) | Refetch once less than this much life remains. |
| `fetch` | `typeof fetch` | `globalThis.fetch`, bound | Injectable for tests. |
| `now` | `() => number` | `Date.now` | Injectable for tests. |

The key's shape is checked locally, against `/^ctm_[0-9a-fA-F]{16}_[0-9a-fA-F]{48}$/`,
before any network call. A key truncated by a bad copy-paste is the common failure, and
naming it without a round trip is both faster and unambiguous, because Cerberus answers a
malformed key and a revoked key with the same 401. Uppercase hex is accepted.

The request is `POST {endpoint}/v1/token` with `Authorization: Bearer {apiKey}` and
`x-cerberus-build: {version}` — or `{version}/{hash}` when a hash is known. When an event
is set, `x-cerberus-event`, `x-cerberus-event-name` and `x-cerberus-event-sku` are added
for whichever fields are non-empty.

`CerberusAuth` extends `AuthProvider` with three members:

```ts
interface CerberusAuth extends AuthProvider {
  lastFailure(): string | null;
  setEvent(event: { code?: string; name?: string; sku?: string }): void;
  setBuildHash(hash: string): void;
}
```

`lastFailure()` is the sentence to put on a screen — `TmError.code` is what you switch on,
this is what you show. It is `null` when the last mint succeeded. The two setters exist
because the event is only known after TM has been asked which one it is running, and the
build hash is often read from disk asynchronously; both take effect on the next mint.

```ts
const auth = createCerberusAuth({
  endpoint: "https://tm.unswrobotics.com",
  apiKey: process.env.TM_CERBERUS_KEY!,
  build: { version: "0.1.0" },
});

const tm = new TmClient({ baseUrl: "http://192.168.1.50", apiKey, auth });

const event = await tm.getEvent();
if (event.ok) auth.setEvent({ code: event.data.code, name: event.data.name });

const status = auth.lastFailure();
if (status) console.warn(status);
```

Three behaviours are worth knowing because they change what your error handling has to
cover:

- **Single-flight.** Concurrent `getBearer()` calls from a cold cache share one request.
  A client with several TM readers should make one token request at match start, not one
  per reader.
- **Stale-token fallback.** A failed refresh does not throw away a token that still works.
  Venues lose their internet constantly while TM stays on the LAN, so `getBearer()` returns
  the existing token if it has any life left and only surfaces the failure once it does
  not. `lastFailure()` still reports the refusal, which is how you notice.
- **`upgrade_required` names the floor.** Cerberus reports the minimum version in a
  separate `minimum` field, so the composed message reads *"Client version below the
  supported minimum (minimum 0.2.0, this build is 0.1.0)"* rather than leaving the operator
  to guess what is new enough.

A 200 that is not a usable token — a captive portal's HTML login page is how this actually
happens — is refused as `cerberus_upstream_error` rather than cached. Caching an undefined
`expires_in` gives an expiry of `NaN`, which reads as permanently stale, so every TM request
would mint again and a venue would rate-limit itself out of its own event.

### `createDwabAuth(options)`

```ts
function createDwabAuth(options: DwabAuthOptions): AuthProvider;
```

Direct OAuth2 client-credentials against DWAB, at the fixed URL
`https://auth.vextm.dwabtech.com/oauth2/token`. Use this only where the long-lived
organisation credential can safely live on the machine; venue laptops should use the broker.

| Option | Type | Default | Notes |
|---|---|---|---|
| `clientId` | `string` | — required | |
| `clientSecret` | `string` | — required | |
| `expirationDateMs` | `number` | — required | When the **credential** expires, in milliseconds since the epoch. Not the token. |
| `marginMs` | `number` | `300_000` (5 minutes) | Refetch once less than this much token life remains. |
| `fetch` | `typeof fetch` | `globalThis.fetch`, bound | Injectable for tests. |
| `now` | `() => number` | `Date.now` | Injectable for tests. |

`expirationDateMs` below `1_000_000_000_000` throws `TmConfigError` at construction. That
threshold is 2001-09-09, and no real credential predates the API, so anything smaller is a
seconds value that was meant to be milliseconds. Left alone it fails in the most confusing
way available: a ten-digit value reads as 1970, so a perfectly good credential is reported
expired and DWAB is never called at all.

The provider checks the credential's expiry locally before each mint, because DWAB would
only answer an expired credential with a generic rejection and the local check names the
actual problem. It is single-flight and has the same stale-token fallback as the Cerberus
provider. A non-200 carrying `{"error": "invalid_client"}` becomes `dwab_invalid_client`;
any other non-200, and a thrown fetch, become `dwab_unreachable`; a 200 that is not a token
becomes `malformed_response`.

The two providers differ here, and the difference is intentional: a nonsense 200 from DWAB
is `malformed_response`, while the same thing from Cerberus is `cerberus_upstream_error`,
because Cerberus is code this organisation operates and the broker being wrong is a
distinguishable, actionable state.

---

## Request signing

TM signs every request with HMAC-SHA256 over a five-line canonical string. These functions
are exported because the algorithm is genuinely useful on its own: `tm-cli sign` is built
on them, and they are the fastest way to settle what a bare 401 actually means.

Signing is **async**, and that is not an oversight. It uses WebCrypto (`crypto.subtle`)
rather than `node:crypto` so that one code path ships to Node, Bun, Deno, Workers and the
browser, and `crypto.subtle` is promise-based. The cost is one `await` per request, not a
hot loop, and it means the golden vectors prove the code that actually runs.

### `stringToSign(input)`

```ts
function stringToSign(input: StringToSignInput): string;

interface StringToSignInput {
  method: string;
  url: URL;
  token: string;   // the bearer access token, not the whole Authorization value
  tmDate: string;  // RFC 1123 / IMF-fixdate, e.g. "Tue, 11 Aug 2026 03:14:00 GMT"
}
```

Synchronous. Produces:

```
{METHOD}\n{pathname}{search}\ntoken:{token}\nhost:{host}\nx-tm-date:{tmDate}\n
```

Five lines, each terminated by a newline **including the last one**. Drop that trailing
newline and TM answers a bare 401 with no explanation; it is the single most common
integration mistake, and it is invisible in any output that does not escape it.

Two details that are easy to get wrong and expensive to debug. The method is upper-cased
for you. The host line uses `url.host`, not `url.hostname`: WHATWG keeps the port when it
is not the scheme default, so `:8080` is signed and `:80` is not. And the path includes the
query string, because it is `pathname + search`.

### `signTmRequest(input)`

```ts
function signTmRequest(input: SignInput): Promise<string>;

interface SignInput extends StringToSignInput {
  apiKey: string;  // the event's TM API key
}
```

The `x-tm-signature` value: `stringToSign` fed through HMAC-SHA256 keyed by the API key,
hex-encoded lower-case.

```ts
const signature = await signTmRequest({
  method: "GET",
  url: new URL("http://192.168.1.50:8080/api/rankings/1/QUAL"),
  token: bearer.access_token,
  tmDate: formatTmDate(),
  apiKey: process.env.TM_API_KEY!,
});
```

### `hmacSha256Hex(key, message)`

```ts
function hmacSha256Hex(key: string, message: string): Promise<string>;
```

HMAC-SHA256 over an arbitrary message, hex-encoded. Byte-identical to Node's
`createHmac("sha256", key).update(message).digest("hex")`: Node encodes a string key as
UTF-8 via `Buffer.from`, and `TextEncoder` is UTF-8 by definition, so key and message
encode the same on both paths. The test suite asserts that equivalence directly, including
on a vector carrying multi-byte UTF-8 in both the key and the token — the one input shape
where a WebCrypto implementation (which takes bytes) and `node:crypto` (which takes the
string) could disagree.

### `formatTmDate(date?)`

```ts
function formatTmDate(date?: Date): string;
```

Synchronous; defaults to `new Date()`. RFC 1123 in GMT, which is exactly `toUTCString()`
and exactly what `x-tm-date` requires. A local-zone `Date` is rendered in GMT, not in local
time.

### `buildAuthHeaders(url, options)`

```ts
function buildAuthHeaders(
  url: URL,
  options: { method?: string; token: string; apiKey: string; now?: () => Date },
): Promise<AuthHeaders>;

interface AuthHeaders {
  Authorization: string;
  "x-tm-date": string;
  "x-tm-signature": string;
  Host: string;
}
```

The four headers every signed TM request carries, REST and websocket upgrade alike.
`method` defaults to `"GET"` and `now` to `() => new Date()`.

`Host` is included here and dropped by the REST path. It is a forbidden header name in
Fetch — browsers discard it silently and undici has flip-flopped on it across versions —
and losing it is harmless, because whatever transport sends the request must put the URL's
real authority on the wire anyway, which is exactly the value the signature was built from.
It is kept in this return value because the `ws` and `node:http` paths do honour it.

---

## Field set socket

TM's only push channel, and the one part of this package that cannot run in a browser. TM
signs the socket's HTTP **upgrade** with the same `Authorization` / `x-tm-date` /
`x-tm-signature` headers it requires on REST, and the WebSocket spec forbids setting
request headers from a browser. There is no workaround; see [fieldset-socket.md](./fieldset-socket.md)
for what to do instead.

So this module owns the state machine and takes the transport as an injected factory.
Resolution happens at `connect()` time rather than import time, so a bundler targeting the
browser never pulls `ws` into the graph.

### `new FieldsetSocket(options)`

```ts
interface FieldsetSocketOptions {
  http: FieldsetHttp;
  fieldSetId: number;
  webSocketFactory?: WebSocketFactory;
  backoffMs?: readonly number[];
  healthyMs?: number;
  runtime?: RuntimeProbe;
  setTimeout?: (handler: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}
```

| Option | Default | Notes |
|---|---|---|
| `http` | — required | Normally `tmClient.http`. Only three methods are used; see `FieldsetHttp` below. |
| `fieldSetId` | — required | From `getFieldSets()`. |
| `webSocketFactory` | resolved at `connect()` | Pass one to skip runtime detection, or to supply a transport this package does not know about. |
| `backoffMs` | `DEFAULT_BACKOFF_MS` | An empty array is ignored and the default used. |
| `healthyMs` | `DEFAULT_HEALTHY_MS` (`5_000`) | How long a connection must hold up before it may reset the ladder. |
| `runtime` | `defaultRuntimeProbe` | Override to force the no-transport path in a test. |
| `setTimeout` / `clearTimeout` | globals, with `.unref()` where available | The default unrefs the retry timer so a pending reconnect never stops a CLI exiting. |

```ts
export const DEFAULT_BACKOFF_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000];
export const DEFAULT_HEALTHY_MS = 5_000;
```

Both are exported, so you can extend the shipped ladder rather than retyping it.

`FieldsetHttp` is the slice of `TmHttpClient` the socket actually uses, declared
structurally so a test can substitute a fake without standing up an HTTP client:

```ts
interface FieldsetHttp {
  authHeadersFor(url: URL, method?: string): Promise<Result<Record<string, string>>>;
  resolve(path: string): URL;
  invalidateBearer(): void;
}
```

A compile-time assertion in the source keeps `TmHttpClient` assignable to it, so the two
cannot drift apart silently.

### Connecting

```ts
connect(): Promise<Result<void>>
disconnect(): void
get connected(): boolean
get state(): FieldsetState
get url(): URL           // the signed http(s) URL; the socket URL is this with the scheme swapped
readonly fieldSetId: number
```

`connect()` opens the socket and keeps it open, reconnecting on the backoff ladder until
`disconnect()`. It resolves with the result of the **first** attempt only; every reconnect
after that is reported through the `open`, `close` and `reconnecting` events. Concurrent
calls collapse onto one handshake.

The scheme swap is `http:` → `ws:` and `https:` → `wss:`. Because ws and wss share http and
https's default ports, the authority the signature was built from survives the swap
unchanged.

`disconnect()` closes the socket, cancels any pending retry, stops reconnecting, and
**discards the outbox**. Queued commands can never flush after that, and a caller who sends
afterwards deserves to be told so rather than have it buffered forever.

Two failure paths behave differently, and the difference is deliberate. A bearer failure
schedules a retry — credentials come back. A transport failure (`ws_headers_unsupported`)
does not: no amount of retrying gives a runtime the ability to set handshake headers, so
the machine stops outright and a later `send()` fails with `ws_closed` instead of queueing
into a socket that can never open.

```ts
import { FieldsetSocket, FieldsetAudienceDisplay } from "@unsw-robotics-competition-club/tm-client";
import { createNodeWebSocketFactory } from "@unsw-robotics-competition-club/tm-client/node";

const socket = new FieldsetSocket({
  http: tm.http,
  fieldSetId: 1,
  webSocketFactory: await createNodeWebSocketFactory(),
});

socket.addEventListener("statechange", (e) => {
  render((e as CustomEvent<FieldsetState>).detail);
});
socket.addEventListener("reconnecting", (e) => {
  const { attempt, delayMs } = (e as CustomEvent<{ attempt: number; delayMs: number }>).detail;
  console.warn(`reconnecting in ${delayMs / 1000}s (attempt ${attempt})`);
});

const opened = await socket.connect();
if (!opened.ok) console.error(opened.error.code);

await socket.setAudienceDisplay(FieldsetAudienceDisplay.Rankings);
```

### Events

`FieldsetSocket` extends `EventTarget` and dispatches `CustomEvent`. The payload is always
in `detail`.

| Event | `detail` |
|---|---|
| `fieldMatchAssigned` | `FieldsetEventFieldMatchAssigned` |
| `fieldActivated` | `FieldsetEventFieldActivated` |
| `matchStarted` | `FieldsetEventMatchStarted` |
| `matchStopped` | `FieldsetEventMatchStopped` |
| `audienceDisplayChanged` | `FieldsetEventAudienceDisplayChanged` |
| `message` | the same `FieldsetEvent`, for every type |
| `statechange` | `FieldsetState`, only when the derived state actually changed |
| `open` | `{ url: string }` — the `ws://` or `wss://` URL |
| `close` | `{ reason: string }` |
| `reconnecting` | `{ attempt: number; delayMs: number }` |

`reconnecting` is emitted **before** the wait, not after it, so a caller rendering status
can say how long the gap will be while it is still in front of them.

A frame that does not parse as a known event type is ignored rather than dropping the
socket: TM is free to add event types in a point release, and an unknown type must not take
a live display down. Binary frames are decoded first — `ws` delivers text as `Buffer`,
browsers as `string`, and proxies sometimes in chunks.

### Commands

```ts
send(command: FieldsetCommand): Promise<Result<void>>

startMatch(fieldID: number): Promise<Result<void>>
endMatchEarly(fieldID: number): Promise<Result<void>>
abortMatch(fieldID: number): Promise<Result<void>>
resetTimer(fieldID: number): Promise<Result<void>>
queuePreviousMatch(): Promise<Result<void>>
queueNextMatch(): Promise<Result<void>>
queueSkills(skillsID: FieldsetQueueSkillsType): Promise<Result<void>>
setAudienceDisplay(display: FieldsetAudienceDisplay): Promise<Result<void>>
```

**`send()` returning `ok` can mean *queued*, not *delivered*.** A command issued while the
socket is reconnecting is held and flushed in order on the next open — an operator pressing
Start during a blip expects the match to start, not an error. If you need delivery rather
than acceptance, check `socket.connected` first; that is exactly what `tm-cli send` does
before reporting success.

`send()` fails with `ws_closed` only when the socket is not running at all: before the
first `connect()`, or after a `disconnect()`. It fails with `ws_connection_error` when the
socket died between the readyState check and the write, in which case the payload is queued
anyway so the reconnect delivers it.

### Derived state

```ts
function reduceFieldsetState(state: FieldsetState, event: FieldsetEvent): FieldsetState;
export const INITIAL_FIELDSET_STATE: FieldsetState;
```

Pure, and never mutates its input, so you can hold on to prior states and diff them. It
returns the **same object** when nothing changed, which is what lets `statechange` fire
only on real changes and lets a consumer compare by identity.

The socket runs this for you and exposes the result as `socket.state`. Use the function
directly if you are feeding events from somewhere else — a relay, a recording, a test.

```ts
import { reduceFieldsetState, INITIAL_FIELDSET_STATE } from "@unsw-robotics-competition-club/tm-client";

let state = INITIAL_FIELDSET_STATE;
for (const event of recordedEvents) state = reduceFieldsetState(state, event);
```

The one thing worth reading the source for: **a timeout arrives as a `fieldMatchAssigned`
whose `match` object is empty.** There is no type tag for it anywhere on the wire. The
reducer counts the object's keys and never inspects individual fields, because a future TM
could add one and every field-based check would still pass while live timeouts silently
became matches. TM's separate "nothing is queued" signal is an empty match object **and** a
null `fieldID`.

### `parseFieldsetEvent(raw)`

```ts
function parseFieldsetEvent(raw: unknown): FieldsetEvent | null;
```

Validates one frame, accepting either the raw JSON text or an already-parsed value. Returns
`null` — rather than throwing — for anything unrecognised: unknown type, malformed JSON,
wrong field types. Note that a `fieldMatchAssigned` with a `null` `fieldID` is valid and
keeps its null; only a non-number, non-null `fieldID` is rejected.

### Transports

```ts
type WebSocketFactory = (url: URL, headers: Record<string, string>) => WebSocketLike;

interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "error", listener: (event: unknown) => void): void;
  addEventListener(type: "close", listener: (event: { code?: number; reason?: string }) => void): void;
}

export const WS_OPEN = 1;   // WebSocket.OPEN, spelled out so this file needs no DOM lib
```

A factory receives the `ws://`/`wss://` URL and the four signed headers, and must return
something matching `WebSocketLike`. That is the whole contract — it is deliberately smaller
than the WebSocket interface so that wrapping an unusual transport is not a research
project.

```ts
async function resolveWebSocketFactory(options: {
  explicit?: WebSocketFactory;
  runtime?: RuntimeProbe;
}): Promise<Result<WebSocketFactory>>;

interface RuntimeProbe {
  isNode(): boolean;
  isBun(): boolean;
}

export const defaultRuntimeProbe: RuntimeProbe;
```

Picks a transport: explicit factory, then Node, then Bun, then fail. It never throws — a
runtime that cannot sign the handshake is an operator problem with three concrete remedies,
not an exception for a caller to guess at. Under Node it dynamically imports `ws`, and
reports `ws_headers_unsupported` if that optional dependency is not installed. Under Bun it
uses Bun's non-standard `new WebSocket(url, { headers })`, which stays its own branch
because Bun's header support has regressed before.

`defaultRuntimeProbe` detects Node via `globalThis.process?.versions?.node` and Bun via
`globalThis.Bun`. Inject your own `RuntimeProbe` to exercise the no-transport path without
a header-less runtime to test it in.

### `createNodeWebSocketFactory()`

```ts
// from "@unsw-robotics-competition-club/tm-client/node"
function createNodeWebSocketFactory(): Promise<WebSocketFactory>;
```

Loads `ws` and returns a factory over it. Rejects when `ws` is not installed; it is an
`optionalDependency`, so that is a normal state and not a broken install.

`ws` is the transport because it is the only Node WebSocket that can set headers on the
handshake. Node 22's global `WebSocket` (undici) is spec-compliant and therefore
two-argument only, which TM's signed upgrade rules out.

Passing this factory explicitly is optional — `connect()` finds it by itself under Node —
but doing so makes the dependency visible to a bundler and to whoever reads the call site.

---

## Entity types and enums

All of `src/types.ts` is re-exported from the package root. These are **wire** shapes, so
they use TM's spelling rather than ours: note `fieldID`, not `fieldId`.

### Event, divisions, teams

```ts
interface EventInfo { name: string; code: string }          // `code` is the VEX Events SKU
interface Division { id: number; name: string }

enum AgeGroup {
  HighSchool = "HIGH_SCHOOL",
  MiddleSchool = "MIDDLE_SCHOOL",
  ElementarySchool = "ELEMENTARY_SCHOOL",
  College = "COLLEGE",
}

interface Team {
  number: string;
  name: string;
  shortName: string;   // @deprecated — not generally used, may be removed
  sponsors: string;    // @deprecated — not generally used, may be removed
  school: string;      // may be renamed `organization` in a future TM release
  city: string;        // city/state/country may be merged into `location`
  state: string;
  country: string;
  ageGroup: AgeGroup;
  divId: number;
  checkedIn: boolean;
}
```

The deprecations and the rename warnings are the API guide's own, not this package's.

### Matches

```ts
enum MatchState { Unplayed = "UNPLAYED", Scored = "SCORED" }

enum MatchRound {
  None = "NONE",           Practice = "PRACTICE",     Qualification = "QUAL",
  Quarterfinal = "QF",     Semifinal = "SF",          Final = "F",
  RoundOf16 = "R16",       RoundOf32 = "R32",         RoundOf64 = "R64",
  RoundOf128 = "R128",     TopN = "TOP_N",            RoundRobin = "ROUND_ROBIN",
  Skills = "SKILLS",       Timeout = "TIMEOUT",
}

interface MatchAlliance { teams: { number: string }[] }

interface MatchTuple<R extends MatchRound = MatchRound> {
  session: number; division: number; round: R; instance: number; match: number;
}

interface Match {
  winningAlliance: number;   // 0 red, 1 blue, -1 when no winner is recorded
  finalScore: number[];
  matchInfo: {
    timeScheduled: number;   // epoch SECONDS
    state: MatchState;
    alliances: MatchAlliance[];
    matchTuple: MatchTuple;
  };
}
```

`MatchRound` is the value `getRankings` takes as its `round` argument, and it goes into the
URL verbatim.

### Rankings and skills

```ts
interface RankAlliance { name: string; teams: { number: string }[] }

interface Ranking {
  rank: number;
  tied: boolean;             // this rank is shared with at least one other alliance
  alliance: RankAlliance;
  wins: number; losses: number; ties: number;
  wp: number; ap: number; sp: number;
  avgPoints: number; totalPoints: number; highScore: number;
  numMatches: number; minNumMatches: boolean;
}

interface SkillsRanking {
  rank: number;
  tie: boolean;              // note: `tie`, where Ranking has `tied`
  number: string;
  totalScore: number;
  progHighScore: number; progAttempts: number;
  driverHighScore: number; driverAttempts: number;
}
```

`Ranking.alliance` is a single object, not an array. That diverges from `vex-tm-client`,
which typed it `RankAlliance[]`; the API guide shows a single object and TM sends one, and
upstream's array type was never exercised because no vendored copy actually read the field.
In qualification rankings the alliance carries an empty `name`, which is why `tm-cli`
renders a dash there.

### Field sets and fields

```ts
interface FieldSetInfo { id: number; name: string }
interface Field { id: number; name: string }
```

### Socket events

```ts
enum FieldsetAudienceDisplay {
  Blank = "BLANK",                       Logo = "LOGO",
  Intro = "INTRO",                       InMatch = "IN_MATCH",
  SavedMatchResults = "RESULTS",         Schedule = "SCHEDULE",
  Rankings = "RANKINGS",                 SkillsRankings = "SC_RANKINGS",
  AllianceSelection = "ALLIANCE_SELECTION",
  ElimBracket = "BRACKET",               Slides = "AWARD",
  Inspection = "INSPECTION",
}

interface FieldsetEventFieldMatchAssigned {
  readonly type: "fieldMatchAssigned";
  fieldID: number | null;
  match: MatchTuple | Record<string, never>;
}
interface FieldsetEventFieldActivated        { readonly type: "fieldActivated";  fieldID: number }
interface FieldsetEventMatchStarted          { readonly type: "matchStarted";    fieldID: number }
interface FieldsetEventMatchStopped          { readonly type: "matchStopped";    fieldID: number }
interface FieldsetEventAudienceDisplayChanged {
  readonly type: "audienceDisplayChanged";
  display: FieldsetAudienceDisplay;
}

type FieldsetEvent = /* the union of the five above */;
type FieldsetEventType = FieldsetEvent["type"];
```

Three of those enum spellings do not match their names, and all three are TM's: `Slides` is
`"AWARD"`, `SavedMatchResults` is `"RESULTS"`, and `SkillsRankings` is `"SC_RANKINGS"`.

`fieldID` is nullable on `fieldMatchAssigned` because TM's "nothing is queued" case is an
empty match object *and* a null field. `vex-tm-client` checked for that null at runtime
while typing the field `number`, so every consumer of that type was one real event away
from a crash the compiler had promised could not happen.

### Socket commands

```ts
enum FieldsetQueueSkillsType { Programming = 1, Driver = 2 }

type FieldsetCommand =
  | { cmd: "start"; fieldID: number }
  | { cmd: "endEarly"; fieldID: number }
  | { cmd: "abort"; fieldID: number }
  | { cmd: "reset"; fieldID: number }
  | { cmd: "queuePrevMatch" }
  | { cmd: "queueNextMatch" }
  | { cmd: "queueSkills"; skillsID: FieldsetQueueSkillsType }
  | { cmd: "setAudienceDisplay"; display: FieldsetAudienceDisplay };

type FieldsetCommandType = FieldsetCommand["cmd"];
```

`FieldsetQueueSkillsType` is numeric, not a string enum, and the wire field is `skillsID`
with that capitalisation.

### Derived state

```ts
enum FieldsetActiveMatchType { None = "NONE", Timeout = "TIMEOUT", Match = "MATCH" }
enum FieldsetQueueState { Unplayed = "UNPLAYED", Running = "RUNNING", Stopped = "STOPPED" }

type FieldsetMatch =
  | { type: FieldsetActiveMatchType.None }
  | { type: FieldsetActiveMatchType.Timeout; state: FieldsetQueueState; fieldID: number; active: boolean }
  | { type: FieldsetActiveMatchType.Match;   state: FieldsetQueueState; match: MatchTuple; fieldID: number; active: boolean };

interface FieldsetState {
  match: FieldsetMatch;
  audienceDisplay: FieldsetAudienceDisplay;
}
```

`FieldsetMatch` is a discriminated union on `type`, so `match` is reachable only once
you have narrowed to `FieldsetActiveMatchType.Match`:

```ts
if (socket.state.match.type === FieldsetActiveMatchType.Match) {
  const { round, match } = socket.state.match.match;
  console.log(`${round} ${match}`);
}
```

A timeout stays distinguishable from a match for its whole life, including after it starts
— which is the point of carrying the distinction in the state rather than deriving it from
the last event.
