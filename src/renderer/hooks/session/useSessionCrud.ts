/**
 * useSessionCrud - extracted from App.tsx
 *
 * Handles session create/read/update/delete operations:
 *   - addNewSession (opens modal)
 *   - createNewSession (core creation logic)
 *   - deleteSession (opens confirmation modal)
 *   - deleteWorktreeGroup (removes group + all agents)
 *   - startRenamingSession / finishRenamingSession
 *   - toggleBookmark
 *   - handleDragStart / handleDragOver
 *   - handleCreateGroupAndMove / handleGroupCreated
 *
 * Reads from: sessionStore, settingsStore, uiStore, modalStore
 */

import { useCallback, useState } from 'react';
import { projectTabProvider, resolveTabNativeProvider } from '../../utils/providerTabSessions';
import type { AdditionalDirectory, ToolType, Session } from '../../types';
import { useSessionStore, selectSessionById } from '../../stores/sessionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useUIStore } from '../../stores/uiStore';
import { useModalStore } from '../../stores/modalStore';
import { useWindowContextOptional } from '../../contexts/WindowContext';
import { notifyToast } from '../../stores/notificationStore';
import { generateId } from '../../utils/ids';
import { validateNewSession } from '../../utils/sessionValidation';
import { getTerminalSessionId } from '../../utils/terminalTabHelpers';
import { gitService } from '../../services/git';
import { applySeededTokenProxy } from '../../services/groupDefaultsPublish';
import { buildNewAgentRecord, newAgentClaudeInteractive } from '../../../shared/newAgentRecord';
import type { CodexTransport } from '../../../shared/codexTransport';
import type { RunOnSourceTarget } from '../../../shared/local-models/run-on';
import type { PeerGrants } from '../../../shared/peerAgents';
import type { GroupDefaultsCreateExtras } from '../../../shared/groupAgentDefaults';
import { logger } from '../../utils/logger';
import { killAgentAiProcesses } from '../../services/process';
import { removeGroupAndPromoteChildren } from '../../../shared/groupHierarchy';
import { withAgentInGroup } from '../../../shared/maestro-lib/agents/rules';

// ============================================================================
// Dependencies interface
// ============================================================================

export interface UseSessionCrudDeps {
	/** Flush session persistence immediately (from useDebouncedPersistence) */
	flushSessionPersistence: () => void;
	/** Track removed worktree paths to prevent re-discovery */
	setRemovedWorktreePaths: React.Dispatch<React.SetStateAction<Set<string>>>;
	/** Show confirmation dialog before destructive operations (from useSessionLifecycle) */
	showConfirmation: (message: string, onConfirm: () => void) => void;
	/** Ref to main input element (for auto-focus after session creation) */
	inputRef: React.RefObject<HTMLTextAreaElement | null>;
	/** Open the create-group modal (from group modal state) */
	setCreateGroupModalOpen: (open: boolean) => void;
}

// ============================================================================
// Return type
// ============================================================================

export interface UseSessionCrudReturn {
	/** Opens the new instance modal */
	addNewSession: () => void;
	/** Core session creation logic */
	createNewSession: (
		agentId: string,
		workingDir: string,
		name: string,
		nudgeMessage?: string,
		newSessionMessage?: string,
		customPath?: string,
		customArgs?: string,
		customEnvVars?: Record<string, string>,
		customModel?: string,
		customContextWindow?: number,
		customProviderPath?: string,
		sessionSshRemoteConfig?: {
			enabled: boolean;
			remoteId: string | null;
			workingDirOverride?: string;
		},
		customEffort?: string,
		groupId?: string,
		enableMaestroP?: boolean,
		maestroPPath?: string,
		maestroPMode?: 'interactive' | 'dynamic',
		retryOnAvailabilityErrors?: boolean,
		retryOnTokenExhaustion?: boolean,
		additionalDirectories?: AdditionalDirectory[],
		/** Codex only: spend a reset credit automatically on quota exhaustion. Defaults off. */
		codexAutoResetOnExhaustion?: boolean,
		/** Codex only: which transport chat turns use. `undefined` means `exec`. */
		codexTransport?: CodexTransport,
		/** Local Models gateway URL, already validated; `undefined` sets none. */
		gatewayUrl?: string,
		/** Run on target, already validated; `undefined` means the provider's model. */
		runOn?: RunOnSourceTarget,
		/** Peer Agents: the explicit rows and the two grants. An absent field means that source is off. */
		peerGrants?: PeerGrants,
		/** Group defaults the create form has no control for; stamped onto the new agent. */
		seedExtras?: GroupDefaultsCreateExtras
	) => Promise<void>;
	/** Opens the delete agent confirmation modal */
	deleteSession: (id: string) => void;
	/** Deletes entire worktree group and all its agents */
	deleteWorktreeGroup: (groupId: string) => void;
	/** Opens rename UI for a session */
	startRenamingSession: (editKey: string) => void;
	/** Completes session rename */
	finishRenamingSession: (sessId: string, newName: string) => void;
	/** Toggles bookmarked state on a session */
	toggleBookmark: (sessionId: string) => void;
	/** Initiates drag for a session */
	handleDragStart: (sessionId: string) => void;
	/** Allows drop */
	handleDragOver: (e: React.DragEvent) => void;
	/** Opens create group modal with pending session to move */
	handleCreateGroupAndMove: (sessionId: string) => void;
	/** Clears a pending move when the create-group modal is cancelled. */
	clearPendingMoveToGroup: () => void;
	/** Callback when a group is created - moves pending session to it */
	handleGroupCreated: (groupId: string) => void;
	/** The session ID pending move to a newly created group */
	pendingMoveToGroupSessionId: string | null;
}

