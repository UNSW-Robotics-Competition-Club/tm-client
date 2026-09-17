/**
 * Runnable front end for the mock TM server, for driving a real client by hand.
 *
 *     pnpm mock-tm -- --port 8080 --scenario ok
 *     pnpm mock-tm -- --cycle 20            # replay a match every 20s
 *     pnpm mock-tm -- --help
 *
 * Deliberately thin: everything testable lives in `mock-tm-server.ts`, so the
 * CLI and the integration suite exercise the same server rather than two
 * servers that happen to look alike.
 */

import { argv, exit } from "node:process";

import {
	API_KEY,
	CERBERUS_KEY,
	MIN_BUILD,
	SCENARIOS,
	matchCycle,
	startMockTmServer,
	type MockScenario,
} from "./mock-tm-server.js";

interface Args {
	port: number;
	scenario: MockScenario;
	/** Seconds per replayed match cycle; 0 disables. */
	cycle: number;
	help: boolean;
}

function parseArgs(args: string[]): Args {
	const parsed: Args = { port: 8080, scenario: "ok", cycle: 0, help: false };

	for (let i = 0; i < args.length; i++) {
		const flag = args[i];
		if (flag === "--port") parsed.port = Number(args[++i]);
		else if (flag === "--scenario") parsed.scenario = (args[++i] ?? "ok") as MockScenario;
		else if (flag === "--cycle") parsed.cycle = Number(args[++i] ?? 20);
		else if (flag === "--help" || flag === "-h") parsed.help = true;
		else {
			console.error(`Unknown argument: ${flag}`);
			parsed.help = true;
		}
	}

	return parsed;
}

function usage(): void {
	console.log(
		"Usage: tsx test/mocks/cli.ts [--port N] [--scenario NAME] [--cycle SECONDS]\n\n" +
			"  --cycle SECONDS  replay a full match event sequence every SECONDS, so a client\n" +
			"                   can be driven by hand without a real event running\n\nScenarios:",
	);
	for (const [name, description] of Object.entries(SCENARIOS)) {
		console.log(`  ${name.padEnd(28)} ${description}`);
	}
}

const args = parseArgs(argv.slice(2));

if (args.help) {
	usage();
	exit(0);
}

if (!(args.scenario in SCENARIOS)) {
	console.error(`Unknown scenario "${args.scenario}".\n`);
	usage();
	exit(2);
}

if (!Number.isInteger(args.port) || args.port < 0 || args.port > 65535) {
	console.error(`Invalid --port "${args.port}".`);
	exit(2);
}

const tm = await startMockTmServer({ port: args.port, scenario: args.scenario, log: true });

console.log(`Mock TM API on ${tm.url}  scenario=${args.scenario}`);
console.log(`  sign-in key   ${CERBERUS_KEY}`);
console.log(`  TM API key    ${API_KEY}`);
console.log(`  build floor   ${MIN_BUILD}`);
console.log(`  token mint    POST ${tm.url}/v1/token`);
console.log(`  field set ws  ${tm.wsUrl}/api/fieldsets/1`);

if (args.cycle > 0) {
	let matchNumber = 1;
	const runCycle = async () => {
		if (tm.clientCount(1) === 0) return;
		console.log(`  -- match cycle: QUAL ${matchNumber}`);
		for (const event of matchCycle({ matchNumber })) {
			tm.emit(1, event);
			await new Promise((resolve) => setTimeout(resolve, (args.cycle * 1000) / 8));
		}
		matchNumber++;
	};
	setInterval(() => void runCycle(), args.cycle * 1000);
}

// The process stays up on the listening server's handle; this only makes Ctrl-C
// tidy rather than leaving the port in TIME_WAIT behind an abrupt exit.
process.on("SIGINT", () => {
	console.log("\nshutting down");
	void tm.close().then(() => exit(0));
});
