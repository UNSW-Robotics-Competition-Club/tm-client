# The field set websocket

TM's only push channel. One socket per field set, at `/api/fieldsets/{id}`, carrying five
event types out and eight commands in. If you want to know when a match actually started —
rather than when it was scheduled — this is the only place TM tells you.

```ts
import {
  FieldsetSocket,
  FieldsetAudienceDisplay,
} from "@unsw-robotics-competition-club/tm-client";
import { createNodeWebSocketFactory } from "@unsw-robotics-competition-club/tm-client/node";

const socket = new FieldsetSocket({
  http: tm.http,
  fieldSetId: 1,
  webSocketFactory: await createNodeWebSocketFactory(),
});

socket.addEventListener("matchStarted", (e) => {
  console.log("match started on field", (e as CustomEvent).detail.fieldID);
});

const opened = await socket.connect();
if (!opened.ok) console.error(opened.error.message);

await socket.setAudienceDisplay(FieldsetAudienceDisplay.InMatch);
```

## Browsers cannot run this

Not "it is discouraged", not "you need a polyfill" — it is structurally impossible.

TM signs the socket's **HTTP upgrade** with the same `Authorization`, `x-tm-date` and
`x-tm-signature` headers it requires on REST. The WebSocket API forbids setting request
headers on the handshake; the constructor takes a URL and a subprotocol list and nothing
else. There is no workaround in a browser, and there is no trick involving query
parameters, because TM does not read the signature from anywhere but the headers.

So this package ships **no default transport**. The socket owns the state machine and takes
the transport as an injected factory:

```ts
type WebSocketFactory = (url: URL, headers: Record<string, string>) => WebSocketLike;
```

`connect()` resolves the factory at connect time — never at import time, so a bundler
targeting the browser never pulls a Node-only dependency into the graph. It tries, in
order: the `webSocketFactory` you passed, then Node, then Bun, then it gives up.

| Runtime | What happens |
|---|---|
| Node 22+ | Dynamically imports the optional `ws` package. Node's own global `WebSocket` (undici) is spec-compliant and therefore two-argument only, which is exactly what TM's signed upgrade rules out. |
| Bun | Uses Bun's non-standard `new WebSocket(url, { headers })`. Kept as its own branch because Bun's header support has regressed before. |
| Deno, Workers, anything else | No transport is found. Pass your own factory. |
| Browser / Electron renderer | Impossible. Put a relay you control in between. |

When there is no transport, `connect()` **returns** a `Result`, it does not throw:

```ts
const opened = await socket.connect();
if (!opened.ok && opened.error.code === "ws_headers_unsupported") {
  console.error(remedy(opened.error.code));
}
```

There is no retry ladder for this one. No amount of retrying gives a runtime the ability to
set handshake headers, so the socket stops its state machine outright — a command issued
afterwards fails with `ws_closed` rather than queueing into a socket that can never open.

If `ws` is simply not installed under Node you get the same code with a different message
naming the missing package, because an `optionalDependency` being absent is a normal state
rather than a broken install.

### A transport for another runtime

The factory must return an object synchronously, so a runtime whose connect is async needs
a small adapter that registers listeners now and attaches them when the socket arrives.
Sketched for Cloudflare Workers, where an upgrade is a `fetch` with `Upgrade: websocket`:

```ts
import { type WebSocketFactory, type WebSocketLike } from "@unsw-robotics-competition-club/tm-client";

const workersFactory: WebSocketFactory = (url, headers) => {
  const listeners: [string, (event: never) => void][] = [];
  let socket: WebSocket | null = null;
  const queued: string[] = [];

  void fetch(url.href, { headers: { ...headers, Upgrade: "websocket" } }).then((response) => {
    const ws = response.webSocket;
    if (!ws) throw new Error(`upgrade refused with ${response.status}`);
    ws.accept();
    for (const [type, listener] of listeners) ws.addEventListener(type, listener as never);
    for (const payload of queued) ws.send(payload);
    queued.length = 0;
    socket = ws;
  });

  return {
    get readyState() {
      return socket?.readyState ?? 0;  // 0 = CONNECTING
    },
    send: (data) => (socket ? socket.send(data) : queued.push(data)),
    close: (code, reason) => socket?.close(code, reason),
    addEventListener: (type: string, listener: (event: never) => void) => {
      if (socket) socket.addEventListener(type, listener as never);
      else listeners.push([type, listener]);
    },
  } as WebSocketLike;
};
```

