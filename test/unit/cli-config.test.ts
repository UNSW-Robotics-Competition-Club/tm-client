import { describe, expect, it } from "vitest";
import { TmConfigError } from "../../src/errors.js";
import {
	configFromEnv,
	configFromFile,
	DEFAULT_ADDRESS,
	DEFAULT_CERBERUS_ENDPOINT,
	describeAuthMode,
	resolveConfig,
} from "../../src/cli/config.js";

/** A complete DWAB environment, so each test only varies what it is about. */
const DWAB_ENV = {
	TM_API_KEY: "tm-key",
	TM_CLIENT_ID: "client-id",
	TM_CLIENT_SECRET: "client-secret",
	TM_EXPIRATION_DATE_MS: "1900000000000",
} as const;

function expectConfigError(result: ReturnType<typeof resolveConfig>): TmConfigError {
	if (result.ok) throw new Error("expected a config error, got a resolved config");
	return result.error;
}

describe("configFromEnv", () => {
	it("maps every documented variable", () => {
		expect(
			configFromEnv({
				TM_ADDRESS: "http://10.0.0.5",
				TM_API_KEY: "k",
				TM_CERBERUS_ENDPOINT: "https://broker",
				TM_CERBERUS_KEY: "ctm_x",
				TM_CLIENT_ID: "id",
				TM_CLIENT_SECRET: "secret",
				TM_EXPIRATION_DATE_MS: "1900000000000",
			}),
		).toEqual({
			address: "http://10.0.0.5",
			apiKey: "k",
			cerberusEndpoint: "https://broker",
			cerberusKey: "ctm_x",
			clientId: "id",
			clientSecret: "secret",
			expirationDateMs: "1900000000000",
		});
	});

	it("treats a blank variable as unset", () => {
		// An exported-but-empty shell variable is the common way this happens, and
		// treating it as a value turns a fallback into a mystery failure.
		expect(configFromEnv({ TM_API_KEY: "   " }).apiKey).toBeUndefined();
	});
});

describe("resolveConfig precedence", () => {
	it("prefers flags over env over file", () => {
		const result = resolveConfig({
			flags: { address: "http://from-flag" },
			env: { ...DWAB_ENV, TM_ADDRESS: "http://from-env" },
			file: { address: "http://from-file", apiKey: "from-file" },
		});
		expect(result.ok && result.config.address).toBe("http://from-flag");
	});

	it("prefers env over file", () => {
		const result = resolveConfig({
			env: { ...DWAB_ENV, TM_ADDRESS: "http://from-env" },
			file: { address: "http://from-file" },
		});
		expect(result.ok && result.config.address).toBe("http://from-env");
	});

	it("falls through to the file when neither flag nor env supplies a value", () => {
		const result = resolveConfig({
			env: DWAB_ENV,
			file: { address: "http://from-file" },
		});
		expect(result.ok && result.config.address).toBe("http://from-file");
	});

	it("falls back to the default address", () => {
		const result = resolveConfig({ env: DWAB_ENV });
		expect(result.ok && result.config.address).toBe(DEFAULT_ADDRESS);
	});

	it("does not let an absent flag overwrite an env value", () => {
		const result = resolveConfig({
			flags: { address: undefined, apiKey: undefined },
			env: { ...DWAB_ENV, TM_ADDRESS: "http://from-env" },
		});
		expect(result.ok && result.config.address).toBe("http://from-env");
		expect(result.ok && result.config.apiKey).toBe("tm-key");
	});

	it("strips a trailing slash from the address", () => {
		const result = resolveConfig({ flags: { address: "http://tm.local:8080//" }, env: DWAB_ENV });
		expect(result.ok && result.config.address).toBe("http://tm.local:8080");
	});
});

