/**
 * SSH connection options - the single place `ssh -o KEY=VALUE` is decided.
 *
 * Four call sites used to build this list by hand (the agent spawn builder, the
 * Test Connection probe, the command runner, and the interactive terminal tab)
 * and they had already drifted: only one set `LogLevel`, and the terminal path
 * omitted `BatchMode` entirely. A remote could therefore test green and behave
 * differently when an agent actually ran on it.
 *
 * The other half of what this module fixes: a command-line `-o` OUTRANKS
 * `~/.ssh/config`, so hard-coding these six meant "Use SSH config" was only ever
 * half true. Host, user, key and port came from the file, but the connection
 * options never could - which left `ConnectTimeout=10` unreachable by any means
 * the user had. `SshRemoteConfig.sshOptions` is the override layer that makes
 * exotic transports (a tailcat / cloudflared / Teleport `ProxyCommand`, a
 * `ProxyJump` bastion, a slow tunnel needing a longer `ConnectTimeout`)
 * expressible without a field per transport.
 *
 * This module is deliberately import-free so both the main process and the CLI
 * bundle can use it.
 */

/**
 * Where the SSH command is going to run. This is not cosmetic: an interactive
 * terminal hands the user's keyboard to `ssh`, so the non-interactive defaults
 * would actively break it.
 */
export type SshOptionContext =
	/** A spawned agent or probe. Nobody can answer a prompt, so key-only auth. */
	| 'command'
	/** A terminal tab. The user is at the keyboard and the caller passes `-t`. */
	| 'interactive';

/**
 * Baseline options for a non-interactive SSH invocation.
 *
 * Overridable per remote via `SshRemoteConfig.sshOptions` - except `RequestTTY`,
 * see {@link RESERVED_SSH_OPTION_KEYS}.
 */
export const DEFAULT_SSH_OPTIONS: Readonly<Record<string, string>> = Object.freeze({
	BatchMode: 'yes', // Disable password prompts (key-only)
	StrictHostKeyChecking: 'accept-new', // Auto-accept new host keys
	ConnectTimeout: '10', // Connection timeout in seconds
	ClearAllForwardings: 'yes', // Disable port forwarding from SSH config (avoids "Address already in use" errors)
	RequestTTY: 'no', // Default: do NOT request a TTY. Forced only for specific remote modes (e.g. --print)
	LogLevel: 'ERROR', // Suppress SSH warnings like "Pseudo-terminal will not be allocated..."
});

/**
 * Options dropped in an interactive terminal tab.
 *
 * - `BatchMode`: the user IS there, so let them answer a passphrase prompt.
 * - `RequestTTY`: the caller passes `-t` itself.
 * - `LogLevel`: someone is watching this terminal, so SSH's own warnings are
 *   the diagnostics they need rather than noise to suppress.
 */
const INTERACTIVE_OMITTED_KEYS: readonly string[] = ['BatchMode', 'RequestTTY', 'LogLevel'];

/**
 * Options a remote may NOT override.
 *
 * `RequestTTY` is decided per invocation, not per host: `buildSshCommand`
 * derives it from whether the remote command speaks stream-json, and a forced
 * TTY injects terminal control sequences that corrupt that stream. It is a
 * property of the command, so pinning it on the host silently breaks agents.
 */
export const RESERVED_SSH_OPTION_KEYS: readonly string[] = ['RequestTTY'];

/** SSH keywords are alphanumeric (`ProxyCommand`, `ConnectTimeout`, ...). */
const SSH_OPTION_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9]*$/;

/** Lowercase key -> the spelling we emit, for every option we ship a default for. */
const CANONICAL_KEYS: ReadonlyMap<string, string> = new Map(
	Object.keys(DEFAULT_SSH_OPTIONS).map((key) => [key.toLowerCase(), key])
);

/**
 * Whether `key` is one this module owns and refuses to let a remote redefine.
 *
 * Case-insensitive, because SSH keywords are.
 */
export function isReservedSshOptionKey(key: string): boolean {
	const lower = key.trim().toLowerCase();
	return RESERVED_SSH_OPTION_KEYS.some((reserved) => reserved.toLowerCase() === lower);
}

/**
 * Validate one option key/value pair.
 *
 * @returns An error message, or `null` when the pair is usable.
 */
export function validateSshOption(key: string, value: string): string | null {
	const trimmedKey = key.trim();
	if (!trimmedKey) return 'SSH option name cannot be empty';
	if (!SSH_OPTION_KEY_PATTERN.test(trimmedKey)) {
		return `Invalid SSH option name "${trimmedKey}". Names are alphanumeric, e.g. ProxyCommand`;
	}
	if (isReservedSshOptionKey(trimmedKey)) {
		return `SSH option "${trimmedKey}" is set per command by Maestro and cannot be overridden`;
	}
	if (/[\r\n]/.test(value)) {
		return `SSH option "${trimmedKey}" cannot contain a line break`;
	}
	return null;
}

