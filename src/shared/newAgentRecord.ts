/**
 * The record a brand-new agent starts as: one idle AI tab and every empty
 * collection the desktop expects to find on a restored agent.
 *
 * Three callers build agents and must agree on this shape:
 *
 * - the New Agent flow (`createNewSession` in `useSessionCrud.ts`)
 * - the CLI / web `create_session` handler (`useAppRemoteEventListeners.ts`)
 * - the Cue bundle importer, which writes `maestro-sessions.json` with the
 *   desktop closed (`src/main/cue/bundle/cue-bundle-importer.ts`)
 *
 * The single AI tab is load-bearing. `restoreSession` treats an agent with no
 * tabs of any kind as corrupted data (`useSessionRestoration.ts`), and agent
 * records written off-desktop never pass through the renderer's own creation
 * path to get one.
 *
 * Caller-specific fields (git probe results, custom path/args/env/model, SSH,
 * resilience flags) are spread on top by each caller. Runtime-agnostic: no
 * renderer, main, or Electron imports, so the CLI can load it.
 */

import { PLAYBOOKS_DIR } from './maestro-paths';
import { isAdaptiveModeDefaultOn, resilienceEnabled } from './agentConstants';
import type { CodexTransport } from './codexTransport';
import type { HarnessControlMode } from './maestro-lib/providers/native-control';
import type { AdditionalDirectory, ThinkingMode } from './types';

export interface NewAgentRecordInput {
	id: string;
	name: string;
	toolType: string;
	/** Working directory; also the project root and the shell's starting directory. */
	cwd: string;
	/** Defaults to `<cwd>/.maestro/playbooks`, the desktop's default Auto Run folder. */
	autoRunFolderPath?: string;
	groupId?: string;
	/** Per-tab defaults from the user's settings (`defaultSaveToHistory`, `defaultShowThinking`). */
	saveToHistory?: boolean;
	showThinking?: ThinkingMode;
}

export interface NewAgentRecordDeps {
	/** Id source for the initial tab and the shell's first log line. */
	generateId: () => string;
	/** Epoch ms stamped as the creation time. Defaults to `Date.now()`. */
	now?: number;
}

/**
 * Build the skeleton of a new agent. The result is structurally a `Session`
 * (renderer) and a `StoredSession` (main) once the caller adds its own fields.
 */
export function buildNewAgentRecord(input: NewAgentRecordInput, deps: NewAgentRecordDeps) {
	const now = deps.now ?? Date.now();
	const initialTabId = deps.generateId();
	const initialTab = {
		id: initialTabId,
		agentSessionId: null,
		name: null,
		starred: false,
		logs: [] as never[],
		inputValue: '',
		stagedImages: [] as string[],
		createdAt: now,
		state: 'idle' as const,
		...(input.saveToHistory !== undefined && { saveToHistory: input.saveToHistory }),
		...(input.showThinking !== undefined && { showThinking: input.showThinking }),
	};
	return {
		id: input.id,
		name: input.name,
		toolType: input.toolType,
		state: 'idle' as const,
		cwd: input.cwd,
		fullPath: input.cwd,
		projectRoot: input.cwd,
		createdAt: now,
		aiLogs: [] as never[],
		shellLogs: [
			{
				id: deps.generateId(),
				timestamp: now,
				source: 'system' as const,
				text: 'Shell Session Ready.',
			},
		],
		workLog: [] as never[],
		contextUsage: 0,
		inputMode: input.toolType === 'terminal' ? ('terminal' as const) : ('ai' as const),
		aiPid: 0,
		terminalPid: 0,
		port: 3000 + Math.floor(Math.random() * 100),
		isLive: false,
		changedFiles: [] as never[],
		fileTree: [] as never[],
		fileExplorerExpanded: [] as string[],
		fileExplorerScrollPos: 0,
		fileTreeAutoRefreshInterval: 180,
		shellCwd: input.cwd,
		aiCommandHistory: [] as string[],
		shellCommandHistory: [] as string[],
		executionQueue: [] as never[],
		activeTimeMs: 0,
		aiTabs: [initialTab],
		activeTabId: initialTabId,
		closedTabHistory: [] as never[],
		filePreviewTabs: [] as never[],
		activeFileTabId: null,
		browserTabs: [] as never[],
		activeBrowserTabId: null,
		terminalTabs: [] as never[],
		activeTerminalTabId: null,
		unifiedTabOrder: [{ type: 'ai' as const, id: initialTabId }],
		unifiedClosedTabHistory: [] as never[],
		tabGroups: [] as never[],
		activeGroupId: null,
		groupId: input.groupId,
		autoRunFolderPath: input.autoRunFolderPath ?? `${input.cwd}/${PLAYBOOKS_DIR}`,
	};
}

