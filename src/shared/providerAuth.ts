/**
 * Provider Auth - credential identity for agent login state.
 *
 * Maestro discovers auth failure only after a prompt has been spent: the agent
 * spawns, the CLI complains, `parsers/error-patterns.ts` matches an
 * `auth_expired` regex, and a modal appears. Fifteen agents on one Anthropic
 * account produce fifteen of those modals for one underlying fact.
 *
 * The fix starts here: credentials belong to an IDENTITY, not to an agent. This
 * module maps a session (its tool type, its effective env, its host) onto the
 * credential it will actually present, so probes, stores, and UI can all dedupe
 * on one key. It is the same move `claude-usage-startup.ts` already makes for
 * quota, where one `maestro-p --status` per unique `CLAUDE_CONFIG_DIR` replaces
 * one per session.
 *
 * The second idea the type system enforces: NOT EVERY CREDENTIAL IS AN OAUTH
 * LOGIN. A gateway agent (`ANTHROPIC_BASE_URL` pointed at a third-party
 * operator), an API-key agent, and a Bedrock/Vertex agent are all things
 * `claude auth login` cannot fix, and offering that button to them is worse than
 * offering nothing. {@link CredentialKind} records which remedy applies.
 *
 * ## Purity
 *
 * No Node builtins, like `shared/providerFailover.ts`, so the renderer can call
 * this as freely as the main process (the one import, `agentMetadata`, is itself
 * dependency-free). That is why {@link canonicalizeDirPath} exists
 * instead of `path.resolve` and why {@link fingerprintSecret} carries its own
 * SHA-256 instead of `crypto.createHash`: both of those are Node builtins, the
 * renderer bundle has no polyfill for either (it never imports one - checked),
 * and a shared module that throws on import in one of the two processes is not
 * shared. The canonicalizer deliberately reproduces the `path.resolve` semantics
 * `resolveConfigDirKey()` (`main/stores/claudeUsageStore.ts`) already relies on:
 * lexical normalization only, no `realpath`, no symlink resolution, no case
 * folding.
 */

import { getAgentDisplayName } from './agentMetadata';

// ============================================================================
// Types
// ============================================================================

/**
 * What kind of credential an agent presents, which decides what "fix it" means.
 *
 * - `oauth` - a browser/device login against a config directory. The ONLY kind a
 *   login flow can repair.
 * - `api-key` - a secret in the environment. The remedy is editing the key, not
 *   logging in.
 * - `gateway` - `ANTHROPIC_BASE_URL` (or equivalent) points the agent at a
 *   third-party operator. Whatever failed belongs to that operator.
 * - `cloud-provider` - Bedrock or Vertex. Credentials come from the cloud SDK
 *   chain, not from the agent CLI.
 * - `unknown` - the provider has no probe we trust. Must render as
 *   `unsupported`, never as `logged-out`.
 */
export type CredentialKind = 'oauth' | 'api-key' | 'gateway' | 'cloud-provider' | 'unknown';

/**
 * Login state for one {@link CredentialIdentity}.
 *
 * `unknown` means "not probed yet, or the probe failed"; `unsupported` means
 * "there is nothing to probe". Keeping them distinct stops an unprobeable
 * provider (factory-droid) from ever being reported as logged out.
 */
export type ProviderAuthStatus = 'authenticated' | 'logged-out' | 'unknown' | 'unsupported';

/**
 * The credential an agent will present, independent of which agent presents it.
 *
 * Two sessions that resolve to the same {@link key} share one login, so they are
 * probed once, stored once, and surfaced once.
 */
