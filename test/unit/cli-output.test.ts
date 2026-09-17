import { describe, expect, it } from "vitest";
import { TmConfigError, type TmError } from "../../src/errors.js";
import {
	createOutput,
	EXIT_TM_ERROR,
	EXIT_USAGE,
	exitCodeFor,
	formatTmError,
	isTmError,
	redactAuthorization,
	redactHeaders,
	redactSecret,
	renderFields,
	renderTable,
	shouldUseColor,
	type Column,
} from "../../src/cli/output.js";

interface Row {
	id: number;
	name: string;
}

const ROW_COLUMNS: readonly Column<Row>[] = [
	{ header: "ID", value: (row) => String(row.id), align: "right" },
	{ header: "NAME", value: (row) => row.name },
];

/** Collects what was written to each stream, so routing can be asserted. */
function capture() {
	const out: string[] = [];
	const err: string[] = [];
	return {
		streams: { out: { write: (c: string) => out.push(c) }, err: { write: (c: string) => err.push(c) } },
		stdout: () => out.join(""),
		stderr: () => err.join(""),
	};
}

describe("redaction", () => {
	it("keeps only the last four characters", () => {
		expect(redactSecret("ctm_0123456789abcdef")).toBe("***cdef");
	});

	it("reveals nothing at all from a short value", () => {
		// Four of six characters is most of the secret, so short values get none.
		expect(redactSecret("abcdef")).toBe("***");
		expect(redactSecret("12345678")).toBe("***");
	});

	it("preserves the scheme in an Authorization header", () => {
		expect(redactAuthorization("Bearer abcdefghijklmnop")).toBe("Bearer ***mnop");
	});

	it("redacts Authorization regardless of header case, and leaves the rest", () => {
		const headers = redactHeaders({
			authorization: "Bearer 0123456789abcdef",
			"x-tm-date": "Tue, 11 Aug 2026 03:14:00 GMT",
			"x-tm-signature": "deadbeef",
			Host: "127.0.0.1:8080",
		});
		expect(headers["authorization"]).toBe("Bearer ***cdef");
		// The signature is derived and single-purpose; comparing it is the point of
		// --verbose, so it must survive redaction intact.
		expect(headers["x-tm-signature"]).toBe("deadbeef");
		expect(headers["Host"]).toBe("127.0.0.1:8080");
	});

	it("never leaves the full secret anywhere in the rendered headers", () => {
		const rendered = JSON.stringify(redactHeaders({ Authorization: "Bearer supersecrettoken" }));
		expect(rendered).not.toContain("supersecrettoken");
	});
});

describe("renderTable", () => {
	it("aligns columns to the widest cell and right-aligns where asked", () => {
		expect(renderTable(ROW_COLUMNS, [{ id: 1, name: "Field 1" }, { id: 100, name: "F2" }])).toBe(
			[" ID  NAME", "  1  Field 1", "100  F2"].join("\n"),
		);
	});

	it("still prints the header row for an empty list", () => {
		expect(renderTable(ROW_COLUMNS, [])).toBe("ID  NAME");
	});

	it("leaves no trailing whitespace", () => {
		const lines = renderTable(ROW_COLUMNS, [{ id: 1, name: "a" }, { id: 2, name: "bb" }]).split("\n");
		for (const line of lines) expect(line).toBe(line.trimEnd());
	});
});

describe("renderFields", () => {
	it("aligns on the colon", () => {
		expect(
			renderFields([
				["Name", "Sydney Open"],
				["Code", "RE-VIQRC-25-1234"],
			]),
		).toBe(["Name: Sydney Open", "Code: RE-VIQRC-25-1234"].join("\n"));
	});
});

describe("exit codes", () => {
	const tmError: TmError = { code: "invalid_signature", message: "TM rejected the signature" };

	it("maps a config error to 2", () => {
		expect(exitCodeFor(new TmConfigError("missing key"))).toBe(EXIT_USAGE);
	});

	it("maps a commander failure to 2", () => {
		expect(exitCodeFor({ code: "commander.unknownCommand" })).toBe(EXIT_USAGE);
	});

	it("maps a TmError to 1", () => {
		expect(exitCodeFor(tmError)).toBe(EXIT_TM_ERROR);
	});

	it("maps an unexpected throw to 1", () => {
		expect(exitCodeFor(new Error("boom"))).toBe(EXIT_TM_ERROR);
	});

	it("recognises a TmError by shape", () => {
		expect(isTmError(tmError)).toBe(true);
		expect(isTmError(new Error("boom"))).toBe(false);
		expect(isTmError(null)).toBe(false);
	});

	it("prints the message, the status and the remedy", () => {
		const text = formatTmError({ ...tmError, httpStatus: 401 });
		expect(text).toContain("TM rejected the signature");
		expect(text).toContain("HTTP 401");
		expect(text).toContain("trailing newline");
	});
});