export type NewAgentRecord = ReturnType<typeof buildNewAgentRecord>;

/**
 * How a new Claude Code agent starts out: API mode, chosen automatically.
 * Other providers have no interactive mode, so the field stays unset.
 */
export function newAgentClaudeInteractive(
	toolType: string
): { mode: 'api'; modeReason: 'auto' } | undefined {
	return toolType === 'claude-code' ? { mode: 'api', modeReason: 'auto' } : undefined;
}

/**
 * The persisted fields a duplicate reads from its source agent. Both the
 * renderer's `Session` and the CLI's `SessionInfo` satisfy it.
 */
export interface DuplicateAgentSource {
	name: string;
	toolType: string;
	cwd: string;
	groupId?: string;
	isPianola?: boolean;
	additionalDirectories?: AdditionalDirectory[];
	nudgeMessage?: string;
	newSessionMessage?: string;
	customPath?: string;
	customArgs?: string;
	customEnvVars?: Record<string, string>;
	customModel?: string;
	customContextWindow?: number;
	customProviderPath?: string;
	customEffort?: string;
	enableMaestroP?: boolean;
	maestroPMode?: 'interactive' | 'dynamic';
	maestroPPath?: string;
	retryOnAvailabilityErrors?: boolean;
	retryOnTokenExhaustion?: boolean;
	codexAutoResetOnExhaustion?: boolean;
	codexTransport?: CodexTransport;
	harnessControlMode?: HarnessControlMode;
	sessionSshRemoteConfig?: {
		enabled?: boolean;
		remoteId?: string | null;
		workingDirOverride?: string;
	};
}

/** What the caller may change about a duplicate. Absent means "inherit". */
export interface DuplicateAgentOverrides {
	name?: string;
	/** A group id, or `null` for ungrouped. */
	groupId?: string | null;
	/** The working directory. For an SSH source this is a REMOTE path. */
	cwd?: string;
}

/**
 * Everything the create path takes for a duplicate: the arguments of
 * `createNewSession()` and the `create_session` config, resolved exactly as an
 * untouched New Agent modal submit resolves them.
 */
export interface DuplicateAgentInput {
	toolType: string;
	name: string;
	/** Working directory. For an SSH agent this is the remote directory it runs in. */
	cwd: string;
	groupId?: string;
	additionalDirectories: AdditionalDirectory[];
	nudgeMessage?: string;
	newSessionMessage?: string;
	customPath?: string;
	customArgs?: string;
	customEnvVars?: Record<string, string>;
	customModel?: string;
	customContextWindow?: number;
	customProviderPath?: string;
	customEffort?: string;
	enableMaestroP?: boolean;
	maestroPMode?: 'interactive' | 'dynamic';
	maestroPPath?: string;
	retryOnAvailabilityErrors: boolean;
	retryOnTokenExhaustion: boolean;
	codexAutoResetOnExhaustion: boolean;
	codexTransport: CodexTransport;
	harnessControlMode?: HarnessControlMode;
	sessionSshRemoteConfig:
		| { enabled: true; remoteId: string; workingDirOverride?: string }
		| { enabled: false; remoteId: null };
}

/** The name a duplicate starts with. */
export function defaultDuplicateAgentName(sourceName: string): string {
	return `${sourceName} (Copy)`;
}