Report `readyState` honestly. The socket checks it against `WS_OPEN` (1) before writing,
and a transport that claims to be open while it is not turns a queued command into a lost
one.

## Connecting

```ts
const socket = new FieldsetSocket({
  http: tm.http,          // the signed transport, for the upgrade's headers
  fieldSetId: 1,          // from tm.getFieldSets()
  webSocketFactory,       // optional under Node and Bun
  backoffMs: [1_000, 2_000, 4_000, 8_000, 15_000, 30_000],  // optional
  healthyMs: 5_000,       // optional
  runtime,                // optional; overrides Node/Bun detection, for tests
  setTimeout, clearTimeout,  // optional; injectable timers, for tests
});
```

`http` is `TmClient.http`, or anything structurally matching `FieldsetHttp` —
`authHeadersFor`, `resolve` and `invalidateBearer`. Sharing the client's transport is the
point: the socket signs its upgrade with the same bearer the REST calls use, so one token
covers both.

`connect()` opens the socket and keeps it open until you call `disconnect()`. It resolves
with the result of the **first attempt only**; every reconnect after that is reported
through the `open`, `close` and `reconnecting` events. Concurrent calls, and a manual
reconnect racing a scheduled retry, collapse onto one attempt.

`socket.url` is the signed `http(s)` URL, e.g. `http://192.168.1.50/api/fieldsets/1`. The
socket URL is that with the scheme swapped to `ws`/`wss`; `ws` and `wss` share `http` and
`https`'s default ports, so the authority the signature was built from survives the swap
unchanged.

`socket.connected` is true only while the transport reports `readyState === 1`.

## The event stream

The socket extends `EventTarget`, so listeners attach with `addEventListener` and payloads
arrive in `CustomEvent.detail`:

```ts
socket.addEventListener("fieldActivated", (e) => {
  const event = (e as CustomEvent<FieldsetEventFieldActivated>).detail;
  console.log(event.fieldID);
});
```

TM's five event types, each emitted under its own name:

| Type | Payload | Meaning |
|---|---|---|
| `fieldMatchAssigned` | `{ fieldID: number \| null, match: MatchTuple \| {} }` | A match (or a timeout) was queued to a field, or the queue was cleared. |
| `fieldActivated` | `{ fieldID: number }` | A field became the active one. |
| `matchStarted` | `{ fieldID: number }` | The match timer started. |
| `matchStopped` | `{ fieldID: number }` | The timer stopped, by expiry, abort or end-early. |
| `audienceDisplayChanged` | `{ display: FieldsetAudienceDisplay }` | The audience screen changed. |

Note TM's spelling: `fieldID`, not `fieldId`. These are wire shapes, so they keep TM's
capitalisation rather than the codebase's.

Five more events come from the library rather than TM:

| Event | `detail` | When |
|---|---|---|
| `message` | the same `FieldsetEvent` | After every recognised TM event, whatever its type. |
| `statechange` | `FieldsetState` | When the derived state actually changed. |
| `open` | `{ url }` | The socket opened, including on every reconnect. |
| `close` | `{ reason }` | The socket dropped, with the close reason or code. |
| `reconnecting` | `{ attempt, delayMs }` | A retry has been scheduled, *before* the wait. |

