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
import { useSessionStore, selectSessionById } from '../../stores/sessionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useBatchStore } from '../../stores/batchStore';
import { useModalStore } from '../../stores/modalStore';
import { useUIStore } from '../../stores/uiStore';
import { PLAYBOOKS_DIR } from '../../../shared/maestro-paths';
import { getBasename, isAbsolutePath } from '../../../shared/formatters';
import { getBrowserTabPartition } from '../../utils/browserTabPersistence';
import { insertAfterActiveInUnifiedTabOrder } from '../../utils/unifiedTabOrderUtils';
import {
	createTerminalTab as createTerminalTabHelper,
	addTerminalTab as addTerminalTabHelper,
	resolveTerminalTab,
	getTerminalTabDisplayName,
	getTerminalSessionId,
} from '../../utils/terminalTabHelpers';
import type {
	Session,
	AITab,
	ToolType,
	Group,
	BatchRunConfig,
	BatchDocumentEntry,
	BrowserTab,
} from '../../types';
import { logger } from '../../utils/logger';
import { captureException, captureMessage } from '../../utils/sentry';
import { DEFAULT_BATCH_PROMPT } from '../batch/batchUtils';
import { gitService } from '../../services/git';
import { spawnWorktreeAgentAndDispatch } from '../../utils/worktreeSpawn';
import { notifyToast } from '../../stores/notificationStore';
import {
	canCreateGroupInside,
	removeGroupAndPromoteChildren,
} from '../../../shared/groupHierarchy';

