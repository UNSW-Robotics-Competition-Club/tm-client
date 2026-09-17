# Getting started

From nothing to a successful call against a real Tournament Manager instance. Read the
authentication section first even if you are in a hurry — almost every failure people hit
with this API comes from not understanding that there are two credentials doing two
different jobs.

## What you will need

- **Node 22 or later** for the examples here. The library itself runs anywhere `fetch`,
  `URL` and `crypto.subtle` exist; the field set websocket is the exception, and
  [fieldset-socket.md](fieldset-socket.md) explains why.
- **The TM laptop's address on the venue LAN**, e.g. `http://192.168.1.50` or
  `http://192.168.1.50:8080`. TM's web server is plain HTTP.
- **An app credential** — either DWAB's client ID and secret, or a Cerberus key if your
  organisation runs a broker.
- **The event's TM API key**, which only exists once the Event Partner has switched the
  Local API on for that event.

## The two halves of authentication

TM asks two separate questions on every request, and answers both with the same
unexplained 401 when either goes wrong.

1. **Is this app allowed to talk to the TM API at all?** Answered by an OAuth 2.0 bearer
   token. You obtain it from DWAB's authorisation server using a client ID and secret that
   DWAB issues to you after reviewing your application. The token is short-lived and says
   nothing about any particular event.

2. **Has this Event Partner authorised this app to touch *their* event?** Answered by an
   HMAC-SHA256 signature over a canonical string, keyed with the API key that TM itself
   generates when the Event Partner enables the Local API. The key never leaves the venue
   and is never sent over the wire — only the signature is.

Neither substitutes for the other. A valid bearer with a wrong signature fails, and so
does a correct signature with an expired bearer. The org-wide secret and the per-event key
meet only inside the signature computation, which is the property that makes brokered auth
(below) possible.

The library handles both. You supply an `AuthProvider` for the first and an `apiKey` for
the second, and `TmClient` signs every request for you.

## Obtaining the credentials

### 1. The app credential