export interface CredentialIdentity {
	/** `${provider}::${kind}::${scope}::${host}` - the dedup key. */
	key: string;
	/** Agent id the credential belongs to (`claude-code`, `codex`, ...). */
	provider: string;
	/** Which remedy applies. See {@link CredentialKind}. */
	kind: CredentialKind;
	/**
	 * What distinguishes this credential from another of the same kind: a
	 * canonical config dir, a gateway host, a secret fingerprint, or `'default'`.
	 * Never contains a raw secret.
	 */
	scope: string;
	/** `'local'` or `` `ssh:${remoteId}` `` - the machine the credential lives on. */
	host: string;
	/** The env var that determines this identity, when one does. */
	envVarName?: string;
	/** Canonical config directory, for `oauth` identities only. */
	configDir?: string;
	/** Short human name for UI: `.claude-smash`, `api.z.ai`, `Codex fp_1a2b3c4d`. */
	label: string;
}

/** Input to {@link resolveCredentialIdentity}. */
export interface CredentialIdentityInput {
	/** Agent id, e.g. `claude-code`. Unrecognized values resolve to `unknown`. */
	toolType: string;
	/**
	 * The EFFECTIVE env for the spawn - agent-level merged under session-level.
	 * Build it with {@link mergeEffectiveEnv}; never pass `process.env` when the
	 * spawn will use something else, for the same reason `resolveConfigDirKey()`
	 * makes its env argument required.
	 */
	env: Record<string, string>;
	/** SSH remote id when the agent runs remotely; omitted for local agents. */
	sshRemoteId?: string;
	/** Home directory ON THE HOST the agent runs on, used to expand defaults. */
	homeDir: string;
}

/**
 * How a {@link ProviderAuthSnapshot} learned its status, which decides how much
 * to trust it.
 *
 * - `probe` - a status subcommand was run and its output parsed.
 * - `error-pattern` - an `auth_expired` match in a live agent's output. Reactive,
 *   so it can mark an identity logged out before any probe has run.
 * - `login-flow` - the user completed (or abandoned) a login Maestro drove.
 */
export type ProviderAuthSource = 'probe' | 'error-pattern' | 'login-flow';

/**
 * The stored login state of one {@link CredentialIdentity}.
 *
 * One snapshot per identity key, not per session: fifteen agents sharing an
 * Anthropic account share this record.
 */
export interface ProviderAuthSnapshot {
	/** The credential this describes. Carries the remedy via its `kind`. */
	identity: CredentialIdentity;
	/** Login state. `unknown` is the safe default; see {@link ProviderAuthStatus}. */
	status: ProviderAuthStatus;
	/**
	 * Human-readable specifics for the UI: the signed-in email or org on success,
	 * the reason on failure. NEVER a token, an API key, or a command line
	 * containing one - the store scrubs it, but producers must not rely on that.
	 */
	detail?: string;
	/** Short account name for the UI, when the probe surfaced one. */
	accountLabel?: string;
	/** Epoch ms the status was determined. Drives the re-probe cadence. */
	checkedAt: number;
	/** Where the status came from. See {@link ProviderAuthSource}. */
	source: ProviderAuthSource;
}

// ============================================================================
// Env-var tables
// ============================================================================

/**
 * Anthropic secret-bearing keys, checked in this order so the more specific
 * gateway token wins over the plain API key. Mirrors
 * `ANTHROPIC_CREDENTIAL_ENV_KEYS` in `shared/providerFailover.ts`, which is the
 * failover module's name for the same two vars.
 */
const ANTHROPIC_SECRET_ENV_KEYS = ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'] as const;

/** Flags that route claude-code at a cloud provider instead of Anthropic's API. */
const CLAUDE_CLOUD_PROVIDER_FLAGS = [
	{ envVarName: 'CLAUDE_CODE_USE_BEDROCK', scope: 'bedrock', label: 'AWS Bedrock' },
	{ envVarName: 'CLAUDE_CODE_USE_VERTEX', scope: 'vertex', label: 'Google Vertex AI' },
] as const;

/**
 * Copilot token vars in the CLI's own precedence order, verified against
 * `copilot login --help`. Note the error bank's `gh auth login` advice is stale;
 * the CLI's command is `copilot login`.
 */
const COPILOT_TOKEN_ENV_KEYS = ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'] as const;

