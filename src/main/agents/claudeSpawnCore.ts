/**
 * Claude Spawn Core (bundle-safe)
 *
 * The pure, dependency-injected heart of the Claude token-source decision:
 * given a token mode and the injected collaborators, decide whether a Claude
 * Code spawn runs the maestro-p TUI (Max-plan quota) or `claude --print` (API
 * credit), and produce the command/args/env transform that realizes it.
 *
 * This module has NO native/Electron imports (no electron-store, no SQLite, no
 * desktop logger) so it can be bundled into BOTH surfaces:
 *   - the desktop app, via `resolveClaudeSpawnMode.ts`, which supplies the real
 *     native-backed default deps; and
 *   - the standalone `maestro-cli` (Auto Run playbooks, batch, `send`), which
 *     supplies lightweight CLI deps.
 *
 * Keeping ONE decision function shared by every surface is what makes the
 * per-agent token source honored "across the board" - chat, Auto Run, tab
 * naming, history synopsis, group chat, Cue - with no second implementation to
 * drift out of sync.
 *
 * maestro-p is a Node script that allocates its OWN PTY internally (node-pty)
 * to drive the claude TUI, so it runs fine over plain pipe stdio - callers do
 * not need to allocate a PTY. They only invoke it via `process.execPath`, set
 * `MAESTRO_CLAUDE_BIN`, and deliver the prompt the same way they would to
 * `claude` (stdin / CLI arg per agent capability).
 */

import * as os from 'os';
import * as path from 'path';
import { selectMode as builtinSelectMode } from './claude-mode-selector';
import type { SelectModeInput, SelectModeResult, UsageSnapshot } from './claude-mode-selector';
import type { ClaudeTokenMode } from '../../shared/claudeTokenMode';

const LOG_CONTEXT = 'ClaudeSpawnCore';

/**
 * Minimal agent shape the core needs. Declared locally (not `Pick<AgentConfig>`)
 * so the core stays free of the desktop agent-definitions import graph and
 * remains bundle-safe for the CLI.
 */
export interface ResolverAgent {
	id: string;
	interactiveCommand?: string;
	interactiveModeArgs?: string[];
	defaultEnvVars?: Record<string, string>;
}

/** Minimal logger the core writes fallback/warn diagnostics through (injectable). */
export interface CoreLogger {
	warn: (message: string, context?: string, meta?: unknown) => void;
	debug: (message: string, context?: string, meta?: unknown) => void;
}

/**
 * Return true when `binaryPath` looks like a maestro-p binary (by basename).
 *
 * Canonical implementation shared by every surface. Recognises the bundled
 * `maestro-p.js` script, a packaged `maestro-p` executable, and the Windows
 * `.exe` variant. Used to detect power-user setups where the `Path` field
 * points directly at maestro-p (bypassing the token-source toggle) so the
 * resolved mode still surfaces as `interactive`, and to avoid pointing
 * `MAESTRO_CLAUDE_BIN` at maestro-p itself (which would make it drive itself
 * instead of the claude TUI).
 */
export function isMaestroPBinaryPath(binaryPath: string | undefined | null): boolean {
	if (!binaryPath) return false;
	// Split on both `/` and `\` so a Windows-style path resolves correctly when
	// this code runs on POSIX (path.basename on POSIX doesn't treat `\` as a
	// separator, which would otherwise leave the whole `C:\…` string as the
	// "basename" and miss the match).
	const base = (binaryPath.split(/[\\/]/).pop() ?? '').toLowerCase();
	return base === 'maestro-p' || base === 'maestro-p.js' || base === 'maestro-p.exe';
}

/**
 * Canonical CLAUDE_CONFIG_DIR key: the absolute path of `$CLAUDE_CONFIG_DIR`
 * (or `~/.claude`). Pure. Shared so the desktop usage store and the CLI compute
 * the same key from the same env.
 */
export function resolveConfigDirKeyFromEnv(env: NodeJS.ProcessEnv): string {
	const raw = env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
	return path.resolve(raw);
}

