/**
 * Shared worktree session builder.
 *
 * Extracted from useWorktreeHandlers to allow reuse by useAutoRunHandlers
 * when spawning a worktree agent for Auto Run dispatch.
 */

import type { Session, AITab, ThinkingMode } from '../types';
import { generateId } from './ids';
import { createTerminalTab } from './terminalTabHelpers';
import { useSettingsStore } from '../stores/settingsStore';

/**
 * Parameters for building a worktree Session object.
 *
 * Two modes determined by the presence of `worktreeParentPath`:
 * - New model: sets `parentSessionId`, `worktreeBranch`, `customContextWindow`,
 *   `nudgeMessage`, `autoRunFolderPath`. Shell log says "Worktree Session Ready."
 *   `inputMode` derived from `toolType`.
 * - Legacy model: sets `worktreeParentPath` (no `parentSessionId`). Shell log says
 *   "Shell Session Ready." `inputMode` copied directly from parent. Does NOT set
 *   `customContextWindow`, `nudgeMessage`, `autoRunFolderPath`.
 */
export interface BuildWorktreeSessionParams {
	parentSession: Session;
	path: string;
	branch?: string | null;
	name: string;
	gitBranches?: string[];
	gitTags?: string[];
	gitRefsCacheTime?: number;
	defaultSaveToHistory: boolean;
	defaultShowThinking: ThinkingMode;
	/** Legacy worktreeParentPath to inherit — presence triggers legacy mode. */
	worktreeParentPath?: string;
}

export function buildWorktreeSession(params: BuildWorktreeSessionParams): Session {
	const newId = generateId();
	const initialTabId = generateId();
	const isLegacy = !!params.worktreeParentPath;
	const initialTerminalTab = createTerminalTab(
		useSettingsStore.getState().defaultShell || 'zsh',
		params.path,
		null
	);

	const initialTab: AITab = {
		id: initialTabId,
		agentSessionId: null,
		name: null,
		starred: false,
		logs: [],
		inputValue: '',
		stagedImages: [],
		createdAt: Date.now(),
		state: 'idle',
		saveToHistory: params.defaultSaveToHistory,
		showThinking: params.defaultShowThinking,
	};

	return {
		id: newId,
		name: params.name,
		groupId: params.parentSession.groupId,
		toolType: params.parentSession.toolType,
		state: 'idle',
		cwd: params.path,
		fullPath: params.path,
		projectRoot: params.path,
		isGitRepo: true,
		gitBranches: params.gitBranches,
		gitTags: params.gitTags,
		gitRefsCacheTime: params.gitRefsCacheTime,
		// New model: link to parent via parentSessionId
		// Legacy model: no parentSessionId (uses worktreeParentPath instead)
		parentSessionId: isLegacy ? undefined : params.parentSession.id,
		worktreeBranch: isLegacy ? undefined : params.branch || undefined,
		worktreeParentPath: params.worktreeParentPath,
		// Inherit SSH configuration from parent session
		sessionSshRemoteConfig: params.parentSession.sessionSshRemoteConfig,
		aiLogs: [],
		shellLogs: [
			{
				id: generateId(),
				timestamp: Date.now(),
				source: 'system',
				text: isLegacy ? 'Shell Session Ready.' : 'Worktree Session Ready.',
			},
		],
		workLog: [],
		contextUsage: 0,
		// Legacy: inherits inputMode directly from parent
		// New model: derives from toolType
		inputMode: isLegacy
			? params.parentSession.inputMode
			: params.parentSession.toolType === 'terminal'
				? 'terminal'
				: 'ai',
		aiPid: 0,
		terminalPid: 0,
		port: 3000 + Math.floor(Math.random() * 100),
		isLive: false,
		changedFiles: [],
		fileTree: [],
		fileExplorerExpanded: [],
		fileExplorerScrollPos: 0,
		fileTreeAutoRefreshInterval: 180,
		shellCwd: params.path,
		aiCommandHistory: [],
		shellCommandHistory: [],
		executionQueue: [],
		activeTimeMs: 0,
		aiTabs: [initialTab],
		activeTabId: initialTabId,
		closedTabHistory: [],
		filePreviewTabs: [],
		activeFileTabId: null,
		terminalTabs: [initialTerminalTab],
		activeTerminalTabId: null,
		unifiedTabOrder: [
			{ type: 'ai' as const, id: initialTabId },
			{ type: 'terminal' as const, id: initialTerminalTab.id },
		],
		unifiedClosedTabHistory: [],
		customPath: params.parentSession.customPath,
		customArgs: params.parentSession.customArgs,
		customEnvVars: params.parentSession.customEnvVars,
		customModel: params.parentSession.customModel,
		// New model inherits these; legacy does not
		customContextWindow: isLegacy ? undefined : params.parentSession.customContextWindow,
		nudgeMessage: isLegacy ? undefined : params.parentSession.nudgeMessage,
		autoRunFolderPath: isLegacy ? undefined : params.parentSession.autoRunFolderPath,
	} as Session;
}