describe("resolveConfig auth mode", () => {
	it("picks cerberus when a cerberus key is present, even alongside DWAB values", () => {
		const result = resolveConfig({ env: { ...DWAB_ENV, TM_CERBERUS_KEY: "ctm_abc" } });
		expect(result.ok && result.config.auth).toEqual({
			mode: "cerberus",
			endpoint: DEFAULT_CERBERUS_ENDPOINT,
			apiKey: "ctm_abc",
		});
	});

	it("honours a custom cerberus endpoint", () => {
		const result = resolveConfig({
			env: { TM_API_KEY: "k", TM_CERBERUS_KEY: "ctm_abc", TM_CERBERUS_ENDPOINT: "https://b/" },
		});
		expect(result.ok && result.config.auth).toEqual({
			mode: "cerberus",
			endpoint: "https://b",
			apiKey: "ctm_abc",
		});
	});

	it("picks dwab when all three values are present", () => {
		const result = resolveConfig({ env: DWAB_ENV });
		expect(result.ok && result.config.auth).toEqual({
			mode: "dwab",
			clientId: "client-id",
			clientSecret: "client-secret",
			expirationDateMs: 1_900_000_000_000,
		});
	});

	it("accepts a numeric expirationDateMs from a config file", () => {
		const result = resolveConfig({
			file: {
				apiKey: "k",
				clientId: "id",
				clientSecret: "secret",
				expirationDateMs: 1_900_000_000_000,
			},
		});
		expect(result.ok && result.config.auth.mode).toBe("dwab");
	});
});

describe("resolveConfig errors", () => {
	it("names the missing API key", () => {
		const error = expectConfigError(resolveConfig({ env: { TM_CERBERUS_KEY: "ctm_abc" } }));
		expect(error).toBeInstanceOf(TmConfigError);
		expect(error.message).toContain("--api-key or TM_API_KEY");
	});

	it("names both credential routes when nothing is configured", () => {
		const error = expectConfigError(resolveConfig({ env: { TM_API_KEY: "k" } }));
		expect(error.message).toContain("--cerberus-key or TM_CERBERUS_KEY");
		expect(error.message).toContain("--client-id or TM_CLIENT_ID");
		expect(error.message).toContain("--client-secret or TM_CLIENT_SECRET");
		expect(error.message).toContain("--expiration-date-ms or TM_EXPIRATION_DATE_MS");
	});

	it("names exactly which DWAB values are missing", () => {
		const error = expectConfigError(
			resolveConfig({ env: { TM_API_KEY: "k", TM_CLIENT_ID: "id" } }),
		);
		expect(error.message).toContain("Missing: --client-secret or TM_CLIENT_SECRET");
		expect(error.message).toContain("--expiration-date-ms or TM_EXPIRATION_DATE_MS");
		expect(error.message).not.toContain("Missing: --client-id");
	});

	it("rejects a seconds-shaped expiration date by name", () => {
		const error = expectConfigError(
			resolveConfig({ env: { ...DWAB_ENV, TM_EXPIRATION_DATE_MS: "1900000000" } }),
		);
		expect(error.message).toContain("looks like seconds, not milliseconds");
		expect(error.message).toContain("multiply by 1000");
	});

	it("rejects a non-numeric expiration date", () => {
		const error = expectConfigError(
			resolveConfig({ env: { ...DWAB_ENV, TM_EXPIRATION_DATE_MS: "next tuesday" } }),
		);
		expect(error.message).toContain("whole number of milliseconds");
	});
});

describe("configFromFile", () => {
	it("ignores unrelated keys", () => {
		expect(configFromFile({ apiKey: "k", somethingElse: 3 })).toEqual({ apiKey: "k" });
	});

	it("rejects a non-object document", () => {
		expect(configFromFile([1, 2, 3])).toBeInstanceOf(TmConfigError);
		expect(configFromFile("nope")).toBeInstanceOf(TmConfigError);
	});

	it("rejects a known key of the wrong type rather than coercing it", () => {
		const error = configFromFile({ apiKey: 42 });
		expect(error).toBeInstanceOf(TmConfigError);
		expect((error as TmConfigError).message).toContain('"apiKey" must be a string');
	});

	it("surfaces a bad file through resolveConfig", () => {
		const error = expectConfigError(resolveConfig({ file: 7 }));
		expect(error.message).toContain("must contain a JSON object");
	});
});

describe("describeAuthMode", () => {
	it("never includes the secret", () => {
		expect(describeAuthMode({ mode: "cerberus", endpoint: "https://b", apiKey: "ctm_secret" })).toBe(
			"cerberus (https://b)",
		);
		expect(
			describeAuthMode({
				mode: "dwab",
				clientId: "id",
				clientSecret: "super-secret",
				expirationDateMs: 1_900_000_000_000,
			}),
		).not.toContain("super-secret");
	});
});