describe("shouldUseColor", () => {
	it("follows the TTY by default", () => {
		expect(shouldUseColor({}, true)).toBe(true);
		expect(shouldUseColor({}, false)).toBe(false);
	});

	it("lets NO_COLOR win over a TTY", () => {
		expect(shouldUseColor({ NO_COLOR: "1" }, true)).toBe(false);
	});

	it("ignores an empty NO_COLOR", () => {
		expect(shouldUseColor({ NO_COLOR: "" }, true)).toBe(true);
	});

	it("lets FORCE_COLOR override a pipe", () => {
		expect(shouldUseColor({ FORCE_COLOR: "1" }, false)).toBe(true);
		expect(shouldUseColor({ FORCE_COLOR: "0" }, false)).toBe(false);
	});
});

describe("createOutput routing", () => {
	it("renders a table on stdout in human mode", () => {
		const sink = capture();
		createOutput(sink.streams).table(ROW_COLUMNS, [{ id: 1, name: "Field 1" }]);
		expect(sink.stdout()).toBe("ID  NAME\n 1  Field 1\n");
		expect(sink.stderr()).toBe("");
	});

	it("emits the raw data as JSON under --json, and nothing else on stdout", () => {
		const sink = capture();
		const out = createOutput(sink.streams, { json: true });
		out.table(ROW_COLUMNS, [{ id: 1, name: "Field 1" }]);
		out.line("this must not reach stdout");
		expect(JSON.parse(sink.stdout())).toEqual([{ id: 1, name: "Field 1" }]);
	});

	it("keeps an empty list off stdout under --json-free human mode", () => {
		const sink = capture();
		createOutput(sink.streams).table(ROW_COLUMNS, []);
		expect(sink.stdout()).toBe("");
		expect(sink.stderr()).toContain("no rows");
	});

	it("emits a valid empty JSON array for an empty list", () => {
		const sink = capture();
		createOutput(sink.streams, { json: true }).table(ROW_COLUMNS, []);
		expect(JSON.parse(sink.stdout())).toEqual([]);
	});

	it("writes notes to stderr even under --json, so a pipe stays clean", () => {
		const sink = capture();
		createOutput(sink.streams, { json: true }).note("reconnecting");
		expect(sink.stdout()).toBe("");
		expect(sink.stderr()).toBe("reconnecting\n");
	});

	it("writes one NDJSON record per line", () => {
		const sink = capture();
		const out = createOutput(sink.streams, { json: true });
		out.record({ type: "matchStarted", fieldID: 1 });
		out.record({ type: "matchStopped", fieldID: 1 });
		const lines = sink.stdout().trimEnd().split("\n");
		expect(lines).toHaveLength(2);
		expect(lines.map((line) => JSON.parse(line))).toEqual([
			{ type: "matchStarted", fieldID: 1 },
			{ type: "matchStopped", fieldID: 1 },
		]);
	});

	it("prints nothing for --verbose headers unless verbose is on", () => {
		const sink = capture();
		createOutput(sink.streams).debugRequest("GET", "http://tm/api/event", {
			Authorization: "Bearer 0123456789abcdef",
		});
		expect(sink.stderr()).toBe("");
	});

	it("prints redacted headers to stderr under --verbose", () => {
		const sink = capture();
		createOutput(sink.streams, { verbose: true }).debugRequest("GET", "http://tm/api/event", {
			Authorization: "Bearer 0123456789abcdef",
			"x-tm-date": "Tue, 11 Aug 2026 03:14:00 GMT",
		});
		expect(sink.stdout()).toBe("");
		expect(sink.stderr()).toContain("GET http://tm/api/event");
		expect(sink.stderr()).toContain("Bearer ***cdef");
		expect(sink.stderr()).not.toContain("0123456789abcdef");
	});

	it("emits no ANSI when colour is off", () => {
		const sink = capture();
		createOutput(sink.streams, { verbose: true, color: false }).debugRequest("GET", "u", {});
		expect(sink.stderr()).not.toContain(String.fromCharCode(0x1b));
	});

	it("emits ANSI when colour is on", () => {
		const sink = capture();
		createOutput(sink.streams, { verbose: true, color: true }).debugRequest("GET", "u", {});
		expect(sink.stderr()).toContain(String.fromCharCode(0x1b));
	});

	it("prints an error with its remedy to stderr", () => {
		const sink = capture();
		createOutput(sink.streams).failure({ code: "local_api_disabled", message: "TM said 503" });
		expect(sink.stdout()).toBe("");
		expect(sink.stderr()).toContain("TM said 503");
		expect(sink.stderr()).toContain("Enable Local TM API");
	});
});