/** Injectable collaborators. Every surface supplies these; none are defaulted here. */
export interface ClaudeSpawnCoreDeps {
	/** Resolve the bundled/installed maestro-p script path, or null if none found. */
	getMaestroPBinPath: () => string | null;
	/** Basename check for a maestro-p binary (defaults available as the exported fn). */
	isMaestroPBinaryPath: (p: string | null | undefined) => boolean;
	/** Canonical CLAUDE_CONFIG_DIR key from an env. */
	resolveConfigDirKey: (env: NodeJS.ProcessEnv) => string;
	/** Latest usage snapshot for the config-dir key, or null when unavailable. */
	getUsageSnapshot: (key: string) => UsageSnapshot | null;
	/** Filesystem existence check (injectable for tests / alternate runtimes). */
	fileExists: (p: string) => boolean;
	/**
	 * Cached result of probing an SSH remote for `maestro-p` on its PATH.
	 * `false` = known-absent (fall the remote TUI spawn back to API), `true` =
	 * present, `undefined` = never probed (stay optimistic).
	 */
	getRemoteMaestroPAvailable: (remoteId?: string | null) => boolean | undefined;
	/** Pure dynamic-mode selector (defaults to the shared claude-mode-selector). */
	selectMode: (input: SelectModeInput) => SelectModeResult;
	/** Optional diagnostics sink. */
	logger?: CoreLogger;
}

export interface ResolveClaudeSpawnModeCoreInput {
	/** Resolved agent definition (from the agent detector / CLI definitions). */
	agent: ResolverAgent | null;
	/** Canonical token mode for this spawn (see getClaudeTokenMode). */
	tokenMode: ClaudeTokenMode;
	/**
	 * SSH-enabled spawn. Interactive (TUI) mode runs maestro-p on the remote
	 * host; it falls back to API when the remote probe says maestro-p is absent.
	 */
	sshEnabled: boolean;
	/**
	 * SSH remote id, used to look up the cached remote maestro-p availability so
	 * a remote TUI spawn can fall back to API when the remote can't run it.
	 */
	sshRemoteId?: string;
	/** Base command that would otherwise spawn (the claude binary path). */
	command: string;
	/** Per-session custom Path override, if any. */
	sessionCustomPath?: string;
	/** Per-session custom env vars (feed the CLAUDE_CONFIG_DIR key resolution). */
	sessionCustomEnvVars?: Record<string, string>;
	/** Per-session maestro-p script override. Empty falls back to the bundled script. */
	maestroPPath?: string;
	/** Previously-persisted claudeInteractive state, for sticky-limit + stale clear. */
	persisted?: { mode?: 'interactive' | 'api'; modeReason?: 'auto' | 'limit' };
	/** Injected wall clock (selectMode needs it). */
	now: Date;
}

export interface ClaudeSpawnDecision {
	mode: 'interactive' | 'api';
	reason: 'auto' | 'limit';
	/**
	 * Resolved maestro-p script to invoke via `process.execPath`. Non-null only
	 * for the toggle-driven interactive path (api and direct-binary leave the
	 * spawn command untouched).
	 */
	maestroPBinPath: string | null;
	/** The real claude binary maestro-p should drive (becomes MAESTRO_CLAUDE_BIN). */
	claudeRealBinPath?: string;
	/** Canonical CLAUDE_CONFIG_DIR key, when computed (drives persistence + sampling). */
	configDirKey?: string;
	/**
	 * Interactive resolved because the session Path points directly at a
	 * maestro-p binary. The spawn is left untouched (no execPath wrap); this only
	 * affects how the mode is reported/persisted.
	 */
	directBinary?: boolean;
	/**
	 * Interactive resolved for an SSH REMOTE spawn. maestro-p runs on the remote
	 * host (not a local script via process.execPath), so `maestroPBinPath` is
	 * null. SSH-wrapping callers realize this with {@link buildRemoteInteractiveSpawn}.
	 */
	remote?: boolean;
}

/**
 * Decide the Claude token source for a spawn. Pure aside from the injected
 * collaborators (usage snapshot read + filesystem existence check).
 *
 * This is the SINGLE decision every surface runs. The desktop `resolveClaudeSpawnMode`
 * wrapper and the CLI spawner both call it with their own deps.
 */
