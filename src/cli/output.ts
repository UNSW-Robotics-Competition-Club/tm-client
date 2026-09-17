/**
 * Terminal output for `tm-cli`.
 *
 * Three rules shape everything here:
 *
 * 1. With `--json`, stdout carries JSON and NOTHING else. Every status line,
 *    warning and reconnect notice goes to stderr, so `tm-cli ... --json | jq`
 *    works during a live event without the operator thinking about it.
 * 2. Secrets are redacted to `***` plus the last four characters. `--verbose`
 *    exists to be pasted into a chat during 401 triage; a debugging aid that
 *    leaks a credential into someone's scrollback is worse than no aid.
 * 3. Colour is optional and bare-ANSI. No dependency, and it turns itself off
 *    when stdout is not a TTY or `NO_COLOR` is set.
 *
 * The rendering functions are pure and exported so they can be tested without
 * a terminal; `createOutput` is the thin stateful wrapper over two streams.
 */

import { remedy, TmConfigError, type TmError } from "../errors.js";

export const EXIT_OK = 0;
/** A `TmError`: TM, DWAB or Cerberus said no. */
export const EXIT_TM_ERROR = 1;
/** Bad flags, missing config — the invocation itself is wrong. */
export const EXIT_USAGE = 2;

// ---------------------------------------------------------------------------
// Redaction

/**
 * `***` plus the last four characters, which is enough to tell two keys apart
 * without disclosing either. Short values reveal nothing at all: four
 * characters of a six-character secret is most of it.
 */
export function redactSecret(value: string): string {
	if (value.length <= 8) return "***";
	return `***${value.slice(-4)}`;
}

/**
 * Redacts the bearer inside an `Authorization` header value, preserving the
 * scheme so the header still reads as one.
 */
export function redactAuthorization(value: string): string {
	const match = /^(\S+)\s+(.*)$/.exec(value);
	if (!match || match[1] === undefined || match[2] === undefined) return redactSecret(value);
	return `${match[1]} ${redactSecret(match[2])}`;
}

/**
 * Prepares signed request headers for display.
 *
 * `Authorization` is redacted: the bearer is a real credential with up to an
 * hour of life. `x-tm-signature` is NOT — it is derived, it is bound to one
 * method, path and date, and comparing it against what the server expected is
 * the entire point of `--verbose` during a 401 investigation.
 */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers)) {
		result[name] = name.toLowerCase() === "authorization" ? redactAuthorization(value) : value;
	}
	return result;
}

// ---------------------------------------------------------------------------
// Tables

export interface Column<T> {
	readonly header: string;
	readonly value: (item: T) => string;
	/** Numbers read better right-aligned; everything else defaults to left. */
	readonly align?: "left" | "right";
}

export type TableSpec<T> = readonly Column<T>[];

/**
 * Space-padded columns sized to their widest cell. No box drawing: the output
 * of a list command is routinely piped into `awk` or `grep`, and borders make
 * that worse rather than better.
 */
export function renderTable<T>(columns: TableSpec<T>, items: readonly T[]): string {
	const rows = items.map((item) => columns.map((column) => column.value(item)));
	const widths = columns.map((column, index) =>
		rows.reduce((max, row) => Math.max(max, (row[index] ?? "").length), column.header.length),
	);

	const line = (cells: readonly string[]): string =>
		cells
			.map((cell, index) => {
				const width = widths[index] ?? cell.length;
				return columns[index]?.align === "right" ? cell.padStart(width) : cell.padEnd(width);
			})
			.join("  ")
			// Trailing padding on the last column is invisible but shows up in diffs
			// and in anything that compares lines, so drop it.
			.trimEnd();

	return [line(columns.map((column) => column.header)), ...rows.map(line)].join("\n");
}

/** Key/value pairs for the single-entity commands, aligned on the colon. */
export function renderFields(fields: readonly (readonly [string, string])[]): string {
	const width = fields.reduce((max, [label]) => Math.max(max, label.length), 0);
	return fields.map(([label, value]) => `${`${label}:`.padEnd(width + 1)} ${value}`).join("\n");
}

// ---------------------------------------------------------------------------
// Errors and exit codes

export function isTmError(value: unknown): value is TmError {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { code?: unknown }).code === "string" &&
		typeof (value as { message?: unknown }).message === "string"
	);
}

/** The technical message, then the sentence the operator can act on. */
export function formatTmError(error: TmError): string {
	const status = error.httpStatus === undefined ? "" : ` (HTTP ${error.httpStatus})`;
	return `error: ${error.message}${status}\n  ${remedy(error.code)}`;
}

