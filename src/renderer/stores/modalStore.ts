/**
 * modalStore - Zustand store for modal visibility state
 *
 * Replaces the monolithic ModalContext (90+ fields) with a registry pattern.
 * Each modal is identified by a ModalId and stores { open: boolean, data?: T }.
 *
 * Benefits:
 * - Consumers subscribe to specific modal IDs only (granular re-renders)
 * - Single Map replaces 90 boolean fields
 * - openModal('settings', { tab }) replaces setSettingsModalOpen(true); setSettingsTab(tab)
 * - Type-safe ModalId union prevents typos
 *
 * Migration: Components can incrementally migrate from useModalContext() to useModalStore().
 * Once all consumers are migrated, ModalContext can be removed.
 */

import { create } from 'zustand';
import type { Session, SettingsTab } from '../types';
import type { SerializableWizardState } from '../components/Wizard';
import type { ConductorBadge } from '../constants/conductorBadges';

// ============================================================================
// Modal Data Types
// ============================================================================

/** Standing ovation celebration data */
export interface StandingOvationData {
	badge: ConductorBadge;
	isNewRecord: boolean;
	recordTimeMs?: number;
}

/** First run celebration data */
export interface FirstRunCelebrationData {
	elapsedTimeMs: number;
	completedTasks: number;
	totalTasks: number;
}

/** Lightbox modal data */
export interface LightboxData {
	image: string | null;
	images: string[];
	source: 'staged' | 'history';
	isGroupChat: boolean;
	allowDelete: boolean;
}

/** Settings modal data */
export interface SettingsModalData {
	tab: SettingsTab;
}

/** New instance modal data */
export interface NewInstanceModalData {
	duplicatingSessionId: string | null;
}

/** Edit agent modal data */
export interface EditAgentModalData {
	session: Session;
}

/** Quick action modal data */
export interface QuickActionModalData {
	initialMode: 'main' | 'move-to-group';
}

/** Confirmation modal data */
export interface ConfirmModalData {
	message: string;
	onConfirm: () => void;
	title?: string;
	destructive?: boolean;
}

/** Rename instance modal data */
export interface RenameInstanceModalData {
	sessionId: string;
	value: string;
}

/** Rename tab modal data */
export interface RenameTabModalData {
	tabId: string;
	initialName: string;
}

/** Rename group modal data */
export interface RenameGroupModalData {
	groupId: string;
	value: string;
	emoji: string;
}

/** Agent sessions browser data */
export interface AgentSessionsModalData {
	activeAgentSessionId: string | null;
}

/** Wizard resume modal data */
export interface WizardResumeModalData {
	state: SerializableWizardState;
}

/** Agent error modal data */
export interface AgentErrorModalData {
	sessionId: string;
}

/** Delete agent modal data */
export interface DeleteAgentModalData {
	session: Session;
}

/** Worktree modal data (create/delete/PR) */
export interface WorktreeModalData {
	session: Session;
}

/** Group chat modal data (delete/rename/edit) */
export interface GroupChatModalData {
	groupChatId: string;
}

/** Git diff preview data */
export interface GitDiffModalData {
	diff: string;
}

/** Tour modal data */
export interface TourModalData {
	fromWizard: boolean;
}

/** Keyboard mastery celebration data */
export interface KeyboardMasteryData {
	level: number;
}

// ============================================================================
// Modal ID Registry
// ============================================================================

/**
 * All modal identifiers in the application.
 *
 * Naming convention:
 * - Use camelCase
 * - Group related modals with common prefix (e.g., groupChat*, worktree*)
 */
export type ModalId =
	// Settings & Help
	| 'settings'
	| 'shortcutsHelp'
	| 'about'
	| 'updateCheck'
	// Instance Management
	| 'newInstance'
	| 'editAgent'
	| 'deleteAgent'
	| 'renameInstance'
	| 'agentError'
	// Quick Actions
	| 'quickAction'
	| 'tabSwitcher'
	| 'fuzzyFileSearch'
	| 'promptComposer'
	// Tab Management
	| 'renameTab'
	// Group Management
	| 'renameGroup'
	// Session Operations
	| 'mergeSession'
	| 'sendToAgent'
	| 'agentSessions'
	// Batch & Auto Run
	| 'queueBrowser'
	| 'batchRunner'
	| 'autoRunSetup'
	| 'marketplace'
	// Worktree
	| 'worktreeConfig'
	| 'createWorktree'
	| 'createPR'
	| 'deleteWorktree'
	// Group Chat
	| 'newGroupChat'
	| 'deleteGroupChat'
	| 'renameGroupChat'
	| 'editGroupChat'
	| 'groupChatInfo'
	// Git
	| 'gitDiff'
	| 'gitLog'
	// Wizard & Tour
	| 'wizardResume'
	| 'tour'
	// Debug & Dev
	| 'debugWizard'
	| 'debugPackage'
	| 'playground'
	| 'logViewer'
	| 'processMonitor'
	| 'usageDashboard'
	// Confirmations
	| 'confirm'
	| 'quitConfirm'
	// Celebrations & Overlays
	| 'standingOvation'
	| 'firstRunCelebration'
	| 'keyboardMastery'
	| 'leaderboard'
	// Media
	| 'lightbox'
	// Symphony
	| 'symphony'
	// Platform Warnings
	| 'windowsWarning'
	// Director's Notes
	| 'directorNotes'
	// Plugins
	| 'pluginManager';

