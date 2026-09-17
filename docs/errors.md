# Errors

There are nineteen error codes. Each one exists because somebody at a venue needed to know
which of two indistinguishable things had gone wrong, so each one carries a remedy naming
the thing to change.

- [Result or throw](#result-or-throw)
- [The nineteen codes](#the-nineteen-codes)
- [Splitting TM's 401](#splitting-tms-401)
- [HTTP status mapping](#http-status-mapping)
- [Invalidating the bearer](#invalidating-the-bearer)

---

## Result or throw

Two kinds of failure, two mechanisms.

**`TmError`, returned in a `Result<T>`.** TM, DWAB and Cerberus refusing a request is
frequent, expected and operator-actionable. It is not a bug in your program, and wrapping
every call in a `try`/`catch` reads as though it were. Every fallible call in this package
returns `Result<T>`; you narrow it on `.ok`.

**`TmConfigError`, thrown.** The caller has wired something up wrong, and no amount of
retrying will help. There are exactly three of these in the library:

| Thrown by | When |
|---|---|
| `new TmHttpClient(...)` / `new TmClient(...)` | `baseUrl` is not a valid URL |
| `new TmHttpClient(...)` / `new TmClient(...)` | no global `fetch` and no `fetch` option |
| `createDwabAuth(...)` | `expirationDateMs` is below `1_000_000_000_000`, i.e. a seconds value |

All three fire at construction, while the offending configuration is still in view. The CLI
adds more of them for flag and config-file validation, and maps every one to exit code 2.

The dividing line is whether retrying could ever help. It could for everything in the table
below; it never could for the three above.

```ts
const result = await tm.getEvent();
if (!result.ok) {
  console.error(result.error.message);          // short, technical
  console.error(remedy(result.error.code));     // what to actually do
  if (result.error.httpStatus) console.error("HTTP", result.error.httpStatus);
  console.error(result.error.detail);           // response body, or the thrown cause
}
```

---

## The nineteen codes

`remedy` text is reproduced verbatim. The **Drops bearer** column is
`shouldInvalidateBearer(code)` — whether this failure means the cached token can no longer
be trusted. `TmHttpClient` acts on it automatically, dropping both the bearer and that
URL's conditional-GET entry.

### Transport and reachability

| Code | When | Drops bearer |
|---|---|---|
| `host_unreachable` | The `fetch` to TM threw: connection refused, DNS failure, no route. | no |
| `local_api_disabled` | TM answered 503 on any path, or 404 on a path under `/api/`. | no |

> **`host_unreachable`** — Could not reach the TM web server. Check the address and that
> this machine is on the same network as the TM laptop.

> **`local_api_disabled`** — TM's Local API is off. In TM: Tools > Options > Web Publishing
> > Enable Local TM API, then save. It must be enabled for each event.

A 404 under `/api/` is treated as the API being off rather than as one missing resource,
because when the Local API is disabled the entire `/api/*` namespace is absent. A genuinely
absent resource — an unknown division ID, an unknown field set — lands here too; the
response body in `detail` is what separates them.

### Direct DWAB authentication

| Code | When | Drops bearer |
|---|---|---|
| `dwab_invalid_client` | DWAB answered a non-200 whose body names `invalid_client`. | **yes** |
| `dwab_credentials_expired` | `expirationDateMs` is in the past. Checked locally, before any request. | **yes** |
| `dwab_unreachable` | The fetch threw, or DWAB answered any other non-200. | no |

> **`dwab_invalid_client`** — The DWAB client ID or secret was rejected. Check the
> credentials issued to you by DWAB Technologies.

> **`dwab_credentials_expired`** — The DWAB credential has passed its expiry date. Request
> a new client ID and secret.

> **`dwab_unreachable`** — Could not reach the DWAB authorization server. Check this
> machine's internet connection.

`dwab_unreachable` covering both "the socket failed" and "DWAB answered 500" is deliberate:
from the venue's side those are the same problem with the same first action, and the status
is in `httpStatus` for anyone who needs to tell them apart.

### Cerberus broker authentication

| Code | When | Drops bearer |
|---|---|---|
| `cerberus_unreachable` | The fetch to the broker threw. | no |
| `cerberus_key_invalid` | The key fails the local `ctm_<16 hex>_<48 hex>` check, or the body names `invalid_client`, or the status is 401. | **yes** |
| `cerberus_upgrade_required` | The body names `upgrade_required`, or the status is 426. | no |
| `cerberus_rate_limited` | The body names `rate_limited`, or the status is 429. | no |
| `cerberus_credentials_invalid` | The body names `credentials_expired` or `credentials_invalid`, or the status is 503. | **yes** |
| `cerberus_upstream_error` | The body names `upstream_error`, the status is anything else, or a 200 arrived that is not a usable token. | no |

> **`cerberus_unreachable`** — Could not reach the Cerberus token broker. Check this
> machine's internet connection.

> **`cerberus_key_invalid`** — The Cerberus API key was rejected. It may have been revoked,
> or copied incorrectly.

> **`cerberus_upgrade_required`** — This build is older than the minimum version Cerberus
> accepts. Update to the current release.

> **`cerberus_rate_limited`** — Too many token requests. Wait for the period given by
> Retry-After before trying again.

> **`cerberus_credentials_invalid`** — Cerberus's own upstream credential was rejected. This
> is a server-side problem — contact whoever operates the broker.

> **`cerberus_upstream_error`** — Cerberus could not reach DWAB. Retry shortly; if it
> persists, contact whoever operates the broker.

The named `error` field in the body is preferred over the status, because Cerberus is
explicit about which of the two 503 cases it is in and a proxy in front of it can rewrite a
status without knowing what it meant.

`cerberus_credentials_invalid` is the one code here that is nobody at the venue's fault: it
means the broker reached DWAB and DWAB refused the *organisation's* credential. It is
deliberately not a 401, so that an operator staring at a rejection can tell it apart from
their own key being wrong.

`cerberus_upgrade_required` is the one whose message gets composed rather than copied.
Cerberus reports the floor in a separate `minimum` field, so `CerberusAuth.lastFailure()`
reads *"Client version below the supported minimum (minimum 0.2.0, this build is 0.1.0)"* —
the bare server message tells an operator they are too old without telling them what is new
enough.

### Signing and authorization

| Code | When | Drops bearer |
|---|---|---|
| `invalid_signature` | TM answered 401 or 403, and the measured clock skew is within tolerance. | **yes** |
| `clock_skew` | TM answered 401 or 403, and the measured skew exceeds `maxClockSkewMs` (default 5 minutes). | **yes** |
| `token_expired` | Never produced by this package. See below. | **yes** |

> **`invalid_signature`** — TM rejected the request signature. Check, in order: the
> canonical string ends with a trailing newline; the address you called matches the host
> that is actually listening (including the port); the API key matches the one TM currently
> shows.

> **`clock_skew`** — This machine's clock differs from the TM server's by more than the
> allowed margin, so the signature is rejected. Sync the clock (enable automatic time) and
> retry.

> **`token_expired`** — The bearer token expired before the request completed. This should
> recover on retry.

**`token_expired` is declared, has a remedy, and invalidates the bearer, but nothing in
this package ever returns it.** It is part of the code vocabulary for an `AuthProvider` you
write yourself: if your provider can tell that a token aged out in flight, this is the code
for it, and `TmHttpClient` will drop the cached bearer when it sees it. The two shipped
providers never need it, because they recompute remaining life on every read and refresh
inside a five-minute margin.

### Generic

| Code | When | Drops bearer |
|---|---|---|
| `http_error` | TM answered a non-2xx status that is none of the above. | no |
| `malformed_response` | TM's 200 body was not JSON; TM answered 304 with no matching cache entry; a resource envelope key was missing or the wrong shape; DWAB answered 200 with something that is not a token. | no |

> **`http_error`** — TM returned an unexpected HTTP status. See the detail field for the
> response body.

> **`malformed_response`** — TM's response could not be parsed as the expected JSON shape.
> This usually means a TM version mismatch.

A 304 with no cache entry earns `malformed_response` because there is genuinely no correct
answer: TM has told us nothing changed, and we have nothing to compare it against. Inventing
data or returning `undefined` would both be worse than saying so.

### Field set websocket

| Code | When | Drops bearer |
|---|---|---|
| `ws_headers_unsupported` | No transport can sign the handshake: not Node or Bun and no explicit factory, or Node without the optional `ws` package. | no |
| `ws_connection_error` | The factory threw, the socket emitted `error`, building the signed headers threw, or `send()` threw on an apparently-open socket. | no |
| `ws_closed` | The socket emitted `close`; or `send()` was called before `connect()` or after `disconnect()`. | no |

> **`ws_headers_unsupported`** — This runtime's WebSocket cannot send the Authorization,
> x-tm-date and x-tm-signature headers that TM requires on the field set socket. Run under
> Node or Bun, pass your own webSocketFactory, or proxy through a relay you control.
> Browsers cannot do this at all.

> **`ws_connection_error`** — The field set websocket failed to connect. Check the field set
> ID exists and that TM is reachable.

> **`ws_closed`** — The field set websocket is closed. Reconnect before sending commands.

`ws_headers_unsupported` is the only socket failure the reconnect ladder does not retry. No
amount of waiting gives a runtime the ability to set handshake headers, so the socket stops
outright and a later `send()` fails with `ws_closed` rather than queueing into something
that can never open.

The socket does drop the bearer on its own when TM refuses the upgrade with a 401 or 403 —
that status only survives in the transport's error text, so it is matched there rather than
through `shouldInvalidateBearer`.

---

## Splitting TM's 401

This is the package's main diagnostic value, and the reason the taxonomy is as fine-grained
as it is.

TM answers a bad signature, a skewed clock and a disabled Local API with responses that look
nearly identical to an operator — a bare rejection with no useful body. The reference
implementations collapse them: `vex-tm-client`'s `TMErrors` enum has one code for all of it,
and an operator handed "unauthorized" has three completely different things to go and try.

This package splits them into `invalid_signature`, `clock_skew` and `local_api_disabled`.
The evidence it uses is the response *status* and the server's own `Date` header, which is
recorded on every response — success and failure alike — before anything is classified.

### The order to check them

`remedy("invalid_signature")` is written as an ordered list because that is the order in
which these actually go wrong:

**1. `invalid_signature` — the canonical string is wrong.** By a wide margin the most common
cause is a missing trailing newline. The canonical string has five lines and the fifth is
terminated too; drop that byte and TM answers 401 with no explanation. It is invisible in
any output that does not escape it, which is why `tm-cli sign` prints an escaped form, the
byte length, and an explicit verdict on the trailing newline.

The other two causes, in order: the address you called does not match the host that is
actually listening — `url.host` is what gets signed, so `:8080` present in the request and
absent in the signature is an instant 401 — and the API key no longer matches the one TM
shows, which happens when the Event Partner regenerates it or moves to a new event.

```
$ tm-cli sign --api-key TESTAPIKEY0123456789 \
    --url http://127.0.0.1:8151/api/event \
    --token abc123 --date 'Tue, 11 Aug 2026 03:14:00 GMT'
escaped:    GET\n/api/event\ntoken:abc123\nhost:127.0.0.1:8151\nx-tm-date:Tue, 11 Aug 2026 03:14:00 GMT\n
bytes:      88
trailing newline: present
```

**2. `clock_skew` — this machine's clock is too far from TM's.** The `x-tm-date` header is
part of the signature specifically so old signatures cannot be replayed, which means the
client's clock has to agree with the server's. When TM rejects a request *and* the measured
skew exceeds `maxClockSkewMs`, the failure is relabelled and the message names the actual
drift:

```
error: TM returned 401; this machine's clock differs from the server's by -3599s. (HTTP 401)
  This machine's clock differs from the TM server's by more than the allowed margin, so the
  signature is rejected. Sync the clock (enable automatic time) and retry.
```

The sign follows `observedClockSkewMs`: positive means this machine is ahead of TM, negative
means behind. The default tolerance is five minutes, wide enough that ordinary NTP drift
never trips it and narrow enough that a machine with a dead RTC does. TM's own tolerance is
not documented.

**Skew is diagnosed and never corrected.** The observed offset relabels a 401 and is
readable as `client.http.observedClockSkewMs`, but it never changes the outgoing
`x-tm-date`. Auto-correcting would paper over a dead RTC or a machine with no NTP, which is
the one thing the operator actually needs told, and it would let an untrusted response
header steer what gets signed.

**3. `local_api_disabled` — the API is simply switched off.** A 503, or a 404 under `/api/`.
The Event Partner has to tick **Tools > Options > Web Publishing > Enable Local TM API** and
save, **for each event they host**. Forgetting it on the second event of a weekend is the
single most common misconfiguration this package sees.

This one is checked first in the code even though it is listed third here, because the
status decides it outright and there is nothing to weigh up. The ordering above is the order
a human should try things once TM has answered 401 specifically.

---

## HTTP status mapping

How `TmHttpClient` classifies a TM response:

| Status | Code |
|---|---|
| 2xx | success |
| 304 with a cache entry | success, `cached: true` |
| 304 with no cache entry | `malformed_response` |
| 401, 403 — skew within tolerance | `invalid_signature` |
| 401, 403 — skew beyond tolerance | `clock_skew` |
| 404 on a path under `/api/` | `local_api_disabled` |
| 404 elsewhere | `http_error` |
| 503 | `local_api_disabled` |
| anything else non-2xx | `http_error` |
| `fetch` threw | `host_unreachable` |

And how the Cerberus provider classifies a broker response. The body's named `error` wins
over the status:

| `error` in body | Code | Status fallback |
|---|---|---|
| `invalid_client` | `cerberus_key_invalid` | 401 |
| `upgrade_required` | `cerberus_upgrade_required` | 426 |
| `rate_limited` | `cerberus_rate_limited` | 429 |
| `credentials_expired`, `credentials_invalid` | `cerberus_credentials_invalid` | 503 |
| `upstream_error` | `cerberus_upstream_error` | anything else |

---

## Invalidating the bearer

Seven codes return `true` from `shouldInvalidateBearer`:

`invalid_signature` · `clock_skew` · `token_expired` · `dwab_invalid_client` ·
`dwab_credentials_expired` · `cerberus_key_invalid` · `cerberus_credentials_invalid`

When `TmHttpClient.get()` sees one, it drops the cached bearer **and** that URL's
conditional-GET entry, then returns the error. Both halves matter. Upstream's
`vex-tm-client` returns the 401 and keeps both, so the next call re-sends the token TM has
already refused and, on the 304 that follows, hands the caller a stale body as though it
were fresh — a token that has been dead for fifty minutes serving data that looks live.

Dropping the bearer is not the same as retrying. This package does not retry the request;
it invalidates, returns the error, and lets the next call mint a fresh token. That keeps a
failing credential from turning into a silent loop, and it keeps the decision about whether
to try again with the caller.

The codes that do *not* invalidate are the ones where the token is fine and something else
is wrong: the host is unreachable, the API is off, the broker is rate-limiting, TM returned
a 500. Throwing away a working token in those cases costs a round trip and fixes nothing.

Both shipped providers guard against a subtler version of the same bug: a mint that was
already in flight when `invalidate()` was called cannot repopulate the cache. Cerberus caches
its DWAB token server-side, so the response to that in-flight request may be the very token
TM just rejected.