/**
 * 0 ok · 1 the request failed · 2 the invocation was wrong. The split matters
 * for scripting: a 2 means retrying will never help, a 1 might.
 */
export function exitCodeFor(error: unknown): number {
	if (error instanceof TmConfigError) return EXIT_USAGE;
	// Commander tags its own failures; all of them are usage problems except the
	// successful `--help` / `--version` paths, which never reach here.
	const code = (error as { code?: unknown } | null)?.code;
	if (typeof code === "string" && code.startsWith("commander.")) return EXIT_USAGE;
	if (isTmError(error)) return EXIT_TM_ERROR;
	return EXIT_TM_ERROR;
}

// ---------------------------------------------------------------------------
// The output sink

export interface WritableLike {
	write(chunk: string): unknown;
}

export interface OutputStreams {
	readonly out: WritableLike;
	readonly err: WritableLike;
}

export interface OutputOptions {
	readonly json?: boolean;
	readonly verbose?: boolean;
	readonly color?: boolean;
}

// Written as a char code so no raw escape byte ends up in the source file.
const ESC = String.fromCharCode(0x1b);
const DIM = `${ESC}[2m`;
const RESET = `${ESC}[0m`;

/**
 * Whether to emit ANSI. `NO_COLOR` wins over a TTY (no-color.org), and a
 * non-TTY stdout means someone is piping or redirecting, where escapes are
 * noise at best and corrupt a comparison at worst.
 */
export function shouldUseColor(env: Record<string, string | undefined>, isTty: boolean): boolean {
	if (env["NO_COLOR"] !== undefined && env["NO_COLOR"] !== "") return false;
	if (env["FORCE_COLOR"] !== undefined && env["FORCE_COLOR"] !== "0") return true;
	return isTty;
}

export interface Output {
	readonly json: boolean;
	/** Renders `data` as a table, or emits it verbatim as JSON under `--json`. */
	table<T>(columns: TableSpec<T>, items: readonly T[]): void;
	/** Renders key/value fields, or emits `data` as JSON under `--json`. */
	fields(pairs: readonly (readonly [string, string])[], data: unknown): void;
	/** Raw JSON of the unwrapped data. stdout only. */
	jsonOut(data: unknown): void;
	/** A line of ordinary output on stdout. Suppressed under `--json`. */
	line(text: string): void;
	/** Status, progress and warnings. Always stderr, never suppressed. */
	note(text: string): void;
	/** Signed request headers, secrets redacted. Only under `--verbose`. */
	debugRequest(method: string, url: string, headers: Record<string, string>): void;
	/** An NDJSON record on stdout — one event per line, for `watch --json`. */
	record(value: unknown): void;
	failure(error: TmError): void;
	usage(message: string): void;
}

export function createOutput(streams: OutputStreams, options: OutputOptions = {}): Output {
	const json = options.json === true;
	const verbose = options.verbose === true;
	const color = options.color === true;
	const dim = (text: string): string => (color ? `${DIM}${text}${RESET}` : text);

	const writeOut = (text: string): void => {
		streams.out.write(text.endsWith("\n") ? text : `${text}\n`);
	};
	const writeErr = (text: string): void => {
		streams.err.write(text.endsWith("\n") ? text : `${text}\n`);
	};

	return {
		json,
		table(columns, items) {
			if (json) {
				writeOut(JSON.stringify(items, null, 2));
				return;
			}
			if (items.length === 0) {
				writeErr("(no rows)");
				return;
			}
			writeOut(renderTable(columns, items));
		},
		fields(pairs, data) {
			if (json) {
				writeOut(JSON.stringify(data, null, 2));
				return;
			}
			writeOut(renderFields(pairs));
		},
		jsonOut(data) {
			writeOut(JSON.stringify(data, null, 2));
		},
		line(text) {
			if (!json) writeOut(text);
		},
		note(text) {
			writeErr(text);
		},
		debugRequest(method, url, headers) {
			if (!verbose) return;
			const redacted = redactHeaders(headers);
			const lines = Object.entries(redacted).map(([name, value]) => `  ${name}: ${value}`);
			writeErr(dim([`${method} ${url}`, ...lines].join("\n")));
		},
		record(value) {
			streams.out.write(`${JSON.stringify(value)}\n`);
		},
		failure(error) {
			writeErr(formatTmError(error));
		},
		usage(message) {
			writeErr(`error: ${message}`);
		},
	};
}