export function resolveClaudeSpawnModeCore(
	input: ResolveClaudeSpawnModeCoreInput,
	deps: ClaudeSpawnCoreDeps
): ClaudeSpawnDecision {
	const d = deps;
	const log = d.logger;
	const { agent, tokenMode, sshEnabled, command, sessionCustomPath } = input;

	const isClaudeCode =
		agent?.id === 'claude-code' && !!agent?.interactiveCommand && !!agent?.interactiveModeArgs;

	// Non-Claude agents never route through maestro-p.
	if (!isClaudeCode) {
		return { mode: 'api', reason: 'auto', maestroPBinPath: null };
	}

	const envForKey: NodeJS.ProcessEnv = {
		...(process.env as NodeJS.ProcessEnv),
		...(agent?.defaultEnvVars ?? {}),
		...(input.sessionCustomEnvVars ?? {}),
	};

	// ── API mode ────────────────────────────────────────────────────────────
	if (tokenMode === 'api') {
		// Power-user setup: the Path field itself points at a maestro-p binary.
		// The command already launches maestro-p, so we leave the spawn alone and
		// only reflect that it's really interactive (for the TUI/API pill + the
		// renderStyle tagger that reads claudeInteractive.mode). Local-only: a
		// remote custom path can't be probed against the local filesystem.
		if (!sshEnabled && d.isMaestroPBinaryPath(sessionCustomPath)) {
			return {
				mode: 'interactive',
				reason: 'auto',
				maestroPBinPath: null,
				directBinary: true,
				configDirKey: d.resolveConfigDirKey(envForKey),
			};
		}
		// Stale-state cleanup: if a prior turn persisted interactive, surface the
		// config-dir key so the caller can write 'api' back over it.
		const configDirKey =
			input.persisted?.mode === 'interactive' ? d.resolveConfigDirKey(envForKey) : undefined;
		return { mode: 'api', reason: 'auto', maestroPBinPath: null, configDirKey };
	}

	// ── SSH remote: maestro-p runs on the REMOTE host ─────────────────────────
	// The interactive wrapper used to be local-only because it needs the claude
	// TUI binary. Over SSH that binary lives on the remote, and maestro-p (which
	// the user must have installed on the remote PATH) drives it there. There is
	// no local script to resolve, so the SSH-wrapping caller realizes the spawn
	// via buildRemoteInteractiveSpawn.
	//
	// Only the explicit `interactive` (TUI) choice routes through maestro-p on
	// remote. `dynamic` is NOT offered for SSH agents because the auto-switch
	// reads a LOCAL usage snapshot that says nothing about the remote account's
	// quota - there's no honest signal to switch on. A `dynamic` value that
	// reaches here anyway falls back to `api` rather than silently spending
	// Max-plan quota the user never explicitly opted into.
	if (sshEnabled) {
		if (tokenMode === 'interactive') {
			// The remote must have maestro-p on its PATH to drive the TUI. If a
			// probe has already determined it is absent, fall back to API rather
			// than spawning `maestro-p` on the remote and exiting 127 on every turn.
			// Unknown (never probed) stays optimistic.
			if (d.getRemoteMaestroPAvailable(input.sshRemoteId) === false) {
				log?.warn(
					'maestro-p (TUI) selected for an SSH remote that has no maestro-p on its PATH - falling back to API mode',
					LOG_CONTEXT,
					{ sshRemoteId: input.sshRemoteId }
				);
				return {
					mode: 'api',
					reason: 'auto',
					maestroPBinPath: null,
					configDirKey: d.resolveConfigDirKey(envForKey),
				};
			}
			return {
				mode: 'interactive',
				reason: 'auto',
				maestroPBinPath: null,
				remote: true,
				// A custom remote claude path, when set, becomes MAESTRO_CLAUDE_BIN on
				// the remote; otherwise maestro-p defaults to `claude` on the remote
				// PATH. Never forward a maestro-p path here: when the agent's binary
				// IS maestro-p, using it as MAESTRO_CLAUDE_BIN makes the remote
				// maestro-p drive ITSELF in the PTY instead of claude - the child
				// exits instantly and every turn dies as `tui_exited`.
				claudeRealBinPath:
					sessionCustomPath && !d.isMaestroPBinaryPath(sessionCustomPath)
						? sessionCustomPath
						: undefined,
				configDirKey: d.resolveConfigDirKey(envForKey),
			};
		}
		// dynamic over SSH: no remote quota signal, fall back to API.
		return {
			mode: 'api',
			reason: 'auto',
			maestroPBinPath: null,
			configDirKey: d.resolveConfigDirKey(envForKey),
		};
	}

	// ── interactive / dynamic ─────────────────────────────────────────────────
	const candidate = (input.maestroPPath && input.maestroPPath.trim()) || d.getMaestroPBinPath();
	if (!candidate || !d.fileExists(candidate)) {
		log?.warn(
			'maestro-p selected but no maestro-p binary found - falling back to API mode',
			LOG_CONTEXT,
			{ tokenMode, override: input.maestroPPath }
		);
		return { mode: 'api', reason: 'auto', maestroPBinPath: null };
	}

	const configDirKey = d.resolveConfigDirKey(envForKey);
	// Same self-reference guard as the remote branch: neither the custom path nor
	// the resolved command may become MAESTRO_CLAUDE_BIN if it points at maestro-p
	// itself, or maestro-p would spawn itself instead of the claude TUI. Fall back
	// to `claude` on PATH (undefined) when both are maestro-p.
	const claudeRealBinPath =
		(sessionCustomPath && !d.isMaestroPBinaryPath(sessionCustomPath)
			? sessionCustomPath
			: undefined) ?? (command && !d.isMaestroPBinaryPath(command) ? command : undefined);

	if (tokenMode === 'interactive') {
		return {
			mode: 'interactive',
			reason: 'auto',
			maestroPBinPath: candidate,
			claudeRealBinPath,
			configDirKey,
		};
	}

	// dynamic: let the usage snapshot decide, with sticky-limit fallback.
	const snapshot = d.getUsageSnapshot(configDirKey);
	const decision = d.selectMode({
		perTabReason: input.persisted?.modeReason === 'limit' ? 'limit' : 'auto',
		usageSnapshot: snapshot,
		now: input.now,
	});
	if (decision.mode === 'interactive') {
		return {
			mode: 'interactive',
			reason: decision.reason,
			maestroPBinPath: candidate,
			claudeRealBinPath,
			configDirKey,
		};
	}
	return { mode: 'api', reason: decision.reason, maestroPBinPath: null, configDirKey };
}

