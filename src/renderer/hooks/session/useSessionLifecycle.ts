import { requestProviderTranslation } from '../../services/providerTranslation';
/**
 * useSessionLifecycle - extracted from App.tsx (Phase 2H)
 *
 * Owns session operation callbacks and session-level effects:
 *   - handleSaveEditAgent: persist agent config changes
 *   - handleRenameTab: rename tab with multi-agent persistence
 *   - performDeleteSession: multi-step session deletion with cleanup
 *   - showConfirmation: modal coordination helper
 *   - toggleTabStar / toggleTabUnread / toggleUnreadFilter: tab state toggles
 *
 * Effects:
 *   - Groups persistence (sync groups to electron-store)
 *   - Navigation history tracking (push on session/tab change)
 *
 * Reads from: sessionStore, modalStore
 */

import { useCallback, useEffect } from 'react';
import type { AdditionalDirectory, Session } from '../../types';
import type { ToolType } from '../../../shared/types';
import {
	useSessionStore,
	selectActiveSession,
	updateSessionWith,
	updateAiTab,
} from '../../stores/sessionStore';
import { useGroupChatStore } from '../../stores/groupChatStore';
import { useModalStore } from '../../stores/modalStore';
import { notifyToast } from '../../stores/notificationStore';
import { getActiveTab } from '../../utils/tabHelpers';
import { requestManualTabAutoName } from '../../services/tabAutoNaming';
import { renameTabInSession } from '../../services/tabRename';
import { getTerminalSessionId } from '../../utils/terminalTabHelpers';
import { resolveActiveNavTab } from './useNavigationHistory';
import type { NavHistoryEntry } from './useNavigationHistory';
import { captureException } from '../../utils/sentry';
import type { CodexTransport } from '../../../shared/codexTransport';
import { persistTabStarred } from '../../utils/starredSessions';
import { toggleTabUnreadFilter } from '../../services/unreadFilters';
import { killAgentAiProcesses } from '../../services/process';
import {
	withWorkingDirectory,
	workingDirectoryChangeBlocker,
} from '../../utils/agentWorkingDirectory';

// ============================================================================
// Dependencies interface
// ============================================================================

export interface SessionLifecycleDeps {
	/** Flush debounced session persistence immediately (from useDebouncedPersistence) */
	flushSessionPersistence: () => void;
	/** Track removed worktree paths to prevent re-discovery (from useWorktreeHandlers) */
	setRemovedWorktreePaths: React.Dispatch<React.SetStateAction<Set<string>>>;
	/** Push a navigation entry to the shared history stack */
	pushNavigation: (entry: NavHistoryEntry) => void;
}

// ============================================================================
// Return type
// ============================================================================