/**
 * Type mapping from ModalId to its data type.
 * Modals not listed here have no associated data (just open/close).
 */
export interface ModalDataMap {
	settings: SettingsModalData;
	newInstance: NewInstanceModalData;
	editAgent: EditAgentModalData;
	quickAction: QuickActionModalData;
	confirm: ConfirmModalData;
	renameInstance: RenameInstanceModalData;
	renameTab: RenameTabModalData;
	renameGroup: RenameGroupModalData;
	agentSessions: AgentSessionsModalData;
	wizardResume: WizardResumeModalData;
	agentError: AgentErrorModalData;
	deleteAgent: DeleteAgentModalData;
	createWorktree: WorktreeModalData;
	createPR: WorktreeModalData;
	deleteWorktree: WorktreeModalData;
	deleteGroupChat: GroupChatModalData;
	renameGroupChat: GroupChatModalData;
	editGroupChat: GroupChatModalData;
	gitDiff: GitDiffModalData;
	tour: TourModalData;
	standingOvation: StandingOvationData;
	firstRunCelebration: FirstRunCelebrationData;
	keyboardMastery: KeyboardMasteryData;
	lightbox: LightboxData;
}

// Helper type to get data type for a modal ID
type ModalDataFor<T extends ModalId> = T extends keyof ModalDataMap ? ModalDataMap[T] : undefined;

// ============================================================================
// Store Types
// ============================================================================

interface ModalEntry<T = unknown> {
	open: boolean;
	data?: T;
}

interface ModalStoreState {
	modals: Map<ModalId, ModalEntry>;
}

interface ModalStoreActions {
	/**
	 * Open a modal, optionally with associated data.
	 * If the modal is already open, this updates its data.
	 */
	openModal: <T extends ModalId>(id: T, data?: ModalDataFor<T>) => void;

	/**
	 * Close a modal and clear its data.
	 */
	closeModal: (id: ModalId) => void;

	/**
	 * Toggle a modal's open state.
	 * If opening, you can provide data.
	 */
	toggleModal: <T extends ModalId>(id: T, data?: ModalDataFor<T>) => void;

	/**
	 * Update a modal's data without changing its open state.
	 */
	updateModalData: <T extends ModalId>(id: T, data: Partial<ModalDataFor<T>>) => void;

	/**
	 * Check if a modal is open.
	 */
	isOpen: (id: ModalId) => boolean;

	/**
	 * Get a modal's associated data.
	 */
	getData: <T extends ModalId>(id: T) => ModalDataFor<T> | undefined;

	/**
	 * Close all open modals.
	 */
	closeAll: () => void;
}

export type ModalStore = ModalStoreState & ModalStoreActions;

// ============================================================================
// Store Implementation
// ============================================================================

export const useModalStore = create<ModalStore>()((set, get) => ({
	modals: new Map(),

	openModal: (id, data) => {
		set((state) => {
			const current = state.modals.get(id);
			// Skip if already open with same data reference
			if (current?.open && current.data === data) return state;
			const newModals = new Map(state.modals);
			newModals.set(id, { open: true, data });
			return { modals: newModals };
		});
	},

	closeModal: (id) => {
		set((state) => {
			const current = state.modals.get(id);
			// Skip if already closed (or never opened)
			if (!current?.open) return state;
			const newModals = new Map(state.modals);
			newModals.set(id, { open: false, data: undefined });
			return { modals: newModals };
		});
	},

	toggleModal: (id, data) => {
		set((state) => {
			const current = state.modals.get(id);
			const newModals = new Map(state.modals);
			if (current?.open) {
				newModals.set(id, { open: false, data: undefined });
			} else {
				newModals.set(id, { open: true, data });
			}
			return { modals: newModals };
		});
	},

	updateModalData: (id, data) => {
		set((state) => {
			const current = state.modals.get(id);
			if (!current || !current.data) return state;
			const newModals = new Map(state.modals);
			const mergedData = Object.assign({}, current.data, data);
			newModals.set(id, {
				...current,
				data: mergedData,
			});
			return { modals: newModals };
		});
	},

	isOpen: (id) => {
		return get().modals.get(id)?.open ?? false;
	},

	getData: <T extends ModalId>(id: T) => {
		return get().modals.get(id)?.data as ModalDataFor<T> | undefined;
	},

	closeAll: () => {
		set((state) => {
			// Skip if no modals are open
			let anyOpen = false;
			for (const entry of state.modals.values()) {
				if (entry.open) {
					anyOpen = true;
					break;
				}
			}
			if (!anyOpen) return state;
			const newModals = new Map<ModalId, ModalEntry>();
			state.modals.forEach((_, id) => {
				newModals.set(id, { open: false, data: undefined });
			});
			return { modals: newModals };
		});
	},
}));