An unrecognised event type is ignored, not an error. TM is free to add types in a point
release, and an unknown one must not take the socket down. The same is true of a frame that
is not valid JSON, or whose fields are the wrong types — `parseFieldsetEvent` returns
`null` and the frame is dropped. If you want to see raw frames, you will need to log them
in your own transport.

### A timeout is a `fieldMatchAssigned` with an empty match

There is no type tag for a timeout anywhere on the wire. TM sends:

```json
{ "type": "fieldMatchAssigned", "fieldID": 2, "match": {} }
```

An empty `match` object is the only marker. Every correct implementation of this API has
had to detect it the same way — by counting keys:

```ts
socket.addEventListener("fieldMatchAssigned", (e) => {
  const event = (e as CustomEvent<FieldsetEventFieldMatchAssigned>).detail;

  if (event.fieldID === null) {
    console.log("queue cleared");                     // nothing is queued
  } else if (Object.keys(event.match).length === 0) {
    console.log("timeout on field", event.fieldID);   // a timeout, not a match
  } else {
    console.log("match", event.match, "on field", event.fieldID);
  }
});
```

Count the keys; do not inspect the fields. A future TM adding a field to the match object
would still pass a field-based check while live timeouts silently became matches.

### `fieldID` is `number | null`

`null` means the queue was cleared — TM sends an empty match object **and** a null field
together for that case. The type says so, which is a deliberate divergence from the prior
implementation: it checked for the null at runtime while typing the field `number`, so
every consumer of that type was one real event away from a crash the compiler had promised
was impossible.

Narrow it before you use it. The other four events always carry a real `fieldID`.

## Derived state

The socket maintains a reduced view of what is happening on the field set, available as
`socket.state` and emitted as `statechange`:

```ts
interface FieldsetState {
  match:
    | { type: "NONE" }
    | { type: "TIMEOUT"; state: FieldsetQueueState; fieldID: number; active: boolean }
    | { type: "MATCH"; state: FieldsetQueueState; match: MatchTuple; fieldID: number; active: boolean };
  audienceDisplay: FieldsetAudienceDisplay;
}
```

`FieldsetQueueState` is `UNPLAYED`, `RUNNING` or `STOPPED`; `active` is whether the field
has been activated. A real sequence, as observed against the mock:

| Event | Resulting `state.match` |
|---|---|
| — | `{ type: NONE }` |
| `fieldMatchAssigned` field 1, QUAL 2 | `{ MATCH, UNPLAYED, fieldID: 1, active: false }` |
| `fieldActivated` field 1 | `{ MATCH, UNPLAYED, fieldID: 1, active: true }` |
| `matchStarted` field 1 | `{ MATCH, RUNNING, fieldID: 1, active: true }` |
| `matchStopped` field 1 | `{ MATCH, STOPPED, fieldID: 1, active: true }` |
| `fieldMatchAssigned` field 2, `{}` | `{ TIMEOUT, UNPLAYED, fieldID: 2, active: false }` |
| `fieldMatchAssigned` field `null`, `{}` | `{ NONE }` |

Two cases in there are worth knowing about, because they are how TM actually behaves rather
than how you would design it:

- **A field going active with nothing queued is a timeout run straight from the TM UI.**
  There was no assignment event in front of it, so the reducer synthesises the timeout.
- **A match starting with nothing queued is likewise treated as a timeout**, in the
  `RUNNING` state.

The reducer is exported and pure, so you can drive it yourself — replaying a recorded
stream, or keeping a parallel view per field:

```ts
import { reduceFieldsetState, INITIAL_FIELDSET_STATE } from "@unsw-robotics-competition-club/tm-client";

let state = INITIAL_FIELDSET_STATE;
for (const event of recorded) state = reduceFieldsetState(state, event);
```

It never mutates its input, so holding on to a previous state to diff against it is safe.
`parseFieldsetEvent(raw)` is exported too, taking either JSON text or an already-parsed
value and returning a validated `FieldsetEvent` or `null`.

