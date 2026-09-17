# CLI reference

`tm-cli` is the operator-facing front end for this package. It exists for two jobs the
library cannot do on its own: proving a TM laptop is reachable and authenticating *before*
an event starts, and triaging TM's bare 401 when it is not.

```bash
npm install -g @unsw-robotics-competition-club/tm-client
# or, without installing:
npx --package @unsw-robotics-competition-club/tm-client tm-cli event
```

Node 22 or newer. Every transcript in this file was captured against the mock TM server in
`test/mocks/`, which validates signatures for real; see [Reproducing these
transcripts](#reproducing-these-transcripts).

- [Configuration](#configuration)
- [Exit codes](#exit-codes)
- [Global flags](#global-flags)
- [Reading commands](#reading-commands)
- [`watch`](#watch)
- [`send`](#send)
- [`token`](#token)
- [`sign`](#sign)
- [Reproducing these transcripts](#reproducing-these-transcripts)

---

## Configuration

Three sources, in descending precedence: **command-line flags**, then **environment
variables**, then the JSON file named by `--config`. Built-in defaults sit below all three.
A value absent from a higher layer never blanks out a lower one, and an environment
variable set to an empty or whitespace-only string counts as absent — an unset shell
variable is often spelled that way.

| Setting | Flag | Environment | Default |
|---|---|---|---|
| TM web server | `--address <url>` | `TM_ADDRESS` | `http://127.0.0.1` |
| TM API key | `--api-key <key>` | `TM_API_KEY` | — required |
| Cerberus endpoint | `--cerberus-endpoint <url>` | `TM_CERBERUS_ENDPOINT` | `https://tm.unswrobotics.com` |
| Cerberus client key | `--cerberus-key <key>` | `TM_CERBERUS_KEY` | — |
| DWAB client ID | `--client-id <id>` | `TM_CLIENT_ID` | — |
| DWAB client secret | `--client-secret <secret>` | `TM_CLIENT_SECRET` | — |
| DWAB credential expiry | `--expiration-date-ms <ms>` | `TM_EXPIRATION_DATE_MS` | — |

Two further environment variables affect output only: `NO_COLOR` (any non-empty value
disables ANSI, per no-color.org) and `FORCE_COLOR` (any value other than `0` enables it
even when stdout is a pipe). Colour is used for exactly one thing — dimming the `--verbose`
header block — so neither matters much.

Trailing slashes are stripped from both URLs. The TM API key has no default because there
is nothing sensible to default it to; TM shows it under **Tools > Options > Web Publishing**
once the Local API is enabled.

### Choosing an auth mode

The presence of a Cerberus key decides it. If `--cerberus-key` / `TM_CERBERUS_KEY` is set,
the CLI uses the broker and ignores any DWAB values that are also present. Cerberus wins
because it is the revocable, per-build credential; DWAB direct puts an organisation-wide
secret on a venue laptop and is the fallback for people outside the organisation.

With no Cerberus key, all three DWAB values are required. Supplying some but not all names
exactly the ones you left out:

```
$ tm-cli event
error: Incomplete DWAB credentials. Missing: --client-secret or TM_CLIENT_SECRET,
--expiration-date-ms or TM_EXPIRATION_DATE_MS. Supply all three, or use a Cerberus key
(--cerberus-key or TM_CERBERUS_KEY) instead.
```

Supplying none at all names both routes:

```
$ tm-cli event
error: No auth credentials configured. Supply either a Cerberus key (--cerberus-key or
TM_CERBERUS_KEY), or all three DWAB values: --client-id or TM_CLIENT_ID, --client-secret or
TM_CLIENT_SECRET, --expiration-date-ms or TM_EXPIRATION_DATE_MS.
```

Both exit 2.

### `--config <file>`

A JSON object with any of `address`, `apiKey`, `cerberusEndpoint`, `cerberusKey`,
`clientId`, `clientSecret`, `expirationDateMs`. Keys the CLI does not recognise are
ignored, so a shared configuration file can carry settings for other tools. A key it *does*
recognise holding the wrong type is an error rather than a silent coercion:
`expirationDateMs` accepts a number or a numeric string, everything else must be a string.

```json
{
  "address": "http://192.168.1.50",
  "apiKey": "…",
  "cerberusKey": "ctm_…"
}
```

```
$ tm-cli --config ./tm.json event
Name: SRA Mock Scrimmage
Code: RE-V5RC-25-0000
```

An unreadable or malformed file exits 2 and says which:

```
$ tm-cli --config ./bad.json event
error: The config file ./bad.json is not valid JSON: Unexpected token 'o', "not json
" is not valid JSON
```

### `expirationDateMs` is milliseconds

DWAB reports credential expiry in milliseconds since the epoch. A ten-digit seconds value
reads as 1970, so a perfectly good credential would be reported expired before DWAB was
ever called. Anything below `1_000_000_000_000` is rejected by name, with the year it would
have meant.

---

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success. Also `--help` and `--version`. |
| `1` | A `TmError` — TM, DWAB or Cerberus said no. Retrying might help. |
| `2` | Usage or configuration error. Bad flags, missing credentials, an unparseable config file, an unknown command. Retrying will never help. |

That split is what makes `tm-cli` scriptable. A 2 means the invocation itself is wrong and
a supervisor should stop rather than back off; a 1 means the venue is having a bad moment
and a retry is reasonable.

An unexpected throw is reported as a 1 with its stack trace, because an unhandled exception
here is a bug in this package rather than a problem at the venue.

Failures are written to **stderr**, as the technical message followed by the operator-facing
remedy:

```
$ tm-cli event
error: TM returned 503 for a Local API path. (HTTP 503)
  TM's Local API is off. In TM: Tools > Options > Web Publishing > Enable Local TM API, then
  save. It must be enabled for each event.
```

See [errors.md](./errors.md) for every code and what each one means.

---

## Global flags

Accepted by every command, before or after the subcommand name.

| Flag | Effect |
|---|---|
| `--json` | Emit JSON on stdout and nothing else. |
| `--verbose` | Print each signed request's headers to stderr, secrets redacted. |
| `--config <file>` | Read configuration from a JSON file. |
| `-V`, `--version` | Print the version and exit 0. |
| `-h`, `--help` | Print usage and exit 0. `tm-cli <command> --help` works too. |

### `--json`

Under `--json`, stdout carries JSON and **nothing else**. Every status line, warning and
reconnect notice goes to stderr, so `tm-cli … --json | jq` keeps working during a live
event without anyone having to think about it.

List commands emit the unwrapped array verbatim — the same objects the library's
`Result.data` would give you, not the table's columns:

```
$ tm-cli event --json
{
  "name": "SRA Mock Scrimmage",
  "code": "RE-V5RC-25-0000"
}
```

An empty list emits a valid `[]` rather than nothing. Without `--json`, an empty list writes
`(no rows)` to stderr and leaves stdout untouched, so a pipe that gets nothing gets nothing
rather than a stray header row.

`watch --json` is the exception to the shape: it emits NDJSON, one event object per line,
rather than a single document. That is the only form that makes sense for a stream with no
end.

### `--verbose`

Prints the method, URL and headers of each request actually sent, to stderr:

```
$ tm-cli event --verbose
GET http://127.0.0.1:8151/api/event
  authorization: Bearer ***6877
  x-tm-date: Thu, 17 Sep 2026 13:49:19 GMT
  x-tm-signature: a5678f43352036a6f625e3fa48b852d9425725ce6ab907a06363d07f9a7292a3
Name: SRA Mock Scrimmage
Code: RE-V5RC-25-0000
```

These are the headers on the wire, not a re-signed copy: re-signing would produce a
different `x-tm-date` and therefore a different signature, which is precisely the value
being investigated. Header names appear lower-cased because they have been through a
`Headers` object.

`Authorization` is redacted to `***` plus the last four characters — enough to tell two
tokens apart, not enough to use — and values of eight characters or fewer are redacted
entirely. `x-tm-signature` is **not** redacted, deliberately: it is derived, it is bound to
one method, path and date, and comparing it against what the server expected is the entire
point. The output is meant to be pasteable into a chat during triage.

`Host` never appears. `TmHttpClient` strips it before every REST call because Fetch forbids
the header; the canonical string still signs the URL's host, and `tm-cli sign` prints that.

---

## Reading commands

Eight commands map to the eight read endpoints. All of them accept `--json`.

### `event`

```
$ tm-cli event
Name: SRA Mock Scrimmage
Code: RE-V5RC-25-0000
```

`Code` is the VEX Events SKU, when the event has one configured.

### `divisions`

```
$ tm-cli divisions
ID  NAME
 1  Division 1
 2  Division 2
```

### `teams [--division <id>]`

```
$ tm-cli teams
TEAM   NAME             ORGANISATION  LOCATION              GROUP        DIV  IN
1234A  Mock Robotics A  SRA           Sydney, Australia     HIGH_SCHOOL    1  yes
1234B  Mock Robotics B  SRA           Sydney, Australia     HIGH_SCHOOL    1  yes
5678C  Test Team C      Other         Melbourne, Australia  HIGH_SCHOOL    1  no
5678D  Test Team D      Other         Melbourne, Australia  HIGH_SCHOOL    2  yes
```

`--division` filters server-side, on `/api/teams/{id}`. `LOCATION` joins city, state and
country, skipping whichever are empty; `IN` is the check-in flag.

### `matches <divisionId>`

```
$ tm-cli matches 1
MATCH   SCHEDULED         STATE     RED          BLUE         SCORE
QUAL 1  2026-08-11 13:20  SCORED    1234A 1234B  5678C 5678D  42-31
QUAL 2  2026-08-11 13:26  SCORED    5678C 1234A  1234B 5678D  15-88
QUAL 3  2026-08-11 13:32  UNPLAYED  1234A 5678D  1234B 5678C    0-0
```

`SCHEDULED` is rendered in **local** time with no zone suffix, because the only clock that
matters at a venue is the one on the wall next to the field. The match identifier drops the
instance number for single-instance rounds, so a quarterfinal reads `QF 2-1` and a
qualification match reads `QUAL 12` — TM's own display does the same.

### `rankings <divisionId> <round>`

`<round>` takes TM's own spelling, case-insensitively: `NONE`, `PRACTICE`, `QUAL`, `QF`,
`SF`, `F`, `R16`, `R32`, `R64`, `R128`, `TOP_N`, `ROUND_ROBIN`, `SKILLS`, `TIMEOUT`.

```
$ tm-cli rankings 1 QUAL
RANK  ALLIANCE  TEAMS  W-L-T  WP  AP  SP   AVG  HIGH  PLAYED
   1  —         1234A  2-0-0   4  12  31  42.0    42       2
   2  —         5678D  1-1-0   2   8  20  30.0    88       2
```

A dash in `ALLIANCE` is normal for qualification rankings, where TM sends an empty alliance
name. A tied rank is marked with a trailing `=`, as `1=`.

An unknown round is a usage error:

```
$ tm-cli rankings 1 BOGUS
error: Unknown round "BOGUS". Expected one of: NONE, PRACTICE, QUAL, QF, SF, F, R16, R32,
R64, R128, TOP_N, ROUND_ROBIN, SKILLS, TIMEOUT.
```

### `skills`

```
$ tm-cli skills
RANK  TEAM   TOTAL  PROG  ATT  DRIVER  ATT
   1  1234A     55    25    3      30    3
   2  5678C     40    18    3      22    2
```

The two `ATT` columns are attempt counts for programming and driver respectively.

### `fieldsets` and `fields <fieldSetId>`

```
$ tm-cli fieldsets
ID  NAME
 1  Match Field Set
 2  Skills Field Set

$ tm-cli fields 1
ID  NAME
 1  Field 1
 2  Field 2
```

`fieldsets` is where the IDs `watch` and `send` take come from; `fields` is where the
`--field` values come from.

Note what a nonexistent field set gets you, because it looks alarming and is not:

```
$ tm-cli fields 99
error: TM returned 404 for a Local API path. (HTTP 404)
  TM's Local API is off. In TM: Tools > Options > Web Publishing > Enable Local TM API, then
  save. It must be enabled for each event.
```

A 404 anywhere under `/api/` is reported as the Local API being off, because when it *is*
off the whole namespace is absent and that is by far the more common cause. If the other
commands are working, the API is plainly on and this is simply an ID that does not exist.

---

## `watch`

```
tm-cli watch <fieldSetId> [--filter <types>]
```

Streams a field set's events until interrupted. This is the command that runs for six hours
on a second monitor, so the stdout/stderr split is the whole design: **events go to stdout,
one per line; connection, reconnect and status chatter goes to stderr.** That means
`tm-cli watch 1 --json | jq` keeps working across a dropped cable, which is exactly when
someone is watching it.

Human-readable form — clock, padded event type, payload:

```
$ tm-cli watch 1
connected to ws://127.0.0.1:8152/api/fieldsets/1        <- stderr
23:50:11  fieldMatchAssigned      field 1  QUAL 1
23:50:12  fieldActivated          field 1
23:50:13  audienceDisplayChanged  INTRO
23:50:14  matchStarted            field 1
23:50:15  audienceDisplayChanged  IN_MATCH
23:50:16  matchStopped            field 1
23:50:17  audienceDisplayChanged  RESULTS
23:50:19  fieldMatchAssigned      field 1  QUAL 2
```

The timestamp is local `HH:MM:SS`, because the clock an operator is comparing against is the
venue's.

Two `fieldMatchAssigned` shapes are spelled out rather than rendered as assignments to
nothing, since TM gives no type tag for either. An empty match object is a **timeout**, and
renders as `field 1  TIMEOUT`; an empty match object *with* a null field is TM clearing the
queue, and renders as `nothing queued`.

With `--json`, NDJSON on stdout, one event per line:

```
$ tm-cli watch 1 --json
{"type":"matchStopped","fieldID":1}
{"type":"audienceDisplayChanged","display":"RESULTS"}
{"type":"fieldMatchAssigned","fieldID":1,"match":{"division":1,"session":0,"round":"QUAL","match":6,"instance":1}}
{"type":"fieldActivated","fieldID":1}
{"type":"audienceDisplayChanged","display":"INTRO"}
{"type":"matchStarted","fieldID":1}
```

Which pipes:

```bash
tm-cli watch 1 --json | jq -r 'select(.type == "matchStarted") | "field \(.fieldID) went live"'
```

`--filter` takes a comma-separated subset of `fieldMatchAssigned`, `fieldActivated`,
`matchStarted`, `matchStopped`, `audienceDisplayChanged`:

```
$ tm-cli watch 1 --filter matchStarted,matchStopped
connected to ws://127.0.0.1:8152/api/fieldsets/1        <- stderr
23:59:12  matchStopped            field 1
23:59:18  matchStarted            field 1
23:59:20  matchStopped            field 1
```

An unknown type is a usage error, exit 2, and names the valid set:

```
$ tm-cli watch 1 --filter bogus
error: Unknown event type in --filter: bogus. Valid types: fieldMatchAssigned,
fieldActivated, matchStarted, matchStopped, audienceDisplayChanged.
```

### Reconnecting, and stopping

`watch` reconnects on the library's backoff ladder — 1s, 2s, 4s, 8s, 15s, 30s, then 30s
forever — and narrates it on stderr:

```
disconnected: closed with code 1006
reconnecting in 1s (attempt 1)
connected to ws://127.0.0.1:8152/api/fieldsets/1
```

The notice is emitted *before* the wait, so it is still true as you read it. The ladder
resets only after a connection that survived five seconds, which stops a TM that accepts and
instantly drops from being hammered at one-second intervals.

Ctrl-C is the documented way out, so it is a clean shutdown: `watch` prints
`stopping on SIGINT` to stderr, closes the socket and **exits 0**. `SIGTERM` behaves the
same way, because a supervisor is as likely to stop this as a person is. A second Ctrl-C
still kills a socket that somehow refuses to close.

The other commands let the process exit as soon as they are done; `watch` deliberately holds
the event loop open, because if TM goes away, staying up and retrying *is* the job.

---

## `send`

```
tm-cli send <fieldSetId> <cmd> [--field <id>] [--skills-id <n>] [--display <name>]
```

Issues exactly one field set command, then tears the socket down. All eight commands are
available and there is no confirmation gate — the Stream Deck plugin and the LED controller
both need full parity, and a prompt in a CLI is worked around within a day.

| `<cmd>` | Requires |
|---|---|
| `start` | `--field <id>` |
| `endEarly` | `--field <id>` |
| `abort` | `--field <id>` |
| `reset` | `--field <id>` |
| `queuePrevMatch` | — |
| `queueNextMatch` | — |
| `queueSkills` | `--skills-id <1\|2>` |
| `setAudienceDisplay` | `--display <NAME>` |

The command name is matched case-insensitively, which matters because the wire spelling is
camelCase and easy to mistype. `--skills-id` accepts `1`/`programming`/`prog` or
`2`/`driver`. `--display` accepts any `FieldsetAudienceDisplay` value, case-insensitively:
`BLANK`, `LOGO`, `INTRO`, `IN_MATCH`, `RESULTS`, `SCHEDULE`, `RANKINGS`, `SC_RANKINGS`,
`ALLIANCE_SELECTION`, `BRACKET`, `AWARD`, `INSPECTION`.

On success it echoes the exact JSON that went to TM:

```
$ tm-cli send 1 start --field 1
sent {"cmd":"start","fieldID":1}

$ tm-cli send 1 queueNextMatch
sent {"cmd":"queueNextMatch"}

$ tm-cli send 1 setAudienceDisplay --display INTRO
sent {"cmd":"setAudienceDisplay","display":"INTRO"}
```

Argument validation happens before a socket is opened, so a missing flag costs nothing and
exits 2:

```
$ tm-cli send 1 start
error: `start` requires --field <id>. List them with `tm-cli fields <fieldSetId>`.
```

A flag that means nothing for the chosen command is a warning on stderr, not an error — a
wrapper script that always passes `--field` should not break when it queues the next match,
but a typo'd command name should still be visible:

```
$ tm-cli send 1 queueNextMatch --field 1
warning: --field has no meaning for `queueNextMatch` and was ignored
sent {"cmd":"queueNextMatch"}
```

One behaviour worth knowing: the library's `send()` **queues** rather than fails when the
socket is down, and returns success either way. For a long-lived consumer that is right —
an operator pressing Start during a blip expects the match to start. For a one-shot CLI that
closes the socket on the next line it would silently drop the command and still print
`sent`. So `tm-cli send` checks the socket is actually connected first, and says so plainly
when it is not:

```
error: The field set socket dropped before start could be sent, so TM did not receive it.
  The field set socket is closed. Reconnect before sending commands.
```

---

## `token`

```
tm-cli token
```

Forces a bearer mint and reports on it. It deliberately invalidates any cached token first:
the question this command answers is "can these credentials get a token **right now**", and
serving one from an earlier run answers a different question.

```
$ tm-cli token
Auth mode:  cerberus (http://127.0.0.1:8151)
Address:    http://127.0.0.1:8151
Token type: Bearer
Remaining:  120m 0s
Expires at: 2026-09-17T15:48:56.015Z
```

```
$ tm-cli token --json
{
  "mode": "cerberus",
  "endpoint": "http://127.0.0.1:8151",
  "tokenType": "Bearer",
  "expiresInSeconds": 7200,
  "expiresAt": "2026-09-17T15:49:19.353Z"
}
```

In DWAB mode the third line reads `dwab direct (client <id>)` and the JSON carries
`clientId` in place of `endpoint`.

It prints the token's metadata and **never** the token itself, nor the Cerberus key, nor the
DWAB secret. This output is meant to be pasted into a chat while someone works out why a
venue laptop cannot authenticate.

This is the command to run first, before an event, from the machine that will be doing the
work. It answers the credential half of the problem on its own, without needing TM to be up:

```
$ tm-cli token
error: Invalid or revoked API key (HTTP 401)
  The Cerberus API key was rejected. It may have been revoked, or copied incorrectly.

$ tm-cli token
error: Client version below the supported minimum (HTTP 426)
  This build is older than the minimum version Cerberus accepts. Update to the current release.
```

When a token comes back but the broker had something to say — a stale-token fallback
succeeded, say — the sentence appears as a warning on stderr after the fields.

---

## `sign`

```
tm-cli sign --api-key <key> --url <url> --token <bearer> [--method <verb>] [--date <rfc1123>]
```

Prints the canonical string and its `x-tm-signature` for the given inputs. **It talks to
nothing** — no TM, no DWAB, no Cerberus — so it works from a laptop that cannot reach the
venue, and it is step one of triaging TM's bare 401.

```
$ tm-cli sign --api-key TESTAPIKEY0123456789 \
    --url http://127.0.0.1:8151/api/event \
    --token abc123 \
    --date 'Tue, 11 Aug 2026 03:14:00 GMT'
escaped:    GET\n/api/event\ntoken:abc123\nhost:127.0.0.1:8151\nx-tm-date:Tue, 11 Aug 2026 03:14:00 GMT\n
bytes:      88
lines:      5, ending with a newline (compare yours)

--- begin canonical string ---
GET
/api/event
token:abc123
host:127.0.0.1:8151
x-tm-date:Tue, 11 Aug 2026 03:14:00 GMT
--- end canonical string ---

signature:  ca3c2c3656ddba73faa6ec750f6a8f6466c599bd47ddf0d42f6752c63afcf50a
```

The canonical string has five lines and a **mandatory** trailing newline, and a missing
trailing newline is the single most common cause of a 401. Since it is invisible in normal
output, this command prints an escaped form alongside the raw one and states the byte
length, so the difference is something you can actually see.

The `lines:` line states the canonical form rather than checking your input — this command
builds the string with the library's own `stringToSign`, which cannot get it wrong. Its
value is as a reference: the escaped form and the byte count are what you compare your *other*
implementation's canonical string against, whether that is a shell script, a Python
prototype or a colleague's guess. If yours is 87 bytes where this says 88, that is the
newline.

The three values to check against what TM saw: `host` must include the port if the server is
not on 80 or 443, the second line must include the query string, and the byte length must
match the string you think you are signing.

```
$ tm-cli sign --api-key TESTAPIKEY0123456789 \
    --url http://127.0.0.1:8151/api/event \
    --token abc123 --date 'Tue, 11 Aug 2026 03:14:00 GMT' --json
{
  "method": "GET",
  "signedPath": "/api/event",
  "host": "127.0.0.1:8151",
  "tmDate": "Tue, 11 Aug 2026 03:14:00 GMT",
  "stringToSign": "GET\n/api/event\ntoken:abc123\nhost:127.0.0.1:8151\nx-tm-date:Tue, 11 Aug 2026 03:14:00 GMT\n",
  "stringToSignEscaped": "GET\\n/api/event\\ntoken:abc123\\nhost:127.0.0.1:8151\\nx-tm-date:Tue, 11 Aug 2026 03:14:00 GMT\\n",
  "byteLength": 88,
  "signature": "ca3c2c3656ddba73faa6ec750f6a8f6466c599bd47ddf0d42f6752c63afcf50a"
}
```

`--method` defaults to `GET` and is upper-cased. `--date` defaults to now, in RFC 1123 GMT.
`--url` must be absolute, including the scheme, or you get a usage error naming the problem.

### What `sign` does and does not read

The API key resolves the same way as everywhere else — `--api-key`, then `TM_API_KEY`,
then the `--config` file — so an exported key works without repeating it:

```
$ export TM_API_KEY=TESTAPIKEY0123456789
$ tm-cli sign --url http://192.168.1.50/api/event --token abc123
...
signature:  d9d23e9e1b523ad8af372c6efc7a048e4f00fafc4c59b50d47fed147c0e41ee0
```

With none of the three, it exits 2 naming both sources it accepts.

`--address` is genuinely inert here, and that is not an oversight: `sign` signs the URL
you pass to `--url`, and taking a host from anywhere else would defeat the point of a
command whose job is to show you exactly what a given URL produces.

### Using it against a live 401

The pairing is `--verbose` and `sign`. `--verbose` shows the signature that was actually
sent; `sign` shows the signature the inputs *should* produce. If they differ, one of the
inputs is not what you think it is.

```
$ tm-cli event --verbose
GET http://127.0.0.1:8151/api/event
  authorization: Bearer ***0726
  x-tm-date: Thu, 17 Sep 2026 13:59:10 GMT
  x-tm-signature: 8bf123584f005afc2b2fa307fe02dfa11bacbe5738126668fe476d5455d06dd9
error: TM returned 401. (HTTP 401)
  TM rejected the request signature. Check, in order: the canonical string ends with a
  trailing newline; the address you called matches the host that is actually listening
  (including the port); the API key matches the one TM currently shows.
```

Take the URL and `x-tm-date` from that block, add the API key you believe is correct, and
run `sign`. If the signatures match, the problem is the key TM currently shows or the
address; if they do not, it is the inputs. The full procedure is in
[troubleshooting.md](./troubleshooting.md).

---

## Reproducing these transcripts

Every transcript above was captured against the repository's mock TM server, which
rebuilds the canonical string and compares digests rather than waving requests through, so
a client that passes against it should pass against real TM.

```bash
pnpm build
npx tsx test/mocks/cli.ts --port 8151 &

export TM_ADDRESS=http://127.0.0.1:8151
export TM_API_KEY=TESTAPIKEY0123456789
export TM_CERBERUS_ENDPOINT=http://127.0.0.1:8151
export TM_CERBERUS_KEY=ctm_0123456789abcdef_0123456789abcdef0123456789abcdef0123456789abcdef

node dist/cli/main.js event
```

Those credentials are fixtures checked into the test suite, not secrets.

Add `--cycle 8` to replay a full match event sequence every eight seconds, which is what the
`watch` transcripts were captured against. `--scenario <name>` forces a specific failure —
`api-disabled`, `bad-signature`, `clock-skew`, `cerberus-invalid-key`,
`cerberus-upgrade-required` and others; `npx tsx test/mocks/cli.ts --help` lists them with
descriptions. That is how the error transcripts in this file and in
[errors.md](./errors.md) were produced.
