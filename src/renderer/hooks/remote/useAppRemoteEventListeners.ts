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
import { insertAfterActiveInUnifiedTabOrder } from '../../utils/unifiedTabOrderUtils';
import {
	createTerminalTab as createTerminalTabHelper,
	addTerminalTab as addTerminalTabHelper,
} from '../../utils/terminalTabHelpers';
import type { Session, AITab, ToolType, Group, BatchRunConfig, BrowserTab } from '../../types';
import { logger } from '../../utils/logger';
import { captureException, captureMessage } from '../../utils/sentry';
import { DEFAULT_BATCH_PROMPT } from '../batch/batchUtils';
import { gitService } from '../../services/git';

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
	/** Resume a batch run that was paused on agent error */
	resumeAfterError: (sessionId: string) => void;
	/** Skip the failing document and continue with the next one */
	skipCurrentDocument: (sessionId: string) => void;
	/** Abort a paused-on-error batch run entirely */
	abortBatchOnError: (sessionId: string) => void;
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
		resumeAfterError,
		skipCurrentDocument,
		abortBatchOnError,
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
					unifiedTabOrder: insertAfterActiveInUnifiedTabOrder(s, {
						type: 'browser',
						id: newBrowserTab.id,
					}),
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

	// Handle remote set Auto Run folder events from web interface — repoints
	// a session at a different `.maestro/` folder, mirroring desktop's
	// `dialog.selectFolder` + `handleAutoRunFolderSelected` flow. Lists docs
	// from the new path via the autorun preload API and writes the new folder
	// + first doc + content into the session atomically; the session storage
	// layer persists `autoRunFolderPath` on the next save tick.
	useEventListener('maestro:setAutoRunFolder', async (e: Event) => {
		const { sessionId, folderPath, responseChannel } = (e as CustomEvent).detail as {
			sessionId: string;
			folderPath: string;
			responseChannel: string;
		};

		try {
			const session = sessionsRef.current.find((s) => s.id === sessionId);
			if (!session) {
				window.maestro.process.sendRemoteSetAutoRunFolderResponse(responseChannel, {
					success: false,
					error: `Session ${sessionId} not found`,
				});
				return;
			}

			const sshRemoteId =
				session.sshRemoteId || session.sessionSshRemoteConfig?.remoteId || undefined;

			let listResult: {
				success: boolean;
				files?: string[];
				tree?: unknown[];
				error?: string;
			} | null = null;
			try {
				listResult = await window.maestro.autorun.listDocs(folderPath, sshRemoteId);
			} catch (error) {
				captureException(error, {
					extra: { sessionId, folderPath, responseChannel, sshRemoteId },
				});
				listResult = {
					success: false,
					error: error instanceof Error ? error.message : String(error),
				};
			}

			// Treat a structured failure the same as a thrown one — otherwise we
			// silently repoint the session at an unreadable folder and the caller
			// gets a false-positive `{ success: true }`.
			if (!listResult?.success) {
				captureMessage('AutoRun listDocs returned failure', {
					level: 'error',
					extra: { sessionId, folderPath, responseChannel, sshRemoteId, listResult },
				});
				window.maestro.process.sendRemoteSetAutoRunFolderResponse(responseChannel, {
					success: false,
					error: listResult?.error || `Could not read folder ${folderPath}`,
				});
				return;
			}

			const firstFile = listResult.files?.[0];
			let firstFileContent = '';
			if (firstFile) {
				try {
					const contentResult = await window.maestro.autorun.readDoc(
						folderPath,
						firstFile + '.md',
						sshRemoteId
					);
					if (contentResult.success) {
						firstFileContent = contentResult.content || '';
					}
				} catch {
					/* leave empty; the autoRunContent useEffect will retry on next select */
				}
			}

			setSessions((prev) =>
				prev.map((s) =>
					s.id === sessionId
						? {
								...s,
								autoRunFolderPath: folderPath,
								autoRunSelectedFile: firstFile,
								autoRunContent: firstFileContent,
								autoRunContentVersion: (s.autoRunContentVersion || 0) + 1,
							}
						: s
				)
			);

			window.maestro.process.sendRemoteSetAutoRunFolderResponse(responseChannel, {
				success: true,
			});
		} catch (error) {
			captureException(error, { extra: { sessionId, folderPath, responseChannel } });
			window.maestro.process.sendRemoteSetAutoRunFolderResponse(responseChannel, {
				success: false,
				error: error instanceof Error ? error.message : String(error),
			});
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

				// CLI/web callers omit prompt → fall back to the default Auto Run prompt
				// template (autorun-default.md), matching what BatchRunnerModal does for
				// GUI launches. An empty string here propagates as undefined through
				// useBatchProcessor → useDocumentProcessor → spawn, causing claude
				// `--print` to exit 1 with "Input must be provided either through stdin
				// or as a prompt argument".
				const batchConfig: BatchRunConfig = {
					documents,
					prompt: config.prompt || DEFAULT_BATCH_PROMPT,
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

			// Transform file paths into AutoRunDocument objects with task counts.
			// `folder` is the directory portion of the relative path (empty for root)
			// so the mobile UI can group documents by subfolder. We normalize
			// backslash-separated paths (Windows sessions can return `subdir\\doc.md`)
			// to forward slashes before splitting so the tree view works cross-platform.
			const docs = await Promise.all(
				filePaths.map(async (filePath) => {
					const normalizedPath = filePath.replace(/\\/g, '/');
					const lastSlash = normalizedPath.lastIndexOf('/');
					const filename = lastSlash >= 0 ? normalizedPath.slice(lastSlash + 1) : normalizedPath;
					const folder = lastSlash >= 0 ? normalizedPath.slice(0, lastSlash) : '';
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
					return { filename, path: normalizedPath, taskCount, completedCount, folder };
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

	// Handle remote reset-tasks: rewrite all `[x]` checkboxes back to `[ ]` for a doc.
	// Uses the same autorun:readDoc / autorun:writeDoc IPC the desktop "Reset Tasks"
	// modal uses, so SSH remote sessions work transparently.
	useEventListener('maestro:resetAutoRunDocTasks', async (e: Event) => {
		const { sessionId, filename, responseChannel } = (e as CustomEvent).detail;
		try {
			const session = sessionsRef.current.find((s) => s.id === sessionId);
			if (!session?.autoRunFolderPath) {
				window.maestro.process.sendRemoteResetAutoRunDocTasksResponse(responseChannel, false);
				return;
			}
			const sshRemoteId =
				session.sshRemoteId || session.sessionSshRemoteConfig?.remoteId || undefined;

			const readResult = await window.maestro.autorun.readDoc(
				session.autoRunFolderPath,
				filename,
				sshRemoteId
			);
			if (!readResult?.success) {
				window.maestro.process.sendRemoteResetAutoRunDocTasksResponse(responseChannel, false);
				return;
			}
			const original: string = readResult.content ?? '';
			// Reset all completed task checkboxes (both `[x]` and `[X]`) back to `[ ]`
			// while preserving leading whitespace and the rest of the line. The
			// trailing whitespace group is `\s?` (not `\s`) so malformed lines like
			// `- [x]Task` (no space after the bracket) still get unchecked — the
			// desktop's uncheckAllTasks() behaves the same way.
			const reset = original.replace(/^(\s*[-*]\s*)\[[xX]\](\s?)/gm, '$1[ ]$2');
			if (reset === original) {
				// Nothing to reset — still report success so the UI doesn't show an error.
				window.maestro.process.sendRemoteResetAutoRunDocTasksResponse(responseChannel, true);
				return;
			}
			const writeResult = await window.maestro.autorun.writeDoc(
				session.autoRunFolderPath,
				filename,
				reset,
				sshRemoteId
			);
			// Mirror the reset back into session state so the renderer's right
			// panel reflects the new content immediately instead of waiting for
			// the next refresh — and the autoRunContent stays in sync with disk.
			if (writeResult?.success && session.autoRunSelectedFile + '.md' === filename) {
				setSessions((prev) =>
					prev.map((s) =>
						s.id === sessionId
							? {
									...s,
									autoRunContent: reset,
									autoRunContentVersion: (s.autoRunContentVersion || 0) + 1,
								}
							: s
					)
				);
			}
			window.maestro.process.sendRemoteResetAutoRunDocTasksResponse(
				responseChannel,
				Boolean(writeResult?.success)
			);
		} catch (error) {
			captureException(error, { extra: { sessionId, filename, responseChannel } });
			logger.error('[Remote] Failed to reset auto-run doc tasks:', undefined, error);
			window.maestro.process.sendRemoteResetAutoRunDocTasksResponse(responseChannel, false);
		}
	});

	// Auto Run error-recovery actions from web — mirror the desktop AutoRunErrorBanner buttons.
	useEventListener('maestro:resumeAutoRunError', (e: Event) => {
		const { sessionId, responseChannel } = (e as CustomEvent).detail;
		try {
			resumeAfterError(sessionId);
			window.maestro.process.sendRemoteResumeAutoRunErrorResponse(responseChannel, true);
		} catch (error) {
			captureException(error, {
				extra: { event: 'maestro:resumeAutoRunError', sessionId, responseChannel },
			});
			logger.error('[Remote] Failed to resume auto-run error:', undefined, error);
			window.maestro.process.sendRemoteResumeAutoRunErrorResponse(responseChannel, false);
		}
	});

	useEventListener('maestro:skipAutoRunDocument', (e: Event) => {
		const { sessionId, responseChannel } = (e as CustomEvent).detail;
		try {
			skipCurrentDocument(sessionId);
			window.maestro.process.sendRemoteSkipAutoRunDocumentResponse(responseChannel, true);
		} catch (error) {
			captureException(error, {
				extra: { event: 'maestro:skipAutoRunDocument', sessionId, responseChannel },
			});
			logger.error('[Remote] Failed to skip auto-run document:', undefined, error);
			window.maestro.process.sendRemoteSkipAutoRunDocumentResponse(responseChannel, false);
		}
	});

	useEventListener('maestro:abortAutoRunError', (e: Event) => {
		const { sessionId, responseChannel } = (e as CustomEvent).detail;
		try {
			abortBatchOnError(sessionId);
			window.maestro.process.sendRemoteAbortAutoRunErrorResponse(responseChannel, true);
		} catch (error) {
			captureException(error, {
				extra: { event: 'maestro:abortAutoRunError', sessionId, responseChannel },
			});
			logger.error('[Remote] Failed to abort auto-run error:', undefined, error);
			window.maestro.process.sendRemoteAbortAutoRunErrorResponse(responseChannel, false);
		}
	});

	// Playbook CRUD from web — forwards to window.maestro.playbooks.*
	useEventListener('maestro:listPlaybooks', async (e: Event) => {
		const { sessionId, responseChannel } = (e as CustomEvent).detail;
		try {
			const result = await window.maestro.playbooks.list(sessionId);
			window.maestro.process.sendRemoteListPlaybooksResponse(
				responseChannel,
				Array.isArray(result?.playbooks) ? result.playbooks : []
			);
		} catch (error) {
			captureException(error, {
				extra: { event: 'maestro:listPlaybooks', sessionId, responseChannel },
			});
			logger.error('[Remote] Failed to list playbooks:', undefined, error);
			window.maestro.process.sendRemoteListPlaybooksResponse(responseChannel, []);
		}
	});

	useEventListener('maestro:createPlaybook', async (e: Event) => {
		const { sessionId, playbook, responseChannel } = (e as CustomEvent).detail;
		try {
			const result = await window.maestro.playbooks.create(sessionId, playbook);
			window.maestro.process.sendRemoteCreatePlaybookResponse(
				responseChannel,
				result?.playbook ?? null
			);
		} catch (error) {
			captureException(error, {
				extra: { event: 'maestro:createPlaybook', sessionId, responseChannel },
			});
			logger.error('[Remote] Failed to create playbook:', undefined, error);
			window.maestro.process.sendRemoteCreatePlaybookResponse(responseChannel, null);
		}
	});

	useEventListener('maestro:updatePlaybook', async (e: Event) => {
		const { sessionId, playbookId, updates, responseChannel } = (e as CustomEvent).detail;
		try {
			const result = await window.maestro.playbooks.update(sessionId, playbookId, updates);
			window.maestro.process.sendRemoteUpdatePlaybookResponse(
				responseChannel,
				result?.playbook ?? null
			);
		} catch (error) {
			captureException(error, {
				extra: { event: 'maestro:updatePlaybook', sessionId, playbookId, responseChannel },
			});
			logger.error('[Remote] Failed to update playbook:', undefined, error);
			window.maestro.process.sendRemoteUpdatePlaybookResponse(responseChannel, null);
		}
	});

	useEventListener('maestro:deletePlaybook', async (e: Event) => {
		const { sessionId, playbookId, responseChannel } = (e as CustomEvent).detail;
		try {
			// `playbooks.delete` returns `{ success: boolean; error?: string }` — if the
			// IPC reports `success: false` (e.g. playbook not found) we must surface
			// that back to the web client instead of silently acking true, otherwise
			// the mobile UI optimistically drops the entry and the list goes stale.
			const result = await window.maestro.playbooks.delete(sessionId, playbookId);
			if (!result?.success) {
				captureMessage('playbooks.delete returned failure', {
					level: 'error',
					extra: {
						event: 'maestro:deletePlaybook',
						sessionId,
						playbookId,
						error: result?.error,
					},
				});
				logger.error('[Remote] Failed to delete playbook:', undefined, result?.error);
			}
			window.maestro.process.sendRemoteDeletePlaybookResponse(
				responseChannel,
				Boolean(result?.success)
			);
		} catch (error) {
			captureException(error, {
				extra: { event: 'maestro:deletePlaybook', sessionId, playbookId, responseChannel },
			});
			logger.error('[Remote] Failed to delete playbook:', undefined, error);
			window.maestro.process.sendRemoteDeletePlaybookResponse(responseChannel, false);
		}
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

			// Probe git repo state for the cwd so the header badge shows the branch
			// instead of "LOCAL". Mirrors the GUI's useSessionCrud flow. For SSH
			// sessions, defer the check until onSshRemote fires (see useAgentListeners).
			// gitService methods route through createIpcMethod with a defaultValue,
			// so they swallow IPC errors (and report to Sentry) rather than throwing.
			const sshConfig = config?.sessionSshRemoteConfig as
				| { enabled?: boolean; remoteId?: string | null }
				| undefined;
			const isRemoteSession = !!(sshConfig?.enabled && sshConfig.remoteId);
			let isGitRepo = false;
			let gitBranches: string[] | undefined;
			let gitTags: string[] | undefined;
			let gitRefsCacheTime: number | undefined;
			if (!isRemoteSession) {
				isGitRepo = await gitService.isRepo(cwd);
				if (isGitRepo) {
					[gitBranches, gitTags] = await Promise.all([
						gitService.getBranches(cwd),
						gitService.getTags(cwd),
					]);
					gitRefsCacheTime = Date.now();
				}
			}

			const newSession: Session = {
				id: newId,
				name,
				toolType: toolType as ToolType,
				state: 'idle',
				createdAt: Date.now(),
				cwd,
				fullPath: cwd,
				projectRoot: cwd,
				isGitRepo,
				...(gitBranches !== undefined && { gitBranches }),
				...(gitTags !== undefined && { gitTags }),
				...(gitRefsCacheTime !== undefined && { gitRefsCacheTime }),
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
				...(config?.autoRunFolderPath && {
					autoRunFolderPath: config.autoRunFolderPath as string,
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
