/**
 * Claude Usage Sampler
 *
 * Wraps a `maestro-p --status` spawn into a swallow-everything async function
 * that returns a `UsageSnapshot` (the camelCase store shape) or `null` on any
 * failure. The mode selector consults the snapshot whenever the per-agent
 * Batch Mode toggle is on; the snapshot store caches it per canonical
 * `CLAUDE_CONFIG_DIR` key.
 *
 * Design choices baked in:
 *
 * - Spawn shape: `process.execPath` invokes the bundled `maestro-p.js` (passed
 *   as `binPath`), so we don't depend on a global `maestro-p` shim on PATH and
 *   the binary's node-script-with-shebang packaging stays valid on Windows
 *   where shebangs aren't honored.
 *
 * - SSH limitation: this spawn is always LOCAL - it does NOT honor a session's
 *   `sshRemoteConfig` / `wrapSpawnWithSsh`, so the snapshot reflects the local
 *   account keyed by `CLAUDE_CONFIG_DIR`, never a remote host's Claude account.
 *   Consumers that act per remote session (notably Auto-Resume On Limit's
 *   `probeAvailability`) must NOT trust this snapshot for an SSH-backed session;
 *   they fall back to a resume-as-probe interval attempt instead.
 *
 * - Env precedence: `process.env` < `customEnvVars` < explicit `configDir`.
 *   Explicit `configDir` wins so a caller cannot accidentally smuggle a
 *   `CLAUDE_CONFIG_DIR` through `customEnvVars` that contradicts the path the
 *   spawner picked. `MAESTRO_CLAUDE_BIN` is intentionally the caller's
 *   responsibility (the spawner already knows the real claude binary path and
 *   threads it via `customEnvVars`).
 *
 * - `configDirKey` canonicalization: we key the returned snapshot by
 *   `resolveConfigDirKey(childEnv)`, NOT by the wire envelope's `config_dir`
 *   echo. The wrapper writes whatever string the maestro-p binary picked
 *   (`process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude')`),
 *   which is the same precedence the store uses but exposed to path-form
 *   drift across hosts; pinning the key locally keeps every consumer aligned.
 *
 * - Wire→store transform: snake_case maps to camelCase here so the rest of
 *   Maestro never sees the wire shape. `sampledAt` is set at parse time on
 *   the sampling host (not lifted from the wire) because the TTL clock is
 *   owned here, not by the binary.
 *
 * - Tolerance: scan stdout for the first line that starts with `{` instead
 *   of blindly `JSON.parse(stdout)`. Node 22 occasionally writes
 *   `(node:1234) DeprecationWarning: ...` to stdout, and we don't want a
 *   single stderr-shaped line to nuke an otherwise-good sample.
 *
 * - Failure modes: never throws. Every error path (spawn `ENOENT`, timeout,
 *   non-zero exit, empty stdout, malformed JSON, missing wire fields)
 *   resolves to `null` and emits a Sentry breadcrumb with stage + binPath +
 *   configDir + reason. Full env and full stdout are intentionally NOT
 *   included in the Sentry payload - env leaks PATH / shell vars, stdout
 *   could carry account-level usage data.
 *
 * - execFile choice: node's `execFile` via `util.promisify`, not the
 *   project's `execFileNoThrow`. The helper's options shape requires either
 *   `env` OR an `ExecOptions` carrying `input`/`timeout` (the two are
 *   mutually exclusive), and extending it would be adjacent-system
 *   refactoring out of scope.
 */

import { execFile } from 'child_process';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

import { captureMessage } from '../utils/sentry';
import { resolveConfigDirKey, type UsageSnapshot } from '../stores/claudeUsageStore';

const execFileAsync = promisify(execFile);

/** Default timeout - comfortably wider than maestro-p's internal /usage budget. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** maxBuffer cap. The real payload is <1KB; 1MB is paranoia. */
const MAX_BUFFER_BYTES = 1 * 1024 * 1024;

export interface SampleUsageOptions {
	/** Absolute path to `maestro-p.js` (the bundled script, not a PATH lookup). */
	binPath: string;
	/**
	 * Override the `CLAUDE_CONFIG_DIR` passed to the spawn. Wins over any
	 * `customEnvVars.CLAUDE_CONFIG_DIR` smuggled in via the env block.
	 */
	configDir?: string;
	/** Working directory for the spawn. */
	cwd: string;
	/**
	 * Per-spawn env overrides layered onto `process.env`. The caller is
	 * responsible for setting `MAESTRO_CLAUDE_BIN` here when the real claude
	 * binary is not on PATH.
	 */
	customEnvVars?: Record<string, string>;
	/** Override the default 30s wall-clock budget. */
	timeoutMs?: number;
}