/**
 * OpenCode recognizes roughly a hundred provider key vars (`ANTHROPIC_API_KEY`,
 * `GROQ_API_KEY`, `MOONSHOT_API_KEY`, ...), and `agents/definitions.ts` lists
 * none of them - its opencode entry only sets `OPENCODE_CONFIG_CONTENT`. Rather
 * than freeze a list that goes stale on every opencode release, match the shape
 * they all share, plus the one non-conforming name.
 *
 * The trade-off is a false positive: a stray `OPENAI_API_KEY` in the environment
 * of an agent that is really logged in via OAuth reads as `api-key`. That costs
 * a login button we would not have offered anyway, which is the safer direction
 * to be wrong in.
 */
const OPENCODE_API_KEY_PATTERN = /^[A-Z][A-Z0-9_]*_API_KEY$/;
const OPENCODE_EXTRA_SECRET_ENV_KEYS = ['ANTHROPIC_AUTH_TOKEN'] as const;

/** Where each provider keeps its OAuth credentials, relative to `homeDir`. */
const DEFAULT_CONFIG_SUBDIRS = {
	'claude-code': '.claude',
	codex: '.codex',
	'copilot-cli': '.copilot',
	// Verified from `opencode auth list`, which prints the credential file path.
	opencode: '.local/share/opencode',
} as const;

// ============================================================================
// Env helpers
// ============================================================================

/**
 * Read an env var, treating whitespace-only as unset.
 *
 * Both halves of that rule are load-bearing. `resolveCodexHomeKey()` length-checks
 * `CODEX_HOME` while `resolveConfigDirKey()` uses `??`, so an empty
 * `CLAUDE_CONFIG_DIR` silently resolves to the process cwd there - this module
 * uses the Codex semantics everywhere. And `resolveFailoverEnv()` skips blank
 * values so a half-filled editor row cannot clobber a working var; a half-filled
 * row must not invent a credential identity either.
 */
function envValue(env: Record<string, string>, key: string): string {
	return (env[key] ?? '').trim();
}

/** First key in `keys` with a non-blank value, or `undefined`. */
function firstSetKey(env: Record<string, string>, keys: readonly string[]): string | undefined {
	return keys.find((key) => envValue(env, key) !== '');
}

/**
 * Whether a boolean-ish env flag is on. Unset, empty, `0`, `false`, `no`, and
 * `off` are off; anything else (including `1` and `true`) is on.
 */
function isFlagEnabled(value: string): boolean {
	const normalized = value.trim().toLowerCase();
	if (normalized === '') return false;
	return !['0', 'false', 'no', 'off'].includes(normalized);
}

/**
 * Merge agent-level and session-level `customEnvVars` into the effective env for
 * a spawn. Session-level wins.
 *
 * This precedence is already implemented in `claude-usage-startup.ts`
 * (`buildTarget()`) and `useQuotaAccounts.ts`, once on each side of the IPC
 * boundary. This is the third site and the last one that should be written by
 * hand: every consumer in the auth feature calls this so main and renderer
 * cannot drift.
 *
 * Blank values are preserved rather than dropped - an explicitly emptied session
 * var is how a user turns an inherited agent-level var off, and {@link envValue}
 * already reads blank as unset at the point of use.
 */
export function mergeEffectiveEnv(
	agentLevel: Record<string, string> | undefined,
	sessionLevel: Record<string, string> | undefined
): Record<string, string> {
	return { ...(agentLevel ?? {}), ...(sessionLevel ?? {}) };
}

// ============================================================================
// Path canonicalization
// ============================================================================

/** True for `/x`, `C:/x`, and `C:\x`. */
function isAbsolutePath(candidate: string): boolean {
	return candidate.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(candidate);
}

/** Split a path into its root prefix (`''`, `'/'`, or `'C:/'`) and the rest. */
function splitRoot(candidate: string): { root: string; rest: string } {
	const drive = /^([a-zA-Z]):\//.exec(candidate);
	if (drive) return { root: `${drive[1].toUpperCase()}:/`, rest: candidate.slice(drive[0].length) };
	if (candidate.startsWith('/')) return { root: '/', rest: candidate.slice(1) };
	return { root: '', rest: candidate };
}

