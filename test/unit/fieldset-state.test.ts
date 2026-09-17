import { describe, expect, it } from "vitest";

import {
	INITIAL_FIELDSET_STATE,
	parseFieldsetEvent,
	reduceFieldsetState,
} from "../../src/fieldset-socket.js";
import {
	FieldsetActiveMatchType,
	FieldsetAudienceDisplay,
	FieldsetQueueState,
	MatchRound,
	type FieldsetEvent,
	type FieldsetState,
	type MatchTuple,
} from "../../src/types.js";

const TUPLE: MatchTuple = {
	session: 1,
	division: 1,
	round: MatchRound.Qualification,
	instance: 0,
	match: 12,
};

function stateWith(match: FieldsetState["match"]): FieldsetState {
	return { ...INITIAL_FIELDSET_STATE, match };
}

const QUEUED_MATCH = stateWith({
	type: FieldsetActiveMatchType.Match,
	state: FieldsetQueueState.Unplayed,
	match: TUPLE,
	fieldID: 1,
	active: false,
});

const QUEUED_TIMEOUT = stateWith({
	type: FieldsetActiveMatchType.Timeout,
	state: FieldsetQueueState.Unplayed,
	fieldID: 2,
	active: false,
});

describe("reduceFieldsetState", () => {
	const cases: { name: string; from: FieldsetState; event: FieldsetEvent; to: FieldsetState }[] = [
		{
			// The single most important behaviour in the package: TM reports a
			// timeout as a fieldMatchAssigned whose match object is empty.
			name: "an empty match object with a field is a TIMEOUT",
			from: INITIAL_FIELDSET_STATE,
			event: { type: "fieldMatchAssigned", fieldID: 2, match: {} },
			to: QUEUED_TIMEOUT,
		},
		{
			name: "a populated tuple is a MATCH",
			from: INITIAL_FIELDSET_STATE,
			event: { type: "fieldMatchAssigned", fieldID: 1, match: TUPLE },
			to: QUEUED_MATCH,
		},
		{
			name: "an assignment replaces whatever was queued before",
			from: QUEUED_MATCH,
			event: { type: "fieldMatchAssigned", fieldID: 2, match: {} },
			to: QUEUED_TIMEOUT,
		},
		{
			name: "an empty match with a null field clears the queue",
			from: QUEUED_MATCH,
			event: { type: "fieldMatchAssigned", fieldID: null, match: {} },
			to: INITIAL_FIELDSET_STATE,
		},
		{
			name: "fieldActivated with nothing queued invents a timeout",
			from: INITIAL_FIELDSET_STATE,
			event: { type: "fieldActivated", fieldID: 3 },
			to: stateWith({
				type: FieldsetActiveMatchType.Timeout,
				state: FieldsetQueueState.Unplayed,
				fieldID: 3,
				active: true,
			}),
		},
		{
			name: "fieldActivated marks the queued match active on that field",
			from: QUEUED_MATCH,
			event: { type: "fieldActivated", fieldID: 4 },
			to: stateWith({
				type: FieldsetActiveMatchType.Match,
				state: FieldsetQueueState.Unplayed,
				match: TUPLE,
				fieldID: 4,
				active: true,
			}),
		},
		{
			name: "matchStarted with nothing queued records a running timeout",
			from: INITIAL_FIELDSET_STATE,
			event: { type: "matchStarted", fieldID: 1 },
			to: stateWith({
				type: FieldsetActiveMatchType.Timeout,
				state: FieldsetQueueState.Running,
				fieldID: 1,
				active: false,
			}),
		},
		{
			name: "matchStarted runs the queued match",
			from: QUEUED_MATCH,
			event: { type: "matchStarted", fieldID: 1 },
			to: stateWith({
				type: FieldsetActiveMatchType.Match,
				state: FieldsetQueueState.Running,
				match: TUPLE,
				fieldID: 1,
				active: false,
			}),
		},
		{
			name: "matchStopped stops the queued match",
			from: QUEUED_MATCH,
			event: { type: "matchStopped", fieldID: 1 },
			to: stateWith({
				type: FieldsetActiveMatchType.Match,
				state: FieldsetQueueState.Stopped,
				match: TUPLE,
				fieldID: 1,
				active: false,
			}),
		},
		{
			name: "matchStopped with nothing queued changes nothing",
			from: INITIAL_FIELDSET_STATE,
			event: { type: "matchStopped", fieldID: 1 },
			to: INITIAL_FIELDSET_STATE,
		},
		{
			name: "audienceDisplayChanged records the display",
			from: INITIAL_FIELDSET_STATE,
			event: {
				type: "audienceDisplayChanged",
				display: FieldsetAudienceDisplay.Rankings,
			},
			to: { ...INITIAL_FIELDSET_STATE, audienceDisplay: FieldsetAudienceDisplay.Rankings },
		},
		{
			name: "audienceDisplayChanged leaves the queued match alone",
			from: QUEUED_MATCH,
			event: { type: "audienceDisplayChanged", display: FieldsetAudienceDisplay.InMatch },
			to: { ...QUEUED_MATCH, audienceDisplay: FieldsetAudienceDisplay.InMatch },
		},
	];

	for (const { name, from, event, to } of cases) {
		it(name, () => {
			expect(reduceFieldsetState(from, event)).toEqual(to);
		});
	}

	it("does not mutate the state it is given", () => {
		const before = structuredClone(QUEUED_MATCH);
		reduceFieldsetState(QUEUED_MATCH, { type: "matchStarted", fieldID: 9 });
		reduceFieldsetState(QUEUED_MATCH, { type: "fieldActivated", fieldID: 9 });
		reduceFieldsetState(QUEUED_MATCH, {
			type: "audienceDisplayChanged",
			display: FieldsetAudienceDisplay.Blank,
		});
		expect(QUEUED_MATCH).toEqual(before);
	});

	it("returns the same object when nothing changed, so callers can diff by identity", () => {
		expect(
			reduceFieldsetState(INITIAL_FIELDSET_STATE, { type: "matchStopped", fieldID: 1 }),
		).toBe(INITIAL_FIELDSET_STATE);
	});

	it("keeps a timeout distinguishable from a match after it starts", () => {
		const queued = reduceFieldsetState(INITIAL_FIELDSET_STATE, {
			type: "fieldMatchAssigned",
			fieldID: 1,
			match: {},
		});
		const running = reduceFieldsetState(queued, { type: "matchStarted", fieldID: 1 });
		expect(running.match.type).toBe(FieldsetActiveMatchType.Timeout);
	});
});