/** Convenience: the built-in selectMode, re-exported so surfaces share one impl. */
export const defaultSelectMode = builtinSelectMode;

export interface ApplyClaudeSpawnInput {
	decision: ClaudeSpawnDecision;
	/** agent.interactiveModeArgs - the maestro-p flag list (e.g. --dangerously-skip-permissions). */
	interactiveModeArgs?: string[];
	command: string;
	/**
	 * The fully-built batch arg list, INCLUDING the prompt as a trailing
	 * positional (e.g. `--print --verbose --output-format stream-json
	 * --dangerously-skip-permissions -- <prompt>`). maestro-p's arg parser strips
	 * the headless-only flags, forwards the rest to the claude TUI, and reads the
	 * prompt from after `--`, so the list is forwarded verbatim.
	 */
	args: string[];
	customEnvVars?: Record<string, string>;
	/** Defaults to process.execPath; injectable for tests. */
	execPath?: string;
	/**
	 * Overall idle budget for the maestro-p run, in seconds. Forwarded as
	 * `--max-wait`. Background callers (Cue, Auto Run) SHOULD pass this so the run
	 * honors their configured timeout instead of maestro-p's built-in default.
	 */
	maxWaitSeconds?: number;
}

export interface ApplyClaudeSpawnResult {
	command: string;
	args: string[];
	customEnvVars?: Record<string, string>;
}

/**
 * Realize a {@link ClaudeSpawnDecision} as concrete spawn inputs for a BATCH
 * spawn surface (Auto Run, group chat, Cue, tab naming) whose arg list already
 * carries the prompt as a positional. For the toggle-driven interactive path it
 * runs maestro-p via `process.execPath`, prepending the maestro-p script and its
 * interactive flags to the existing args (maestro-p strips the headless flags
 * and reads the prompt itself), and injects `MAESTRO_CLAUDE_BIN`. Every other
 * case (API, or direct-binary interactive) passes through unchanged.
 */