DWAB issues a client ID and secret through the [TM API Credentials Request
Form](https://docs.google.com/forms/d/e/1FAIpQLSdV9EQaxfv72-yWc3tVT2WJOEmBwZlYZGOBOlU6WdPGwqRhWg/viewform).
Approval takes a human, so ask well before the event. The credential is *yours as a
developer*, not the event's, and DWAB's terms make it your problem if it leaks — do not
commit it and do not ship it inside a distributed build.

That last constraint is why Cerberus exists. A broker holds the org's DWAB secret
server-side and mints short-lived bearers against per-install keys that look like
`ctm_<16 hex>_<48 hex>` and can be revoked individually. If your organisation runs one
(SRA's is at `https://tm.unswrobotics.com`), you want a `ctm_` key instead of the raw DWAB
credential. See [authentication.md](authentication.md) for what the broker does and does
not do.

### 2. The event's TM API key

This one is physical: someone has to do it on the scoring laptop, in TM, for each event.

1. Open Tournament Manager.
2. **Tools > Options**.
3. Select the **Web Publishing** category.
4. Tick **Enable Local TM API** and save.

TM generates the API key at that point and shows it in the same panel. Copy it out
verbatim — it is the HMAC key, so a truncated paste produces a signature that fails with
no explanation.

Two things people get caught by:

- **It is per event.** Creating a new event in TM means ticking the box again, and the key
  changes. A tool that worked yesterday failing at the next event is almost always this.
- **If the box is not ticked, `/api/*` answers 503** (some builds answer 404). The library
  reports that as `local_api_disabled` rather than a bare HTTP error, precisely because it
  is the most common misconfiguration at a venue.

While you are in that panel, note the address and port TM says it is serving on. The port
is part of the signature, so `http://192.168.1.50` and `http://192.168.1.50:8080` are not
interchangeable.

## Install

```bash
npm install @unsw-robotics-competition-club/tm-client
npm install ws            # only if you need the field set websocket under Node
```

The package publishes to GitHub Packages, so your `.npmrc` needs the scope pointed at that
registry and an authenticated token:

```
@unsw-robotics-competition-club:registry=https://npm.pkg.github.com
```

During development against a checkout, a `file:` dependency works and is what the sibling
projects in this repo set use:

```json
{ "dependencies": { "@unsw-robotics-competition-club/tm-client": "file:../TM-Auth" } }
```

`ws` is an `optionalDependency`. Skip it if you only make REST calls; `FieldsetSocket` is
the only thing that needs it, and it fails with a named error rather than a module
resolution crash if it is absent.

## Your first call

```ts
import { TmClient, createCerberusAuth, remedy } from "@unsw-robotics-competition-club/tm-client";

const tm = new TmClient({
  baseUrl: process.env.TM_ADDRESS!,        // http://192.168.1.50
  apiKey: process.env.TM_API_KEY!,         // from Web Publishing
  auth: createCerberusAuth({
    endpoint: "https://tm.unswrobotics.com",
    apiKey: process.env.TM_CERBERUS_KEY!,  // ctm_...
    build: { version: "1.0.0" },
  }),
});

const event = await tm.getEvent();
if (!event.ok) {
  console.error(event.error.message);
  console.error(remedy(event.error.code));
  process.exit(1);
}

console.log(`${event.data.name} (${event.data.code})`);
```

If you have a DWAB credential rather than a broker key, swap the provider and change
nothing else:

```ts
import { createDwabAuth } from "@unsw-robotics-competition-club/tm-client";

auth: createDwabAuth({
  clientId: process.env.TM_CLIENT_ID!,
  clientSecret: process.env.TM_CLIENT_SECRET!,
  expirationDateMs: Number(process.env.TM_EXPIRATION_DATE_MS),  // MILLISECONDS
}),
```

There is no `connect()` step. The first call that needs a bearer mints one, and every call
after it shares the cached token.

### Reading the result

Nothing here throws on an expected failure. Fallible calls return a `Result<T>`:

```ts
type Result<T> =
  | { ok: true; data: T; cached: boolean }
  | { ok: false; error: { code, message, detail?, httpStatus? } };
```

`ok` narrows the union, so TypeScript will not let you read `data` before you have checked
it. `error.message` is the technical description; `remedy(error.code)` is the sentence to
put in front of an operator. `cached` is `true` when TM answered 304 Not Modified and the
library served the body it already had — see [api-reference.md](api-reference.md) for how
the conditional-GET cache works.

Wiring mistakes do throw, as `TmConfigError`: a `baseUrl` that is not a URL, a runtime with
no `fetch`, a credential expiry in the wrong unit. Those are bugs in your code rather than
conditions a venue can recover from, so they fail loudly and immediately.

## Checking it works without writing code

`tm-cli` ships in the package and reads the same environment variables, which makes it the
fastest way to prove a laptop can reach and authenticate against TM:

```bash
export TM_ADDRESS=http://192.168.1.50
export TM_API_KEY=...
export TM_CERBERUS_KEY=ctm_...

npx tm-cli event      # Name / Code, if everything is right
npx tm-cli token      # auth mode, remaining token life; never prints the secret
npx tm-cli fieldsets  # the field sets you can open a socket to
```

Real output against a working server:

```
$ tm-cli token
Auth mode:  cerberus (https://tm.unswrobotics.com)
Address:    http://192.168.1.50
Token type: Bearer
Remaining:  120m 0s
Expires at: 2026-09-17T15:52:20.919Z
```

Exit codes are scriptable: 0 success, 1 a TM/DWAB/Cerberus failure, 2 a usage or config
error. The full command list is in [cli-reference.md](cli-reference.md).

## Trying it without a TM at all

The repository ships a mock TM that validates signatures properly, so a client that works
against it will work against real TM:

```bash
pnpm mock-tm -- --port 8080
```

It prints the fixture credentials it accepts (a `ctm_` key, a TM API key, the token mint
URL and the field set socket URL), serves all eight REST resources, and speaks the field
set websocket. `--scenario` forces specific failures — `api-disabled`, `bad-signature`,
`clock-skew`, several Cerberus refusals — which is the only practical way to test your
error handling, and `--cycle 20` replays a match every twenty seconds so a UI has
something to react to. `pnpm mock-tm -- --help` lists the scenarios.

## A complete script

This reads an event top to bottom and prints it. Everything in it was run against the mock
server; the shapes are what TM actually returns.

```ts
import {
  TmClient,
  createCerberusAuth,
  remedy,
  MatchRound,
  MatchState,
  type Result,
} from "@unsw-robotics-competition-club/tm-client";

/** Print the operator-facing remedy and stop, or hand back the data. */
function must<T>(what: string, result: Result<T>): T {
  if (result.ok) return result.data;
  console.error(`${what} failed: ${result.error.message}`);
  console.error(remedy(result.error.code));
  process.exit(1);
}

const tm = new TmClient({
  baseUrl: process.env.TM_ADDRESS ?? "http://127.0.0.1",
  apiKey: process.env.TM_API_KEY!,
  auth: createCerberusAuth({
    endpoint: process.env.TM_CERBERUS_ENDPOINT ?? "https://tm.unswrobotics.com",
    apiKey: process.env.TM_CERBERUS_KEY!,
    build: { version: "1.0.0" },
  }),
});

const event = must("event", await tm.getEvent());
console.log(`${event.name}  ${event.code}`);

const divisions = must("divisions", await tm.getDivisions());
for (const division of divisions) {
  console.log(`\n== ${division.name} (id ${division.id})`);

  const teams = must("teams", await tm.getTeams(division.id));
  console.log(`   ${teams.length} teams, ${teams.filter((t) => t.checkedIn).length} checked in`);

  const matches = must("matches", await tm.getMatches(division.id));
  const played = matches.filter((m) => m.matchInfo.state === MatchState.Scored).length;
  console.log(`   ${played}/${matches.length} matches scored`);

  const rankings = must("rankings", await tm.getRankings(division.id, MatchRound.Qualification));
  for (const rank of rankings.slice(0, 5)) {
    const teamNumbers = rank.alliance.teams.map((t) => t.number).join(", ");
    console.log(`   #${rank.rank}${rank.tied ? " (tied)" : ""}  ${teamNumbers}  ${rank.wp} WP`);
  }
}

