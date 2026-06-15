/**
 * Resolve Claude Spawn Mode
 *
 * Single shared decision for every Claude Code spawn surface (desktop turn,
 * Auto Run, background synopsis, tab naming, group chat, Cue): given a token
 * mode and the latest usage snapshot, decide whether to run the maestro-p TUI
 * (Max-plan quota) or `claude --print` (API credit), and produce the
 * command/args/env transform that realizes that choice.
 *
 * This logic used to live inline inside the `process:spawn` IPC handler, which
 * made every other spawn surface silently API-only. Extracting it here is what
 * lets Auto Run, group chat, and Cue honor the per-agent selection.
 *
 * maestro-p is a Node script that allocates its OWN PTY internally (node-pty)
 * to drive the claude TUI, so the maestro-p process itself runs fine over plain
 * pipe stdio - callers do not need to allocate a PTY. They only need to invoke
 * it via `process.execPath`, set `MAESTRO_CLAUDE_BIN`, and deliver the prompt
 * the same way they would to `claude` (stdin / CLI arg per agent capability).
 */

import * as fs from 'fs';
import * as path from 'path';
import type { AgentConfig } from './definitions';
import { selectMode as defaultSelectMode } from './claude-mode-selector';
import type { UsageSnapshot } from './claude-mode-selector';
import {
	getMaestroPBinPath as defaultGetMaestroPBinPath,
	isMaestroPBinaryPath as defaultIsMaestroPBinaryPath,
} from './claude-usage-startup';
import {
	getSnapshot as defaultGetUsageSnapshot,
	resolveConfigDirKey as defaultResolveConfigDirKey,
} from '../stores/claudeUsageStore';
import { getRemoteMaestroPAvailable as defaultGetRemoteMaestroPAvailable } from './remoteMaestroPCache';
import { logger } from '../utils/logger';
import type { ClaudeTokenMode } from '../../shared/claudeTokenMode';

const LOG_CONTEXT = 'ResolveClaudeSpawnMode';

/** Minimal agent shape the resolver needs. */
type ResolverAgent = Pick<
	AgentConfig,
	'id' | 'interactiveCommand' | 'interactiveModeArgs' | 'defaultEnvVars'
> | null;

/** Injectable dependencies (defaulted to the real implementations). */
export interface ResolveClaudeSpawnModeDeps {
	getMaestroPBinPath: () => string | null;
	isMaestroPBinaryPath: (p: string | null | undefined) => boolean;
	resolveConfigDirKey: (env: NodeJS.ProcessEnv) => string;
	getUsageSnapshot: (key: string) => UsageSnapshot | null;
	fileExists: (p: string) => boolean;
	/**
	 * Cached result of probing the SSH remote for `maestro-p` on its PATH.
	 * `false` = known-absent (fall the remote TUI spawn back to API), `true` =
	 * present, `undefined` = never probed (stay optimistic).
	 */
	getRemoteMaestroPAvailable: (remoteId?: string | null) => boolean | undefined;
	selectMode: typeof defaultSelectMode;
}

const defaultDeps: ResolveClaudeSpawnModeDeps = {
	getMaestroPBinPath: defaultGetMaestroPBinPath,
	isMaestroPBinaryPath: defaultIsMaestroPBinaryPath,
	resolveConfigDirKey: defaultResolveConfigDirKey,
	getUsageSnapshot: defaultGetUsageSnapshot,
	fileExists: (p: string) => {
		try {
			return fs.existsSync(p);
		} catch {
			return false;
		}
	},
	getRemoteMaestroPAvailable: defaultGetRemoteMaestroPAvailable,
	selectMode: defaultSelectMode,
};

export interface ResolveClaudeSpawnModeInput {
	/** Resolved agent definition (from the agent detector). */
	agent: ResolverAgent;
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
	/** Test seams. */
	deps?: Partial<ResolveClaudeSpawnModeDeps>;
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
	 * maestro-p binary. The spawn is left untouched (no execPath wrap); this
	 * only affects how the mode is reported/persisted.
	 */
	directBinary?: boolean;
	/**
	 * Interactive resolved for an SSH REMOTE spawn. maestro-p runs on the remote
	 * host (not a local script via process.execPath), so `maestroPBinPath` is
	 * null. SSH-wrapping callers realize this with {@link buildRemoteInteractiveSpawn}:
	 * swap the remote command to `maestro-p`, prepend the interactive flags, and
	 * point MAESTRO_CLAUDE_BIN at the remote claude when a custom path is set.
	 */
	remote?: boolean;
}