## Reconnecting

TM drops sockets. Laptops sleep, switches get kicked, someone restarts TM between
divisions. The socket reconnects on a fixed ladder:

```
1s → 2s → 4s → 8s → 15s → 30s → 30s → 30s → …
```

The last rung repeats forever. Override it with `backoffMs` if you must, but the shape is
deliberate: fast enough that a brief blip is invisible, slow enough that a TM which is
genuinely down is not being hammered during an event.

**The ladder resets only after a connection that survived five seconds** (`healthyMs`). A
TM that accepts the upgrade and immediately drops it — which is what a half-configured
proxy does — would otherwise be retried at one second forever.

`reconnecting` fires *before* the wait, not after, carrying `{ attempt, delayMs }`, so a
status line can say how long the gap will be while it is still in front of the operator:

```ts
socket.addEventListener("reconnecting", (e) => {
  const { attempt, delayMs } = (e as CustomEvent<{ attempt: number; delayMs: number }>).detail;
  status(`TM connection lost — retrying in ${delayMs / 1000}s (attempt ${attempt})`);
});
```

If a drop's reason mentions 401 or 403, the socket invalidates the bearer before retrying.
TM blames a bad API key and a rejected bearer with the same status on the upgrade, so a
retry with the same token would fail identically for the token's full life.

Retry timers are `unref`'d where the runtime supports it, so a pending reconnect is never
the reason a CLI refuses to exit.

## Sending commands

```ts
await socket.startMatch(1);
await socket.queueNextMatch();
await socket.setAudienceDisplay(FieldsetAudienceDisplay.Rankings);
```

### `ok` means written to the socket, not applied by TM

This is the single most important thing about `send()`. A resolved `ok` means the payload
was handed to the transport — or queued, if the socket is down. TM sends no
acknowledgement, so there is nothing to wait for. Whether the match actually started is
told by the `matchStarted` event that follows, and if you need certainty that is what you
must watch for:

```ts
await socket.startMatch(1);
// The match has NOT necessarily started here.

const started = new Promise<void>((resolve) => {
  socket.addEventListener("matchStarted", () => resolve(), { once: true });
});
```

Correlating an echo back to the specific command that caused it needs a timeout heuristic
this package does not ship.

### The outbox

Commands sent while the socket is down are **queued and flushed in order** on the next
open. An operator pressing Start during a blip expects the match to start, not an error.

After an explicit `disconnect()` the outbox is cleared and further sends fail immediately
with `ws_closed`, because there is nothing left to flush into and buffering forever would
be worse than saying so.

```ts
await socket.startMatch(1);   // ok — queued if the socket happens to be down
socket.disconnect();
await socket.queueNextMatch(); // { ok: false, error: { code: "ws_closed" } }
```

A one-shot caller that tears the socket down straight afterwards should check
`socket.connected` before sending, or the command is queued into a socket that is about to
be closed and never reaches TM. `tm-cli send` does exactly this and reports it plainly.

If the transport throws mid-write — the socket died between the `readyState` check and the
`send` — the payload is queued for the reconnect *and* the call returns
`ws_connection_error`, so you can log it without losing the command.

### The eight commands

| Method | Wire JSON |
|---|---|
| `startMatch(fieldID)` | `{"cmd":"start","fieldID":1}` |
| `endMatchEarly(fieldID)` | `{"cmd":"endEarly","fieldID":1}` |
| `abortMatch(fieldID)` | `{"cmd":"abort","fieldID":1}` |
| `resetTimer(fieldID)` | `{"cmd":"reset","fieldID":1}` |
| `queuePreviousMatch()` | `{"cmd":"queuePrevMatch"}` |
| `queueNextMatch()` | `{"cmd":"queueNextMatch"}` |
| `queueSkills(skillsID)` | `{"cmd":"queueSkills","skillsID":2}` |
| `setAudienceDisplay(display)` | `{"cmd":"setAudienceDisplay","display":"RANKINGS"}` |