export interface SessionLifecycleReturn {
	/** Save agent configuration changes (name, nudge, custom path/args/env, SSH config) */
	handleSaveEditAgent: (
		sessionId: string,
		name: string,
		toolType?: ToolType,
		nudgeMessage?: string,
		newSessionMessage?: string,
		customPath?: string,
		customArgs?: string,
		customEnvVars?: Record<string, string>,
		customModel?: string,
		customEffort?: string,
		customContextWindow?: number,
		sessionSshRemoteConfig?: {
			enabled: boolean;
			remoteId: string | null;
			workingDirOverride?: string;
			syncHistory?: boolean;
			shareHistoryToProjectDir?: boolean;
		},
		enableMaestroP?: boolean,
		maestroPPath?: string,
		maestroPMode?: 'interactive' | 'dynamic',
		retryOnAvailabilityErrors?: boolean,
		retryOnTokenExhaustion?: boolean,
		additionalDirectories?: AdditionalDirectory[],
		/** Provenance of `customContextWindow` (finding AD1). */
		contextWindowSource?: 'user-edited',
		/** Env vars parked with the eye button: kept, but never handed to a spawn. */
		customEnvVarsDisabled?: Record<string, string>,
		/** New working directory; `undefined` when the user left it unchanged. */
		workingDirectory?: string,
		/** Codex only: spend a reset credit automatically on quota exhaustion. Defaults off. */
		codexAutoResetOnExhaustion?: boolean,
		/** Codex only: which transport chat turns use. `undefined` means `exec`. */
		codexTransport?: CodexTransport,
		acceptTranslationLimitations?: boolean,
		selectedUserResources?: string[],
		migrationPlanId?: string
	) => void | Promise<void>;
	/** Rename the currently-selected tab (persists to agent session storage + history) */
	handleRenameTab: (newName: string) => void;
	/** Auto-name the currently-selected tab: close modal, show spinner, generate name via agent */
	handleAutoNameTab: () => void;
	/** Delete a session: kill processes, clean up playbooks, optionally erase working dir */
	performDeleteSession: (session: Session, eraseWorkingDirectory: boolean) => Promise<void>;
	/** Show a confirmation modal with a message and callback */
	showConfirmation: (message: string, onConfirm: () => void) => void;
	/** Toggle star on the active tab */
	toggleTabStar: () => void;
	/** Toggle unread status on the active tab */
	toggleTabUnread: () => void;
	/** Toggle unread filter with active tab save/restore */
	toggleUnreadFilter: () => void;
}

// ============================================================================
// Selectors
// ============================================================================

const selectRenameTabId = (s: ReturnType<typeof useModalStore.getState>) =>
	s.getData('renameTab')?.tabId ?? null;
const selectGroups = (s: ReturnType<typeof useSessionStore.getState>) => s.groups;
const selectInitialLoadComplete = (s: ReturnType<typeof useSessionStore.getState>) =>
	s.initialLoadComplete;
const selectGroupsLoaded = (s: ReturnType<typeof useSessionStore.getState>) => s.groupsLoaded;
const selectResolvedActiveSessionId = (s: ReturnType<typeof useSessionStore.getState>) =>
	selectActiveSession(s)?.id;

// ============================================================================
// Hook
// ============================================================================

