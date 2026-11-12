import { useEffect, useRef } from 'react';
import type { AITab, EncoreFeatureFlags, Session } from '../../types';
import { useSessionStore } from '../../stores/sessionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { generateId } from '../../utils/ids';
import { getHomeDirAsync } from '../../utils/homeDir';
import { PLAYBOOKS_DIR } from '../../../shared/maestro-paths';
import { captureException } from '../../utils/sentry';
import { logger } from '../../utils/logger';

/**
 * usePianolaAgent - ensures the single pinned Pianola manager agent exists.
 *
 * Pianola is a real claude-code-backed agent (a Session with isPianola: true)
 * so the user can click it and chat through the existing agent chat system.
 * It is rendered at the very top of the Left Bar and is excluded from the
 * normal session categories (Bookmarks / Groups / Ungrouped).
 *
 * Behavior:
 * - Runs only after sessions have hydrated from disk (gated on sessionsLoaded)
 *   so it cannot race the load and create duplicates.
 * - Creates exactly one Pianola agent when the `pianola` Encore flag is ON and
 *   none exists yet. Never auto-creates while the flag is OFF.
 * - Does NOT call setActiveSessionId: creating Pianola on startup must not
 *   steal focus from the user's active agent.
 * - Guards against double creation with both a useRef "already ensured" flag
 *   and a `prev.some(s => s.isPianola)` check inside the setSessions updater.
 *
 * The Pianola Session mirrors the shape built by createNewSession
 * (useSessionCrud) so it is a valid, fully-formed claude-code agent.
 */
export function usePianolaAgent(encoreFeatures: EncoreFeatureFlags): void {
	const sessionsLoaded = useSessionStore((s) => s.sessionsLoaded);
	const ensuredRef = useRef(false);

	useEffect(() => {
		// Wait until sessions are hydrated from disk; otherwise we would race the
		// load and append a duplicate Pianola before the persisted one arrives.
		if (!sessionsLoaded) return;
		// Only ever auto-create while the flag is ON. When OFF, Pianola persists in
		// storage (if previously created) but stays hidden and is not created.
		if (!encoreFeatures.pianola) return;
		// Run once per session lifetime.
		if (ensuredRef.current) return;

		// Bail early if a Pianola agent already exists (covers the persisted case).
		if (useSessionStore.getState().sessions.some((s) => s.isPianola)) {
			ensuredRef.current = true;
			return;
		}

		ensuredRef.current = true;

		// Resolve the default working directory the same way the rest of the
		// renderer does (home dir via IPC), then create the agent. Fall back to a
		// tilde path which the main process expands if the IPC lookup fails.
		const resolveWorkingDir = getHomeDirAsync() ?? Promise.resolve('~');

		void resolveWorkingDir
			.catch(() => '~')
			.then((workingDir) => {
				const { setSessions } = useSessionStore.getState();
				setSessions((prev) => {
					// Re-check inside the updater so two near-simultaneous runs cannot
					// both append a Pianola agent.
					if (prev.some((s) => s.isPianola)) return prev;

					const currentDefaults = useSettingsStore.getState();
					const newId = generateId();
					const initialTabId = generateId();
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
						saveToHistory: currentDefaults.defaultSaveToHistory,
						showThinking: currentDefaults.defaultShowThinking,
					};

					const pianolaSession: Session = {
						id: newId,
						name: 'Pianola',
						toolType: 'claude-code',
						state: 'idle',
						cwd: workingDir,
						fullPath: workingDir,
						projectRoot: workingDir,
						createdAt: Date.now(),
						isGitRepo: false,
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
						shellCwd: workingDir,
						aiCommandHistory: [],
						shellCommandHistory: [],
						executionQueue: [],
						activeTimeMs: 0,
						aiTabs: [initialTab],
						activeTabId: initialTabId,
						closedTabHistory: [],
						filePreviewTabs: [],
						activeFileTabId: null,
						browserTabs: [],
						activeBrowserTabId: null,
						terminalTabs: [],
						activeTerminalTabId: null,
						unifiedTabOrder: [{ type: 'ai' as const, id: initialTabId }],
						unifiedClosedTabHistory: [],
						tabGroups: [],
						activeGroupId: null,
						autoRunFolderPath: `${workingDir}/${PLAYBOOKS_DIR}`,
						claudeInteractive: { mode: 'api', modeReason: 'auto' },
						isPianola: true,
					};

					return [...prev, pianolaSession];
				});
			})
			.catch((error) => {
				// Allow a retry on the next render if creation failed unexpectedly.
				ensuredRef.current = false;
				if (error instanceof Error) {
					logger.error('Failed to ensure Pianola agent:', undefined, error);
				}
				void captureException(error, { tags: { feature: 'pianola' } });
			});
	}, [sessionsLoaded, encoreFeatures.pianola]);
}