// ============================================================================
// Selector Helpers
// ============================================================================

/**
 * Create a selector for a specific modal's open state.
 * Use this for granular subscriptions.
 *
 * @example
 * const settingsOpen = useModalStore(selectModalOpen('settings'));
 */
export const selectModalOpen =
	(id: ModalId) =>
	(state: ModalStore): boolean =>
		state.modals.get(id)?.open ?? false;

/**
 * Create a selector for a specific modal's data.
 *
 * @example
 * const settingsData = useModalStore(selectModalData('settings'));
 */
export const selectModalData =
	<T extends ModalId>(id: T) =>
	(state: ModalStore): ModalDataFor<T> | undefined =>
		state.modals.get(id)?.data as ModalDataFor<T> | undefined;

/**
 * Create a selector for a specific modal's full entry (open + data).
 *
 * @example
 * const settings = useModalStore(selectModal('settings'));
 * if (settings?.open) { ... }
 */
export const selectModal =
	<T extends ModalId>(id: T) =>
	(state: ModalStore): ModalEntry<ModalDataFor<T>> | undefined =>
		state.modals.get(id) as ModalEntry<ModalDataFor<T>> | undefined;

// ============================================================================
// ModalContext Compatibility Layer
// ============================================================================
// These exports mirror the ModalContext API exactly, making migration seamless.
// App.tsx can change `useModalContext()` to `useModalActions()` with minimal changes.

/**
 * Get all modal actions (stable references, no re-renders).
 * Use this for event handlers and callbacks.
 */