export function applyClaudeSpawnDecision(input: ApplyClaudeSpawnInput): ApplyClaudeSpawnResult {
	const { decision, interactiveModeArgs, command, args, customEnvVars } = input;

	if (decision.mode === 'interactive' && decision.maestroPBinPath) {
		const realBin = decision.claudeRealBinPath ?? command;
		const env: Record<string, string> = {
			...(customEnvVars ?? {}),
			MAESTRO_CLAUDE_BIN: realBin,
			// `process.execPath` under Electron is the app binary. Running it against
			// a `.js` script (maestro-p) without this flag does NOT execute the
			// script as Node in a PACKAGED app - it launches a second Maestro GUI, so
			// maestro-p never runs and the caller gets a null result. Under the plain
			// `node` binary (the standalone CLI) the flag is harmless. Setting it
			// unconditionally keeps both surfaces correct.
			ELECTRON_RUN_AS_NODE: '1',
		};
		// Under ELECTRON_RUN_AS_NODE, maestro-p runs as pure Node and does
		// `require('node-pty')`, which esbuild left external. In a packaged app
		// maestro-p.js sits at the resources root, OUTSIDE the asar, so Node can't
		// find node-pty without help. Point NODE_PATH at the IN-ASAR node_modules
		// (`<resources>/app.asar/node_modules`). node-pty computes its `spawn-helper`
		// path by rewriting `app.asar` → `app.asar.unpacked`, so we must feed it the
		// asar path (not the already-unpacked one, which would double-apply). In dev
		// / under the plain-node CLI `resourcesPath` is empty, so this is skipped and
		// node-pty resolves from the surrounding node_modules.
		if (typeof process.resourcesPath === 'string' && process.resourcesPath.length > 0) {
			const asarModules = path.join(process.resourcesPath, 'app.asar', 'node_modules');
			const existing = env.NODE_PATH ?? process.env.NODE_PATH;
			env.NODE_PATH = existing ? `${asarModules}${path.delimiter}${existing}` : asarModules;
		}
		// `--max-wait` must precede the batch args because those end with the
		// `-- <prompt>` end-of-options marker; anything after `--` is read by
		// maestro-p's parser as the prompt positional, not a flag.
		const maxWaitArgs =
			typeof input.maxWaitSeconds === 'number' && input.maxWaitSeconds > 0
				? ['--max-wait', String(Math.ceil(input.maxWaitSeconds))]
				: [];
		return {
			command: input.execPath ?? process.execPath,
			args: [decision.maestroPBinPath, ...maxWaitArgs, ...(interactiveModeArgs ?? []), ...args],
			customEnvVars: env,
		};
	}

	return { command, args, customEnvVars };
}

/**
 * Command name used to invoke maestro-p on a remote SSH host. The user must have
 * maestro-p installed and on PATH there. Unlike the local path it is a bare
 * command: the SSH stdin script's login-shell PATH resolves it the same way it
 * resolves `claude` for the API path.
 */
export const REMOTE_MAESTRO_P_COMMAND = 'maestro-p';

/** Substitutions an SSH-wrapping caller applies for a remote interactive spawn. */
export interface RemoteInteractiveSpawn {
	/** Remote command to exec instead of `claude` (i.e. `maestro-p`). */
	command: string;
	/** Flags to prepend ahead of the existing (headless) arg list + prompt. */
	prependArgs: string[];
	/** Env additions to merge into the remote env. */
	env: Record<string, string>;
}

/**
 * Realize an interactive {@link ClaudeSpawnDecision} for an SSH REMOTE spawn.
 *
 * Where {@link applyClaudeSpawnDecision} wraps a LOCAL maestro-p script via
 * `process.execPath`, this returns the substitutions an SSH-wrapping caller
 * folds into its remote command: run `maestro-p` on the remote host, prepend
 * the interactive flags (and an optional `--max-wait` idle budget), and point
 * MAESTRO_CLAUDE_BIN at the remote claude binary when a custom remote path is
 * configured. Returns null when the decision is not remote-interactive.
 */
export function buildRemoteInteractiveSpawn(input: {
	decision: ClaudeSpawnDecision;
	interactiveModeArgs?: string[];
	remoteClaudeBin?: string;
	maxWaitSeconds?: number;
}): RemoteInteractiveSpawn | null {
	const { decision, interactiveModeArgs, remoteClaudeBin } = input;
	if (decision.mode !== 'interactive' || !decision.remote) {
		return null;
	}
	const maxWaitArgs =
		typeof input.maxWaitSeconds === 'number' && input.maxWaitSeconds > 0
			? ['--max-wait', String(Math.ceil(input.maxWaitSeconds))]
			: [];
	const env: Record<string, string> = {};
	if (remoteClaudeBin && remoteClaudeBin.length > 0) {
		env.MAESTRO_CLAUDE_BIN = remoteClaudeBin;
	}
	return {
		command: REMOTE_MAESTRO_P_COMMAND,
		prependArgs: [...maxWaitArgs, ...(interactiveModeArgs ?? [])],
		env,
	};
}
