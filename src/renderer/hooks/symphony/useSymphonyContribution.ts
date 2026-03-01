/**
 * useSymphonyContribution — extracted from App.tsx
 *
 * Handles creating a new session for a Symphony contribution:
 *   - Validates session uniqueness
 *   - Creates session with Symphony metadata
 *   - Detects git repo and fetches branches/tags
 *   - Registers active contribution in Symphony persistent state
 *   - Auto-starts batch run with contribution documents
 *
 * Reads from: sessionStore, settingsStore, modalStore, uiStore
 */

import { useCallback } from 'react';
import type { ToolType, Session, AITab, BatchRunConfig } from '../../types';
import type { SymphonyContributionData } from '../../components/SymphonyModal';
import { useSessionStore } from '../../stores/sessionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { getModalActions } from '../../stores/modalStore';
import { useUIStore } from '../../stores/uiStore';
import { generateId } from '../../utils/ids';
import { createTerminalTab } from '../../utils/terminalTabHelpers';
import { validateNewSession } from '../../utils/sessionValidation';
import { gitService } from '../../services/git';
import { notifyToast } from '../../stores/notificationStore';
import { DEFAULT_BATCH_PROMPT } from '../../components/BatchRunnerModal';

// ============================================================================
// Dependencies interface
// ============================================================================

export interface UseSymphonyContributionDeps {
	/** Start a batch run for a session */
	startBatchRun: (sessionId: string, config: BatchRunConfig, folderPath: string) => void;
	/** Ref to input element for focus */
	inputRef: React.RefObject<HTMLTextAreaElement | null>;
}

// ============================================================================
// Return type
// ============================================================================

export interface UseSymphonyContributionReturn {
	/** Handle starting a Symphony contribution (creates session, starts batch) */
	handleStartContribution: (data: SymphonyContributionData) => Promise<void>;
}

// ============================================================================
// Hook implementation
// ============================================================================