export function getModalActions() {
	const { openModal, closeModal, updateModalData } = useModalStore.getState();

	return {
		// Settings Modal
		setSettingsModalOpen: (open: boolean) =>
			open ? openModal('settings', { tab: 'general' }) : closeModal('settings'),
		setSettingsTab: (tab: SettingsTab) => updateModalData('settings', { tab }),
		openSettings: (tab?: SettingsTab) => openModal('settings', { tab: tab ?? 'general' }),
		closeSettings: () => closeModal('settings'),

		// New Instance Modal
		setNewInstanceModalOpen: (open: boolean) =>
			open ? openModal('newInstance', { duplicatingSessionId: null }) : closeModal('newInstance'),
		setDuplicatingSessionId: (id: string | null) =>
			updateModalData('newInstance', { duplicatingSessionId: id }),

		// Edit Agent Modal
		setEditAgentModalOpen: (open: boolean) =>
			open ? openModal('editAgent') : closeModal('editAgent'),
		setEditAgentSession: (session: Session | null) =>
			session ? openModal('editAgent', { session }) : closeModal('editAgent'),

		// Delete Agent Modal
		setDeleteAgentModalOpen: (open: boolean) =>
			open ? openModal('deleteAgent') : closeModal('deleteAgent'),
		setDeleteAgentSession: (session: Session | null) =>
			session ? openModal('deleteAgent', { session }) : closeModal('deleteAgent'),

		// Shortcuts Help Modal
		setShortcutsHelpOpen: (open: boolean) =>
			open ? openModal('shortcutsHelp') : closeModal('shortcutsHelp'),
		setShortcutsSearchQuery: (_query: string) => {
			/* no-op, query is local state */
		},

		// Quick Actions Modal
		setQuickActionOpen: (open: boolean) =>
			open ? openModal('quickAction', { initialMode: 'main' }) : closeModal('quickAction'),
		setQuickActionInitialMode: (mode: 'main' | 'move-to-group') =>
			updateModalData('quickAction', { initialMode: mode }),

		// Lightbox Modal
		setLightboxImage: (image: string | null) => {
			if (image) {
				const current = useModalStore.getState().getData('lightbox');
				openModal('lightbox', {
					image,
					images: current?.images ?? [],
					source: current?.source ?? 'history',
					isGroupChat: current?.isGroupChat ?? false,
					allowDelete: current?.allowDelete ?? false,
				});
			} else {
				closeModal('lightbox');
			}
		},
		setLightboxImages: (images: string[]) => {
			const current = useModalStore.getState().getData('lightbox');
			if (current) {
				updateModalData('lightbox', { images });
			}
		},
		setLightboxSource: (source: 'staged' | 'history') => {
			const current = useModalStore.getState().getData('lightbox');
			if (current) {
				updateModalData('lightbox', { source });
			}
		},

		// About Modal
		setAboutModalOpen: (open: boolean) => (open ? openModal('about') : closeModal('about')),

		// Update Check Modal
		setUpdateCheckModalOpen: (open: boolean) =>
			open ? openModal('updateCheck') : closeModal('updateCheck'),

		// Leaderboard Registration Modal
		setLeaderboardRegistrationOpen: (open: boolean) =>
			open ? openModal('leaderboard') : closeModal('leaderboard'),

		// Standing Ovation Overlay
		setStandingOvationData: (data: StandingOvationData | null) =>
			data ? openModal('standingOvation', data) : closeModal('standingOvation'),

		// First Run Celebration
		setFirstRunCelebrationData: (data: FirstRunCelebrationData | null) =>
			data ? openModal('firstRunCelebration', data) : closeModal('firstRunCelebration'),

		// Log Viewer
		setLogViewerOpen: (open: boolean) => (open ? openModal('logViewer') : closeModal('logViewer')),

		// Process Monitor
		setProcessMonitorOpen: (open: boolean) =>
			open ? openModal('processMonitor') : closeModal('processMonitor'),

		// Usage Dashboard
		setUsageDashboardOpen: (open: boolean) =>
			open ? openModal('usageDashboard') : closeModal('usageDashboard'),

		// Keyboard Mastery Celebration
		setPendingKeyboardMasteryLevel: (level: number | null) =>
			level !== null ? openModal('keyboardMastery', { level }) : closeModal('keyboardMastery'),

		// Playground Panel
		setPlaygroundOpen: (open: boolean) =>
			open ? openModal('playground') : closeModal('playground'),

		// Debug Wizard Modal
		setDebugWizardModalOpen: (open: boolean) =>
			open ? openModal('debugWizard') : closeModal('debugWizard'),

		// Debug Package Modal
		setDebugPackageModalOpen: (open: boolean) =>
			open ? openModal('debugPackage') : closeModal('debugPackage'),

		// Confirmation Modal
		setConfirmModalOpen: (open: boolean) => (open ? openModal('confirm') : closeModal('confirm')),
		setConfirmModalMessage: (message: string) => updateModalData('confirm', { message }),
		setConfirmModalOnConfirm: (fn: (() => void) | null) =>
			fn ? updateModalData('confirm', { onConfirm: fn }) : null,
		showConfirmation: (message: string, onConfirm: () => void) =>
			openModal('confirm', { message, onConfirm }),
		closeConfirmation: () => closeModal('confirm'),

		// Quit Confirmation Modal
		setQuitConfirmModalOpen: (open: boolean) =>
			open ? openModal('quitConfirm') : closeModal('quitConfirm'),

		// Rename Instance Modal
		setRenameInstanceModalOpen: (open: boolean) => {
			if (!open) {
				closeModal('renameInstance');
				return;
			}
			const current = useModalStore.getState().getData('renameInstance');
			openModal('renameInstance', current ?? { sessionId: '', value: '' });
		},
		setRenameInstanceValue: (value: string) => {
			const current = useModalStore.getState().getData('renameInstance');
			if (current) {
				updateModalData('renameInstance', { value });
			} else {
				openModal('renameInstance', { sessionId: '', value });
			}
		},
		setRenameInstanceSessionId: (sessionId: string | null) => {
			if (!sessionId) return;
			const current = useModalStore.getState().getData('renameInstance');
			openModal('renameInstance', { sessionId, value: current?.value ?? '' });
		},

		// Rename Tab Modal
		setRenameTabModalOpen: (open: boolean) => {
			if (!open) {
				closeModal('renameTab');
				return;
			}
			const current = useModalStore.getState().getData('renameTab');
			openModal('renameTab', current ?? { tabId: '', initialName: '' });
		},
		setRenameTabId: (tabId: string | null) => {
			if (!tabId) return;
			const current = useModalStore.getState().getData('renameTab');
			openModal('renameTab', { tabId, initialName: current?.initialName ?? '' });
		},
		setRenameTabInitialName: (initialName: string) => {
			const current = useModalStore.getState().getData('renameTab');
			if (current) {
				updateModalData('renameTab', { initialName });
			} else {
				openModal('renameTab', { tabId: '', initialName });
			}
		},

		// Rename Group Modal
		setRenameGroupModalOpen: (open: boolean) => {
			if (!open) {
				closeModal('renameGroup');
				return;
			}
			const current = useModalStore.getState().getData('renameGroup');
			openModal('renameGroup', current ?? { groupId: '', value: '', emoji: '📂' });
		},
		setRenameGroupId: (groupId: string | null) => {
			if (!groupId) return;
			const current = useModalStore.getState().getData('renameGroup');
			openModal('renameGroup', {
				groupId,
				value: current?.value ?? '',
				emoji: current?.emoji ?? '📂',
			});
		},
		setRenameGroupValue: (value: string) => {
			const current = useModalStore.getState().getData('renameGroup');
			if (current) {
				updateModalData('renameGroup', { value });
			} else {
				openModal('renameGroup', { groupId: '', value, emoji: '📂' });
			}
		},
		setRenameGroupEmoji: (emoji: string) => {
			const current = useModalStore.getState().getData('renameGroup');
			if (current) {
				updateModalData('renameGroup', { emoji });
			} else {
				openModal('renameGroup', { groupId: '', value: '', emoji });
			}
		},

		// Agent Sessions Browser
		setAgentSessionsOpen: (open: boolean) =>
			open
				? openModal('agentSessions', { activeAgentSessionId: null })
				: closeModal('agentSessions'),
		setActiveAgentSessionId: (activeAgentSessionId: string | null) =>
			updateModalData('agentSessions', { activeAgentSessionId }),

		// Execution Queue Browser Modal
		setQueueBrowserOpen: (open: boolean) =>
			open ? openModal('queueBrowser') : closeModal('queueBrowser'),

		// Batch Runner Modal
		setBatchRunnerModalOpen: (open: boolean) =>
			open ? openModal('batchRunner') : closeModal('batchRunner'),

		// Auto Run Setup Modal
		setAutoRunSetupModalOpen: (open: boolean) =>
			open ? openModal('autoRunSetup') : closeModal('autoRunSetup'),

		// Marketplace Modal
		setMarketplaceModalOpen: (open: boolean) =>
			open ? openModal('marketplace') : closeModal('marketplace'),

		// Wizard Resume Modal
		setWizardResumeModalOpen: (open: boolean) =>
			open ? openModal('wizardResume') : closeModal('wizardResume'),
		setWizardResumeState: (state: SerializableWizardState | null) =>
			state ? openModal('wizardResume', { state }) : closeModal('wizardResume'),

		// Agent Error Modal
		setAgentErrorModalSessionId: (sessionId: string | null) =>
			sessionId ? openModal('agentError', { sessionId }) : closeModal('agentError'),

		// Worktree Modals
		setWorktreeConfigModalOpen: (open: boolean) =>
			open ? openModal('worktreeConfig') : closeModal('worktreeConfig'),
		setCreateWorktreeModalOpen: (open: boolean) =>
			open ? openModal('createWorktree') : closeModal('createWorktree'),
		setCreateWorktreeSession: (session: Session | null) =>
			session ? openModal('createWorktree', { session }) : closeModal('createWorktree'),
		setCreatePRModalOpen: (open: boolean) =>
			open ? openModal('createPR') : closeModal('createPR'),
		setCreatePRSession: (session: Session | null) =>
			session ? openModal('createPR', { session }) : closeModal('createPR'),
		setDeleteWorktreeModalOpen: (open: boolean) =>
			open ? openModal('deleteWorktree') : closeModal('deleteWorktree'),
		setDeleteWorktreeSession: (session: Session | null) =>
			session ? openModal('deleteWorktree', { session }) : closeModal('deleteWorktree'),

		// Tab Switcher Modal
		setTabSwitcherOpen: (open: boolean) =>
			open ? openModal('tabSwitcher') : closeModal('tabSwitcher'),

		// Fuzzy File Search Modal
		setFuzzyFileSearchOpen: (open: boolean) =>
			open ? openModal('fuzzyFileSearch') : closeModal('fuzzyFileSearch'),

		// Prompt Composer Modal
		setPromptComposerOpen: (open: boolean) =>
			open ? openModal('promptComposer') : closeModal('promptComposer'),

		// Merge Session Modal
		setMergeSessionModalOpen: (open: boolean) =>
			open ? openModal('mergeSession') : closeModal('mergeSession'),

		// Send to Agent Modal
		setSendToAgentModalOpen: (open: boolean) =>
			open ? openModal('sendToAgent') : closeModal('sendToAgent'),

		// Group Chat Modals
		setShowNewGroupChatModal: (open: boolean) =>
			open ? openModal('newGroupChat') : closeModal('newGroupChat'),
		setShowDeleteGroupChatModal: (id: string | null) =>
			id ? openModal('deleteGroupChat', { groupChatId: id }) : closeModal('deleteGroupChat'),
		setShowRenameGroupChatModal: (id: string | null) =>
			id ? openModal('renameGroupChat', { groupChatId: id }) : closeModal('renameGroupChat'),
		setShowEditGroupChatModal: (id: string | null) =>
			id ? openModal('editGroupChat', { groupChatId: id }) : closeModal('editGroupChat'),
		setShowGroupChatInfo: (open: boolean) =>
			open ? openModal('groupChatInfo') : closeModal('groupChatInfo'),

		// Git Diff Viewer
		setGitDiffPreview: (diff: string | null) =>
			diff ? openModal('gitDiff', { diff }) : closeModal('gitDiff'),

		// Git Log Viewer
		setGitLogOpen: (open: boolean) => (open ? openModal('gitLog') : closeModal('gitLog')),

		// Tour Overlay
		setTourOpen: (open: boolean) =>
			open ? openModal('tour', { fromWizard: false }) : closeModal('tour'),
		setTourFromWizard: (fromWizard: boolean) => updateModalData('tour', { fromWizard }),

		// Symphony Modal
		setSymphonyModalOpen: (open: boolean) =>
			open ? openModal('symphony') : closeModal('symphony'),

		// Windows Warning Modal
		setWindowsWarningModalOpen: (open: boolean) =>
			open ? openModal('windowsWarning') : closeModal('windowsWarning'),

		// Director's Notes Modal
		setDirectorNotesOpen: (open: boolean) =>
			open ? openModal('directorNotes') : closeModal('directorNotes'),

		// Plugin Manager Modal
		setPluginManagerOpen: (open: boolean) =>
			open ? openModal('pluginManager') : closeModal('pluginManager'),

		// Lightbox refs replacement - use updateModalData instead
		setLightboxIsGroupChat: (isGroupChat: boolean) => updateModalData('lightbox', { isGroupChat }),
		setLightboxAllowDelete: (allowDelete: boolean) => updateModalData('lightbox', { allowDelete }),
	};
}

