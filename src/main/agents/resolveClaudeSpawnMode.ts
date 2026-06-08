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
	selectMode: defaultSelectMode,
};

export interface ResolveClaudeSpawnModeInput {
	/** Resolved agent definition (from the agent detector). */
	agent: ResolverAgent;
	/** Canonical token mode for this spawn (see getClaudeTokenMode). */
	tokenMode: ClaudeTokenMode;
	/** SSH-enabled spawns always stay on API - maestro-p needs the local TUI. */
	sshEnabled: boolean;
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

	// Non-Claude, or SSH (the TUI wrapper needs the local claude binary): API.
	if (!isClaudeCode || sshEnabled) {
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
		// renderStyle tagger that reads claudeInteractive.mode).
		if (d.isMaestroPBinaryPath(sessionCustomPath)) {
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
		return {
			command: input.execPath ?? process.execPath,
			args: [decision.maestroPBinPath, ...(interactiveModeArgs ?? []), ...args],
			customEnvVars: env,
		};
	}

	return { command, args, customEnvVars };
}
