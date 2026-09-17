# Authentication

Everything TM requires to accept a request, and everything this package does about it.
[getting-started.md](getting-started.md) covers the shape of the two-part model; this is
the detail: the token flows, the caching rules, how to implement `AuthProvider` yourself,
and the signing algorithm byte by byte.

## The pieces

| Piece | Scope | Where it lives | On the wire |
|---|---|---|---|
| DWAB client ID + secret | your app, all events | your server, or a broker | exchanged for a bearer at DWAB |
| Bearer token | your app, short-lived | memory | `Authorization: Bearer …` |
| TM API key | one event, one TM install | the venue machine | never — only the signature derived from it |
| Cerberus `ctm_` key | one install or build | the distributed build | `Authorization: Bearer ctm_…` to the broker only |

The bearer and the API key are checked independently. TM rejects a failure of either with
the same bare 401, which is why this package spends so much effort telling the cases
apart.

## The DWAB client-credentials flow

`createDwabAuth` implements OAuth 2.0 client credentials against DWAB directly:

```
POST https://auth.vextm.dwabtech.com/oauth2/token
Content-Type: application/x-www-form-urlencoded; charset=UTF-8

client_id=…&client_secret=…&grant_type=client_credentials
```

A success is `{ "access_token": "…", "token_type": "Bearer", "expires_in": 7200 }`.

```ts
import { createDwabAuth } from "@unsw-robotics-competition-club/tm-client";

const auth = createDwabAuth({
  clientId: process.env.TM_CLIENT_ID!,
  clientSecret: process.env.TM_CLIENT_SECRET!,
  expirationDateMs: 1_800_000_000_000,  // when the CREDENTIAL expires, in ms
  marginMs: 300_000,                    // optional; default five minutes
  fetch: myFetch,                       // optional; for tests or a proxy
  now: () => Date.now(),                // optional; for tests
});
```

Use this only where the org-wide secret can safely live on the machine — a server you
control, a CI job, your own laptop. A venue laptop or a plugin you hand to other people
should use the broker instead, because a secret in a distributed build is a secret you
cannot revoke without revoking it for everyone.

Failures map to three codes: `dwab_invalid_client` when DWAB names `invalid_client`,
`dwab_credentials_expired` when the credential's own expiry has passed (checked locally,
before the request — DWAB would only answer with a generic rejection, and the local check
names the actual problem), and `dwab_unreachable` for a transport failure or any other
status.

### The `expirationDateMs` trap

`expirationDateMs` is the expiry of the *credential DWAB issued you*, not of any token,
and DWAB reports it in **milliseconds**. A ten-digit seconds value reads as 1970, which
means the provider decides the credential expired decades ago and never calls DWAB at all
— a failure that looks nothing like a unit mistake.

So the constructor refuses anything earlier than 2001-09-09 outright:

```ts
createDwabAuth({ clientId: "id", clientSecret: "s", expirationDateMs: 1_800_000_000 });
// throws TmConfigError:
//   expirationDateMs must be milliseconds since the epoch; got 1800000000,
//   which looks like a seconds value. Multiply by 1000.
```

It throws rather than returning a `Result` because it is a wiring mistake, and throwing
puts the error where the offending config is still on screen. `tm-cli` applies the same
check to `--expiration-date-ms` and `TM_EXPIRATION_DATE_MS` and exits 2.

## Cerberus, and why a broker exists

Cerberus is a token broker. It holds one org-wide DWAB credential server-side and mints
short-lived TM bearers for clients that present a revocable per-install key:

```
POST {endpoint}/v1/token
Authorization: Bearer ctm_<16 hex>_<48 hex>
x-cerberus-build: 1.2.0            (or "1.2.0/9f1c3a…" when a build hash is known)
x-cerberus-event: RE-V5RC-25-0000  (optional, attribution only)
x-cerberus-event-name: …           (optional)
x-cerberus-event-sku: …            (optional)
```