/**
 * Hook that provides ModalContext-compatible API.
 * This is the main migration path from useModalContext().
 *
 * DESIGN NOTE: This hook subscribes to ~40 selectors to provide the same
 * reactive API shape as the old ModalContext. Each selector returns a primitive
 * (boolean) so Zustand's Object.is equality prevents re-renders unless the
 * specific value changes. However, the component calling this hook (App.tsx)
 * will re-evaluate all selectors on any modal state change — the same behavior
 * as the old Context. This is intentionally transitional: as components migrate
 * to direct useModalStore(selectModalOpen('xyz')) calls, they decouple from
 * App.tsx's prop-drilling and get truly granular subscriptions.
 *
 * Usage: Replace `useModalContext()` with `useModalActions()` in App.tsx
 */
export function useModalActions() {
	// Get reactive state via selectors
	const settingsModalOpen = useModalStore(selectModalOpen('settings'));
	const settingsData = useModalStore(selectModalData('settings'));
	const newInstanceModalOpen = useModalStore(selectModalOpen('newInstance'));
	const newInstanceData = useModalStore(selectModalData('newInstance'));
	const editAgentModalOpen = useModalStore(selectModalOpen('editAgent'));
	const editAgentData = useModalStore(selectModalData('editAgent'));
	const deleteAgentModalOpen = useModalStore(selectModalOpen('deleteAgent'));
	const deleteAgentData = useModalStore(selectModalData('deleteAgent'));
	const shortcutsHelpOpen = useModalStore(selectModalOpen('shortcutsHelp'));
	const quickActionOpen = useModalStore(selectModalOpen('quickAction'));
	const quickActionData = useModalStore(selectModalData('quickAction'));
	const lightboxData = useModalStore(selectModalData('lightbox'));
	const aboutModalOpen = useModalStore(selectModalOpen('about'));
	const updateCheckModalOpen = useModalStore(selectModalOpen('updateCheck'));
	const leaderboardRegistrationOpen = useModalStore(selectModalOpen('leaderboard'));
	const standingOvationData = useModalStore(selectModalData('standingOvation'));
	const firstRunCelebrationData = useModalStore(selectModalData('firstRunCelebration'));
	const logViewerOpen = useModalStore(selectModalOpen('logViewer'));
	const processMonitorOpen = useModalStore(selectModalOpen('processMonitor'));
	const usageDashboardOpen = useModalStore(selectModalOpen('usageDashboard'));
	const keyboardMasteryData = useModalStore(selectModalData('keyboardMastery'));
	const playgroundOpen = useModalStore(selectModalOpen('playground'));
	const debugWizardModalOpen = useModalStore(selectModalOpen('debugWizard'));
	const debugPackageModalOpen = useModalStore(selectModalOpen('debugPackage'));
	const confirmModalOpen = useModalStore(selectModalOpen('confirm'));
	const confirmData = useModalStore(selectModalData('confirm'));
	const quitConfirmModalOpen = useModalStore(selectModalOpen('quitConfirm'));
	const renameInstanceModalOpen = useModalStore(selectModalOpen('renameInstance'));
	const renameInstanceData = useModalStore(selectModalData('renameInstance'));
	const renameTabModalOpen = useModalStore(selectModalOpen('renameTab'));
	const renameTabData = useModalStore(selectModalData('renameTab'));
	const renameGroupModalOpen = useModalStore(selectModalOpen('renameGroup'));
	const renameGroupData = useModalStore(selectModalData('renameGroup'));
	const agentSessionsOpen = useModalStore(selectModalOpen('agentSessions'));
	const agentSessionsData = useModalStore(selectModalData('agentSessions'));
	const queueBrowserOpen = useModalStore(selectModalOpen('queueBrowser'));
	const batchRunnerModalOpen = useModalStore(selectModalOpen('batchRunner'));
	const autoRunSetupModalOpen = useModalStore(selectModalOpen('autoRunSetup'));
	const marketplaceModalOpen = useModalStore(selectModalOpen('marketplace'));
	const wizardResumeModalOpen = useModalStore(selectModalOpen('wizardResume'));
	const wizardResumeData = useModalStore(selectModalData('wizardResume'));
	const agentErrorData = useModalStore(selectModalData('agentError'));
	const worktreeConfigModalOpen = useModalStore(selectModalOpen('worktreeConfig'));
	const createWorktreeModalOpen = useModalStore(selectModalOpen('createWorktree'));
	const createWorktreeData = useModalStore(selectModalData('createWorktree'));
	const createPRModalOpen = useModalStore(selectModalOpen('createPR'));
	const createPRData = useModalStore(selectModalData('createPR'));
	const deleteWorktreeModalOpen = useModalStore(selectModalOpen('deleteWorktree'));
	const deleteWorktreeData = useModalStore(selectModalData('deleteWorktree'));
	const tabSwitcherOpen = useModalStore(selectModalOpen('tabSwitcher'));
	const fuzzyFileSearchOpen = useModalStore(selectModalOpen('fuzzyFileSearch'));
	const promptComposerOpen = useModalStore(selectModalOpen('promptComposer'));
	const mergeSessionModalOpen = useModalStore(selectModalOpen('mergeSession'));
	const sendToAgentModalOpen = useModalStore(selectModalOpen('sendToAgent'));
	const newGroupChatModalOpen = useModalStore(selectModalOpen('newGroupChat'));
	const deleteGroupChatData = useModalStore(selectModalData('deleteGroupChat'));
	const renameGroupChatData = useModalStore(selectModalData('renameGroupChat'));
	const editGroupChatData = useModalStore(selectModalData('editGroupChat'));
	const groupChatInfoOpen = useModalStore(selectModalOpen('groupChatInfo'));
	const gitDiffData = useModalStore(selectModalData('gitDiff'));
	const gitLogOpen = useModalStore(selectModalOpen('gitLog'));
	const tourOpen = useModalStore(selectModalOpen('tour'));
	const tourData = useModalStore(selectModalData('tour'));
	const symphonyModalOpen = useModalStore(selectModalOpen('symphony'));
	const windowsWarningModalOpen = useModalStore(selectModalOpen('windowsWarning'));
	const directorNotesOpen = useModalStore(selectModalOpen('directorNotes'));
	const pluginManagerOpen = useModalStore(selectModalOpen('pluginManager'));

	// Get stable actions
	const actions = getModalActions();

	return {
		// Settings Modal
		settingsModalOpen,
		settingsTab: settingsData?.tab ?? 'general',
		...actions,

		// New Instance Modal
		newInstanceModalOpen,
		duplicatingSessionId: newInstanceData?.duplicatingSessionId ?? null,

		// Edit Agent Modal
		editAgentModalOpen,
		editAgentSession: editAgentData?.session ?? null,

		// Delete Agent Modal
		deleteAgentModalOpen,
		deleteAgentSession: deleteAgentData?.session ?? null,

		// Shortcuts Help Modal
		shortcutsHelpOpen,

		// Quick Actions Modal
		quickActionOpen,
		quickActionInitialMode: quickActionData?.initialMode ?? 'main',

		// Lightbox Modal
		lightboxImage: lightboxData?.image ?? null,
		lightboxImages: lightboxData?.images ?? [],

		// About Modal
		aboutModalOpen,

		// Update Check Modal
		updateCheckModalOpen,

		// Leaderboard Registration Modal
		leaderboardRegistrationOpen,

		// Standing Ovation Overlay
		standingOvationData: standingOvationData ?? null,

		// First Run Celebration
		firstRunCelebrationData: firstRunCelebrationData ?? null,

		// Log Viewer
		logViewerOpen,

		// Process Monitor
		processMonitorOpen,

		// Usage Dashboard
		usageDashboardOpen,

		// Keyboard Mastery Celebration
		pendingKeyboardMasteryLevel: keyboardMasteryData?.level ?? null,

		// Playground Panel
		playgroundOpen,

		// Debug Wizard Modal
		debugWizardModalOpen,

		// Debug Package Modal
		debugPackageModalOpen,

		// Confirmation Modal
		confirmModalOpen,
		confirmModalMessage: confirmData?.message ?? '',
		confirmModalOnConfirm: confirmData?.onConfirm ?? null,
		confirmModalTitle: confirmData?.title,
		confirmModalDestructive: confirmData?.destructive,

		// Quit Confirmation Modal
		quitConfirmModalOpen,

		// Rename Instance Modal
		renameInstanceModalOpen,
		renameInstanceValue: renameInstanceData?.value ?? '',
		renameInstanceSessionId: renameInstanceData?.sessionId ?? null,

		// Rename Tab Modal
		renameTabModalOpen,
		renameTabId: renameTabData?.tabId ?? null,
		renameTabInitialName: renameTabData?.initialName ?? '',

		// Rename Group Modal
		renameGroupModalOpen,
		renameGroupId: renameGroupData?.groupId ?? null,
		renameGroupValue: renameGroupData?.value ?? '',
		renameGroupEmoji: renameGroupData?.emoji ?? '📂',

		// Agent Sessions Browser
		agentSessionsOpen,
		activeAgentSessionId: agentSessionsData?.activeAgentSessionId ?? null,

		// Execution Queue Browser Modal
		queueBrowserOpen,

		// Batch Runner Modal
		batchRunnerModalOpen,

		// Auto Run Setup Modal
		autoRunSetupModalOpen,

		// Marketplace Modal
		marketplaceModalOpen,

		// Wizard Resume Modal
		wizardResumeModalOpen,
		wizardResumeState: wizardResumeData?.state ?? null,

		// Agent Error Modal
		agentErrorModalSessionId: agentErrorData?.sessionId ?? null,

		// Worktree Modals
		worktreeConfigModalOpen,
		createWorktreeModalOpen,
		createWorktreeSession: createWorktreeData?.session ?? null,
		createPRModalOpen,
		createPRSession: createPRData?.session ?? null,
		deleteWorktreeModalOpen,
		deleteWorktreeSession: deleteWorktreeData?.session ?? null,

		// Tab Switcher Modal
		tabSwitcherOpen,

		// Fuzzy File Search Modal
		fuzzyFileSearchOpen,

		// Prompt Composer Modal
		promptComposerOpen,

		// Merge Session Modal
		mergeSessionModalOpen,

		// Send to Agent Modal
		sendToAgentModalOpen,

		// Group Chat Modals
		showNewGroupChatModal: newGroupChatModalOpen,
		showDeleteGroupChatModal: deleteGroupChatData?.groupChatId ?? null,
		showRenameGroupChatModal: renameGroupChatData?.groupChatId ?? null,
		showEditGroupChatModal: editGroupChatData?.groupChatId ?? null,
		showGroupChatInfo: groupChatInfoOpen,

		// Git Diff Viewer
		gitDiffPreview: gitDiffData?.diff ?? null,

		// Git Log Viewer
		gitLogOpen,

		// Tour Overlay
		tourOpen,
		tourFromWizard: tourData?.fromWizard ?? false,

		// Symphony Modal
		symphonyModalOpen,

		// Windows Warning Modal
		windowsWarningModalOpen,

		// Director's Notes Modal
		directorNotesOpen,

		// Plugin Manager Modal
		pluginManagerOpen,

		// Lightbox ref replacements (now stored as data)
		lightboxIsGroupChat: lightboxData?.isGroupChat ?? false,
		lightboxAllowDelete: lightboxData?.allowDelete ?? false,
	};
}
