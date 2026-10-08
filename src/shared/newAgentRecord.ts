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
import type { ThinkingMode } from './types';

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