The point is distribution. A Stream Deck plugin, an LED controller or a CLI handed to
twenty venues cannot carry the DWAB secret: extracting it from a build is trivial, and
revoking it would break every install at once. A `ctm_` key can be revoked on its own,
carries a build version the broker can refuse if it is too old, and grants nothing except
the ability to ask for a bearer.

Crucially **the broker is not in the TM data path**. It never sees the TM API key and
never sees your event's data — the key stays on the venue machine and signs requests
locally. The two secrets meet only inside an HMAC computation.

```ts
import { createCerberusAuth } from "@unsw-robotics-competition-club/tm-client";

const auth = createCerberusAuth({
  endpoint: "https://tm.unswrobotics.com",
  apiKey: process.env.TM_CERBERUS_KEY!,        // ctm_<16 hex>_<48 hex>
  build: { version: "1.2.0" },                  // `hash` optional; see setBuildHash below
  event: { code: "RE-V5RC-25-0000" },           // optional attribution
  marginMs: 300_000,                            // optional; default five minutes
});
```

`createCerberusAuth` returns a `CerberusAuth`, which is an `AuthProvider` plus three
things the plain interface has no room for:

- **`lastFailure(): string | null`** — why the last mint was refused, in a sentence an
  operator can act on, or `null` when healthy. `error.code` is what you switch on;
  this is what you put on screen.
- **`setEvent({ code, name, sku })`** — late-binds the event, once you have asked TM which
  one it is running. Attribution only: it makes a leaked key traceable to the events it
  minted for. It proves nothing and is never checked for authorisation.
- **`setBuildHash(hash)`** — late-binds the build hash, which is usually read from disk
  asynchronously after construction.

A typical wiring reports the event back once, after the first successful read:

```ts
const event = await tm.getEvent();
if (event.ok) auth.setEvent({ code: event.data.code, name: event.data.name });
```

### The key is checked before any network call

`ctm_<16 hex>_<48 hex>` is validated locally, because Cerberus answers a malformed key and
a revoked key with the same 401 and a truncated copy-paste is by far the more common of
the two. A bad shape fails instantly as `cerberus_key_invalid` with no round trip.

### What each refusal means

| `error.code` | Cerberus says | What to do |
|---|---|---|
| `cerberus_key_invalid` | `invalid_client`, or HTTP 401 | The key is unknown, malformed or revoked. Reissue it. |
| `cerberus_upgrade_required` | `upgrade_required`, or 426 | This build is below the broker's floor. Update. |
| `cerberus_rate_limited` | `rate_limited`, or 429 | Too many mints. Wait for `Retry-After`. |
| `cerberus_credentials_invalid` | `credentials_expired` / `credentials_invalid`, or 503 | The broker's *own* DWAB credential was rejected. Server-side; not the operator's fault. |
| `cerberus_upstream_error` | `upstream_error`, or anything else | The broker could not reach DWAB. Retry shortly. |
| `cerberus_unreachable` | — (transport failure) | The venue has no internet, or the endpoint is wrong. |

The named `error` field in the body wins over the HTTP status, because the broker is
explicit about which of the two 503 cases it is in and a proxy in front of it can rewrite
a status without knowing what it meant.

`cerberus_upgrade_required` composes its operator message from two fields, so it names the
version you actually need:

```
Client version below the supported minimum (minimum 0.1.0, this build is 0.0.1).
```

A 200 that is not a token — a captive portal answering with an HTML login page, most
realistically — is refused as `cerberus_upstream_error` rather than cached. Caching a body
with no `expires_in` gives an expiry of `NaN`, which reads as permanently stale, so every
TM request would mint again and a venue would rate-limit itself out of its own event.

## Token lifecycle

Both providers behave identically here, and the behaviour matters more than it looks.

**Caching with a margin.** A cached token is served while more than `marginMs` of life
remains — five minutes by default. Refreshing early costs one extra request an hour;
refreshing late costs a 401 in the middle of a final.

**`expires_in` is remaining life, recomputed on every read.** The field is
`Math.floor((expiresAt - now) / 1000)`, never the number the issuer returned at grant
time. Re-serving the original value tells a caller forty minutes later that it has two
hours left, which is exactly the sort of quiet lie that makes an expiry bug take a whole
event to find.