/**
 * The wire shape `maestro-p --status` emits on stdout. Local to this module;
 * the store / selector only ever see the canonical camelCase `UsageSnapshot`.
 *
 * `auth_state` is optional for back-compat with older maestro-p builds that
 * didn't emit the field - readers treat its absence as `'authenticated'`.
 */
interface StatusWireEnvelope {
	type: 'status';
	auth_state?: 'authenticated' | 'unauthenticated';
	config_dir: string;
	session: { percent: number; resets_at: string };
	week_all_models: { percent: number; resets_at: string };
	week_sonnet_only: { percent: number; resets_at: string };
}

/**
 * Run `maestro-p --status`, parse the wire envelope, and return a
 * canonicalized `UsageSnapshot`. Resolves to `null` on any failure - see the
 * module docblock for the full list of swallowed failure modes.
 */
export async function sampleUsage(opts: SampleUsageOptions): Promise<UsageSnapshot | null> {
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const childEnv: NodeJS.ProcessEnv = { ...process.env, ...(opts.customEnvVars ?? {}) };
	if (opts.configDir !== undefined) {
		childEnv.CLAUDE_CONFIG_DIR = opts.configDir;
	}

	// `process.execPath` is the Electron binary in a packaged app. Running it
	// against a `.js` script without this flag launches a second GUI instance
	// instead of executing the script as Node - so `maestro-p --status` would
	// never run and the snapshot would always be null. Every other execPath
	// node-script spawn in the app sets this (see `cue-cli-executor.ts`,
	// `maestro-cli-manager.ts`); the sampler was missing it.
	childEnv.ELECTRON_RUN_AS_NODE = '1';

	// Hard guarantee: this read-only `/usage` probe must never be able to launch
	// the Claude OAuth browser. When a config dir holds an expired / needs-consent
	// token (distinct from fully-logged-out, which claude renders inline as
	// "Not logged in · Run /login"), launching the TUI kicks off the OAuth consent
	// flow and opens a browser window - intolerable on an unattended background
	// refresh tick. claude's URL opener uses `$BROWSER` as the launch command when
	// set and does NOT fall back to the system opener, so pointing it at a no-op
	// (`/usr/bin/true` on unix; a nonexistent path on Windows fails closed the same
	// way) makes the consent flow open nothing. The sampler then just times out and
	// skips that account. Login still happens normally in real interactive Claude
	// sessions - those spawn through the process manager, not this sampler.
	childEnv.BROWSER = '/usr/bin/true';

	// `maestro-p.js` is shipped via `extraResources` at the resources root and
	// `require('node-pty')` (left external by its esbuild bundle). From outside
	// the asar, Node can't find node-pty without help. Point NODE_PATH at the
	// IN-ASAR node_modules (`<resources>/app.asar/node_modules`), NOT the
	// unpacked copy: node-pty's JS loads from the asar (Electron's patched fs
	// reads it; the native `pty.node` is auto-redirected to app.asar.unpacked),
	// and critically node-pty computes its `spawn-helper` path by doing
	// `helperPath.replace('app.asar', 'app.asar.unpacked')`. If we hand it the
	// already-unpacked path, that replace double-applies to
	// `app.asar.unpacked.unpacked` and the helper exec fails with
	// "posix_spawn failed: No such file or directory" - which silently broke
	// every Claude usage sample in packaged builds (empty store, no dashboard
	// tab). Feeding the asar path lets node-pty rewrite it once, correctly.
	// Mirrors resolveClaudeSpawnMode.ts. Only applies to the packaged app; in
	// dev `resourcesPath` is empty and node-pty resolves from the project tree.
	if (typeof process.resourcesPath === 'string' && process.resourcesPath.length > 0) {
		const asarModules = path.join(process.resourcesPath, 'app.asar', 'node_modules');
		childEnv.NODE_PATH = childEnv.NODE_PATH
			? `${asarModules}${path.delimiter}${childEnv.NODE_PATH}`
			: asarModules;
	}

	let stdout: string;
	try {
		const result = await execFileAsync(process.execPath, [opts.binPath, '--status'], {
			cwd: opts.cwd,
			env: childEnv,
			encoding: 'utf8',
			maxBuffer: MAX_BUFFER_BYTES,
			timeout: timeoutMs,
		});
		stdout = result.stdout;
	} catch (err) {
		void reportFailure('spawn', opts, classifySpawnError(err));
		return null;
	}

	if (!stdout || stdout.trim().length === 0) {
		void reportFailure('parse', opts, 'empty stdout');
		return null;
	}

	const jsonLine = extractFirstJsonLine(stdout);
	if (jsonLine === null) {
		void reportFailure('parse', opts, 'no json object line found');
		return null;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonLine);
	} catch (err) {
		void reportFailure(
			'parse',
			opts,
			`json parse: ${err instanceof Error ? err.message : String(err)}`
		);
		return null;
	}

	if (!isStatusWireEnvelope(parsed)) {
		void reportFailure('parse', opts, 'wire shape rejected by type guard');
		return null;
	}

	return {
		sampledAt: new Date().toISOString(),
		configDirKey: resolveConfigDirKey(childEnv),
		authState: parsed.auth_state ?? 'authenticated',
		session: {
			percent: parsed.session.percent,
			resetsAt: parsed.session.resets_at,
		},
		weekAllModels: {
			percent: parsed.week_all_models.percent,
			resetsAt: parsed.week_all_models.resets_at,
		},
		weekSonnetOnly: {
			percent: parsed.week_sonnet_only.percent,
			resetsAt: parsed.week_sonnet_only.resets_at,
		},
	};
}

