/**
 * Host-owned spawn binary allowlist (main process).
 *
 * The central control for the `process:spawn` act verb
 * (`Plans/plugin-phase4-high-risk-verbs.md` §2): a plugin NEVER supplies a
 * path, a shell, or an interpreter — it selects a host-blessed entry by NAME,
 * and everything the child actually runs with (absolute binary path, base
 * argv, env, cwd) is owned by this registry, not by the plugin.
 *
 * Invariants enforced here (registration time, so a bad entry can never be
 * selected at call time):
 *  - names are opaque exact tokens (no paths, no whitespace, no pattern chars);
 *  - shells / interpreters / arg-exec tools are REJECTED by basename, so
 *    "spawn" can never degenerate into "execute anything";
 *  - the binary path is absolute (the host names a specific program, the
 *    child's PATH resolves nothing);
 *  - env is a closed host-chosen allowlist and NEVER inherits `process.env`
 *    (same discipline as the sandbox fork's `env: {}`).
 *
 * The registry ships EMPTY: Maestro currently blesses no helper binaries.
 * `register()` is the deliberate seam an integrator uses to bless one, and
 * every registration is logged by the caller-provided audit hook.
 */

import * as path from 'path';

export interface SpawnBinaryEntry {
	/** The exact name a plugin selects (and an allowlist grant names). */
	name: string;
	/** Absolute path to the specific binary the host blesses. */
	binaryPath: string;
	/** Host-chosen argv PREFIX, prepended before any plugin-validated args. */
	baseArgs?: readonly string[];
	/** Closed, host-chosen env for the child. NEVER merged with process.env. */
	env?: Readonly<Record<string, string>>;
	/** Host-confined working directory. Absent = the host default the sink picks. */
	cwd?: string;
}

/** Exact-token shape for a blessed name: letters/digits, then ._- separators. */
const SPAWN_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

const SAFE_ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Same broad secret heuristic the settings handlers use: host-blessed spawn
 * env must not become a covert secret-delivery channel either. */
const SECRET_ENV_KEY_PATTERN =
	/key|token|secret|password|credential|apikey|sk$|^sk[_.]|auth|bearer|oauth|jwt|pat$|[._-]pat([._-]|$)|private|cert|signing/i;

/**
 * Shells, interpreters, and arg-exec tools that must NEVER be blessed, by
 * basename (extension-insensitive, case-insensitive). Executing any of these
 * with plugin-influenced args is arbitrary code execution with extra steps.
 * A denylist has gaps by nature — it is the backstop UNDER the empty-registry
 * default and the deliberate `register()` seam, not the boundary itself.
 */
const FORBIDDEN_BASENAMES: Record<string, true> = {
	sh: true,
	bash: true,
	dash: true,
	zsh: true,
	ksh: true,
	csh: true,
	tcsh: true,
	fish: true,
	cmd: true,
	command: true,
	powershell: true,
	pwsh: true,
	node: true,
	nodejs: true,
	bun: true,
	deno: true,
	python: true,
	python2: true,
	python3: true,
	ruby: true,
	perl: true,
	php: true,
	lua: true,
	osascript: true,
	wscript: true,
	cscript: true,
	mshta: true,
	env: true,
	xargs: true,
	eval: true,
	exec: true,
	busybox: true,
	su: true,
	sudo: true,
	runas: true,
	doas: true,
	nice: true,
	nohup: true,
	setsid: true,
	time: true,
	timeout: true,
	watch: true,
	find: true,
	awk: true,
	gawk: true,
	java: true,
	dotnet: true,
};

/** Basename of a path, tolerant of both separators, extension stripped. */
function normalizedBasename(p: string): string {
	const base = p.replace(/\\/g, '/').split('/').pop() ?? p;
	return base.replace(/\.(exe|com|bat|cmd|ps1|sh|py|rb|pl|js|mjs|cjs)$/i, '').toLowerCase();
}

/**
 * The host-owned registry. Deliberately NOT persisted and NOT reachable from
 * any plugin-facing surface: only main-process integration code can register.
 */
export class SpawnBinaryRegistry {
	private readonly entries = new Map<string, SpawnBinaryEntry>();

	constructor(
		private readonly deps: {
			/** Audit sink for every (attempted) registration. */
			onRegister?: (entry: SpawnBinaryEntry) => void;
		} = {}
	) {}

	/**
	 * Bless one binary. Throws on any invariant violation so a misconfigured
	 * integration fails loudly at startup, never silently at plugin-call time.
	 */
	register(entry: SpawnBinaryEntry): void {
		if (!SPAWN_NAME_PATTERN.test(entry.name)) {
			throw new Error(`spawn registry: invalid name "${entry.name}" (exact token required)`);
		}
		if (this.entries.has(entry.name)) {
			throw new Error(`spawn registry: "${entry.name}" is already registered`);
		}
		if (typeof entry.binaryPath !== 'string' || !path.isAbsolute(entry.binaryPath)) {
			throw new Error(
				`spawn registry: "${entry.name}" binaryPath must be an absolute path (got "${String(entry.binaryPath)}")`
			);
		}
		if (FORBIDDEN_BASENAMES[normalizedBasename(entry.binaryPath)]) {
			throw new Error(
				`spawn registry: refusing to bless shell/interpreter "${entry.binaryPath}" — spawning one is arbitrary code execution`
			);
		}
		if (FORBIDDEN_BASENAMES[normalizedBasename(entry.name)]) {
			throw new Error(`spawn registry: refusing shell/interpreter-shaped name "${entry.name}"`);
		}
		for (const [key, value] of Object.entries(entry.env ?? {})) {
			if (!SAFE_ENV_KEY_PATTERN.test(key)) {
				throw new Error(`spawn registry: "${entry.name}" env key "${key}" is not a safe name`);
			}
			if (SECRET_ENV_KEY_PATTERN.test(key)) {
				throw new Error(
					`spawn registry: "${entry.name}" env key "${key}" looks secret-bearing — blessed env must not carry credentials`
				);
			}
			if (typeof value !== 'string') {
				throw new Error(`spawn registry: "${entry.name}" env value for "${key}" must be a string`);
			}
		}
		if (entry.cwd !== undefined && !path.isAbsolute(entry.cwd)) {
			throw new Error(`spawn registry: "${entry.name}" cwd must be absolute when present`);
		}
		const frozen: SpawnBinaryEntry = Object.freeze({
			name: entry.name,
			binaryPath: entry.binaryPath,
			baseArgs: Object.freeze([...(entry.baseArgs ?? [])]),
			env: Object.freeze({ ...(entry.env ?? {}) }),
			...(entry.cwd !== undefined ? { cwd: entry.cwd } : {}),
		});
		this.entries.set(frozen.name, frozen);
		this.deps.onRegister?.(frozen);
	}

	/** Resolve a blessed entry by exact name, or null (deny). */
	resolve(name: string): SpawnBinaryEntry | null {
		return this.entries.get(name) ?? null;
	}

	/** The blessed names (for diagnostics / the consent surface). */
	names(): readonly string[] {
		return [...this.entries.keys()];
	}
}