**Single-flight minting.** Concurrent `getBearer()` calls from a cold cache share one
in-flight request. A client with several TM readers should make one token request at match
start, not one per reader. The surviving upstream had no such guard, so two calls in the
same tick both minted.

**`invalidate()` drops the cache and disowns any mint already in flight.** It bumps a
generation counter, and a refresh that was started before the invalidation is allowed to
return its value to its own caller but not to become the new cache entry. This matters for
Cerberus in particular: the broker caches its DWAB token server-side, so a mint racing an
invalidation can return the very token TM just rejected.

**A failed refresh does not throw away a token that still works.** If the broker or DWAB
is unreachable but the cached token has life left, the cached token is returned. Venues
lose their internet constantly while TM stays on the LAN, and only TM answering 401 proves
a token is actually dead.

### Who calls `invalidate()`

You rarely need to. The library does it where TM's answer implicates the token:

- `TmHttpClient` invalidates on `invalid_signature`, `token_expired`, `clock_skew`,
  `dwab_invalid_client`, `dwab_credentials_expired`, `cerberus_key_invalid` and
  `cerberus_credentials_invalid` — the set that `shouldInvalidateBearer(code)` returns true
  for. It also drops that URL's conditional-GET entry, so a stale body cannot come back via
  a 304 issued against a dead token.
- `FieldsetSocket` invalidates when a socket drop mentions 401 or 403, since TM blames a
  bad API key and a bad bearer with the same status on the upgrade.

`tm-cli token` calls it deliberately, because the question that command answers is "can
these credentials get a token *right now*", and serving a cached one answers a different
question.

## Implementing `AuthProvider` yourself

The interface is two methods, and anything satisfying it can be passed as `auth`:

```ts
interface AuthProvider {
  getBearer(): Promise<Result<BearerToken>>;
  invalidate(): void;
}

interface BearerToken {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;   // REMAINING seconds, recomputed per read
}
```

No helper ships for the two cases below, because both are three lines and both want
project-specific policy.

### A static token, for development

Useful against a mock TM, or when someone has handed you a bearer to reproduce a problem:

```ts
import { ok, type AuthProvider } from "@unsw-robotics-competition-club/tm-client";

const auth: AuthProvider = {
  getBearer: async () =>
    ok({ access_token: process.env.TM_DEV_TOKEN!, token_type: "Bearer", expires_in: 3600 }),
  invalidate() {},
};
```

The `expires_in` here is a lie that nothing reads: the client does not manage the token's
life, the provider does. `invalidate()` is a no-op because there is nothing to drop —
which also means a token that TM rejects will be retried unchanged, so keep this to
development.

### A build-time baked key

A distributed build substitutes a `ctm_` key at bundle time and hands it to
`createCerberusAuth`, so the operator is never given a credential to paste:

```ts
/** Replaced by the bundler (rollup's @rollup/plugin-replace, esbuild's define, …). */
declare const __CERBERUS_API_KEY__: string | undefined;

const CERBERUS_KEY_PATTERN = /^ctm_[0-9a-f]{16}_[0-9a-f]{48}$/;

// `typeof` rather than a bare reference: in a dev build the identifier is never
// substituted and never declared, and only `typeof` is safe on those.
const baked = typeof __CERBERUS_API_KEY__ === "string" ? __CERBERUS_API_KEY__ : undefined;

const key = baked && CERBERUS_KEY_PATTERN.test(baked) ? baked : settings.cerberusKey;
const auth = createCerberusAuth({ endpoint, apiKey: key, build: { version: BUILD_VERSION } });
```

Check the shape at the point of substitution. A truncated bake fails at a venue as a 401
indistinguishable from a revoked key; checked here, it is a message in your own settings
UI. Fail the release build when the key is absent rather than shipping one that cannot
authenticate.

### Wrapping a token service of your own

If you front DWAB with something else, implement the same four properties the shipped
providers have, in this order of importance:

1. **Cache**, and refresh on a margin rather than on expiry.
2. **Recompute `expires_in`** as remaining life on every read.
3. **Single-flight** concurrent calls from a cold cache.
4. **Make `invalidate()` disown in-flight mints**, not just clear the cache.

```ts
function createMyAuth(mint: () => Promise<{ token: string; ttlSeconds: number }>): AuthProvider {
  let cached: { token: string; expiresAtMs: number } | null = null;
  let pending: Promise<Result<BearerToken>> | null = null;
  let generation = 0;

  const present = (minRemainingMs: number): Result<BearerToken> | null => {
    if (!cached || cached.expiresAtMs - Date.now() <= minRemainingMs) return null;
    return ok({
      access_token: cached.token,
      token_type: "Bearer",
      expires_in: Math.floor((cached.expiresAtMs - Date.now()) / 1000),
    });
  };

  async function refresh(): Promise<Result<BearerToken>> {
    const mintedFor = generation;
    try {
      const { token, ttlSeconds } = await mint();
      const expiresAtMs = Date.now() + ttlSeconds * 1000;
      if (generation === mintedFor) cached = { token, expiresAtMs };
      return ok({ access_token: token, token_type: "Bearer", expires_in: ttlSeconds });
    } catch (cause) {
      return err("cerberus_unreachable", "Could not mint a token", { detail: cause });
    }
  }

  return {
    async getBearer() {
      const fresh = present(300_000);
      if (fresh) return fresh;
      pending ??= refresh().finally(() => { pending = null; });
      const result = await pending;
      // A failed mint is not a reason to discard a token that still works.
      return result.ok ? result : (present(0) ?? result);
    },
    invalidate() {
      cached = null;
      generation += 1;
    },
  };
}
```

Pick an existing `TmErrorCode` for failures rather than inventing one; the taxonomy is a
closed union, and `remedy()` is exhaustive over it. [errors.md](errors.md) lists them.

## Request signing

Every request to TM — REST calls and the field set websocket upgrade alike — carries four
headers:

```
Authorization: Bearer {token}
x-tm-date:     {RFC 1123 date in GMT}
x-tm-signature: {hex HMAC-SHA256}
Host:          {host, with port if non-default}
```

### The canonical string

Five lines, each terminated by a newline, **including the last one**:

```
{METHOD}\n
{path and query}\n
token:{bearer access token}\n
host:{host header value}\n
x-tm-date:{date}\n
```

Concretely, for `GET http://192.168.1.50:8080/api/rankings/1/QUAL`:

```
GET\n/api/rankings/1/QUAL\ntoken:BEARER\nhost:192.168.1.50:8080\nx-tm-date:Tue, 11 Aug 2026 03:14:00 GMT\n
```

101 bytes. The signature is `HMAC-SHA256(apiKey, canonicalString)`, hex-encoded; with the
API key `TESTAPIKEY0123456789` the result is
`e885f64627a02bccd049b757228b034a4c9826bc285a3059d4e782227645b863`. That is a vector you
can reproduce, which makes it a useful first check on any other implementation.

Three details cause nearly all signing failures:

- **The trailing newline.** Drop it and TM answers a bare 401 with no explanation. It is
  the single most common mistake in this API, which is why it is checked first in the
  `invalid_signature` remedy, and what `tm-cli sign` gives you to compare against.
- **`host` keeps the port** when it is not the scheme default. The library builds it from
  WHATWG's `url.host` (not `url.hostname`), so `:8080` is signed and `:80` is not. Losing
  the port between the address you configured and the address you called is an instant,
  unexplained 401.
- **The bearer is part of the signature.** A refreshed token changes the signature, so
  headers cannot be cached across a token refresh. The library rebuilds them per request.

### The functions

```ts
import {
  stringToSign,
  signTmRequest,
  buildAuthHeaders,
  hmacSha256Hex,
  formatTmDate,
} from "@unsw-robotics-competition-club/tm-client";

const url = new URL("http://192.168.1.50:8080/api/rankings/1/QUAL");
const tmDate = formatTmDate();                // RFC 1123 in GMT, e.g. Tue, 11 Aug 2026 03:14:00 GMT

stringToSign({ method: "GET", url, token, tmDate });          // string, synchronous
await signTmRequest({ method: "GET", url, token, tmDate, apiKey });  // hex signature
await buildAuthHeaders(url, { method: "GET", token, apiKey });        // all four headers
```

