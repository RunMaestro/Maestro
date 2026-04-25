/**
 * useAppRemoteEventListeners.ts
 *
 * Extracted from App.tsx - handles all CustomEvent-based remote event listeners
 * dispatched by useRemoteIntegration (maestro:openFileTab, maestro:remoteCreateSession, etc.).
 *
 * These listeners bridge remote/web/CLI commands to the renderer's state and actions.
 */

import React from 'react';
import { useEventListener } from '../utils/useEventListener';
import { generateId } from '../../utils/ids';
import { useSessionStore } from '../../stores/sessionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { PLAYBOOKS_DIR } from '../../../shared/maestro-paths';
import { getBrowserTabPartition } from '../../utils/browserTabPersistence';
import { ensureInUnifiedTabOrder } from '../../utils/tabHelpers';
import {
	createTerminalTab as createTerminalTabHelper,
	addTerminalTab as addTerminalTabHelper,
} from '../../utils/terminalTabHelpers';
import type { Session, AITab, ToolType, Group, BatchRunConfig, BrowserTab } from '../../types';
import { logger } from '../../utils/logger';

// ============================================================================
// Dependencies interface
// ============================================================================

export interface UseAppRemoteEventListenersDeps {
	/** Ref-like getter for current sessions array */
	sessionsRef: React.MutableRefObject<Session[]>;
	/** Switch active session (wrapper that also dismisses group chat) */
	setActiveSessionId: (id: string) => void;
	/** Update sessions array in store */
	setSessions: (sessions: Session[] | ((prev: Session[]) => Session[])) => void;
	/** Update groups array in store */
	setGroups: (groups: Group[] | ((prev: Group[]) => Group[])) => void;
	/** Open a file in a preview tab */
	handleOpenFileTab: (
		file: {
			path: string;
			name: string;
			content: string;
			sshRemoteId?: string;
			lastModified?: number;
		},
		options?: { targetSessionId?: string }
	) => void;
	/** Refresh the file tree for a session */
	refreshFileTree: (sessionId: string) => void;
	/** Refresh the Auto Run document list for the active session */
	handleAutoRunRefresh: () => void;
	/** Start a batch (Auto Run) for a session */
	startBatchRun: (sessionId: string, config: BatchRunConfig, folderPath: string) => Promise<void>;
	/** Stop a batch run directly (no confirmation dialog) */
	stopBatchRun: (sessionId: string) => void;
}

// ============================================================================
// Hook
// ============================================================================