/**
 * Drop empty and reserved entries from a stored override record.
 *
 * Storage is not a trusted input: a record can arrive from an older build, a
 * hand-edited settings file, or `maestro-cli`, so resolution filters again
 * rather than assuming the write path validated.
 *
 * @returns The cleaned record, or `undefined` when nothing survives - so a
 * remote with no overrides stores no key at all.
 */
export function normalizeSshOptions(
	options: Record<string, string> | undefined
): Record<string, string> | undefined {
	if (!options) return undefined;
	const cleaned: Record<string, string> = {};
	for (const [key, value] of Object.entries(options)) {
		const trimmedKey = key.trim();
		if (!trimmedKey || isReservedSshOptionKey(trimmedKey)) continue;
		cleaned[trimmedKey] = value;
	}
	return Object.keys(cleaned).length > 0 ? cleaned : undefined;
}

export interface ResolveSshOptionsContext {
	/** Where this SSH command runs. Defaults to `'command'`. */
	context?: SshOptionContext;
	/**
	 * Force TTY allocation (`RequestTTY=force`). Only meaningful for
	 * `'command'`; an interactive caller passes `-t` instead.
	 */
	forceTty?: boolean;
}

/**
 * Merge a remote's overrides onto the baseline and return the options to emit.
 *
 * The merge is CASE-INSENSITIVE, which is the whole reason it lives in one
 * function. OpenSSH treats keywords case-insensitively but applies `-o` flags
 * FIRST-WINS, so a naive object spread emitting both `-o ConnectTimeout=10` and
 * `-o connecttimeout=45` silently keeps the 10 and the user's override does
 * nothing at all. Matching on the lowercased key means an override replaces the
 * default it names however it was typed.
 */
export function resolveSshOptions(
	overrides: Record<string, string> | undefined,
	{ context = 'command', forceTty = false }: ResolveSshOptionsContext = {}
): Record<string, string> {
	const resolved: Record<string, string> = {};

	for (const [key, value] of Object.entries(DEFAULT_SSH_OPTIONS)) {
		if (context === 'interactive' && INTERACTIVE_OMITTED_KEYS.includes(key)) continue;
		resolved[key] = key === 'RequestTTY' && forceTty ? 'force' : value;
	}

	for (const [rawKey, value] of Object.entries(normalizeSshOptions(overrides) ?? {})) {
		// Reuse the baseline's spelling when the override names one of ours, so
		// the emitted list can never carry the same keyword twice.
		const canonical = CANONICAL_KEYS.get(rawKey.toLowerCase());
		if (canonical) {
			// An option this context deliberately dropped stays dropped: adding it
			// back would re-break the terminal it was dropped for.
			if (!(canonical in resolved)) continue;
			resolved[canonical] = value;
			continue;
		}
		resolved[rawKey] = value;
	}

	return resolved;
}

/**
 * Flatten resolved options into the `['-o', 'KEY=VALUE', ...]` argv slice.
 */
export function sshOptionArgs(options: Record<string, string>): string[] {
	const args: string[] = [];
	for (const [key, value] of Object.entries(options)) {
		args.push('-o', `${key}=${value}`);
	}
	return args;
}

/**
 * Build the argv slice for a remote in one step. The common case.
 */
export function buildSshOptionArgs(
	overrides: Record<string, string> | undefined,
	context?: ResolveSshOptionsContext
): string[] {
	return sshOptionArgs(resolveSshOptions(overrides, context));
}

/** Result of parsing `--ssh-option KEY=VALUE` entries from a command line. */
export interface ParsedSshOptions {
	options?: Record<string, string>;
	error?: string;
}

/**
 * Parse repeated `KEY=VALUE` assignments (the CLI's `--ssh-option` flag).
 *
 * Splits on the FIRST `=` only, because a `ProxyCommand` value routinely
 * contains more of them.
 */
export function parseSshOptionAssignments(entries: string[] | undefined): ParsedSshOptions {
	if (!entries || entries.length === 0) return {};
	const options: Record<string, string> = {};
	for (const entry of entries) {
		const eqIndex = entry.indexOf('=');
		if (eqIndex === -1) {
			return { error: `Invalid --ssh-option format "${entry}". Expected KEY=VALUE` };
		}
		const key = entry.slice(0, eqIndex).trim();
		const value = entry.slice(eqIndex + 1);
		const invalid = validateSshOption(key, value);
		if (invalid) return { error: invalid };
		options[key] = value;
	}
	return { options };
}