**Signing is async**, because it uses WebCrypto (`crypto.subtle`) rather than
`node:crypto`. That is what lets the same code run in Node, Bun, Deno, Cloudflare Workers
and a browser, and it costs nothing — one HMAC per request, not a hot loop. If you are
porting from code that signed synchronously, this is the one change that reaches your call
sites; see [migrating.md](migrating.md).

`hmacSha256Hex(key, message)` is byte-identical to Node's
`createHmac("sha256", key).update(message).digest("hex")`. Node encodes a string key as
UTF-8 via `Buffer.from` and `TextEncoder` is UTF-8 by definition, so both paths encode key
and message the same way — including for multi-byte characters, which the golden vectors
shared with the C++ implementation pin explicitly.

### The `Host` header

`buildAuthHeaders` returns `Host` because the `ws` and `node:http` paths honour it, which
matters if TM is reached through a name-based reverse proxy. The REST path deletes it
before calling `fetch`: `Host` is a forbidden header name in Fetch, browsers drop it
silently and undici has flip-flopped on it across versions. Losing it is harmless — the
transport must put the URL's real authority on the wire anyway, and that is exactly the
value the signature was built from.

### Signing something the library does not cover

`TmHttpClient.authHeadersFor(url, method)` gives you the signed headers for an arbitrary
URL, minting or reusing the bearer as needed:

```ts
const headers = await tm.http.authHeadersFor(new URL("http://192.168.1.50/api/event"), "GET");
if (!headers.ok) throw new Error(headers.error.message);
// headers.data: Authorization, x-tm-date, x-tm-signature, Host
```

This is what `FieldsetSocket` uses to sign its upgrade, and what you would use for a
transport of your own.

## Diagnosing a rejection

TM's 401 says nothing, so work in this order.

1. **Is the canonical string right?** `tm-cli sign` computes it offline, with no network
   and no credentials beyond the ones you pass:

   ```
   $ tm-cli sign --method GET --url http://192.168.1.50:8080/api/event \
       --token BEARER --date "Tue, 11 Aug 2026 03:14:00 GMT" --api-key KEY
   escaped:    GET\n/api/event\ntoken:BEARER\nhost:192.168.1.50:8080\nx-tm-date:Tue, 11 Aug 2026 03:14:00 GMT\n
   bytes:      91
   lines:      5, ending with a newline (compare yours)

   --- begin canonical string ---
   GET
   /api/event
   token:BEARER
   host:192.168.1.50:8080
   x-tm-date:Tue, 11 Aug 2026 03:14:00 GMT
   --- end canonical string ---

   signature:  ffa843f7b41e5ff2c720f5f65f506a6274b8a0e5a65fc3ed124a825e96b44e58
   ```

   Check the host line against the address you are actually calling, port included.

2. **Is the clock right?** The client records how far this machine's clock is from TM's,
   read from the server's `Date` header, and relabels a 401 as `clock_skew` when the drift
   exceeds five minutes. Read it directly with `tm.http.observedClockSkewMs`. A few hundred
   milliseconds is normal — `Date` has one-second resolution.

   The skew is **diagnosed, never corrected**. Auto-correcting the outgoing `x-tm-date`
   would hide a dead RTC or a machine with no NTP, which is the one thing the operator
   needs telling, and would let an untrusted response header steer what gets signed.

3. **Is the API on at all?** A 503 (or a 404 under `/api/`) is `local_api_disabled`: the
   Event Partner has not ticked **Enable Local TM API** for this event.

4. **Is it the bearer rather than the signature?** `tm-cli token` forces a fresh mint and
   reports the auth mode and remaining life without ever printing the secret. If that
   succeeds and TM still refuses, the problem is on the signature side.

[troubleshooting.md](troubleshooting.md) works through the venue-side symptoms;
[errors.md](errors.md) documents every code.