function resolveRemoteAutoRunFilename(filename: string, folderPath: string): string {
	const normalized = filename.replace(/\\/g, '/').replace(/\.md$/i, '');
	const normalizedFolder = folderPath.replace(/\\/g, '/').replace(/\/$/, '');
	let relative = normalized;

	if (isAbsolutePath(filename)) {
		if (!normalized.toLowerCase().startsWith(`${normalizedFolder.toLowerCase()}/`)) {
			throw new Error(
				`Auto Run document is outside the configured folder: ${getBasename(filename)}`
			);
		}
		relative = normalized.slice(normalizedFolder.length + 1);
	}

	relative = relative.replace(/^\.\/+/, '');
	if (!relative || relative.split('/').includes('..')) {
		throw new Error(`Invalid Auto Run document path: ${filename}`);
	}

	return relative;
}

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
			/** Optional 1-based line to jump to once the editor mounts (deep links). */
			pendingScrollToLine?: number;
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
		const { sessionId, filePath, switchToAgent, line } = (e as CustomEvent).detail as {
			sessionId: string;
			filePath: string;
			switchToAgent?: boolean;
			/** Optional 1-based line to jump to once the file is open. Set by
			 *  maestro://file/...#L<n> deep links. */
			line?: number;
		};
		const session = sessionsRef.current.find((s) => s.id === sessionId);
		if (!session) {
			logger.error('[Remote] Session not found for openFileTab:', undefined, sessionId);
			return;
		}
		const sshRemoteId =
			session.sshRemoteId || session.sessionSshRemoteConfig?.remoteId || undefined;
		// Honor `--no-switch`: register the tab on the target agent but leave the
		// active agent untouched so the CLI invocation doesn't hijack focus.
		if (switchToAgent !== false) {
			setActiveSessionId(sessionId);
		}
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
						pendingScrollToLine: line,
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
		const { sessionId, url, responseChannel, background } = (e as CustomEvent).detail as {
			sessionId: string;
			url: string;
			responseChannel?: string;
			background?: boolean;
		};
		const ack = (success: boolean, tabId?: string) => {
			if (responseChannel) {
				window.maestro.process.sendRemoteOpenBrowserTabResponse(responseChannel, success, tabId);
			}
		};
		const session = sessionsRef.current.find((s) => s.id === sessionId);
		if (!session) {
			logger.error('[Remote] Session not found for openBrowserTab:', undefined, sessionId);
			ack(false);
			return;
		}
		// A background tab must not move the user: leave the active agent alone
		// and leave whatever tab they were on visible. Agents doing research
		// open tabs this way so the window doesn't jump mid-keystroke.
		if (!background) {
			setActiveSessionId(sessionId);
		}
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
				const withTab = {
					...s,
					browserTabs: [...(s.browserTabs || []), newBrowserTab],
					unifiedTabOrder: insertAfterActiveInUnifiedTabOrder(s, {
						type: 'browser',
						id: newBrowserTab.id,
					}),
				};
				if (background) return withTab;
				return {
					...withTab,
					activeFileTabId: null,
					activeBrowserTabId: newBrowserTab.id,
					activeTerminalTabId: null,
					inputMode: 'ai' as const,
				};
			})
		);
		ack(true, newBrowserTab.id);
	});

	// Handle remote close browser tab events from CLI/web interface. Resolves
	// the owning agent from the tab id so callers only need what open-browser
	// handed back. Acks false when no such tab exists, so an agent cleaning up
	// after itself can tell a no-op from a real close.
	useEventListener('maestro:closeBrowserTab', (e: Event) => {
		const { tabId, responseChannel } = (e as CustomEvent).detail as {
			tabId: string;
			responseChannel?: string;
		};
		const ack = (success: boolean) => {
			if (responseChannel) {
				window.maestro.process.sendRemoteCloseBrowserTabResponse(responseChannel, success);
			}
		};
		const owner = sessionsRef.current.find((s) =>
			(s.browserTabs || []).some((t) => t.id === tabId)
		);
		if (!owner) {
			ack(false);
			return;
		}
		setSessions((prev) =>
			prev.map((s) => {
				if (s.id !== owner.id) return s;
				return {
					...s,
					browserTabs: (s.browserTabs || []).filter((t) => t.id !== tabId),
					// Only clear the active pointer when the closed tab was the
					// visible one; a background tab closing must not change the view.
					activeBrowserTabId: s.activeBrowserTabId === tabId ? null : s.activeBrowserTabId,
					unifiedTabOrder: (s.unifiedTabOrder || []).filter(
						(ref) => !(ref.type === 'browser' && ref.id === tabId)
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
			config: { cwd?: string; shell?: string; name?: string | null; command?: string };
			responseChannel?: string;
		};
		const ack = (success: boolean, tabId?: string) => {
			if (responseChannel) {
				window.maestro.process.sendRemoteOpenTerminalTabResponse(responseChannel, success, tabId);
			}
		};
		const session = sessionsRef.current.find((s) => s.id === sessionId);
		if (!session) {
			logger.error('[Remote] Session not found for openTerminalTab:', undefined, sessionId);
			ack(false);
			return;
		}
		setActiveSessionId(sessionId);
		const baseTab = createTerminalTabHelper(
			config?.shell,
			config?.cwd ?? session.cwd,
			config?.name ?? null
		);
		// A requested command becomes the tab's startup command rather than a
		// one-shot write: TerminalView already runs that once the PTY is up, and
		// storing it means a `npm run dev` terminal comes back after a restart or
		// a manual restart of the tab instead of reopening to an empty shell.
		const command = config?.command?.trim();
		const tab = command ? { ...baseTab, startupCommand: command } : baseTab;
		setSessions((prev) =>
			prev.map((s) => {
				if (s.id !== sessionId) return s;
				const updated = addTerminalTabHelper(s, tab);
				return { ...updated, inputMode: 'terminal' as const };
			})
		);
		ack(true, tab.id);
	});

	// Handle remote writes into an existing terminal tab from CLI/web interface.
	// This is the "type into the terminal the user is looking at" path, as
	// opposed to openTerminalTab which makes a new one.
	useEventListener('maestro:writeTerminalTab', async (e: Event) => {
		const { sessionId, tabRef, data, responseChannel } = (e as CustomEvent).detail as {
			sessionId: string;
			tabRef?: string;
			data: string;
			responseChannel?: string;
		};
		const ack = (
			success: boolean,
			result?: { error?: string; tabId?: string; tabName?: string }
		) => {
			if (responseChannel) {
				window.maestro.process.sendRemoteWriteTerminalTabResponse(responseChannel, success, result);
			}
		};

		const resolved = resolveTerminalTab(sessionsRef.current, sessionId, tabRef);
		if (!resolved) {
			const session = sessionsRef.current.find((s) => s.id === sessionId);
			if (!session) {
				ack(false, { error: 'Agent not found' });
			} else if (tabRef) {
				ack(false, { error: `No terminal tab matching "${tabRef}"` });
			} else if ((session.terminalTabs || []).length === 0) {
				ack(false, {
					error: 'No terminal tab is open for this agent. Use open-terminal first.',
				});
			} else {
				ack(false, {
					error: 'Several terminal tabs are open and none is active. Pass --tab to pick one.',
				});
			}
			return;
		}

		const { session: owner, tab } = resolved;
		const index = (owner.terminalTabs || []).findIndex((t) => t.id === tab.id);
		const tabName = getTerminalTabDisplayName(tab, index);

		// The PTY lives in the main process and outlives its React view, so a
		// write lands even when the owning agent is not on screen. A tab that was
		// never rendered has no PTY at all though (pid 0), and only the ACTIVE
		// session has a live TerminalView that would spawn one. Waiting for a
		// background agent would stall until the timeout for a shell that is
		// never coming, so wait only when it can actually arrive - and never
		// switch agents to force it, since that would yank the screen away to
		// service a background command.
		let pid = tab.pid;
		if (pid === 0 && tab.state !== 'exited') {
			const isActiveSession = useSessionStore.getState().activeSessionId === owner.id;
			if (isActiveSession) {
				const deadline = Date.now() + 4000;
				while (pid === 0 && Date.now() < deadline) {
					await new Promise((resolve) => setTimeout(resolve, 100));
					pid =
						(sessionsRef.current.find((s) => s.id === owner.id)?.terminalTabs || []).find(
							(t) => t.id === tab.id
						)?.pid ?? 0;
				}
			}
		}
		if (pid === 0) {
			ack(false, {
				error:
					tab.state === 'exited'
						? `Terminal "${tabName}" has exited. Restart it from the tab menu, or open a new one.`
						: `Terminal "${tabName}" has no running shell yet. Select the tab in Maestro, or use open-terminal --command.`,
				tabId: tab.id,
				tabName,
			});
			return;
		}

		const success = await window.maestro.process.write(
			getTerminalSessionId(owner.id, tab.id),
			data
		);
		ack(success, {
			error: success ? undefined : `Failed to write to terminal "${tabName}"`,
			tabId: tab.id,
			tabName,
		});
	});

	// Handle remote terminal tab listing from CLI/web interface. Terminal tabs
	// live only in renderer state, so this is the only way a caller can discover
	// what is open before writing to it.
	useEventListener('maestro:listTerminalTabs', (e: Event) => {
		const { sessionId, responseChannel } = (e as CustomEvent).detail as {
			sessionId?: string;
			responseChannel?: string;
		};
		if (!responseChannel) return;
		const sessions = sessionId
			? sessionsRef.current.filter((s) => s.id === sessionId)
			: sessionsRef.current;
		const tabs = sessions.flatMap((session) =>
			(session.terminalTabs || []).map((tab, index) => ({
				tabId: tab.id,
				agentId: session.id,
				agentName: session.name,
				name: getTerminalTabDisplayName(tab, index),
				cwd: tab.cwd || session.cwd || '',
				pid: tab.pid,
				state: tab.state,
				active: session.activeTerminalTabId === tab.id,
				startupCommand: tab.startupCommand ?? null,
			}))
		);
		window.maestro.process.sendRemoteListTerminalTabsResponse(responseChannel, tabs);
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

	// Handle remote set Auto Run folder events from web interface - repoints
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

			// Treat a structured failure the same as a thrown one - otherwise we
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
					(doc: { filename: string; resetOnCompletion?: boolean }) => ({
						id: generateId(),
						filename: resolveRemoteAutoRunFilename(doc.filename, folderPath),
						resetOnCompletion: doc.resetOnCompletion || false,
						isDuplicate: false,
					})
				);

				if (documents.length === 0) {
					window.maestro.process.sendRemoteConfigureAutoRunResponse(responseChannel, {
						success: false,
						error: 'No documents provided for auto-run',
					});
					return;
				}

				// Capture whether the launch enables worktree dispatch - used below to
				// decide whether to spawn a child session via the desktop helper.
				const worktreeEnabled = Boolean(config.worktree?.enabled);

				// CLI/web callers omit prompt → fall back to the default Auto Run prompt
				// template (autorun-default.md), matching what BatchRunnerModal does for
				// GUI launches. An empty string here propagates as undefined through
				// useBatchProcessor → useDocumentProcessor → spawn, causing claude
				// `--print` to exit 1 with "Input must be provided either through stdin
				// or as a prompt argument".
				//
				// Note: batchConfig.worktree is intentionally NOT pre-populated from the
				// raw config payload. The mobile client sends the user-typed branch
				// (e.g. "Cue Dashboard") and a path computed before sanitization, both
				// of which can drift from what spawnWorktreeAgentAndDispatch actually
				// resolves on disk (sanitized branch, or an existingPath returned by
				// `git worktree add` when the branch already had a worktree). The spawn
				// helper writes the resolved values back into config.worktree when
				// createPROnCompletion is true; we mirror that result onto batchConfig
				// below so PR creation downstream sees the correct path/branch.
				// Per-run model/effort override (CLI `--model` / `--effort`). Spread
				// only when set so an omitted flag never serializes as an empty string,
				// which would pin the run to a nonexistent model instead of falling
				// through to the agent default.
				const batchConfig: BatchRunConfig = {
					documents,
					prompt: config.prompt || DEFAULT_BATCH_PROMPT,
					loopEnabled: config.loopEnabled || false,
					maxLoops: config.maxLoops,
					...(config.model && { model: config.model }),
					...(config.effort && { effort: config.effort }),
				};

				// Mirror desktop's useAutoRunHandlers: when worktree dispatch is enabled,
				// spawn a child session linked to the launching parent BEFORE calling
				// startBatchRun. Without this, startBatchRun creates the worktree on
				// disk but no session is bound to the launching agent - chokidar in
				// useWorktreeHandlers eventually attaches the new directory to whichever
				// sibling's worktreeConfig.basePath matches first, producing the wrong-
				// parent attachment reported in PR #946.
				let targetSessionId = sessionId;
				if (worktreeEnabled && config.worktree) {
					// If the launching session is itself a worktree child, resolve to
					// its parent so basePath/cwd used for worktree creation come from
					// the main repo. Falls back to the launching session if the parent
					// can't be loaded (mirrors desktop behavior).
					let parentForSpawn = session;
					if (session.parentSessionId) {
						const parent = selectSessionById(session.parentSessionId)(useSessionStore.getState());
						if (parent) parentForSpawn = parent;
					}

					// Build a WorktreeRunTarget from the mobile/web LaunchWorktreeConfig.
					// Mobile currently only supports create-new; existing-open/closed are
					// desktop-only flows.
					//
					// baseBranch resolution order: explicit `worktree.baseBranch` from the
					// caller (CLI `--base-branch`, mobile picker) wins. Fall back to
					// `prTargetBranch` only for older clients that conflated the two, then
					// to "main" as a final default. This keeps payloads from pre-baseBranch
					// CLIs working while letting newer callers pick a base independent of
					// the PR target.
					const spawnConfig: BatchRunConfig = {
						...batchConfig,
						worktreeTarget: {
							mode: 'create-new',
							newBranchName: config.worktree.branchName,
							baseBranch: config.worktree.baseBranch || config.worktree.prTargetBranch || 'main',
							createPROnCompletion: Boolean(config.worktree.createPROnCompletion),
						},
					};

					try {
						const newSessionId = await spawnWorktreeAgentAndDispatch(parentForSpawn, spawnConfig);
						if (!newSessionId) {
							window.maestro.process.sendRemoteConfigureAutoRunResponse(responseChannel, {
								success: false,
								error: 'Failed to spawn worktree agent',
							});
							return;
						}
						targetSessionId = newSessionId;
						// spawnWorktreeAgentAndDispatch writes the resolved worktree
						// path/branch back into spawnConfig.worktree when PR creation is
						// requested (sanitized branch name, or the existingPath that
						// `git worktree add` returned for an already-attached branch).
						// Forward that authoritative value to startBatchRun; when PR
						// creation is off, leave batchConfig.worktree undefined and rely
						// on worktreeTarget + the spawned session's cwd - the same shape
						// the desktop launch path produces.
						if (spawnConfig.worktree) {
							batchConfig.worktree = spawnConfig.worktree;
						}
						// Setting worktreeTarget tells startBatchRun to skip its own
						// setupWorktree call - the spawn helper already created the
						// directory and built the session.
						batchConfig.worktreeTarget = spawnConfig.worktreeTarget;
					} catch (err) {
						captureException(err, {
							extra: {
								event: 'maestro:configureAutoRun',
								sessionId,
								parentSessionId: parentForSpawn.id,
								worktree: config.worktree,
								responseChannel,
							},
						});
						logger.error('[Remote] Failed to spawn worktree agent:', undefined, err);
						notifyToast({
							type: 'error',
							title: 'Worktree Error',
							message: err instanceof Error ? err.message : String(err),
						});
						window.maestro.process.sendRemoteConfigureAutoRunResponse(responseChannel, {
							success: false,
							error: err instanceof Error ? err.message : String(err),
						});
						return;
					}
				}

				// Send success response immediately - startBatchRun is long-running
				// and would exceed the IPC/CLI timeout if awaited.
				window.maestro.process.sendRemoteConfigureAutoRunResponse(responseChannel, {
					success: true,
				});
				startBatchRun(targetSessionId, batchConfig, folderPath).catch((err) => {
					logger.error('[Remote] Failed to start auto-run:', undefined, err);
				});
				return;
			}

			// Case 3: Configure the Batch Runner modal without launching.
			const folderPath = session.autoRunFolderPath;
			if (!folderPath) {
				window.maestro.process.sendRemoteConfigureAutoRunResponse(responseChannel, {
					success: false,
					error: 'No Auto Run folder configured for this session',
				});
				return;
			}

			const documents: BatchDocumentEntry[] = (config.documents || []).map(
				(doc: { filename: string; resetOnCompletion?: boolean }) => ({
					id: generateId(),
					filename: resolveRemoteAutoRunFilename(doc.filename, folderPath),
					resetOnCompletion: doc.resetOnCompletion || false,
					isDuplicate: false,
				})
			);
			if (documents.length === 0) {
				window.maestro.process.sendRemoteConfigureAutoRunResponse(responseChannel, {
					success: false,
					error: 'No documents provided for auto-run',
				});
				return;
			}

			const selectedFile = documents[0].filename;
			const sshRemoteId =
				session.sshRemoteId || session.sessionSshRemoteConfig?.remoteId || undefined;
			const contentResult = await window.maestro.autorun.readDoc(
				folderPath,
				`${selectedFile}.md`,
				sshRemoteId
			);
			const batchConfig: BatchRunConfig = {
				documents,
				prompt: config.prompt || '',
				loopEnabled: config.loopEnabled || false,
				maxLoops: config.maxLoops ?? null,
			};

			setSessions((prev) =>
				prev.map((candidate) =>
					candidate.id === sessionId
						? {
								...candidate,
								autoRunSelectedFile: selectedFile,
								autoRunContent: contentResult.success ? contentResult.content || '' : '',
								autoRunContentVersion: (candidate.autoRunContentVersion || 0) + 1,
								batchRunnerPrompt: batchConfig.prompt,
								batchRunnerPromptModifiedAt: Date.now(),
							}
						: candidate
				)
			);
			useBatchStore.getState().setDocumentList(documents.map((document) => document.filename));
			setActiveSessionId(sessionId);
			const uiActions = useUIStore.getState();
			uiActions.setRightPanelOpen(true);
			uiActions.setActiveRightTab('autorun');
			useModalStore.getState().openBatchRunnerWithConfig(batchConfig);
			window.maestro.process.sendRemoteConfigureAutoRunResponse(responseChannel, {
				success: true,
			});
		} catch (error) {
			logger.error('[Remote] Failed to configure auto-run:', undefined, error);
			window.maestro.process.sendRemoteConfigureAutoRunResponse(responseChannel, {
				success: false,
				error: String(error),
			});
		}
	});

	// Handle remote create-worktree-agent from the CLI. Creates a new agent in a
	// git worktree branched off a parent agent, without an Auto Run playbook.
	// Reuses spawnWorktreeAgentAndDispatch (the same helper the Auto Run launch
	// path uses) but skips the batch dispatch: the new agent is left idle, and
	// the CLI optionally follows up with `dispatch` to send an initial prompt.
	useEventListener('maestro:createWorktreeSession', async (e: Event) => {
		const { parentSessionId, config, responseChannel } = (e as CustomEvent).detail;

		try {
			const parent = sessionsRef.current.find((s) => s.id === parentSessionId);
			if (!parent) {
				window.maestro.process.sendRemoteCreateWorktreeSessionResponse(responseChannel, {
					success: false,
					error: `Parent agent ${parentSessionId} not found`,
				});
				return;
			}

			// If the addressed agent is itself a worktree child, resolve to its
			// parent so the new worktree branches off the main repo (mirrors the
			// desktop and remote Auto Run launch paths).
			let parentForSpawn = parent;
			if (parent.parentSessionId) {
				const grandparent = selectSessionById(parent.parentSessionId)(useSessionStore.getState());
				if (grandparent) parentForSpawn = grandparent;
			}

			const spawnConfig: BatchRunConfig = {
				documents: [],
				prompt: '',
				loopEnabled: false,
				worktreeTarget: {
					mode: 'create-new',
					newBranchName: config.branchName,
					baseBranch: config.baseBranch || undefined,
					createPROnCompletion: false,
				},
			};

			const newSessionId = await spawnWorktreeAgentAndDispatch(parentForSpawn, spawnConfig);
			if (!newSessionId) {
				// spawnWorktreeAgentAndDispatch already surfaced a toast describing why.
				window.maestro.process.sendRemoteCreateWorktreeSessionResponse(responseChannel, {
					success: false,
					error: 'Failed to create worktree agent',
				});
				return;
			}

			window.maestro.process.sendRemoteCreateWorktreeSessionResponse(responseChannel, {
				success: true,
				sessionId: newSessionId,
			});
		} catch (error) {
			captureException(error, { extra: { parentSessionId, responseChannel } });
			logger.error('[Remote] Failed to create worktree agent:', undefined, error);
			window.maestro.process.sendRemoteCreateWorktreeSessionResponse(responseChannel, {
				success: false,
				error: error instanceof Error ? error.message : String(error),
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
			// `- [x]Task` (no space after the bracket) still get unchecked - the
			// desktop's uncheckAllTasks() behaves the same way.
			const reset = original.replace(/^(\s*[-*]\s*)\[[xX]\](\s?)/gm, '$1[ ]$2');
			if (reset === original) {
				// Nothing to reset - still report success so the UI doesn't show an error.
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
			// the next refresh - and the autoRunContent stays in sync with disk.
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

	// Auto Run error-recovery actions from web - mirror the desktop AutoRunErrorBanner buttons.
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

	// Playbook CRUD from web - forwards to window.maestro.playbooks.*
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
			// `playbooks.delete` returns `{ success: boolean; error?: string }` - if the
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
				...(config?.contextWindowSource === 'user-edited' && {
					contextWindowSource: 'user-edited' as const,
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

			// Persist the new agent to disk synchronously before responding. The
			// renderer's debounced persistence path (useDebouncedPersistence) is
			// driven by React render cycles and a 2s timer, so a CLI consumer that
			// runs `create-agent` and then immediately `list agents` / `send` would
			// otherwise hit the disk-backed CLI storage layer before the in-memory
			// session has been flushed - surfacing as `AGENT_NOT_FOUND` (issue #1013).
			// `setMany` is incremental and idempotent: the debounced flush that
			// follows simply rewrites the same row.
			try {
				await window.maestro.sessions.setMany([newSession], []);
			} catch (persistErr) {
				logger.error('[Remote] Failed to persist new CLI-created session:', undefined, persistErr);
			}

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

		// Flush the removal to disk synchronously: useDebouncedPersistence
		// runs on a 2s timer, so a CLI consumer that hits the disk-backed
		// session store between this event and the next debounce window
		// would otherwise read the pre-removal state. setMany is incremental
		// and idempotent with the subsequent debounced flush.
		try {
			await window.maestro.sessions.setMany([], [sessionId]);
		} catch (persistErr) {
			logger.error('[Remote] Failed to persist session removal:', undefined, persistErr);
		}
	});

	// Handle remote update session cwd from CLI/web. Mutates the UI-facing
	// cwd/fullPath only; projectRoot is intentionally preserved so historical
	// provider sessions (stored under the original project root) remain
	// addressable. The PTY's cwd is fixed at spawn time, so we refuse the
	// update when an agent process is alive.
	useEventListener('maestro:remoteUpdateSessionCwd', (e: Event) => {
		const { sessionId, newCwd, responseChannel } = (e as CustomEvent).detail;
		const session = sessionsRef.current.find((s) => s.id === sessionId);
		if (!session) {
			window.maestro.process.sendRemoteUpdateSessionCwdResponse(responseChannel, {
				success: false,
				error: 'Agent not found',
			});
			return;
		}
		if (session.aiPid && session.aiPid > 0) {
			window.maestro.process.sendRemoteUpdateSessionCwdResponse(responseChannel, {
				success: false,
				error: 'Agent process is running; stop it before changing cwd',
			});
			return;
		}
		setSessions((prev: Session[]) =>
			prev.map((s) =>
				s.id === sessionId ? { ...s, cwd: newCwd, fullPath: newCwd, shellCwd: newCwd } : s
			)
		);
		window.maestro.process.sendRemoteUpdateSessionCwdResponse(responseChannel, { success: true });
	});

	// Handle remote update of an agent's SSH execution config. Merges the
	// partial patch onto the existing sessionSshRemoteConfig and flushes to disk
	// so a follow-up CLI read sees the new config (the renderer owns the
	// authoritative in-memory state; offline JSON edits get clobbered). Refused
	// while the agent process is alive because the spawn target is fixed at launch.
	useEventListener('maestro:remoteUpdateSessionSsh', async (e: Event) => {
		const { sessionId, sshPatch, responseChannel } = (e as CustomEvent).detail;
		const session = sessionsRef.current.find((s) => s.id === sessionId);
		if (!session) {
			window.maestro.process.sendRemoteUpdateSessionSshResponse(responseChannel, {
				success: false,
				error: 'Agent not found',
			});
			return;
		}
		if (session.aiPid && session.aiPid > 0) {
			window.maestro.process.sendRemoteUpdateSessionSshResponse(responseChannel, {
				success: false,
				error: 'Agent process is running; stop it before changing SSH config',
			});
			return;
		}

		// Merge the patch onto the existing config, then normalize the two
		// always-required fields so the persisted config is well-formed even when
		// the caller only touched an optional flag (e.g. syncHistory) on an agent
		// that never had SSH config.
		const existing = session.sessionSshRemoteConfig ?? {};
		const merged = { ...existing, ...sshPatch };
		const normalized = {
			...merged,
			enabled: merged.enabled ?? false,
			remoteId: merged.remoteId ?? null,
		};

		setSessions((prev: Session[]) =>
			prev.map((s) => (s.id === sessionId ? { ...s, sessionSshRemoteConfig: normalized } : s))
		);

		// Flush to disk before signaling success so a follow-up CLI read sees the
		// new config instead of the 2s-debounced stale value (mirrors rename).
		try {
			await window.maestro.sessions.setMany(
				[{ ...session, sessionSshRemoteConfig: normalized } as any],
				[]
			);
		} catch (persistErr) {
			logger.error('[Remote] Failed to persist session SSH config:', undefined, persistErr);
		}

		window.maestro.process.sendRemoteUpdateSessionSshResponse(responseChannel, { success: true });
	});

	// Handle remote update of an agent's editable per-session config from the CLI
	// (nudge / new-session message, custom path / args / env vars, model, effort,
	// context window, Claude token-source tri-state). Only the keys present in the
	// patch are applied; a key whose value is `null` clears that field to
	// undefined. These are spawn-time settings (they take effect on the next
	// launch), so unlike cwd/SSH they are applied even while the agent runs. The
	// new config is flushed to disk before signaling success so a follow-up CLI
	// read sees it rather than the 2s-debounced stale value.
	useEventListener('maestro:remoteUpdateSessionConfig', async (e: Event) => {
		const { sessionId, configPatch, responseChannel } = (e as CustomEvent).detail;
		const session = sessionsRef.current.find((s) => s.id === sessionId);
		if (!session) {
			window.maestro.process.sendRemoteUpdateSessionConfigResponse(responseChannel, {
				success: false,
				error: 'Agent not found',
			});
			return;
		}

		const patchObj = configPatch as Record<string, unknown>;

		// Provider switch (toolType change) is destructive and handled separately
		// from plain settings edits: it resets tabs, clears provider-specific
		// config, and kills the running agent process - mirroring the Edit Agent
		// modal's toolType-change branch. The CLI gates this behind --force. When a
		// toolType is present and actually differs, do the switch and ignore any
		// other keys in the same patch (the CLI sends it exclusively).
		const requestedToolType =
			typeof patchObj.toolType === 'string' ? (patchObj.toolType as ToolType) : undefined;
		if (requestedToolType && requestedToolType !== session.toolType) {
			const newTabId = generateId();
			const freshTab: AITab = {
				id: newTabId,
				agentSessionId: null,
				name: null,
				starred: false,
				logs: [],
				inputValue: '',
				stagedImages: [],
				createdAt: Date.now(),
				state: 'idle',
				saveToHistory: true,
			};
			const providerSwitch: Partial<Session> = {
				toolType: requestedToolType,
				aiTabs: [freshTab],
				activeTabId: newTabId,
				closedTabHistory: [],
				// Clear provider-specific overrides - they don't carry across providers.
				customPath: undefined,
				customArgs: undefined,
				customEnvVars: undefined,
				customModel: undefined,
				customContextWindow: undefined,
				// Provenance describes the value cleared above and must not outlive
				// it (finding AD1); mirrors the Edit Agent modal's switch branch.
				contextWindowSource: undefined,
				enableMaestroP: undefined,
				maestroPPath: undefined,
				maestroPMode: undefined,
				// Reset file preview tabs and unified tab order to just the new AI tab.
				filePreviewTabs: [],
				activeFileTabId: null,
				unifiedTabOrder: [{ type: 'ai' as const, id: newTabId }],
				unifiedClosedTabHistory: [],
				// Reset runtime state.
				state: 'idle' as const,
				aiPid: 0,
				executionQueue: [],
			};

			// Kill the existing AI process for the old provider (no-op if none).
			window.maestro.process.kill(`${sessionId}-ai`).catch(() => {});

			setSessions((prev: Session[]) =>
				prev.map((s) => (s.id === sessionId ? { ...s, ...providerSwitch } : s))
			);
			try {
				await window.maestro.sessions.setMany([{ ...session, ...providerSwitch } as any], []);
			} catch (persistErr) {
				logger.error('[Remote] Failed to persist provider switch:', undefined, persistErr);
			}
			window.maestro.process.sendRemoteUpdateSessionConfigResponse(responseChannel, {
				success: true,
			});
			return;
		}

		// Allowlist of editable session config keys. Anything else in the patch is
		// ignored so the CLI can't write arbitrary Session internals.
		const EDITABLE_KEYS = new Set([
			'nudgeMessage',
			'newSessionMessage',
			'customPath',
			'customArgs',
			'customEnvVars',
			'customModel',
			'customEffort',
			'customContextWindow',
			// Provenance for the key above (finding AD1). Must be allowlisted or
			// `maestro-cli update-agent --context-window` writes the number without
			// its provenance, and the value it just set stays outranked by the
			// provider's report - the deliberate edit would silently not apply.
			'contextWindowSource',
			'enableMaestroP',
			'maestroPMode',
			'maestroPPath',
		]);

		// Build the field patch. A `null` value clears the field (sets undefined);
		// any other provided value is written through as-is.
		const patch = patchObj;
		const updated: Partial<Session> = {};
		for (const key of Object.keys(patch)) {
			if (!EDITABLE_KEYS.has(key)) continue;
			const value = patch[key];
			(updated as Record<string, unknown>)[key] = value === null ? undefined : value;
		}

		// Clearing the window clears its provenance too, even when the caller sent
		// only `customContextWindow: null`. Otherwise a stale 'user-edited' outlives
		// the value it described and the next window set without provenance
		// inherits precedence nobody asked for (finding AD1).
		if (patch.customContextWindow === null) {
			updated.contextWindowSource = undefined;
		}

		if (Object.keys(updated).length === 0) {
			window.maestro.process.sendRemoteUpdateSessionConfigResponse(responseChannel, {
				success: false,
				error: 'No editable config fields in patch',
			});
			return;
		}

		setSessions((prev: Session[]) =>
			prev.map((s) => (s.id === sessionId ? { ...s, ...updated } : s))
		);

		try {
			await window.maestro.sessions.setMany([{ ...session, ...updated } as any], []);
		} catch (persistErr) {
			logger.error('[Remote] Failed to persist session config:', undefined, persistErr);
		}

		window.maestro.process.sendRemoteUpdateSessionConfigResponse(responseChannel, {
			success: true,
		});
	});

	// Handle remote rename session from web interface
	useEventListener('maestro:remoteRenameSession', async (e: Event) => {
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

		// Flush the rename to disk before signaling success: the renderer's
		// 2s debounced persistence path would otherwise let a follow-up CLI
		// read see the stale name. setMany merges incrementally so the next
		// debounced flush is idempotent.
		try {
			await window.maestro.sessions.setMany([{ ...session, name: newName } as any], []);
		} catch (persistErr) {
			logger.error('[Remote] Failed to persist session rename:', undefined, persistErr);
		}

		window.maestro.process.sendRemoteRenameSessionResponse(responseChannel, true);
	});

	// --- Group CRUD ---

	// Handle remote create group from web interface
	useEventListener('maestro:remoteCreateGroup', (e: Event) => {
		const {
			name,
			emoji,
			parentGroupId: requestedParentGroupId,
			responseChannel,
		} = (e as CustomEvent).detail;
		const trimmed = name.trim();
		if (!trimmed) {
			window.maestro.process.sendRemoteCreateGroupResponse(responseChannel, null);
			return;
		}
		const parentGroupId =
			typeof requestedParentGroupId === 'string' && requestedParentGroupId
				? requestedParentGroupId
				: undefined;
		if (!canCreateGroupInside(useSessionStore.getState().groups, parentGroupId)) {
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
				kind: 'user',
				...(parentGroupId ? { parentGroupId } : {}),
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
		setGroups((prev: Group[]) => removeGroupAndPromoteChildren(prev, groupId));
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
