/**
 * `tm-cli token` — force a bearer mint and report on it.
 *
 * Deliberately invalidates first: the question this command answers is "can
 * these credentials get a token RIGHT NOW", and serving a cached one from an
 * earlier run answers a different question.
 *
 * It prints the token's metadata and NEVER the token itself, nor the Cerberus
 * key, nor the DWAB secret. This output is meant to be pasted into a chat while
 * someone works out why a venue laptop cannot authenticate.
 */

import type { Command } from "commander";
import { describeAuthMode } from "../config.js";
import { unwrap, type GlobalOptions, type Run } from "./context.js";

/** Whole minutes and seconds — hours of remaining life is not a useful unit here. */
export function formatRemaining(seconds: number): string {
	if (seconds <= 0) return "expired";
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m ${seconds % 60}s`;
}

export function registerTokenCommand(program: Command, run: Run): void {
	program
		.command("token")
		.description("Force a bearer fetch and report the auth mode, expiry and remaining life")
		.action(async (_options: unknown, command: Command) => {
			await run(command.optsWithGlobals() as GlobalOptions, async ({ auth, config, out }) => {
				auth.invalidate();
				const bearer = unwrap(await auth.getBearer());
				const expiresAt = new Date(Date.now() + bearer.expires_in * 1000);

				if (out.json) {
					out.jsonOut({
						mode: config.auth.mode,
						...(config.auth.mode === "cerberus"
							? { endpoint: config.auth.endpoint }
							: { clientId: config.auth.clientId }),
						tokenType: bearer.token_type,
						expiresInSeconds: bearer.expires_in,
						expiresAt: expiresAt.toISOString(),
					});
					return;
				}

				out.fields(
					[
						["Auth mode", describeAuthMode(config.auth)],
						["Address", config.address],
						["Token type", bearer.token_type],
						["Remaining", formatRemaining(bearer.expires_in)],
						["Expires at", expiresAt.toISOString()],
					],
					null,
				);

				// Cerberus keeps the last refusal in a sentence an operator can act on.
				// It is normally null here — a failed mint would have thrown above — but
				// a stale-token fallback succeeds while still having something to say.
				const failure = (auth as { lastFailure?: () => string | null }).lastFailure?.();
				if (failure) out.note(`warning: ${failure}`);
			});
		});
}