describe("parseFieldsetEvent", () => {
	it("parses each of the five event types from JSON text", () => {
		expect(parseFieldsetEvent('{"type":"fieldActivated","fieldID":1}')).toEqual({
			type: "fieldActivated",
			fieldID: 1,
		});
		expect(parseFieldsetEvent('{"type":"matchStarted","fieldID":1}')).toEqual({
			type: "matchStarted",
			fieldID: 1,
		});
		expect(parseFieldsetEvent('{"type":"matchStopped","fieldID":1}')).toEqual({
			type: "matchStopped",
			fieldID: 1,
		});
		expect(parseFieldsetEvent('{"type":"audienceDisplayChanged","display":"RANKINGS"}')).toEqual({
			type: "audienceDisplayChanged",
			display: FieldsetAudienceDisplay.Rankings,
		});
		expect(parseFieldsetEvent('{"type":"fieldMatchAssigned","fieldID":1,"match":{}}')).toEqual({
			type: "fieldMatchAssigned",
			fieldID: 1,
			match: {},
		});
	});

	it("accepts an already parsed object", () => {
		expect(parseFieldsetEvent({ type: "matchStarted", fieldID: 2 })).toEqual({
			type: "matchStarted",
			fieldID: 2,
		});
	});

	it("keeps the null fieldID of a queue-cleared assignment", () => {
		expect(parseFieldsetEvent('{"type":"fieldMatchAssigned","fieldID":null,"match":{}}')).toEqual({
			type: "fieldMatchAssigned",
			fieldID: null,
			match: {},
		});
	});

	it.each([
		["an unknown event type", '{"type":"matchPaused","fieldID":1}'],
		["a missing type", '{"fieldID":1}'],
		["a non-numeric fieldID", '{"type":"matchStarted","fieldID":"1"}'],
		["an unknown audience display", '{"type":"audienceDisplayChanged","display":"HOLOGRAM"}'],
		["an array in place of a match object", '{"type":"fieldMatchAssigned","fieldID":1,"match":[]}'],
		["malformed JSON", "{not json"],
		["a JSON scalar", "42"],
		["null", "null"],
	])("returns null for %s", (_name, raw) => {
		expect(parseFieldsetEvent(raw)).toBeNull();
	});
});