export function useSymphonyContribution(
	deps: UseSymphonyContributionDeps
): UseSymphonyContributionReturn {
	const { startBatchRun, inputRef } = deps;

	// --- Reactive subscriptions ---
	const sessions = useSessionStore((s) => s.sessions);

	// --- Store actions (stable via getState) ---
	const { setSessions, setActiveSessionId } = useSessionStore.getState();
	const { setSymphonyModalOpen } = getModalActions();
	const { setActiveFocus, setActiveRightTab } = useUIStore.getState();

	// --- Settings ---
	const defaultSaveToHistory = useSettingsStore((s) => s.defaultSaveToHistory);

	const handleStartContribution = useCallback(
		async (data: SymphonyContributionData) => {
			console.log('[Symphony] Creating session for contribution:', data);

			// Get agent definition
			const agent = await window.maestro.agents.get(data.agentType);
			if (!agent) {
				console.error(`Agent not found: ${data.agentType}`);
				notifyToast({
					type: 'error',
					title: 'Symphony Error',
					message: `Agent not found: ${data.agentType}`,
				});
				return;
			}

			// Validate uniqueness
			const validation = validateNewSession(
				data.sessionName,
				data.localPath,
				data.agentType as ToolType,
				sessions
			);
			if (!validation.valid) {
				console.error(`Session validation failed: ${validation.error}`);
				notifyToast({
					type: 'error',
					title: 'Agent Creation Failed',
					message: validation.error || 'Cannot create duplicate agent',
				});
				return;
			}

			const newId = generateId();
			const initialTabId = generateId();

			// Check git repo status
			const isGitRepo = await gitService.isRepo(data.localPath);
			let gitBranches: string[] | undefined;
			let gitTags: string[] | undefined;
			let gitRefsCacheTime: number | undefined;

			if (isGitRepo) {
				[gitBranches, gitTags] = await Promise.all([
					gitService.getBranches(data.localPath),
					gitService.getTags(data.localPath),
				]);
				gitRefsCacheTime = Date.now();
			}

			// Create initial tabs
			const initialTerminalTab = createTerminalTab(
				useSettingsStore.getState().defaultShell || 'zsh',
				data.localPath,
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
				saveToHistory: defaultSaveToHistory,
			};

			// Create session with Symphony metadata
			const newSession: Session = {
				id: newId,
				name: data.sessionName,
				toolType: data.agentType as ToolType,
				state: 'idle',
				cwd: data.localPath,
				fullPath: data.localPath,
				projectRoot: data.localPath,
				isGitRepo,
				gitBranches,
				gitTags,
				gitRefsCacheTime,
				aiLogs: [],
				shellLogs: [
					{
						id: generateId(),
						timestamp: Date.now(),
						source: 'system',
						text: 'Shell Session Ready.',
					},
				],
				workLog: [],
				contextUsage: 0,
				inputMode: 'ai',
				aiPid: 0,
				terminalPid: 0,
				port: 3000 + Math.floor(Math.random() * 100),
				isLive: false,
				changedFiles: [],
				fileTree: [],
				fileExplorerExpanded: [],
				fileExplorerScrollPos: 0,
				fileTreeAutoRefreshInterval: 180,
				shellCwd: data.localPath,
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
				// Custom agent config
				customPath: data.customPath,
				customArgs: data.customArgs,
				customEnvVars: data.customEnvVars,
				// Auto Run setup - use autoRunPath from contribution
				autoRunFolderPath: data.autoRunPath,
				// Symphony metadata for tracking
				symphonyMetadata: {
					isSymphonySession: true,
					contributionId: data.contributionId,
					repoSlug: data.repo.slug,
					issueNumber: data.issue.number,
					issueTitle: data.issue.title,
					documentPaths: data.issue.documentPaths.map((d) => d.path),
					status: 'running',
				},
			};

			setSessions((prev) => [...prev, newSession]);
			setActiveSessionId(newId);
			setSymphonyModalOpen(false);

			// Register active contribution in Symphony persistent state
			// This makes it show up in the Active tab of the Symphony modal
			window.maestro.symphony
				.registerActive({
					contributionId: data.contributionId,
					sessionId: newId,
					repoSlug: data.repo.slug,
					repoName: data.repo.name,
					issueNumber: data.issue.number,
					issueTitle: data.issue.title,
					localPath: data.localPath,
					branchName: data.branchName || '',
					totalDocuments: data.issue.documentPaths.length,
					agentType: data.agentType,
					draftPrNumber: data.draftPrNumber,
					draftPrUrl: data.draftPrUrl,
				})
				.catch((err: unknown) => {
					console.error('[Symphony] Failed to register active contribution:', err);
				});

			// Track stats
			window.maestro.stats.recordSessionCreated({
				sessionId: newId,
				agentType: data.agentType,
				projectPath: data.localPath,
				createdAt: Date.now(),
				isRemote: false,
			});

			// Focus input
			setActiveFocus('main');
			setTimeout(() => inputRef.current?.focus(), 50);

			// Switch to Auto Run tab so user sees the documents
			setActiveRightTab('autorun');

			// Auto-start batch run with all contribution documents
			if (data.autoRunPath && data.issue.documentPaths.length > 0) {
				const batchConfig: BatchRunConfig = {
					documents: data.issue.documentPaths.map((doc) => ({
						id: generateId(),
						filename: doc.name.replace(/\.md$/, ''),
						resetOnCompletion: false,
						isDuplicate: false,
					})),
					prompt: DEFAULT_BATCH_PROMPT,
					loopEnabled: false,
				};

				// Small delay to ensure session state is fully propagated
				setTimeout(() => {
					console.log(
						'[Symphony] Auto-starting batch run with',
						batchConfig.documents.length,
						'documents'
					);
					startBatchRun(newId, batchConfig, data.autoRunPath!);
				}, 500);
			}
		},
		[sessions, defaultSaveToHistory, startBatchRun]
	);

	return { handleStartContribution };
}