const fieldSets = must("field sets", await tm.getFieldSets());
for (const fieldSet of fieldSets) {
  const fields = must("fields", await tm.getFields(fieldSet.id));
  console.log(`\n${fieldSet.name} (id ${fieldSet.id}): ${fields.map((f) => f.name).join(", ")}`);
}

// Non-zero here means this machine's clock disagrees with TM's. Past about five
// minutes TM starts rejecting signatures, and the 401 does not say why.
console.log(`\nclock skew vs TM: ${tm.http.observedClockSkewMs} ms`);
```

Two details in that script worth carrying with you:

- `getRankings` needs a `MatchRound`, and `rank.alliance` is a single object with a
  `teams` array. Qualification rankings produce one-team alliances with an empty `name`.
- `getFieldSets` has a capital S, because TM's response envelope key is `fieldSets` even
  though the path is `/api/fieldsets`. TM is inconsistent with itself here; the library
  follows the body.

## Being a good client

The API guide asks for restraint, and TM is a laptop that is also running an event:

- **Poll no faster than about once a minute.** Nothing at an event changes faster than a
  match cycle. The library sends `If-Modified-Since` automatically once it has seen a
  `Last-Modified`, so a repeat read costs TM a 304 and you a `cached: true` — but the
  request still happens, so the interval is still yours to choose.
- **Use the websocket for anything live.** Field activation, match start and stop arrive as
  push events within milliseconds; polling for them is both slower and ruder.
- **Never replace TM's own functionality.** The published usage restrictions rule out
  alternative audience displays, pit displays, match timers and TM Mobile lookalikes, and
  the API is non-commercial use only.

## Where to go next

- [authentication.md](authentication.md) — the token flows in depth, writing your own
  `AuthProvider`, and the signing algorithm.
- [fieldset-socket.md](fieldset-socket.md) — live events, derived state, and driving a
  field set.
- [api-reference.md](api-reference.md) — every exported function, type and option.
- [cli-reference.md](cli-reference.md) — `tm-cli` in full.
- [errors.md](errors.md) — the error codes and what each one means.
- [troubleshooting.md](troubleshooting.md) — when it does not work at the venue.