export function useSessionLifecycle(deps: SessionLifecycleDeps): SessionLifecycleReturn {
	const { flushSessionPersistence, setRemovedWorktreePaths, pushNavigation } = deps;

	// --- Store subscriptions ---
	// PERF: Never useSessionStore(selectActiveSession). Streamed logs/tokens would
	// wake App via this hook. Rename handlers resolve via getState(); nav tracking
	// uses narrow focus fields only.
	const renameTabId = useModalStore(selectRenameTabId);
	const groups = useSessionStore(selectGroups);
	const initialLoadComplete = useSessionStore(selectInitialLoadComplete);
	const groupsLoaded = useSessionStore(selectGroupsLoaded);
	const activeSessionId = useSessionStore(selectResolvedActiveSessionId);
	const activeTabId = useSessionStore((s) => selectActiveSession(s)?.activeTabId);
	const activeFileTabId = useSessionStore((s) => selectActiveSession(s)?.activeFileTabId);
	const activeBrowserTabId = useSessionStore((s) => selectActiveSession(s)?.activeBrowserTabId);
	const activeTerminalTabId = useSessionStore((s) => selectActiveSession(s)?.activeTerminalTabId);
	const activeInputMode = useSessionStore((s) => selectActiveSession(s)?.inputMode);
	const activeAiTabCount = useSessionStore((s) => selectActiveSession(s)?.aiTabs?.length);

	// ====================================================================
	// Callbacks
	// ====================================================================

	const handleSaveEditAgent = useCallback(
		async (
			sessionId: string,
			name: string,
			toolType?: ToolType,
			nudgeMessage?: string,
			newSessionMessage?: string,
			customPath?: string,
			customArgs?: string,
			customEnvVars?: Record<string, string>,
			customModel?: string,
			customEffort?: string,
			customContextWindow?: number,
			sessionSshRemoteConfig?: {
				enabled: boolean;
				remoteId: string | null;
				workingDirOverride?: string;
				syncHistory?: boolean;
				shareHistoryToProjectDir?: boolean;
			},
			enableMaestroP?: boolean,
			maestroPPath?: string,
			maestroPMode?: 'interactive' | 'dynamic',
			retryOnAvailabilityErrors?: boolean,
			retryOnTokenExhaustion?: boolean,
			additionalDirectories?: AdditionalDirectory[],
			/** Provenance of `customContextWindow` (finding AD1). */
			contextWindowSource?: 'user-edited',
			/** Env vars parked with the eye button: kept, but never handed to a spawn. */
			customEnvVarsDisabled?: Record<string, string>,
			/** New working directory; `undefined` when the user left it unchanged. */
			workingDirectory?: string,
			/** Codex only: spend a reset credit automatically on quota exhaustion. Defaults off. */
			codexAutoResetOnExhaustion?: boolean,
			/** Codex only: which transport chat turns use. `undefined` means `exec`. */
			codexTransport?: CodexTransport,
			acceptTranslationLimitations?: boolean,
			selectedUserResources?: string[],
			migrationPlanId?: string
		) => {
			const before = useSessionStore.getState().sessions.find((s) => s.id === sessionId);
			if (toolType && before && toolType !== before.toolType) {
				if (customPath || customArgs || Object.keys(customEnvVars ?? {}).length)
					throw new Error(
						'Save provider migration separately from binary, arguments or account environment edits'
					);
				if (workingDirectory && withWorkingDirectory(before, workingDirectory) !== before)
					throw new Error('Change the working directory separately from provider migration');
				const report = await requestProviderTranslation(
					{
						agentId: sessionId,
						destination: toolType,
						action: 'apply',
						acceptLimitations: acceptTranslationLimitations,
						selectedUserResources,
						planId: migrationPlanId,
					},
					{ waitForDeferred: true }
				);
				if (!report.success)
					throw new Error(report.error ?? report.result?.error ?? 'Provider migration refused');
			}
			// The dialog disables the field while the agent runs, but the agent can
			// start between opening the dialog and saving. Say so rather than
			// silently keeping the old directory.
			let relocateTo = workingDirectory;
			const current = useSessionStore.getState().sessions.find((s) => s.id === sessionId);
			// Only a directory the helper would actually move to is gated: a value
			// that differs by a trailing slash is not a move, and must not be
			// reported as a refused one.
			const wouldMove =
				!!relocateTo && !!current && withWorkingDirectory(current, relocateTo) !== current;
			const blocker = wouldMove ? workingDirectoryChangeBlocker(current!) : null;
			if (blocker) {
				relocateTo = undefined;
				notifyToast({ color: 'yellow', title: 'Working directory not changed', message: blocker });
			}

			updateSessionWith(sessionId, (s) => {
				const updatedFields: Partial<Session> = {
					name,
					nudgeMessage,
					newSessionMessage,
					// Directory grants are provider-agnostic, so (like resilience) they
					// survive a provider switch below.
					additionalDirectories,
					customPath,
					customArgs,
					customEnvVars: toolType
						? { ...(s.customEnvVars ?? {}), ...(customEnvVars ?? {}) }
						: customEnvVars,
					customEnvVarsDisabled,
					customModel,
					customEffort,
					customContextWindow,
					contextWindowSource,
					sessionSshRemoteConfig,
					enableMaestroP,
					maestroPPath,
					maestroPMode,
					// Agent Resilience: resilience is provider-agnostic, so it is NOT
					// cleared on a provider switch below (unlike maestroP fields).
					retryOnAvailabilityErrors,
					retryOnTokenExhaustion,
					// Codex automatic usage resets. Like resilience above, this is left
					// alone by the provider switch below: an agent moved off Codex keeps
					// the preference so moving back does not silently lose it, and the
					// flag is inert for any provider without reset credits.
					codexAutoResetOnExhaustion,
					// Same provider-switch rule as the reset flag: kept, and inert off
					// Codex because `resolveCodexTransport` ignores it there. Only the
					// opt-in is stored, so choosing Standard clears the field.
					codexTransport: codexTransport === 'app-server' ? 'app-server' : undefined,
				};

				const next = { ...s, ...updatedFields };
				return relocateTo ? withWorkingDirectory(next, relocateTo) : next;
			});
			// The spawn path routes from the PERSISTED record (Codex transport, Claude
			// token mode), so a stale renderer cannot send a turn somewhere other than
			// what is saved. Persistence is debounced and re-arms on every store
			// change, so while any agent streams this save could still be unwritten
			// when the next turn spawns. Write it now.
			setTimeout(() => flushSessionPersistence(), 0);
		},
		[flushSessionPersistence]
	);

	// The rename itself is the shared explicit-target service (a tab window's
	// owner renames a popped tab with the same function).
	const handleRenameTab = useCallback(
		(newName: string) => {
			const activeSession = selectActiveSession(useSessionStore.getState());
			if (!activeSession || !renameTabId) return;
			renameTabInSession(activeSession.id, renameTabId, newName);
		},
		[renameTabId]
	);

	const handleAutoNameTab = useCallback(() => {
		const activeSession = selectActiveSession(useSessionStore.getState());
		if (!activeSession || !renameTabId) return;

		// The user pressed "Auto" - honor it even with automatic naming switched off,
		// and overwrite whatever the tab is called now. Close the modal once naming
		// has started; with nothing to name from, it stays open.
		if (requestManualTabAutoName(activeSession.id, renameTabId)) {
			useModalStore.getState().closeModal('renameTab');
		}
	}, [renameTabId]);

	const performDeleteSession = useCallback(
		async (session: Session, eraseWorkingDirectory: boolean) => {
			const id = session.id;

			// Record session closure for Usage Dashboard (before cleanup)
			window.maestro.stats.recordSessionClosed(id, Date.now());

			// Kill all processes for this session (AI + legacy terminal + terminal tabs)
			try {
				await killAgentAiProcesses(id);
			} catch (error) {
				captureException(error, {
					extra: { sessionId: id, operation: 'kill-ai' },
				});
			}

			try {
				await window.maestro.process.kill(`${id}-terminal`);
			} catch (error) {
				captureException(error, {
					extra: { sessionId: id, operation: 'kill-terminal' },
				});
			}

			// Kill terminal tab PTYs - each tab has its own PTY with ID {sessionId}-terminal-{tabId}
			for (const tab of session.terminalTabs || []) {
				try {
					await window.maestro.process.kill(getTerminalSessionId(id, tab.id));
				} catch (error) {
					captureException(error, {
						extra: { sessionId: id, tabId: tab.id, operation: 'kill-terminal-tab' },
					});
				}
			}

			// Delete associated playbooks
			try {
				await window.maestro.playbooks.deleteAll(id);
			} catch (error) {
				captureException(error, {
					extra: { sessionId: id, operation: 'delete-playbooks' },
				});
			}

			// If this is a worktree session, track its path to prevent re-discovery
			if (session.worktreeParentPath && session.cwd) {
				setRemovedWorktreePaths((prev) => new Set([...prev, session.cwd]));
			}

			// Optionally erase the working directory (move to trash)
			if (eraseWorkingDirectory && session.cwd) {
				try {
					await window.maestro.shell.trashItem(session.cwd);
				} catch (error) {
					captureException(error, {
						extra: { sessionId: id, cwd: session.cwd, operation: 'trash-working-directory' },
					});
					notifyToast({
						title: 'Failed to Erase Directory',
						message: error instanceof Error ? error.message : 'Unknown error',
						type: 'error',
					});
				}
			}

			const { sessions: currentSessions } = useSessionStore.getState();
			const newSessions = currentSessions.filter((s) => s.id !== id);
			useSessionStore.getState().setSessions(newSessions);
			// Flush immediately for critical operation (session deletion)
			setTimeout(() => flushSessionPersistence(), 0);
			if (newSessions.length > 0) {
				useSessionStore.getState().setActiveSessionId(newSessions[0].id);
			} else {
				useSessionStore.getState().setActiveSessionId('');
			}
		},
		[flushSessionPersistence, setRemovedWorktreePaths]
	);

	const showConfirmation = useCallback((message: string, onConfirm: () => void) => {
		// Use openModal with data in a single call to avoid race condition where
		// updateModalData fails because the modal hasn't been opened yet (no existing data)
		useModalStore.getState().openModal('confirm', { message, onConfirm });
	}, []);

	const toggleTabStar = useCallback(() => {
		const session = selectActiveSession(useSessionStore.getState());
		if (!session) return;
		// Star toggle only applies when an AI tab is the visible view - not when a
		// terminal, file preview, or browser tab is focused.
		if (session.inputMode !== 'ai' || session.activeFileTabId || session.activeBrowserTabId) {
			return;
		}
		const tab = getActiveTab(session);
		if (!tab) return;

		const newStarred = !tab.starred;
		updateSessionWith(session.id, (s) => {
			// Persist starred status to session metadata (async) and broadcast the
			// change so the Left Bar's starred-sessions cache refreshes. Uses
			// projectRoot (not cwd) for consistent session storage access.
			persistTabStarred(s, tab, newStarred);
			return {
				...s,
				aiTabs: s.aiTabs.map((t) => (t.id === tab.id ? { ...t, starred: newStarred } : t)),
			};
		});
	}, []);

	const toggleTabUnread = useCallback(() => {
		const session = selectActiveSession(useSessionStore.getState());
		if (!session) return;
		const tab = getActiveTab(session);
		if (!tab) return;

		updateAiTab(session.id, tab.id, (t) => ({ ...t, hasUnread: !t.hasUnread }));
	}, []);

	const toggleUnreadFilter = useCallback(() => {
		toggleTabUnreadFilter();
	}, []);

	// ====================================================================
	// Effects
	// ====================================================================

	// Persist groups directly (groups change infrequently, no need to debounce).
	//
	// Gated on `groupsLoaded`, NOT on `initialLoadComplete`. The latter is set in
	// a `finally` and so is true even when the group read failed, which made this
	// effect write an empty registry over a good one and then rewrite it on every
	// launch after. `groupsLoaded` is true only when `groups:getAll` actually came
	// back, so a registry we never read is never persisted.
	useEffect(() => {
		if (initialLoadComplete && groupsLoaded) {
			window.maestro.groups.setAll(groups);
		}
	}, [groups, initialLoadComplete, groupsLoaded]);

	// Track navigation history when session or AI tab changes
	const activeGroupChatId = useGroupChatStore((s) => s.activeGroupChatId);

	useEffect(() => {
		// Group chat navigation takes precedence when a group chat is open
		if (activeGroupChatId) {
			pushNavigation({ groupChatId: activeGroupChatId });
		} else {
			const activeSession = selectActiveSession(useSessionStore.getState());
			if (!activeSession) return;
			// Resolve the active tab across all kinds using the same priority as
			// findActiveUnifiedTabIndex (terminal > file > browser > ai) so the
			// breadcrumb tracks whichever tab the user actually sees.
			const { tabId, tabKind } = resolveActiveNavTab(activeSession);
			pushNavigation({ sessionId: activeSession.id, tabId, tabKind });
		}
	}, [
		activeSessionId,
		activeTabId,
		activeFileTabId,
		activeBrowserTabId,
		activeTerminalTabId,
		activeInputMode,
		activeAiTabCount,
		activeGroupChatId,
	]);

	return {
		handleSaveEditAgent,
		handleRenameTab,
		handleAutoNameTab,
		performDeleteSession,
		showConfirmation,
		toggleTabStar,
		toggleTabUnread,
		toggleUnreadFilter,
	};
}
