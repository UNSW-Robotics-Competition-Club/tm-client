# Troubleshooting

Most problems with the TM API present as one of two symptoms: a bare `401` with no
explanation, or a socket that will not open. This page is ordered by how often each
cause actually turns out to be the one.

## A bare 401

TM answers a wrong signature, a skewed clock, a revoked key and a disabled Local API with
responses that look nearly identical. This package splits them into distinct error codes,
so start by reading the code rather than the status:

```ts
const result = await tm.getEvent();
if (!result.ok) {
  console.error(result.error.code);     // e.g. "invalid_signature"
  console.error(remedy(result.error.code));
}
```

Check the causes in this order. It is roughly the order of likelihood, and each step is
cheap.

### 1. The trailing newline

The canonical string is five lines, **each terminated by a newline, including the last
one**. Dropping the final `\n` is the single most common integration mistake, and TM's
only response is an unexplained 401.

```
GET\n/api/event\ntoken:<bearer>\nhost:192.168.1.50\nx-tm-date:<RFC1123>\n
                                                                       ↑ this one
```

Confirm what is actually being signed:

```bash
tm-cli sign --method GET --url http://192.168.1.50/api/event \
  --token <bearer> --date 'Tue, 11 Aug 2026 03:14:00 GMT' --api-key <key>
```

It prints the canonical string in both escaped and raw form, its byte count, and an
explicit trailing-newline check. If you are using this package's `signTmRequest`, this is
already correct and you can move on — the signer is pinned to golden vectors shared with
two other implementations.

### 2. The host you signed is not the host you called

The signature covers `url.host`, which **includes a non-default port**. `:8080` is part
of the signed string; `:80` is not. So signing `http://192.168.1.50/api/event` and then
calling `http://192.168.1.50:8080/api/event` produces a valid signature for a different
request, and TM rejects it.

If TM is reached through a reverse proxy or an SSH tunnel, the host the proxy forwards may
differ from the one you signed. Sign the address you actually connect to.

### 3. Clock skew

The signature includes `x-tm-date`, and TM rejects a date too far from its own clock —
which is the point, since it stops an old signature being replayed. A laptop with a dead
RTC or no NTP drifts enough to break this within days.

```ts
console.log(tm.http.observedClockSkewMs);
```

The client measures the offset from TM's own `Date` response header and uses it to
relabel a 401 as `clock_skew` rather than `invalid_signature`. It **does not correct the
outgoing date**, deliberately: silently compensating would hide a broken clock, which is
usually a symptom of something else worth knowing about, and would let a response header
influence what gets signed.

Fix the clock (enable automatic time), do not work around it.

### 4. The Local API is off, or the key changed

`local_api_disabled` means TM answered 503, or 404 on an `/api/` path. In TM: **Tools >
Options > Web Publishing > Enable Local TM API**, then save.

Two things people get caught by:

- **It must be enabled for each event.** A machine that worked last weekend is not
  necessarily enabled today.
- **The API key is regenerated with it.** If the box was unticked and re-ticked, the key
  your app holds is stale even though it looks right.

## The bearer, not the signature

If the code is `cerberus_*` or `dwab_*`, the request never reached TM — the token could
not be minted.

| Code | What it means |
|---|---|
| `cerberus_key_invalid` | The `ctm_` key was rejected, or is malformed. The shape is checked locally before any network call, so a typo fails immediately. |
| `cerberus_upgrade_required` | This build is below the version floor. The message names the minimum. |
| `cerberus_rate_limited` | Too many mints. Honour `Retry-After`. Usually means something is minting per request instead of caching. |
| `cerberus_credentials_invalid` | Cerberus's own upstream credential is broken. Server-side; not your key. |
| `dwab_credentials_expired` | The DWAB credential passed its expiry date. No network call is made. |

`auth.lastFailure()` on a Cerberus provider gives the operator-facing sentence for the
most recent refusal.

### "Expired" when the credential is fine

If `createDwabAuth` throws `TmConfigError` at construction, check the units.
`expirationDateMs` is **milliseconds**. A ten-digit seconds value reads as a date in 1970,
so a perfectly good credential looks long expired before DWAB is ever contacted. The
constructor rejects it rather than letting it fail confusingly later.

## The field set socket will not connect

### In a browser, it never will

TM signs the socket's HTTP upgrade with the same headers it requires on REST, and the
WebSocket spec forbids JavaScript from setting handshake headers. This is not a gap in
the package; there is no workaround at any level. `connect()` returns
`ws_headers_unsupported`.

Options: run the socket in Node or Bun, inject a `WebSocketFactory` for a runtime that
can set headers (Cloudflare Workers can, via `fetch` with an `Upgrade` header), or put a
relay you control between the browser and TM.

### Under Node

`ws` is an optional dependency. If it is not installed, the factory cannot load and you
get `ws_headers_unsupported` with a message saying so. `npm install ws`.

If you are consuming a **built bundle** rather than source, make sure `ws` was not
inlined by your bundler. An inlined copy fails on its conditional native-addon loading,
and the symptom is identical to not having it installed. This package marks it external
for exactly that reason.

### It connects, then drops repeatedly

Watch the `reconnecting` event — it carries `{ attempt, delayMs }`. If the ladder keeps
climbing from 1s, the socket is being refused rather than dropped, and the cause is
usually auth: a token that expired mid-session, or an API key rotated underneath you.

## Commands appear to do nothing

`send()` resolving `ok` means **written to the socket**, not **applied by TM**. There is
no acknowledgement in the protocol to wait on.

If the socket is down, the command is queued and flushed on reconnect — so `ok` can also
mean "queued". For a one-shot command where that distinction matters, check `connected`
first:

```ts
if (!socket.connected) throw new Error("not connected");
await socket.queueNextMatch();
```

To confirm TM acted, watch for the resulting event. A `setAudienceDisplay` produces an
`audienceDisplayChanged`; that echo is the real confirmation.

## A timeout looks like a match

TM reports a timeout as a `fieldMatchAssigned` whose `match` object is **empty**. There is
no type tag distinguishing it, and code that reads match fields without checking will
treat a timeout as match 0 of round 0.

`reduceFieldsetState` handles this by key count, producing
`FieldsetActiveMatchType.Timeout`. If you parse events yourself, you must do the same.
Related: `fieldID` is `number | null`, and null means the queue was cleared entirely.

## Nothing is wrong but nothing updates

The client honours `Last-Modified` / `If-Modified-Since`, and a `304` returns the cached
body with `cached: true`. That is working as intended, not a stale read — TM is saying
nothing changed.

The guide asks clients not to poll any resource more than about once a minute. Match cycle
times mean nothing changes faster than that anyway.

## Reporting something this page does not cover

The fastest useful bug report contains the error `code` (not just the status), the output
of `tm-cli sign` for a failing request with the key redacted, `observedClockSkewMs`, and
the TM version. Do not paste an API key or a `ctm_` key — `tm-cli --verbose` redacts
secrets to their last four characters for exactly this reason.