export function useAppRemoteEventListeners(deps: UseAppRemoteEventListenersDeps): void {
	const {
		sessionsRef,
		setActiveSessionId,
		setSessions,
		setGroups,
		handleOpenFileTab,
		refreshFileTree,
		handleAutoRunRefresh,
		startBatchRun,
		stopBatchRun,
	} = deps;

	// --- File Operations ---

	// Handle remote open file tab events from CLI/web interface
	useEventListener('maestro:openFileTab', async (e: Event) => {
		const { sessionId, filePath } = (e as CustomEvent).detail;
		const session = sessionsRef.current.find((s) => s.id === sessionId);
		if (!session) {
			logger.error('[Remote] Session not found for openFileTab:', undefined, sessionId);
			return;
		}
		const sshRemoteId =
			session.sshRemoteId || session.sessionSshRemoteConfig?.remoteId || undefined;
		// Switch to the target session
		setActiveSessionId(sessionId);
		try {
			const [content, stat] = await Promise.all([
				window.maestro.fs.readFile(filePath, sshRemoteId),
				window.maestro.fs.stat(filePath, sshRemoteId).catch(() => null),
			]);
			if (content !== null) {
				const filename = filePath.split(/[\\/]/).pop() || filePath;
				const lastModified = stat?.modifiedAt ? new Date(stat.modifiedAt).getTime() : undefined;
				handleOpenFileTab(
					{
						path: filePath,
						name: filename,
						content,
						lastModified,
						sshRemoteId,
					},
					{ targetSessionId: sessionId }
				);
			}
		} catch (error) {
			logger.error('[Remote] Failed to open file tab:', undefined, error);
		}
	});

	// Handle remote refresh file tree events from CLI/web interface
	useEventListener('maestro:refreshFileTree', (e: Event) => {
		const { sessionId } = (e as CustomEvent).detail;
		refreshFileTree(sessionId);
	});

	// Handle remote open browser tab events from CLI/web interface.
	// Acks success to responseChannel so the CLI only reports success after
	// the tab is actually created.
	useEventListener('maestro:openBrowserTab', (e: Event) => {
		const { sessionId, url, responseChannel } = (e as CustomEvent).detail as {
			sessionId: string;
			url: string;
			responseChannel?: string;
		};
		const ack = (success: boolean) => {
			if (responseChannel) {
				window.maestro.process.sendRemoteOpenBrowserTabResponse(responseChannel, success);
			}
		};
		const session = sessionsRef.current.find((s) => s.id === sessionId);
		if (!session) {
			logger.error('[Remote] Session not found for openBrowserTab:', undefined, sessionId);
			ack(false);
			return;
		}
		setActiveSessionId(sessionId);
		const newBrowserTab: BrowserTab = {
			id: generateId(),
			url,
			title: url,
			createdAt: Date.now(),
			partition: getBrowserTabPartition(sessionId),
			canGoBack: false,
			canGoForward: false,
			isLoading: true,
			favicon: null,
		};
		setSessions((prev) =>
			prev.map((s) => {
				if (s.id !== sessionId) return s;
				return {
					...s,
					browserTabs: [...(s.browserTabs || []), newBrowserTab],
					activeFileTabId: null,
					activeBrowserTabId: newBrowserTab.id,
					activeTerminalTabId: null,
					inputMode: 'ai' as const,
					unifiedTabOrder: ensureInUnifiedTabOrder(
						s.unifiedTabOrder || [],
						'browser',
						newBrowserTab.id
					),
				};
			})
		);
		ack(true);
	});

	// Handle remote open terminal tab events from CLI/web interface.
	// Acks success to responseChannel so the CLI only reports success after
	// the tab is actually created.
	useEventListener('maestro:openTerminalTab', (e: Event) => {
		const { sessionId, config, responseChannel } = (e as CustomEvent).detail as {
			sessionId: string;
			config: { cwd?: string; shell?: string; name?: string | null };
			responseChannel?: string;
		};
		const ack = (success: boolean) => {
			if (responseChannel) {
				window.maestro.process.sendRemoteOpenTerminalTabResponse(responseChannel, success);
			}
		};
		const session = sessionsRef.current.find((s) => s.id === sessionId);
		if (!session) {
			logger.error('[Remote] Session not found for openTerminalTab:', undefined, sessionId);
			ack(false);
			return;
		}
		setActiveSessionId(sessionId);
		const tab = createTerminalTabHelper(
			config?.shell,
			config?.cwd ?? session.cwd,
			config?.name ?? null
		);
		setSessions((prev) =>
			prev.map((s) => {
				if (s.id !== sessionId) return s;
				const updated = addTerminalTabHelper(s, tab);
				return { ...updated, inputMode: 'terminal' as const };
			})
		);
		ack(true);
	});

	// --- Auto Run Operations ---

	// Handle remote refresh auto-run docs events from CLI/web interface
	useEventListener('maestro:refreshAutoRunDocs', (e: Event) => {
		const { sessionId } = (e as CustomEvent).detail;
		const currentActiveId = useSessionStore.getState().activeSessionId;
		if (sessionId === currentActiveId) {
			// Already the active session - refresh immediately
			handleAutoRunRefresh();
		} else {
			// Switch to the target session - the autoRunFolderPath useEffect
			// will trigger handleAutoRunRefresh for the newly active session
			setActiveSessionId(sessionId);
		}
	});

	// Handle remote configure auto-run events from CLI/web interface
	useEventListener('maestro:configureAutoRun', async (e: Event) => {
		const { sessionId, config, responseChannel } = (e as CustomEvent).detail;

		try {
			// Find the target session
			const session = sessionsRef.current.find((s) => s.id === sessionId);
			if (!session) {
				window.maestro.process.sendRemoteConfigureAutoRunResponse(responseChannel, {
					success: false,
					error: `Session ${sessionId} not found`,
				});
				return;
			}

			// Case 1: Save as playbook
			if (config.saveAsPlaybook) {
				const result = await window.maestro.playbooks.create(sessionId, {
					name: config.saveAsPlaybook,
					documents: config.documents || [],
					loopEnabled: config.loopEnabled || false,
					maxLoops: config.maxLoops,
					prompt: config.prompt || '',
				});
				window.maestro.process.sendRemoteConfigureAutoRunResponse(responseChannel, {
					success: result.success,
					playbookId: result.playbook?.id,
					error: result.error,
				});
				return;
			}

			// Case 2: Launch auto-run immediately
			if (config.launch) {
				const folderPath = session.autoRunFolderPath;
				if (!folderPath) {
					window.maestro.process.sendRemoteConfigureAutoRunResponse(responseChannel, {
						success: false,
						error: 'No Auto Run folder configured for this session',
					});
					return;
				}

				const documents = (config.documents || []).map(
					(doc: { filename: string; resetOnCompletion?: boolean }) => {
						// Compute path relative to the session's autoRunFolderPath.
						// CLI sends full absolute paths (e.g., "/path/to/Auto Run Docs/subdir/temp.md")
						// but the batch processor expects the path relative to folderPath without .md
						// (e.g., "subdir/temp").
						let name = doc.filename.replace(/\.md$/i, '');
						// Normalize separators to forward slash for comparison
						const normalized = name.replace(/\\/g, '/');
						const normalizedFolder = (folderPath || '').replace(/\\/g, '/');
						// Case-insensitive prefix check for cross-platform compatibility (Windows drive letters)
						const normalizedLower = normalized.toLowerCase();
						const folderLower = normalizedFolder.toLowerCase();
						if (normalizedFolder && normalizedLower.startsWith(folderLower + '/')) {
							name = normalized.substring(normalizedFolder.length + 1);
						} else {
							// Fallback for paths not under folderPath: use basename only
							const lastSlash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
							if (lastSlash >= 0) name = name.substring(lastSlash + 1);
						}
						return {
							id: generateId(),
							filename: name,
							resetOnCompletion: doc.resetOnCompletion || false,
							isDuplicate: false,
						};
					}
				);

				if (documents.length === 0) {
					window.maestro.process.sendRemoteConfigureAutoRunResponse(responseChannel, {
						success: false,
						error: 'No documents provided for auto-run',
					});
					return;
				}

				// Forward worktree configuration when the CLI requests it.
				// startBatchRun handles worktree setup, branch checkout, and (optionally)
				// PR creation on completion via the existing git IPC handlers.
				const worktree: BatchRunConfig['worktree'] | undefined =
					config.worktree && config.worktree.enabled
						? {
								enabled: true,
								path: config.worktree.path,
								branchName: config.worktree.branchName,
								createPROnCompletion: Boolean(config.worktree.createPROnCompletion),
								prTargetBranch: config.worktree.prTargetBranch || '',
							}
						: undefined;

				const batchConfig: BatchRunConfig = {
					documents,
					prompt: config.prompt || '',
					loopEnabled: config.loopEnabled || false,
					maxLoops: config.maxLoops,
					...(worktree ? { worktree } : {}),
				};

				// Send success response immediately - startBatchRun is long-running
				// and would exceed the IPC/CLI timeout if awaited.
				window.maestro.process.sendRemoteConfigureAutoRunResponse(responseChannel, {
					success: true,
				});
				startBatchRun(sessionId, batchConfig, folderPath).catch((err) => {
					logger.error('[Remote] Failed to start auto-run:', undefined, err);
				});
				return;
			}

			// Case 3: Just configure (no launch, no save)
			// Without --launch or --save-as, there is no persistent state to update.
			// Return an error guiding the user to use one of those flags.
			window.maestro.process.sendRemoteConfigureAutoRunResponse(responseChannel, {
				success: false,
				error: 'Use --launch to start auto-run immediately, or --save-as to save as a playbook',
			});
		} catch (error) {
			logger.error('[Remote] Failed to configure auto-run:', undefined, error);
			window.maestro.process.sendRemoteConfigureAutoRunResponse(responseChannel, {
				success: false,
				error: String(error),
			});
		}
	});

	// Handle remote get auto-run docs from web interface
	useEventListener('maestro:getAutoRunDocs', async (e: Event) => {
		const { sessionId, responseChannel } = (e as CustomEvent).detail;
		try {
			const session = sessionsRef.current.find((s) => s.id === sessionId);
			if (!session?.autoRunFolderPath) {
				window.maestro.process.sendRemoteGetAutoRunDocsResponse(responseChannel, []);
				return;
			}
			const sshRemoteId =
				session.sshRemoteId || session.sessionSshRemoteConfig?.remoteId || undefined;
			const listResult = await window.maestro.autorun.listDocs(
				session.autoRunFolderPath,
				sshRemoteId
			);
			const filePaths: string[] = listResult.success ? listResult.files || [] : [];

			// Transform file paths into AutoRunDocument objects with task counts
			const docs = await Promise.all(
				filePaths.map(async (filePath) => {
					const filename = filePath.split('/').pop() || filePath;
					let taskCount = 0;
					let completedCount = 0;
					try {
						const result = await window.maestro.autorun.readDoc(
							session.autoRunFolderPath!,
							filePath,
							sshRemoteId
						);
						if (result?.content) {
							const unchecked = result.content.match(/^[\s]*-\s*\[\s*\]\s*.+$/gm);
							const checked = result.content.match(/^[\s]*-\s*\[x\]\s*.+$/gim);
							taskCount = (unchecked?.length || 0) + (checked?.length || 0);
							completedCount = checked?.length || 0;
						}
					} catch {
						// If reading fails, leave counts at 0
					}
					return { filename, path: filePath, taskCount, completedCount };
				})
			);
			window.maestro.process.sendRemoteGetAutoRunDocsResponse(responseChannel, docs);
		} catch (error) {
			logger.error('[Remote] Failed to get auto-run docs:', undefined, error);
			window.maestro.process.sendRemoteGetAutoRunDocsResponse(responseChannel, []);
		}
	});

	// Handle remote get auto-run doc content from web interface
	useEventListener('maestro:getAutoRunDocContent', async (e: Event) => {
		const { sessionId, filename, responseChannel } = (e as CustomEvent).detail;
		try {
			const session = sessionsRef.current.find((s) => s.id === sessionId);
			if (!session?.autoRunFolderPath) {
				window.maestro.process.sendRemoteGetAutoRunDocContentResponse(responseChannel, '');
				return;
			}
			const sshRemoteId =
				session.sshRemoteId || session.sessionSshRemoteConfig?.remoteId || undefined;
			const contentResult = await window.maestro.autorun.readDoc(
				session.autoRunFolderPath,
				filename,
				sshRemoteId
			);
			const content = contentResult.success ? contentResult.content || '' : '';
			window.maestro.process.sendRemoteGetAutoRunDocContentResponse(responseChannel, content);
		} catch (error) {
			logger.error('[Remote] Failed to get auto-run doc content:', undefined, error);
			window.maestro.process.sendRemoteGetAutoRunDocContentResponse(responseChannel, '');
		}
	});

	// Handle remote save auto-run doc from web interface
	useEventListener('maestro:saveAutoRunDoc', async (e: Event) => {
		const { sessionId, filename, content, responseChannel } = (e as CustomEvent).detail;
		try {
			const session = sessionsRef.current.find((s) => s.id === sessionId);
			if (!session?.autoRunFolderPath) {
				window.maestro.process.sendRemoteSaveAutoRunDocResponse(responseChannel, false);
				return;
			}
			const sshRemoteId =
				session.sshRemoteId || session.sessionSshRemoteConfig?.remoteId || undefined;
			const writeResult = await window.maestro.autorun.writeDoc(
				session.autoRunFolderPath,
				filename,
				content,
				sshRemoteId
			);
			window.maestro.process.sendRemoteSaveAutoRunDocResponse(
				responseChannel,
				writeResult.success ?? false
			);
		} catch (error) {
			logger.error('[Remote] Failed to save auto-run doc:', undefined, error);
			window.maestro.process.sendRemoteSaveAutoRunDocResponse(responseChannel, false);
		}
	});

	// Handle remote stop auto-run from web interface (fire-and-forget, no confirmation dialog)
	useEventListener('maestro:stopAutoRun', (e: Event) => {
		const { sessionId } = (e as CustomEvent).detail;
		stopBatchRun(sessionId);
	});

	// --- Session CRUD ---

	// Handle remote create session from web interface
	useEventListener('maestro:remoteCreateSession', async (e: Event) => {
		const { name, toolType, cwd, groupId, config, responseChannel } = (e as CustomEvent).detail;
		try {
			// Get agent definition to validate
			const agent = await (window as any).maestro.agents.get(toolType);
			if (!agent) {
				window.maestro.process.sendRemoteCreateSessionResponse(responseChannel, null);
				return;
			}

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

			const newSession: Session = {
				id: newId,
				name,
				toolType: toolType as ToolType,
				state: 'idle',
				createdAt: Date.now(),
				cwd,
				fullPath: cwd,
				projectRoot: cwd,
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
				inputMode: toolType === 'terminal' ? 'terminal' : 'ai',
				aiPid: 0,
				terminalPid: 0,
				port: 3000 + Math.floor(Math.random() * 100),
				isLive: false,
				changedFiles: [],
				fileTree: [],
				fileExplorerExpanded: [],
				fileExplorerScrollPos: 0,
				fileTreeAutoRefreshInterval: 180,
				shellCwd: cwd,
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
				groupId: groupId || undefined,
				autoRunFolderPath: `${cwd}/${PLAYBOOKS_DIR}`,
				// Apply optional config fields from CLI/web
				...(config?.nudgeMessage && { nudgeMessage: config.nudgeMessage as string }),
				...(config?.newSessionMessage && { newSessionMessage: config.newSessionMessage as string }),
				...(config?.customPath && { customPath: config.customPath as string }),
				...(config?.customArgs && { customArgs: config.customArgs as string }),
				...(config?.customEnvVars && {
					customEnvVars: config.customEnvVars as Record<string, string>,
				}),
				...(config?.customModel && { customModel: config.customModel as string }),
				...(config?.customEffort && { customEffort: config.customEffort as string }),
				...(config?.customContextWindow && {
					customContextWindow: config.customContextWindow as number,
				}),
				...(config?.customProviderPath && {
					customProviderPath: config.customProviderPath as string,
				}),
				...(config?.sessionSshRemoteConfig && {
					sessionSshRemoteConfig:
						config.sessionSshRemoteConfig as Session['sessionSshRemoteConfig'],
				}),
			};

			setSessions((prev: Session[]) => [...prev, newSession]);
			setActiveSessionId(newId);
			(window as any).maestro.stats.recordSessionCreated({
				sessionId: newId,
				agentType: toolType,
				projectPath: cwd,
				createdAt: Date.now(),
				isRemote: false,
			});

			window.maestro.process.sendRemoteCreateSessionResponse(responseChannel, {
				sessionId: newId,
			});
		} catch (error) {
			logger.error('[Remote] Failed to create session:', undefined, error);
			window.maestro.process.sendRemoteCreateSessionResponse(responseChannel, null);
		}
	});

	// Handle remote delete session from web interface (skip confirmation dialog)
	useEventListener('maestro:remoteDeleteSession', async (e: Event) => {
		const { sessionId } = (e as CustomEvent).detail;
		const session = sessionsRef.current.find((s) => s.id === sessionId);
		if (!session) return;

		// Kill processes
		try {
			await window.maestro.process.kill(`${sessionId}-ai`);
		} catch {
			/* ignore */
		}
		try {
			await window.maestro.process.kill(`${sessionId}-terminal`);
		} catch {
			/* ignore */
		}
		for (const tab of session.terminalTabs || []) {
			try {
				await window.maestro.process.kill(`${sessionId}-terminal-${tab.id}`);
			} catch {
				/* ignore */
			}
		}

		// Remove session
		setSessions((prev: Session[]) => {
			const filtered = prev.filter((s) => s.id !== sessionId);
			if (filtered.length > 0 && useSessionStore.getState().activeSessionId === sessionId) {
				setActiveSessionId(filtered[0].id);
			}
			return filtered;
		});
	});

	// Handle remote rename session from web interface
	useEventListener('maestro:remoteRenameSession', (e: Event) => {
		const { sessionId, newName, responseChannel } = (e as CustomEvent).detail;
		const session = sessionsRef.current.find((s) => s.id === sessionId);
		if (!session) {
			window.maestro.process.sendRemoteRenameSessionResponse(responseChannel, false);
			return;
		}

		setSessions((prev: Session[]) => {
			const updated = prev.map((s) => (s.id === sessionId ? { ...s, name: newName } : s));
			const sess = updated.find((s) => s.id === sessionId);
			// Persist name to agent storage
			const providerSessionId =
				sess?.agentSessionId ||
				sess?.aiTabs?.find((t) => t.id === sess.activeTabId)?.agentSessionId ||
				sess?.aiTabs?.[0]?.agentSessionId;
			if (providerSessionId && sess?.projectRoot) {
				const agentId = sess.toolType || 'claude-code';
				if (agentId === 'claude-code') {
					(window as any).maestro.claude
						.updateSessionName(sess.projectRoot, providerSessionId, newName)
						.catch(() => {});
				} else {
					(window as any).maestro.agentSessions
						.setSessionName(agentId, sess.projectRoot, providerSessionId, newName)
						.catch(() => {});
				}
			}
			return updated;
		});

		window.maestro.process.sendRemoteRenameSessionResponse(responseChannel, true);
	});

	// --- Group CRUD ---

	// Handle remote create group from web interface
	useEventListener('maestro:remoteCreateGroup', (e: Event) => {
		const { name, emoji, responseChannel } = (e as CustomEvent).detail;
		const trimmed = name.trim();
		if (!trimmed) {
			window.maestro.process.sendRemoteCreateGroupResponse(responseChannel, null);
			return;
		}
		const newGroupId = `group-${generateId()}`;
		setGroups((prev: Group[]) => [
			...prev,
			{
				id: newGroupId,
				name: trimmed.toUpperCase(),
				emoji: emoji || '\u{1F4C2}',
				collapsed: false,
			},
		]);
		window.maestro.process.sendRemoteCreateGroupResponse(responseChannel, { id: newGroupId });
	});

	// Handle remote rename group from web interface
	useEventListener('maestro:remoteRenameGroup', (e: Event) => {
		const { groupId, name, responseChannel } = (e as CustomEvent).detail;
		const trimmed = name.trim();
		if (!trimmed) {
			window.maestro.process.sendRemoteRenameGroupResponse(responseChannel, false);
			return;
		}
		setGroups((prev: Group[]) =>
			prev.map((g) => (g.id === groupId ? { ...g, name: trimmed.toUpperCase() } : g))
		);
		window.maestro.process.sendRemoteRenameGroupResponse(responseChannel, true);
	});

	// Handle remote delete group from web interface (fire-and-forget)
	useEventListener('maestro:remoteDeleteGroup', (e: Event) => {
		const { groupId } = (e as CustomEvent).detail;
		// Ungroup sessions in this group
		setSessions((prev: Session[]) =>
			prev.map((s) => (s.groupId === groupId ? { ...s, groupId: undefined } : s))
		);
		// Remove the group
		setGroups((prev: Group[]) => prev.filter((g) => g.id !== groupId));
	});

	// Handle remote move session to group from web interface
	useEventListener('maestro:remoteMoveSessionToGroup', (e: Event) => {
		const { sessionId, groupId, responseChannel } = (e as CustomEvent).detail;
		const session = sessionsRef.current.find((s) => s.id === sessionId);
		if (!session) {
			window.maestro.process.sendRemoteMoveSessionToGroupResponse(responseChannel, false);
			return;
		}
		setSessions((prev: Session[]) =>
			prev.map((s) => (s.id === sessionId ? { ...s, groupId: groupId || undefined } : s))
		);
		window.maestro.process.sendRemoteMoveSessionToGroupResponse(responseChannel, true);
	});
}