/**
 * Canonicalize a config-directory path so the same directory written three ways
 * produces one identity key.
 *
 * Handles `~`, trailing separators, `.` / `..` segments, and Windows backslashes;
 * resolves a relative path against `homeDir` rather than the process cwd, because
 * a config dir is a home-relative concept and the app's cwd has nothing to do
 * with it (this is the one place the behavior differs from `path.resolve`, which
 * has no home to resolve against). Purely lexical otherwise, matching
 * `resolveConfigDirKey()`: no `realpath`, no symlink resolution, no case folding.
 *
 * Returns `''` for a blank input so callers can fall back to their default.
 */
export function canonicalizeDirPath(raw: string, homeDir: string): string {
	const trimmed = raw.trim();
	if (trimmed === '') return '';

	const home = homeDir.trim().replace(/\\/g, '/');
	let candidate = trimmed.replace(/\\/g, '/');
	if (candidate === '~') candidate = home;
	else if (candidate.startsWith('~/')) candidate = `${home}/${candidate.slice(2)}`;
	if (!isAbsolutePath(candidate)) candidate = `${home}/${candidate}`;

	const { root, rest } = splitRoot(candidate);
	const segments: string[] = [];
	for (const segment of rest.split('/')) {
		if (segment === '' || segment === '.') continue;
		if (segment === '..') {
			segments.pop();
			continue;
		}
		segments.push(segment);
	}
	return root + segments.join('/');
}

/** Last segment of a canonical path, used as the UI label for a config dir. */
function basename(canonicalPath: string): string {
	const segments = canonicalPath.split('/').filter((segment) => segment !== '');
	return segments[segments.length - 1] ?? canonicalPath;
}

/**
 * Host (with port) of a base URL, lowercased. Falls back to the leading path
 * segment for values a URL parser rejects, so a typo still produces a stable
 * scope instead of collapsing every malformed gateway into one identity.
 */
function baseUrlHost(rawUrl: string): string {
	try {
		return new URL(rawUrl).host.toLowerCase() || rawUrl.toLowerCase();
	} catch {
		return rawUrl
			.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '')
			.split('/')[0]
			.toLowerCase();
	}
}

// ============================================================================
// Secret fingerprinting
// ============================================================================