/**
 * Why an agent cannot be duplicated, or null when it can. The Left Bar hides
 * Duplicate... for these and `duplicate-agent` refuses them.
 */
export function duplicateAgentBlocker(
	source: Pick<DuplicateAgentSource, 'isPianola'>
): string | null {
	return source.isPianola
		? 'The Pianola manager cannot be duplicated: there is only ever one.'
		: null;
}

function trimmedOrUndefined(value: string | undefined): string | undefined {
	return value?.trim() || undefined;
}

/**
 * What a duplicate inherits from its source agent: the New Agent modal's
 * prefill AND `maestro-cli duplicate-agent` both come from here. Full rule
 * table: `docs/agent-guides/CANONICAL-UTILITIES.md`.
 */
export function buildDuplicateAgentInput(
	source: DuplicateAgentSource,
	overrides: DuplicateAgentOverrides = {}
): DuplicateAgentInput {
	const ssh = source.sessionSshRemoteConfig;
	const sshRemoteId = ssh?.enabled && ssh.remoteId ? ssh.remoteId : null;
	// An SSH agent runs in its override (a CLI-created agent keeps a local
	// placeholder in `cwd`), so that is the directory the copy starts from.
	const cwd = (overrides.cwd ?? ((ssh?.enabled && ssh.workingDirOverride) || source.cwd)).trim();
	// The explicit choice is carried, including an explicit `false`. Unset
	// falls through to the same default a fresh agent gets.
	const enableMaestroP =
		source.enableMaestroP ?? (isAdaptiveModeDefaultOn(source.toolType) || undefined);
	const groupId = overrides.groupId === undefined ? source.groupId : overrides.groupId;
	const customEnvVars =
		source.customEnvVars && Object.keys(source.customEnvVars).length > 0
			? { ...source.customEnvVars }
			: undefined;

	return {
		toolType: source.toolType,
		name: (overrides.name ?? defaultDuplicateAgentName(source.name)).trim(),
		cwd,
		groupId: groupId || undefined,
		// Cloned, never aliased: the modal edits rows in place.
		additionalDirectories: (source.additionalDirectories ?? []).map((d) => ({ ...d })),
		nudgeMessage: trimmedOrUndefined(source.nudgeMessage),
		newSessionMessage: trimmedOrUndefined(source.newSessionMessage),
		customPath: trimmedOrUndefined(source.customPath),
		customArgs: trimmedOrUndefined(source.customArgs),
		customEnvVars,
		customModel: trimmedOrUndefined(source.customModel),
		customContextWindow: source.customContextWindow || undefined,
		customProviderPath: trimmedOrUndefined(source.customProviderPath),
		customEffort: trimmedOrUndefined(source.customEffort),
		enableMaestroP,
		// The token-source refinement only travels with the opt-in.
		maestroPMode: enableMaestroP ? (source.maestroPMode ?? 'dynamic') : undefined,
		maestroPPath: enableMaestroP ? trimmedOrUndefined(source.maestroPPath) : undefined,
		retryOnAvailabilityErrors: resilienceEnabled(source.retryOnAvailabilityErrors),
		retryOnTokenExhaustion: resilienceEnabled(source.retryOnTokenExhaustion),
		// A copy must not start spending reset credits the original never did.
		codexAutoResetOnExhaustion: source.codexAutoResetOnExhaustion === true,
		codexTransport: source.codexTransport === 'app-server' ? 'app-server' : 'exec',
		...(source.harnessControlMode === 'native' ? { harnessControlMode: 'native' as const } : {}),
		// The override is always the copy's own directory, never the source's
		// stored one: carrying that pinned the copy's terminals, git and file
		// tree to the OLD remote directory. History-sync flags are not carried.
		sessionSshRemoteConfig: sshRemoteId
			? { enabled: true, remoteId: sshRemoteId, workingDirOverride: cwd || undefined }
			: { enabled: false, remoteId: null },
	};
}