Those payloads are what a TM-side observer actually receives; they were captured from the
mock server, which records every frame.

`skillsID` is `FieldsetQueueSkillsType.Programming` (1) or `.Driver` (2).
`display` is one of `FieldsetAudienceDisplay`: `BLANK`, `LOGO`, `INTRO`, `IN_MATCH`,
`RESULTS`, `SCHEDULE`, `RANKINGS`, `SC_RANKINGS`, `ALLIANCE_SELECTION`, `BRACKET`, `AWARD`,
`INSPECTION`.

The published API guide shows `start`, `endEarly`, `abort` and `reset` without a field —
`{"cmd":"start"}`. In practice a field set has several fields and TM needs to be told
which, so this package sends `fieldID` with all four, matching what the reference client
did. Field IDs come from `tm.getFields(fieldSetId)`.

`send(command)` takes the discriminated union directly if you are dispatching commands from
data rather than calling the helpers:

```ts
await socket.send({ cmd: "queueSkills", skillsID: FieldsetQueueSkillsType.Driver });
```

**These commands drive a live field.** `abort` stops a match in progress; `start` starts
one. There is no confirmation gate anywhere in this package — that decision belongs to your
UI, not to a library.

## Shutting down

```ts
socket.disconnect();
```

Closes the socket, cancels any pending retry, clears the outbox and stops the reconnect
machine. Call it before your process exits, or the ladder keeps the process alive.

## A complete listener

```ts
import {
  FieldsetSocket,
  remedy,
  type FieldsetEvent,
  type FieldsetState,
} from "@unsw-robotics-competition-club/tm-client";
import { createNodeWebSocketFactory } from "@unsw-robotics-competition-club/tm-client/node";

const socket = new FieldsetSocket({
  http: tm.http,
  fieldSetId: 1,
  webSocketFactory: await createNodeWebSocketFactory(),
});

socket.addEventListener("open", () => console.error("connected"));
socket.addEventListener("close", (e) =>
  console.error("dropped:", (e as CustomEvent<{ reason: string }>).detail.reason),
);
socket.addEventListener("reconnecting", (e) => {
  const { attempt, delayMs } = (e as CustomEvent<{ attempt: number; delayMs: number }>).detail;
  console.error(`retrying in ${delayMs}ms (attempt ${attempt})`);
});

// One line of NDJSON per TM event, so the stream can be piped into jq or a file.
socket.addEventListener("message", (e) => {
  const event = (e as CustomEvent<FieldsetEvent>).detail;
  console.log(JSON.stringify({ at: new Date().toISOString(), ...event }));
});

socket.addEventListener("statechange", (e) => {
  const state = (e as CustomEvent<FieldsetState>).detail;
  console.error("state:", state.match.type, state.audienceDisplay);
});

const opened = await socket.connect();
if (!opened.ok) {
  console.error(opened.error.message);
  console.error(remedy(opened.error.code));
  process.exit(1);
}

process.on("SIGINT", () => {
  socket.disconnect();
  process.exit(0);
});
```

That is roughly what `tm-cli watch <fieldSetId> --json` does, and the stdout/stderr split
is the same: events on stdout, status chatter on stderr, so a pipe keeps working across a
dropped cable — which is exactly when someone is watching it.

To drive it without an event running, `pnpm mock-tm -- --cycle 20` replays a full match
sequence every twenty seconds against a server that validates your signatures properly.

## See also

- [api-reference.md](api-reference.md) — every option, type and exported symbol.
- [errors.md](errors.md) — `ws_headers_unsupported`, `ws_connection_error`, `ws_closed`.
- [cli-reference.md](cli-reference.md) — `tm-cli watch` and `tm-cli send`.
- [migrating.md](migrating.md) — moving from `vex-tm-client`'s `Fieldset`, which was an
  `EventEmitter`.