/**
 * Locate the first line whose first non-whitespace character is `{`. Tolerates
 * a leading `(node:1234) DeprecationWarning: ...` and any other stderr-shaped
 * prefix node may have leaked onto stdout.
 */
function extractFirstJsonLine(stdout: string): string | null {
	for (const line of stdout.split(/\r?\n/)) {
		if (line.trimStart().startsWith('{')) {
			return line;
		}
	}
	return null;
}

/**
 * Verify the parsed wire object carries every field the camelCase mapping
 * reads. A single missing or wrong-typed field discards the whole sample -
 * a half-populated snapshot would be worse than no snapshot at all.
 */
function isStatusWireEnvelope(obj: unknown): obj is StatusWireEnvelope {
	if (!obj || typeof obj !== 'object') return false;
	const e = obj as Record<string, unknown>;
	if (e.type !== 'status') return false;
	if (typeof e.config_dir !== 'string') return false;
	// `auth_state` is optional; when present it must be one of two values.
	// Anything else is malformed and we reject the whole envelope rather
	// than coercing - a half-typed wire is worse than a missing sample.
	if (
		e.auth_state !== undefined &&
		e.auth_state !== 'authenticated' &&
		e.auth_state !== 'unauthenticated'
	) {
		return false;
	}
	return (
		isWireWindow(e.session) && isWireWindow(e.week_all_models) && isWireWindow(e.week_sonnet_only)
	);
}

function isWireWindow(value: unknown): value is { percent: number; resets_at: string } {
	if (!value || typeof value !== 'object') return false;
	const w = value as Record<string, unknown>;
	return typeof w.percent === 'number' && typeof w.resets_at === 'string';
}

/**
 * Map a spawn-stage exception onto a short reason string. ENOENT / EACCES /
 * timeout each get a stable token so Sentry aggregations stay clean; anything
 * else is included verbatim from the error message.
 */
function classifySpawnError(err: unknown): string {
	if (!err || typeof err !== 'object') {
		return `unknown: ${String(err)}`;
	}
	const e = err as { code?: string; killed?: boolean; signal?: string; message?: string };
	if (e.code === 'ENOENT') return 'ENOENT';
	if (e.code === 'EACCES') return 'EACCES';
	// node's execFile sets killed=true and signal='SIGTERM' when its own
	// timeout fires; absence of `code` distinguishes this from a non-zero
	// process exit that happens to carry a signal field.
	if (e.killed && !e.code) return 'timeout';
	if (typeof e.code === 'string') return `exit: ${e.code}`;
	if (typeof e.code === 'number') return `exit: ${e.code}`;
	return e.message ? `error: ${e.message}` : 'unknown';
}

/**
 * Emit a Sentry warning breadcrumb with the safe subset of context - stage,
 * binPath, configDir, reason. Full env / full stdout are deliberately omitted.
 */
async function reportFailure(
	stage: 'spawn' | 'parse',
	opts: SampleUsageOptions,
	reason: string
): Promise<void> {
	await captureMessage('maestro-p --status sample failed', 'warning', {
		stage,
		binPath: opts.binPath,
		configDir: opts.configDir ?? path.join(os.homedir(), '.claude'),
		reason,
	});
}