/**
 * Decide the Claude token source for a spawn. Pure aside from reading the
 * cached usage snapshot and the filesystem existence check (both injectable).
 */
export function resolveClaudeSpawnMode(input: ResolveClaudeSpawnModeInput): ClaudeSpawnDecision {
	const d = { ...defaultDeps, ...(input.deps ?? {}) };
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
	// remote. `dynamic` is NOT offered for SSH agents (the AgentConfigPanel
	// selector hides it) because the auto-switch reads a LOCAL usage snapshot
	// that says nothing about the remote account's quota - there's no honest
	// signal to switch on. A `dynamic` value that reaches here anyway (e.g. a
	// local agent later flipped to SSH) falls back to `api` rather than silently
	// spending Max-plan quota the user never explicitly opted into.
	if (sshEnabled) {
		if (tokenMode === 'interactive') {
			// The remote must have maestro-p on its PATH to drive the TUI. If a probe
			// has already determined it is absent, fall back to API rather than
			// spawning `maestro-p` on the remote and exiting 127 on every turn - the
			// remote analogue of the local `fileExists` guard below. Unknown
			// (never probed) stays optimistic: a probe at the spawn/config surface
			// warms the cache, so a correctly-set-up remote is never downgraded.
			if (d.getRemoteMaestroPAvailable(input.sshRemoteId) === false) {
				logger.warn(
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
				// the remote; otherwise maestro-p defaults to `claude` on the remote PATH.
				claudeRealBinPath: sessionCustomPath || undefined,
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
		logger.warn(
			'maestro-p selected but no maestro-p binary found - falling back to API mode',
			LOG_CONTEXT,
			{ tokenMode, override: input.maestroPPath }
		);
		return { mode: 'api', reason: 'auto', maestroPBinPath: null };
	}

	const configDirKey = d.resolveConfigDirKey(envForKey);
	const claudeRealBinPath = sessionCustomPath || command;

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

export interface ApplyClaudeSpawnInput {
	decision: ClaudeSpawnDecision;
	/** agent.interactiveModeArgs - the maestro-p flag list (e.g. --dangerously-skip-permissions). */
	interactiveModeArgs?: string[];
	command: string;
	/**
	 * The fully-built batch arg list, INCLUDING the prompt as a trailing
	 * positional (e.g. `--print --verbose --output-format stream-json
	 * --dangerously-skip-permissions -- <prompt>`). maestro-p's arg parser
	 * strips the headless-only flags, forwards the rest to the claude TUI, and
	 * reads the prompt from after `--`, so the list is forwarded verbatim.
	 */
	args: string[];
	customEnvVars?: Record<string, string>;
	/** Defaults to process.execPath; injectable for tests. */
	execPath?: string;
	/**
	 * Overall idle budget for the maestro-p run, in seconds. Forwarded as
	 * `--max-wait`. Background callers (Cue, Auto Run) MUST pass this so the run
	 * honors their configured timeout instead of maestro-p's 300s default — the
	 * default silently killed long-running background turns. Omit to let
	 * maestro-p use its built-in default (fine for short interactive surfaces
	 * like tab naming that enforce their own outer process timeout).
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
 * spawn surface (group chat, Cue, tab naming) whose arg list already carries
 * the prompt as a positional. For the toggle-driven interactive path it runs
 * maestro-p via `process.execPath`, prepending the maestro-p script and its
 * interactive flags to the existing args (maestro-p strips the headless flags
 * and reads the prompt itself), and injects `MAESTRO_CLAUDE_BIN`. Every other
 * case (API, or direct-binary interactive where the command already launches
 * maestro-p) passes through unchanged.
 *
 * NOTE: the desktop `process:spawn` handler does NOT use this helper - it
 * rebuilds args and delivers the prompt over stdin (stream-json, for image
 * support), so it applies the decision inline.
 */
export function applyClaudeSpawnDecision(input: ApplyClaudeSpawnInput): ApplyClaudeSpawnResult {
	const { decision, interactiveModeArgs, command, args, customEnvVars } = input;

	if (decision.mode === 'interactive' && decision.maestroPBinPath) {
		const realBin = decision.claudeRealBinPath ?? command;
		const env: Record<string, string> = {
			...(customEnvVars ?? {}),
			MAESTRO_CLAUDE_BIN: realBin,
			// `process.execPath` is the Electron binary. Running it against a `.js`
			// script (maestro-p) without this flag does NOT execute the script as
			// Node: in dev the Electron binary happens to load it as an app entry
			// and it works, but a PACKAGED app ignores the script arg entirely and
			// just launches a second Maestro GUI - so maestro-p never runs, emits no
			// stream-json, and the caller (tab naming, synopsis, group chat) gets a
			// null result. This is the dev-works / packaged-fails discrepancy. Every
			// other execPath node-script spawn sets this (claude-usage-sampler.ts,
			// cue-cli-executor.ts, maestro-cli-manager.ts). buildChildProcessEnv
			// strips ELECTRON_RUN_AS_NODE from the inherited env, but applies
			// customEnvVars AFTER the strip, so setting it here survives.
			ELECTRON_RUN_AS_NODE: '1',
		};
		// Under ELECTRON_RUN_AS_NODE, maestro-p runs as pure Node and does
		// `require('node-pty')`, which esbuild left external. In a packaged app
		// maestro-p.js sits at the resources root, OUTSIDE the asar, so Node can't
		// find node-pty without help. Point NODE_PATH at the IN-ASAR node_modules
		// (`<resources>/app.asar/node_modules`), NOT the unpacked copy. node-pty's
		// JS loads from the asar (Electron's patched fs reads it; the native
		// `pty.node` is auto-redirected to app.asar.unpacked), and critically
		// node-pty computes its `spawn-helper` path by doing
		// `helperPath.replace('app.asar', 'app.asar.unpacked')`. If we hand it the
		// already-unpacked path, that replace double-applies to
		// `app.asar.unpacked.unpacked` and the helper exec fails with
		// "posix_spawn failed: No such file or directory" - verified against the
		// packaged build. Feeding the asar path lets node-pty rewrite it once,
		// correctly. In dev `resourcesPath` is empty and node-pty resolves from the
		// project tree, so this only fires when packaged.
		if (typeof process.resourcesPath === 'string' && process.resourcesPath.length > 0) {
			const asarModules = path.join(process.resourcesPath, 'app.asar', 'node_modules');
			const existing = env.NODE_PATH ?? process.env.NODE_PATH;
			env.NODE_PATH = existing ? `${asarModules}${path.delimiter}${existing}` : asarModules;
		}
		// `--max-wait` must precede the batch args because those end with the
		// `-- <prompt>` end-of-options marker; anything after `--` is read by
		// maestro-p's parser as the prompt positional, not a flag. Slotting it
		// right after the script keeps it inside the flag region.
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
 * Command name used to invoke maestro-p on a remote SSH host. The user must
 * have maestro-p installed and on PATH there (e.g. an npm-global install of the
 * Maestro CLI, which exposes a `maestro-p` bin). Unlike the local path it is a
 * bare command, not an absolute path: the SSH stdin script's login-shell PATH
 * setup resolves it the same way it resolves `claude` for the API path.
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
 * folds into its remote command: run `maestro-p` on the remote host (it strips
 * the headless-only flags, drives the remote claude TUI on the Max
 * subscription, and reads the prompt from the stdin passthrough), prepend the
 * interactive flags (and an optional `--max-wait` idle budget for background
 * surfaces), and point MAESTRO_CLAUDE_BIN at the remote claude binary when a
 * custom remote path is configured (otherwise maestro-p defaults to `claude`
 * on the remote PATH).
 *
 * Returns null when the decision is not remote-interactive (API, or local
 * interactive), so callers leave their SSH config untouched.
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