// ============================================================================
// Hook implementation
// ============================================================================

export function useSessionCrud(deps: UseSessionCrudDeps): UseSessionCrudReturn {
	const {
		flushSessionPersistence,
		setRemovedWorktreePaths,
		showConfirmation,
		inputRef,
		setCreateGroupModalOpen,
	} = deps;

	// --- Store actions (stable via getState) ---
	const { setSessions, setActiveSessionId, setGroups } = useSessionStore.getState();
	const { setEditingSessionId, setDraggingSessionId, setActiveFocus } = useUIStore.getState();
	// PERF: Do not call getModalActions() at render time for deleteSession deps -
	// it returns fresh wrapper functions every call and would bust SessionList memo.

	// Multi-window: claim a newly-created agent for the window that created it so
	// it never momentarily surfaces in the primary's catch-all (spawn flicker).
	// Optional - undefined outside a WindowProvider (web build / isolation tests),
	// where creation is unscoped and this is a no-op. Pulled out as a stable ref
	// (memoized on isMainWindow inside the context) so it can sit in createNewSession's
	// deps without re-creating the callback on every window-scope change.
	const registerNewSession = useWindowContextOptional()?.registerNewSession;

	// --- Local state ---
	const [pendingMoveToGroupSessionId, setPendingMoveToGroupSessionId] = useState<string | null>(
		null
	);

	// ========================================================================
	// addNewSession - opens the new agent choice modal (Manual vs Wizard)
	// ========================================================================
	const addNewSession = useCallback(() => {
		useModalStore.getState().openModal('newAgentChoice');
	}, []);

	// ========================================================================
	// createNewSession - core session creation logic
	// ========================================================================
	const createNewSession = useCallback(
		async (
			agentId: string,
			workingDir: string,
			name: string,
			nudgeMessage?: string,
			newSessionMessage?: string,
			customPath?: string,
			customArgs?: string,
			customEnvVars?: Record<string, string>,
			customModel?: string,
			customContextWindow?: number,
			customProviderPath?: string,
			sessionSshRemoteConfig?: {
				enabled: boolean;
				remoteId: string | null;
				workingDirOverride?: string;
			},
			customEffort?: string,
			groupId?: string,
			enableMaestroP?: boolean,
			maestroPPath?: string,
			maestroPMode?: 'interactive' | 'dynamic',
			retryOnAvailabilityErrors?: boolean,
			retryOnTokenExhaustion?: boolean,
			additionalDirectories?: AdditionalDirectory[],
			/** Codex only: spend a reset credit automatically on quota exhaustion. Defaults off. */
			codexAutoResetOnExhaustion?: boolean,
			/** Codex only: which transport chat turns use. `undefined` means `exec`. */
			codexTransport?: CodexTransport,
			/** Local Models gateway URL, already validated; `undefined` sets none. */
			gatewayUrl?: string,
			/** Run on target, already validated; `undefined` means the provider's model. */
			runOn?: RunOnSourceTarget,
			/** Peer Agents: the explicit rows and the two grants. An absent field means that source is off. */
			peerGrants?: PeerGrants,
			/** Group defaults the create form has no control for; stamped onto the new agent. */
			seedExtras?: GroupDefaultsCreateExtras
		) => {
			try {
				// Get agent definition to get correct command
				const agent = await (window as any).maestro.agents.get(agentId);
				if (!agent) {
					logger.error(`Agent not found: ${agentId}`);
					return;
				}
				const currentSessions = useSessionStore.getState().sessions;
				const validation = validateNewSession(
					name,
					workingDir,
					agentId as ToolType,
					currentSessions,
					sessionSshRemoteConfig?.enabled ? sessionSshRemoteConfig.remoteId : null
				);
				if (!validation.valid) {
					logger.error(`Session validation failed: ${validation.error}`);
					notifyToast({
						type: 'error',
						title: 'Agent Creation Failed',
						message: validation.error || 'Cannot create duplicate agent',
					});
					return;
				}

				const newId = generateId();
				const aiPid = 0;

				// For SSH sessions, defer git check until onSshRemote fires
				const isRemoteSession = sessionSshRemoteConfig?.enabled && sessionSshRemoteConfig.remoteId;
				let isGitRepo = false;
				let gitBranches: string[] | undefined;
				let gitTags: string[] | undefined;
				let gitRefsCacheTime: number | undefined;

				if (!isRemoteSession) {
					isGitRepo = await gitService.isRepo(workingDir);
					if (isGitRepo) {
						[gitBranches, gitTags] = await Promise.all([
							gitService.getBranches(workingDir),
							gitService.getTags(workingDir),
						]);
						gitRefsCacheTime = Date.now();
					}
				}

				const currentDefaults = useSettingsStore.getState();
				const newSession: Session = {
					...buildNewAgentRecord(
						{
							id: newId,
							name,
							toolType: agentId,
							cwd: workingDir,
							groupId,
							saveToHistory: currentDefaults.defaultSaveToHistory,
							showThinking: currentDefaults.defaultShowThinking,
						},
						{ generateId }
					),
					toolType: agentId as ToolType,
					additionalDirectories,
					isGitRepo,
					gitBranches,
					gitTags,
					gitRefsCacheTime,
					aiPid,
					nudgeMessage,
					newSessionMessage,
					customPath,
					customArgs,
					customEnvVars,
					customModel,
					customContextWindow,
					customProviderPath,
					customEffort: customEffort?.trim() || undefined,
					sessionSshRemoteConfig,
					enableMaestroP,
					maestroPPath,
					maestroPMode,
					// Agent Resilience: only persist an explicit OFF; leaving these
					// undefined reads as ON via `resilienceEnabled`, so the default
					// behavior needs no stored value.
					retryOnAvailabilityErrors,
					retryOnTokenExhaustion,
					// Only persist an explicit opt-IN. The default is off, so an absent
					// value already means off and storing `false` on every non-Codex
					// agent would be noise in every session record.
					codexAutoResetOnExhaustion: codexAutoResetOnExhaustion === true ? true : undefined,
					// Same rule: `exec` is the default, so only the opt-in is stored.
					codexTransport: codexTransport === 'app-server' ? 'app-server' : undefined,
					// Set from the New Agent Models tab. The token proxy mode is not set
					// here: absent reads as `passthrough` when this URL is the proxy's.
					gatewayUrl: gatewayUrl || undefined,
					// Set from the New Agent Models tab. Absent means the provider's
					// own model. A target takes the gateway's place at launch.
					runOn,
					// Set from the New Agent Peers tab. Each source is stored only when
					// it is on: an absent field is what the roster reads as off.
					peerAgents: peerGrants?.peerAgents,
					groupPeerAccess: peerGrants?.groupPeerAccess,
					worktreePeerAccess: peerGrants?.worktreePeerAccess,
					// Group defaults the New Agent form has no control for, copied from
					// the group the agent was created in. The token proxy mode and its
					// background requests target are not among them: they are applied
					// below, through the writers that work out the proxy's address.
					customEnvVarsDisabled: seedExtras?.customEnvVarsDisabled,
					tierTargets: seedExtras?.tierTargets,
					systemOneOptOut: seedExtras?.systemOneOptOut,
					claudeInteractive: newAgentClaudeInteractive(agentId),
				};

				setSessions((prev) => [...prev, newSession]);
				setActiveSessionId(newId);
				// The first spawn reads its routing (Codex transport, Claude token mode)
				// from the persisted record, so do not leave the new agent sitting in a
				// debounce that any streaming agent keeps re-arming.
				setTimeout(() => flushSessionPersistence(), 0);
				// Claim the agent for THIS window before any process spawns, so a
				// secondary window surfaces it immediately and the primary's catch-all
				// never flashes it. No-op in the primary window / outside a WindowProvider.
				void registerNewSession?.(newId);
				// Publish membership immediately: output from another agent can keep
				// resetting the debounce, leaving this agent without a host owner.
				flushSessionPersistence();
				(window as any).maestro.stats.recordSessionCreated({
					sessionId: newId,
					agentType: agentId,
					projectPath: workingDir,
					createdAt: Date.now(),
					isRemote: !!isRemoteSession,
					isWorktree: false,
				});

				setActiveFocus('main');
				setTimeout(() => inputRef.current?.focus(), 50);

				// The agent is in the store now, which is where the proxy writers
				// look it up. Not awaited: the agent exists whatever they answer, and
				// a refusal is reported by its own toast.
				if (seedExtras?.tokenProxyMode) {
					void applySeededTokenProxy(newId, seedExtras);
				}
			} catch (error) {
				logger.error('Failed to create session:', undefined, error);
			}
		},
		[
			setSessions,
			setActiveSessionId,
			setActiveFocus,
			inputRef,
			registerNewSession,
			flushSessionPersistence,
		]
	);

	// ========================================================================
	// deleteSession - opens the delete agent confirmation modal
	// ========================================================================
	const deleteSession = useCallback((id: string) => {
		const session = selectSessionById(id)(useSessionStore.getState());
		if (!session) return;
		// Event-time modal open - stable callback identity for SessionList memo.
		useModalStore.getState().openModal('deleteAgent', { session });
	}, []);

	// ========================================================================
	// deleteWorktreeGroup - removes group + all agents
	// ========================================================================
	const deleteWorktreeGroup = useCallback(
		(groupId: string) => {
			const currentGroups = useSessionStore.getState().groups;
			const currentSessions = useSessionStore.getState().sessions;
			const group = currentGroups.find((g) => g.id === groupId);
			if (!group) return;

			const groupSessions = currentSessions.filter((s) => s.groupId === groupId);
			const sessionCount = groupSessions.length;

			showConfirmation(
				`Are you sure you want to remove the group "${group.name}" and all ${sessionCount} agent${
					sessionCount !== 1 ? 's' : ''
				} in it? This action cannot be undone.`,
				async () => {
					for (const session of groupSessions) {
						try {
							await killAgentAiProcesses(session.id);
						} catch (error) {
							logger.error('Failed to kill AI process:', undefined, error);
						}
						try {
							await (window as any).maestro.process.kill(`${session.id}-terminal`);
						} catch (error) {
							logger.error('Failed to kill terminal process:', undefined, error);
						}
						// Kill terminal tab PTYs - each tab has its own PTY
						for (const tab of session.terminalTabs || []) {
							try {
								await (window as any).maestro.process.kill(
									getTerminalSessionId(session.id, tab.id)
								);
							} catch (error) {
								logger.error('Failed to kill terminal tab process:', undefined, error);
							}
						}
						try {
							await (window as any).maestro.playbooks.deleteAll(session.id);
						} catch (error) {
							logger.error('Failed to delete playbooks:', undefined, error);
						}
					}

					const pathsToTrack = groupSessions
						.filter((s) => s.worktreeParentPath && s.cwd)
						.map((s) => s.cwd);

					if (pathsToTrack.length > 0) {
						setRemovedWorktreePaths((prev) => new Set([...prev, ...pathsToTrack]));
					}

					const sessionIdsToRemove = new Set(groupSessions.map((s) => s.id));
					const latestSessions = useSessionStore.getState().sessions;
					const newSessions = latestSessions.filter((s) => !sessionIdsToRemove.has(s.id));
					setSessions(newSessions);
					setGroups((prev) => removeGroupAndPromoteChildren(prev, groupId));

					setTimeout(() => flushSessionPersistence(), 0);

					const latestActiveId = useSessionStore.getState().activeSessionId;
					if (sessionIdsToRemove.has(latestActiveId) && newSessions.length > 0) {
						setActiveSessionId(newSessions[0].id);
					} else if (newSessions.length === 0) {
						setActiveSessionId('');
					}

					notifyToast({
						type: 'success',
						title: 'Group Removed',
						message: `Removed "${group.name}" and ${sessionCount} agent${
							sessionCount !== 1 ? 's' : ''
						}`,
					});
				}
			);
		},
		[
			showConfirmation,
			setSessions,
			setGroups,
			setActiveSessionId,
			setRemovedWorktreePaths,
			flushSessionPersistence,
		]
	);

	// ========================================================================
	// startRenamingSession / finishRenamingSession
	// ========================================================================
	const startRenamingSession = useCallback(
		(editKey: string) => {
			setEditingSessionId(editKey);
		},
		[setEditingSessionId]
	);

	const finishRenamingSession = useCallback(
		(sessId: string, newName: string) => {
			setSessions((prev) => {
				const updated = prev.map((s) => (s.id === sessId ? { ...s, name: newName } : s));
				const session = updated.find((s) => s.id === sessId);
				const activeTab = session?.aiTabs?.find((t) => t.id === session.activeTabId);
				const fallback =
					session &&
					[activeTab, session.aiTabs?.[0]]
						.filter((tab) => tab !== undefined)
						.map((tab) => projectTabProvider(session, tab, resolveTabNativeProvider(tab, session)))
						.find((native) => native.tab?.agentSessionId);
				// The legacy ID belongs to the agent default; a tab fallback carries its own owner.
				const providerSessionId = session?.agentSessionId || fallback?.tab?.agentSessionId;
				if (providerSessionId && session?.projectRoot) {
					const agentId = session.agentSessionId ? session.toolType : fallback!.agent.toolType;
					if (agentId === 'claude-code') {
						(window as any).maestro.claude
							.updateSessionName(session.projectRoot, providerSessionId, newName)
							.catch((err: Error) =>
								logger.warn('[finishRenamingSession] Failed to sync session name:', undefined, err)
							);
					} else {
						(window as any).maestro.agentSessions
							.setSessionName(agentId, session.projectRoot, providerSessionId, newName)
							.catch((err: Error) =>
								logger.warn('[finishRenamingSession] Failed to sync session name:', undefined, err)
							);
					}
				}
				return updated;
			});
			setEditingSessionId(null);
		},
		[setSessions, setEditingSessionId]
	);

	// ========================================================================
	// toggleBookmark
	// ========================================================================
	const toggleBookmark = useCallback((sessionId: string) => {
		useSessionStore
			.getState()
			.setSessions((prev) =>
				prev.map((s) => (s.id === sessionId ? { ...s, bookmarked: !s.bookmarked } : s))
			);
	}, []);

	// ========================================================================
	// Drag and drop handlers
	// ========================================================================
	const handleDragStart = useCallback(
		(sessionId: string) => {
			setDraggingSessionId(sessionId);
		},
		[setDraggingSessionId]
	);

	const handleDragOver = useCallback((e: React.DragEvent) => {
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
	}, []);

	// ========================================================================
	// Group + move handlers
	// ========================================================================
	const handleCreateGroupAndMove = useCallback(
		(sessionId: string) => {
			setPendingMoveToGroupSessionId(sessionId);
			setCreateGroupModalOpen(true);
		},
		[setCreateGroupModalOpen]
	);

	const clearPendingMoveToGroup = useCallback(() => {
		setPendingMoveToGroupSessionId(null);
	}, []);

	const handleGroupCreated = useCallback(
		(groupId: string) => {
			if (pendingMoveToGroupSessionId) {
				setSessions((prev) => withAgentInGroup(prev, pendingMoveToGroupSessionId, groupId));
				setPendingMoveToGroupSessionId(null);
			}
		},
		[pendingMoveToGroupSessionId, setSessions]
	);

	return {
		addNewSession,
		createNewSession,
		deleteSession,
		deleteWorktreeGroup,
		startRenamingSession,
		finishRenamingSession,
		toggleBookmark,
		handleDragStart,
		handleDragOver,
		handleCreateGroupAndMove,
		clearPendingMoveToGroup,
		handleGroupCreated,
		pendingMoveToGroupSessionId,
	};
}
