/**
 * Resolve Claude Spawn Mode (desktop entry)
 *
 * Thin desktop wrapper over the bundle-safe decision core in `claudeSpawnCore.ts`.
 * It supplies the native-backed default deps (electron-store maestro-p path
 * resolution, SQLite usage snapshot, remote-probe cache, desktop logger) and
 * preserves the historical `resolveClaudeSpawnMode(input)` signature every
 * desktop spawn surface already calls.
 *
 * The actual decision logic, the spawn realizers (`applyClaudeSpawnDecision`,
 * `buildRemoteInteractiveSpawn`), and all types now live in `claudeSpawnCore.ts`
 * so the standalone `maestro-cli` can share the exact same logic without pulling
 * the native/Electron dependency graph. See that file for the rationale.
 */

import * as fs from 'fs';
import type { AgentConfig } from './definitions';
import { selectMode as defaultSelectMode } from './claude-mode-selector';
import { getMaestroPBinPath as defaultGetMaestroPBinPath } from './claude-usage-startup';
import {
	getSnapshot as defaultGetUsageSnapshot,
	resolveConfigDirKey as defaultResolveConfigDirKey,
} from '../stores/claudeUsageStore';
import { getRemoteMaestroPAvailable as defaultGetRemoteMaestroPAvailable } from './remoteMaestroPCache';
import { logger } from '../utils/logger';
import type { ClaudeTokenMode } from '../../shared/claudeTokenMode';
import {
	resolveClaudeSpawnModeCore,
	isMaestroPBinaryPath,
	type ClaudeSpawnCoreDeps,
	type ClaudeSpawnDecision,
	type ResolveClaudeSpawnModeCoreInput,
} from './claudeSpawnCore';

// Re-export the shared realizers, constant, and types so existing desktop
// importers (`process.ts`, `tabNaming.ts`, `cue-spawn-builder.ts`,
// `spawnGroupChatAgent.ts`, tests, …) keep importing from here unchanged.
export {
	applyClaudeSpawnDecision,
	buildRemoteInteractiveSpawn,
	isMaestroPBinaryPath,
	REMOTE_MAESTRO_P_COMMAND,
} from './claudeSpawnCore';
export type {
	ClaudeSpawnDecision,
	ApplyClaudeSpawnInput,
	ApplyClaudeSpawnResult,
	RemoteInteractiveSpawn,
	ResolverAgent,
} from './claudeSpawnCore';

/** Injectable dependencies (defaulted to the real desktop implementations). */
export type ResolveClaudeSpawnModeDeps = ClaudeSpawnCoreDeps;

const defaultDeps: ClaudeSpawnCoreDeps = {
	getMaestroPBinPath: defaultGetMaestroPBinPath,
	isMaestroPBinaryPath,
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
	logger,
};

/** Minimal agent shape the resolver needs (desktop callers pass an AgentConfig). */
type ResolverAgentInput = Pick<
	AgentConfig,
	'id' | 'interactiveCommand' | 'interactiveModeArgs' | 'defaultEnvVars'
> | null;

export interface ResolveClaudeSpawnModeInput extends Omit<
	ResolveClaudeSpawnModeCoreInput,
	'agent'
> {
	/** Resolved agent definition (from the agent detector). */
	agent: ResolverAgentInput;
	/** Test seams. */
	deps?: Partial<ClaudeSpawnCoreDeps>;
}

/**
 * Desktop entry: resolve the Claude token source for a spawn using the shared
 * core with native-backed defaults. Partial `deps` still override individual
 * collaborators (used by tests).
 */
export function resolveClaudeSpawnMode(input: ResolveClaudeSpawnModeInput): ClaudeSpawnDecision {
	const { deps, ...coreInput } = input;
	return resolveClaudeSpawnModeCore(coreInput, { ...defaultDeps, ...(deps ?? {}) });
}

// Preserve the token-mode type re-export some callers relied on transitively.
export type { ClaudeTokenMode };