/** SHA-256 round constants (first 32 bits of the cube roots of the first 64 primes). */
// prettier-ignore
const SHA256_K = new Uint32Array([
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
	0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
	0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
	0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
	0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
	0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
	0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** 32-bit rotate right. */
function rotr(value: number, bits: number): number {
	return ((value >>> bits) | (value << (32 - bits))) >>> 0;
}

/**
 * SHA-256 of a UTF-8 string, as lowercase hex.
 *
 * Vendored (FIPS 180-4) rather than imported so this module stays free of Node
 * builtins - see the purity note at the top of the file. `TextEncoder`,
 * `Uint32Array`, and `DataView` are globals in both processes.
 */
function sha256Hex(input: string): string {
	const message = new TextEncoder().encode(input);
	const bitLength = message.length * 8;
	// One 0x80 byte, then zeros, then a 64-bit big-endian length, padded to 64.
	const withTerminator = message.length + 1;
	const total = withTerminator + ((56 - (withTerminator % 64) + 64) % 64) + 8;

	const buffer = new Uint8Array(total);
	buffer.set(message);
	buffer[message.length] = 0x80;
	const view = new DataView(buffer.buffer);
	view.setUint32(total - 8, Math.floor(bitLength / 0x100000000));
	view.setUint32(total - 4, bitLength >>> 0);

	const h = new Uint32Array([
		0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
	]);
	const w = new Uint32Array(64);

	for (let offset = 0; offset < total; offset += 64) {
		for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
		for (let i = 16; i < 64; i++) {
			const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
			const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
			w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
		}

		let [a, b, c, d, e, f, g, hh] = h;
		for (let i = 0; i < 64; i++) {
			const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
			const ch = (e & f) ^ (~e & g);
			const t1 = (hh + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
			const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
			const maj = (a & b) ^ (a & c) ^ (b & c);
			const t2 = (S0 + maj) >>> 0;
			hh = g;
			g = f;
			f = e;
			e = (d + t1) >>> 0;
			d = c;
			c = b;
			b = a;
			a = (t1 + t2) >>> 0;
		}

		h[0] = (h[0] + a) >>> 0;
		h[1] = (h[1] + b) >>> 0;
		h[2] = (h[2] + c) >>> 0;
		h[3] = (h[3] + d) >>> 0;
		h[4] = (h[4] + e) >>> 0;
		h[5] = (h[5] + f) >>> 0;
		h[6] = (h[6] + g) >>> 0;
		h[7] = (h[7] + hh) >>> 0;
	}

	return Array.from(h, (word) => word.toString(16).padStart(8, '0')).join('');
}

/**
 * Short, stable, non-reversible tag for a secret.
 *
 * Two different secrets get two different tags, the same secret always gets the
 * same one, and the raw value can never be recovered from it. The `fp_` prefix
 * is there so a reader of a log line or a store record recognizes it as a
 * fingerprint rather than mistaking it for a truncated key.
 *
 * This is the ONLY representation of a secret allowed to leave this module. The
 * raw value must never reach an identity, the store, a log line, or the UI.
 */
export function fingerprintSecret(value: string): string {
	return `fp_${sha256Hex(value).slice(0, 8)}`;
}

// ============================================================================
// Resolver
// ============================================================================

/** Assemble an identity and derive its dedup key. */
function buildIdentity(parts: Omit<CredentialIdentity, 'key'>): CredentialIdentity {
	return {
		key: `${parts.provider}::${parts.kind}::${parts.scope}::${parts.host}`,
		...parts,
	};
}

/** An `api-key` identity scoped to a fingerprint of the secret it presents. */
function apiKeyIdentity(
	provider: string,
	host: string,
	envVarName: string,
	secret: string
): CredentialIdentity {
	const fingerprint = fingerprintSecret(secret);
	return buildIdentity({
		provider,
		kind: 'api-key',
		scope: fingerprint,
		host,
		envVarName,
		label: `${getAgentDisplayName(provider)} ${fingerprint}`,
	});
}

/** An `oauth` identity scoped to a canonical config directory. */
function oauthIdentity(
	provider: string,
	host: string,
	configDir: string,
	envVarName?: string
): CredentialIdentity {
	return buildIdentity({
		provider,
		kind: 'oauth',
		scope: configDir,
		host,
		envVarName,
		configDir,
		label: basename(configDir),
	});
}

function resolveClaudeCode(
	env: Record<string, string>,
	host: string,
	homeDir: string
): CredentialIdentity {
	// Cloud provider first: Bedrock/Vertex ignore both the config dir and the
	// Anthropic vars, so anything below would describe a credential the CLI is
	// not going to use.
	for (const flag of CLAUDE_CLOUD_PROVIDER_FLAGS) {
		if (!isFlagEnabled(envValue(env, flag.envVarName))) continue;
		return buildIdentity({
			provider: 'claude-code',
			kind: 'cloud-provider',
			scope: flag.scope,
			host,
			envVarName: flag.envVarName,
			label: flag.label,
		});
	}

	// A gateway outranks the token check even when a token is present: the token
	// belongs to the gateway operator, and `claude auth login` cannot fix it.
	// Same reasoning as `failoverUnsetEnvKeys()` in shared/providerFailover.ts.
	const baseUrl = envValue(env, 'ANTHROPIC_BASE_URL');
	if (baseUrl !== '') {
		const gatewayHost = baseUrlHost(baseUrl);
		return buildIdentity({
			provider: 'claude-code',
			kind: 'gateway',
			scope: gatewayHost,
			host,
			envVarName: 'ANTHROPIC_BASE_URL',
			label: gatewayHost,
		});
	}

	const secretKey = firstSetKey(env, ANTHROPIC_SECRET_ENV_KEYS);
	if (secretKey) return apiKeyIdentity('claude-code', host, secretKey, envValue(env, secretKey));

	const configured = envValue(env, 'CLAUDE_CONFIG_DIR');
	const configDir = canonicalizeDirPath(
		configured || `${homeDir}/${DEFAULT_CONFIG_SUBDIRS['claude-code']}`,
		homeDir
	);
	return oauthIdentity('claude-code', host, configDir, 'CLAUDE_CONFIG_DIR');
}

function resolveCodex(
	env: Record<string, string>,
	host: string,
	homeDir: string
): CredentialIdentity {
	const secret = envValue(env, 'OPENAI_API_KEY');
	if (secret !== '') return apiKeyIdentity('codex', host, 'OPENAI_API_KEY', secret);

	const configured = envValue(env, 'CODEX_HOME');
	const configDir = canonicalizeDirPath(
		configured || `${homeDir}/${DEFAULT_CONFIG_SUBDIRS.codex}`,
		homeDir
	);
	return oauthIdentity('codex', host, configDir, 'CODEX_HOME');
}

function resolveCopilot(
	env: Record<string, string>,
	host: string,
	homeDir: string
): CredentialIdentity {
	const tokenKey = firstSetKey(env, COPILOT_TOKEN_ENV_KEYS);
	if (tokenKey) return apiKeyIdentity('copilot-cli', host, tokenKey, envValue(env, tokenKey));

	// `copilot login` stores its device-flow token in the system credential store,
	// falling back to a plain-text config under ~/.copilot. No env var relocates
	// it, so the config dir is the whole scope and there is nothing to name.
	const configDir = canonicalizeDirPath(
		`${homeDir}/${DEFAULT_CONFIG_SUBDIRS['copilot-cli']}`,
		homeDir
	);
	return oauthIdentity('copilot-cli', host, configDir);
}

function resolveOpenCode(
	env: Record<string, string>,
	host: string,
	homeDir: string
): CredentialIdentity {
	// OpenCode keeps every provider's credential in one auth.json, so a key set
	// for ANY provider changes what this agent presents. Fingerprint the whole
	// matching set, sorted, so the identity is order-independent.
	const secretKeys = Object.keys(env)
		.filter(
			(key) =>
				OPENCODE_API_KEY_PATTERN.test(key) ||
				(OPENCODE_EXTRA_SECRET_ENV_KEYS as readonly string[]).includes(key)
		)
		.filter((key) => envValue(env, key) !== '')
		.sort();
	if (secretKeys.length > 0) {
		const material = secretKeys.map((key) => `${key}=${envValue(env, key)}`).join('\n');
		return apiKeyIdentity('opencode', host, secretKeys[0], material);
	}

	// OPENCODE_CONFIG_DIR is the explicit override; otherwise the credential file
	// follows XDG, defaulting to ~/.local/share/opencode (verified from the path
	// `opencode auth list` prints).
	const explicit = envValue(env, 'OPENCODE_CONFIG_DIR');
	if (explicit !== '') {
		return oauthIdentity(
			'opencode',
			host,
			canonicalizeDirPath(explicit, homeDir),
			'OPENCODE_CONFIG_DIR'
		);
	}
	const xdgDataHome = envValue(env, 'XDG_DATA_HOME');
	if (xdgDataHome !== '') {
		return oauthIdentity(
			'opencode',
			host,
			canonicalizeDirPath(`${xdgDataHome}/opencode`, homeDir),
			'XDG_DATA_HOME'
		);
	}
	const configDir = canonicalizeDirPath(`${homeDir}/${DEFAULT_CONFIG_SUBDIRS.opencode}`, homeDir);
	return oauthIdentity('opencode', host, configDir);
}

// ============================================================================
// Login commands
// ============================================================================

/** The command a login flow runs for one identity. See {@link resolveLoginCommand}. */
export interface LoginCommand {
	/**
	 * The provider binary, by NAME. Callers that already resolved an absolute path
	 * (`createBinaryPathResolver()` in `main/agents/auth/auth-startup.ts`) should
	 * substitute it and keep {@link args} verbatim.
	 */
	command: string;
	/** Argument vector, already carrying any flags the options asked for. */
	args: string[];
	/**
	 * What the user should expect from this flow when it is not a plain browser
	 * redirect. Rendered next to the terminal, so it must stay one short sentence.
	 */
	note?: string;
}

/** Options for {@link resolveLoginCommand}. */
export interface LoginCommandOptions {
	/** claude-code: bill against Anthropic Console instead of a Claude subscription. */
	preferConsole?: boolean;
	/** claude-code: force the SSO flow. */
	sso?: boolean;
	/**
	 * Email to pre-populate on the login page, from the last successful snapshot.
	 * For a user with several accounts this is the difference between landing on
	 * the right one and re-authenticating the account that already worked.
	 */
	email?: string;
}

/**
 * The command that repairs one credential identity, or `null` when no command
 * can.
 *
 * `null` for every non-`oauth` kind, by the same rule the probe follows: an API
 * key, a gateway token, and a Bedrock role are not fixed by logging in, and
 * offering that button is worse than offering nothing. `null` also for
 * factory-droid and anything unrecognized, which have no verified login surface.
 *
 * The binary names repeat the `binaryName` fields in
 * `main/agents/definitions.ts` rather than importing them, because this module
 * is renderer-safe (see the purity note at the top) and that one is not.
 * Subcommands and flags verified against the installed CLIs on 2026-08-15.
 */
export function resolveLoginCommand(
	identity: CredentialIdentity,
	opts: LoginCommandOptions = {}
): LoginCommand | null {
	if (identity.kind !== 'oauth') return null;

	switch (identity.provider) {
		case 'claude-code': {
			const args = ['auth', 'login'];
			if (opts.preferConsole) args.push('--console');
			if (opts.sso) args.push('--sso');
			const email = (opts.email ?? '').trim();
			if (email !== '') args.push('--email', email);
			return { command: 'claude', args };
		}
		case 'codex':
			return { command: 'codex', args: ['login'] };
		case 'copilot-cli':
			return {
				command: 'copilot',
				args: ['login'],
				note: 'This is a device-code flow: the CLI prints a code to enter in the browser, so nothing opens on its own.',
			};
		case 'opencode':
			return {
				command: 'opencode',
				args: ['auth', 'login'],
				note: 'OpenCode asks which provider to log in to first, so arrow to it and press Enter before the browser opens.',
			};
		default:
			return null;
	}
}

// ============================================================================
// Login run ids
// ============================================================================

/** Marks a process id as belonging to a login flow rather than to an agent. */
const LOGIN_RUN_PREFIX = 'auth-login-';

/**
 * Session-id segments other subsystems key behavior off: `-ai-` (an AI tab),
 * `-terminal` (a terminal tab), `-batch-` / `-synopsis-` (background runs). A
 * login id is built from a CONFIG DIRECTORY PATH, so a user whose account lives
 * in `~/terminal/.claude` would otherwise produce an id that one of those checks
 * claims. Removing the leading hyphen (`x-terminal-y` -> `xterminal-y`) leaves
 * the slug readable while making the segment unmatchable.
 */
const RESERVED_ID_SEGMENT_RE = /-(ai|terminal|batch|synopsis)(?=-|$)/g;

/**
 * The process id a login PTY streams under.
 *
 * Synthetic, for the same reason `buildShellRunSessionId()` in
 * `renderer/services/shellCommand.ts` is: process output is keyed by session id,
 * and reusing a real one would route login output into the agent listeners and
 * land it in that agent's transcript. This shape matches no listener pattern and
 * no session in the store, so the recovery modal owns the stream.
 *
 * The identity is folded in for debuggability - two accounts logging in at once
 * are told apart in the process list - and the run id makes "Re-run login
 * command" a genuinely new stream rather than a reused one.
 *
 * Lives here rather than in the modal so main can recognize the ids it is asked
 * to spawn under without re-deriving the rule. See {@link isLoginRunSessionId}.
 */
export function buildLoginRunSessionId(identityKey: string, runId: string): string {
	const slug = identityKey
		.replace(/[^a-zA-Z0-9]+/g, '-')
		.replace(/^-|-$/g, '')
		.replace(RESERVED_ID_SEGMENT_RE, '$1');
	return `${LOGIN_RUN_PREFIX}${slug}-${runId}`;
}

/**
 * Whether a process id was minted by {@link buildLoginRunSessionId}.
 *
 * Main checks this before spawning under a renderer-supplied id. Without it a
 * bug (or a compromised renderer) could ask for a login PTY under a live agent's
 * session id, which would kill that agent's process - `ProcessManager.spawn()`
 * kills whatever already holds the key - and then stream login output into its
 * transcript.
 */
export function isLoginRunSessionId(sessionId: string): boolean {
	return (
		sessionId.startsWith(LOGIN_RUN_PREFIX) &&
		sessionId.length > LOGIN_RUN_PREFIX.length &&
		!/-(ai|terminal|batch|synopsis)(-|$)/.test(sessionId.slice(LOGIN_RUN_PREFIX.length))
	);
}

/**
 * An email to pre-fill the login page with, when the stored snapshot still knows
 * one.
 *
 * For a user with several accounts this is the difference between landing on the
 * right one and re-authenticating the account that already worked. Read from the
 * snapshot's `detail`, which the claude-code probe fills with
 * `email · org · subscription` on a successful check. Returns undefined when
 * nothing email-shaped is there - a guessed address is worse than none.
 */
export function extractLoginEmail(
	snapshot: ProviderAuthSnapshot | null | undefined
): string | undefined {
	for (const candidate of [snapshot?.accountLabel, snapshot?.detail]) {
		const match = (candidate ?? '').match(/[^\s·,;()<>]+@[^\s·,;()<>]+\.[A-Za-z]{2,}/);
		if (match) return match[0];
	}
	return undefined;
}

/**
 * Map a session onto the credential it will present.
 *
 * Pure: the same input always produces the same identity, and nothing is read
 * from disk, the environment of the calling process, or the network. Within each
 * provider the checks run most-specific first, so a gateway agent that also
 * carries a config dir resolves as a gateway.
 *
 * Providers with no verified auth surface (factory-droid, terminal, and the
 * hidden agents) resolve to `kind: 'unknown'`. Consumers MUST render those as
 * {@link ProviderAuthStatus} `unsupported`, never as `logged-out`: claiming a
 * login has expired when nothing was ever probed sends the user to a command
 * that does not exist.
 */
export function resolveCredentialIdentity(input: CredentialIdentityInput): CredentialIdentity {
	const { toolType, env, sshRemoteId, homeDir } = input;
	// The same account dir on two machines is two logins. Keying on the host is
	// what stops a remote agent's credential from masquerading as the local one.
	const host = sshRemoteId ? `ssh:${sshRemoteId}` : 'local';

	switch (toolType) {
		case 'claude-code':
			return resolveClaudeCode(env, host, homeDir);
		case 'codex':
			return resolveCodex(env, host, homeDir);
		case 'copilot-cli':
			return resolveCopilot(env, host, homeDir);
		case 'opencode':
			return resolveOpenCode(env, host, homeDir);
		default:
			return buildIdentity({
				provider: toolType,
				kind: 'unknown',
				scope: 'default',
				host,
				label: getAgentDisplayName(toolType),
			});
	}
}
