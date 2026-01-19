/**
 * ModalContext - Centralized modal state management
 *
 * This context extracts all modal open/close states from App.tsx to reduce
 * its complexity and provide a single source of truth for modal visibility.
 *
 * Phase 1 of App.tsx decomposition - see refactor-details-2.md for full plan.
 */

import React, {
	createContext,
	useContext,
	useState,
	useCallback,
	useMemo,
	ReactNode,
	Dispatch,
	SetStateAction,
} from 'react';
import type { SettingsTab, Session } from '../types';
import type { ConductorBadge } from '../constants/conductorBadges';
import type { SerializableWizardState } from '../components/Wizard';

// Standing ovation celebration data
export interface StandingOvationData {
	badge: ConductorBadge;
	isNewRecord: boolean;
	recordTimeMs?: number;
}

// First run celebration data
export interface FirstRunCelebrationData {
	elapsedTimeMs: number;
	completedTasks: number;
	totalTasks: number;
}

/**
 * Modal context value - all modal states and their setters
 */
export interface ModalContextValue {
	// Settings Modal
	settingsModalOpen: boolean;
	setSettingsModalOpen: (open: boolean) => void;
	settingsTab: SettingsTab;
	setSettingsTab: (tab: SettingsTab) => void;
	openSettings: (tab?: SettingsTab) => void;
	closeSettings: () => void;

	// New Instance Modal
	newInstanceModalOpen: boolean;
	setNewInstanceModalOpen: (open: boolean) => void;
	duplicatingSessionId: string | null;
	setDuplicatingSessionId: (id: string | null) => void;

	// Edit Agent Modal
	editAgentModalOpen: boolean;
	setEditAgentModalOpen: (open: boolean) => void;
	editAgentSession: Session | null;
	setEditAgentSession: (session: Session | null) => void;

	// Shortcuts Help Modal
	shortcutsHelpOpen: boolean;
	setShortcutsHelpOpen: (open: boolean) => void;
	setShortcutsSearchQuery: (query: string) => void;

	// Quick Actions Modal (Command+K)
	quickActionOpen: boolean;
	setQuickActionOpen: (open: boolean) => void;
	quickActionInitialMode: 'main' | 'move-to-group';
	setQuickActionInitialMode: (mode: 'main' | 'move-to-group') => void;

	// Lightbox Modal
	lightboxImage: string | null;
	setLightboxImage: (image: string | null) => void;
	lightboxImages: string[];
	setLightboxImages: (images: string[]) => void;
	setLightboxSource: (source: 'staged' | 'history') => void;
	lightboxIsGroupChatRef: React.MutableRefObject<boolean>;
	lightboxAllowDeleteRef: React.MutableRefObject<boolean>;

	// About Modal
	aboutModalOpen: boolean;
	setAboutModalOpen: (open: boolean) => void;

	// Update Check Modal
	updateCheckModalOpen: boolean;
	setUpdateCheckModalOpen: (open: boolean) => void;

	// Leaderboard Registration Modal
	leaderboardRegistrationOpen: boolean;
	setLeaderboardRegistrationOpen: (open: boolean) => void;

	// Standing Ovation Overlay
	standingOvationData: StandingOvationData | null;
	setStandingOvationData: (data: StandingOvationData | null) => void;

	// First Run Celebration
	firstRunCelebrationData: FirstRunCelebrationData | null;
	setFirstRunCelebrationData: (data: FirstRunCelebrationData | null) => void;

	// Log Viewer
	logViewerOpen: boolean;
	setLogViewerOpen: (open: boolean) => void;

	// Process Monitor
	processMonitorOpen: boolean;
	setProcessMonitorOpen: (open: boolean) => void;

	// Usage Dashboard
	usageDashboardOpen: boolean;
	setUsageDashboardOpen: (open: boolean) => void;

	// Keyboard Mastery Celebration
	pendingKeyboardMasteryLevel: number | null;
	setPendingKeyboardMasteryLevel: (level: number | null) => void;

	// Playground Panel
	playgroundOpen: boolean;
	setPlaygroundOpen: (open: boolean) => void;

	// Debug Wizard Modal
	debugWizardModalOpen: boolean;
	setDebugWizardModalOpen: (open: boolean) => void;

	// Debug Package Modal
	debugPackageModalOpen: boolean;
	setDebugPackageModalOpen: (open: boolean) => void;

	// Confirmation Modal
	confirmModalOpen: boolean;
	setConfirmModalOpen: (open: boolean) => void;
	confirmModalMessage: string;
	setConfirmModalMessage: (message: string) => void;
	confirmModalOnConfirm: (() => void) | null;
	setConfirmModalOnConfirm: (fn: (() => void) | null) => void;
	showConfirmation: (message: string, onConfirm: () => void) => void;
	closeConfirmation: () => void;

	// Quit Confirmation Modal
	quitConfirmModalOpen: boolean;
	setQuitConfirmModalOpen: (open: boolean) => void;

	// Rename Instance Modal
	renameInstanceModalOpen: boolean;
	setRenameInstanceModalOpen: (open: boolean) => void;
	renameInstanceValue: string;
	setRenameInstanceValue: (value: string) => void;
	renameInstanceSessionId: string | null;
	setRenameInstanceSessionId: (id: string | null) => void;

	// Rename Tab Modal
	renameTabModalOpen: boolean;
	setRenameTabModalOpen: (open: boolean) => void;
	renameTabId: string | null;
	setRenameTabId: (id: string | null) => void;
	renameTabInitialName: string;
	setRenameTabInitialName: (name: string) => void;

	// Rename Group Modal
	renameGroupModalOpen: boolean;
	setRenameGroupModalOpen: (open: boolean) => void;
	renameGroupId: string | null;
	setRenameGroupId: (id: string | null) => void;
	renameGroupValue: string;
	setRenameGroupValue: (value: string) => void;
	renameGroupEmoji: string;
	setRenameGroupEmoji: (emoji: string) => void;

	// Agent Sessions Browser
	agentSessionsOpen: boolean;
	setAgentSessionsOpen: (open: boolean) => void;
	activeAgentSessionId: string | null;
	setActiveAgentSessionId: (id: string | null) => void;

	// Execution Queue Browser Modal
	queueBrowserOpen: boolean;
	setQueueBrowserOpen: (open: boolean) => void;

	// Batch Runner Modal
	batchRunnerModalOpen: boolean;
	setBatchRunnerModalOpen: Dispatch<SetStateAction<boolean>>;

	// Auto Run Setup Modal
	autoRunSetupModalOpen: boolean;
	setAutoRunSetupModalOpen: Dispatch<SetStateAction<boolean>>;

	// Marketplace Modal
	marketplaceModalOpen: boolean;
	setMarketplaceModalOpen: Dispatch<SetStateAction<boolean>>;

	// Wizard Resume Modal
	wizardResumeModalOpen: boolean;
	setWizardResumeModalOpen: (open: boolean) => void;
	wizardResumeState: SerializableWizardState | null;
	setWizardResumeState: (state: SerializableWizardState | null) => void;

	// Agent Error Modal
	agentErrorModalSessionId: string | null;
	setAgentErrorModalSessionId: (id: string | null) => void;

	// Worktree Modals
	worktreeConfigModalOpen: boolean;
	setWorktreeConfigModalOpen: (open: boolean) => void;
	createWorktreeModalOpen: boolean;
	setCreateWorktreeModalOpen: (open: boolean) => void;
	createWorktreeSession: Session | null;
	setCreateWorktreeSession: (session: Session | null) => void;
	createPRModalOpen: boolean;
	setCreatePRModalOpen: (open: boolean) => void;
	createPRSession: Session | null;
	setCreatePRSession: (session: Session | null) => void;
	deleteWorktreeModalOpen: boolean;
	setDeleteWorktreeModalOpen: (open: boolean) => void;
	deleteWorktreeSession: Session | null;
	setDeleteWorktreeSession: (session: Session | null) => void;

	// Tab Switcher Modal
	tabSwitcherOpen: boolean;
	setTabSwitcherOpen: (open: boolean) => void;

	// Fuzzy File Search Modal
	fuzzyFileSearchOpen: boolean;
	setFuzzyFileSearchOpen: (open: boolean) => void;

	// Prompt Composer Modal
	promptComposerOpen: boolean;
	setPromptComposerOpen: (open: boolean) => void;

	// Merge Session Modal
	mergeSessionModalOpen: boolean;
	setMergeSessionModalOpen: (open: boolean) => void;

	// Send to Agent Modal
	sendToAgentModalOpen: boolean;
	setSendToAgentModalOpen: (open: boolean) => void;

	// Group Chat Modals
	showNewGroupChatModal: boolean;
	setShowNewGroupChatModal: (open: boolean) => void;
	showDeleteGroupChatModal: string | null;
	setShowDeleteGroupChatModal: (id: string | null) => void;
	showRenameGroupChatModal: string | null;
	setShowRenameGroupChatModal: (id: string | null) => void;
	showEditGroupChatModal: string | null;
	setShowEditGroupChatModal: (id: string | null) => void;
	showGroupChatInfo: boolean;
	setShowGroupChatInfo: (open: boolean) => void;

	// Git Diff Viewer
	gitDiffPreview: string | null;
	setGitDiffPreview: (diff: string | null) => void;

	// Git Log Viewer
	gitLogOpen: boolean;
	setGitLogOpen: (open: boolean) => void;

	// Tour Overlay
	tourOpen: boolean;
	setTourOpen: (open: boolean) => void;
	tourFromWizard: boolean;
	setTourFromWizard: (fromWizard: boolean) => void;
}

// Create context with null as default (will throw if used outside provider)
const ModalContext = createContext<ModalContextValue | null>(null);

interface ModalProviderProps {
	children: ReactNode;
}

/**
 * ModalProvider - Provides centralized modal state management
 *
 * This provider manages all modal open/close states that were previously
 * scattered throughout App.tsx. It reduces App.tsx complexity and provides
 * a single location for modal state management.
 *
 * Usage:
 * Wrap App with this provider:
 * <ModalProvider>
 *   <App />
 * </ModalProvider>
 */
export function ModalProvider({ children }: ModalProviderProps) {
	// Settings Modal
	const [settingsModalOpen, setSettingsModalOpen] = useState(false);
	const [settingsTab, setSettingsTab] = useState<SettingsTab>('general');

	// New Instance Modal
	const [newInstanceModalOpen, setNewInstanceModalOpen] = useState(false);
	const [duplicatingSessionId, setDuplicatingSessionId] = useState<string | null>(null);

	// Edit Agent Modal
	const [editAgentModalOpen, setEditAgentModalOpen] = useState(false);
	const [editAgentSession, setEditAgentSession] = useState<Session | null>(null);

	// Shortcuts Help Modal
	const [shortcutsHelpOpen, setShortcutsHelpOpen] = useState(false);
	const [_shortcutsSearchQuery, setShortcutsSearchQuery] = useState('');

	// Quick Actions Modal (Command+K)
	const [quickActionOpen, setQuickActionOpen] = useState(false);
	const [quickActionInitialMode, setQuickActionInitialMode] = useState<'main' | 'move-to-group'>(
		'main'
	);

	// Lightbox Modal
	const [lightboxImage, setLightboxImage] = useState<string | null>(null);
	const [lightboxImages, setLightboxImages] = useState<string[]>([]);
	const [_lightboxSource, setLightboxSource] = useState<'staged' | 'history'>('history');
	const lightboxIsGroupChatRef = React.useRef<boolean>(false);
	const lightboxAllowDeleteRef = React.useRef<boolean>(false);

	// About Modal
	const [aboutModalOpen, setAboutModalOpen] = useState(false);

	// Update Check Modal
	const [updateCheckModalOpen, setUpdateCheckModalOpen] = useState(false);

	// Leaderboard Registration Modal
	const [leaderboardRegistrationOpen, setLeaderboardRegistrationOpen] = useState(false);

	// Standing Ovation Overlay
	const [standingOvationData, setStandingOvationData] = useState<StandingOvationData | null>(null);

	// First Run Celebration
	const [firstRunCelebrationData, setFirstRunCelebrationData] =
		useState<FirstRunCelebrationData | null>(null);

	// Log Viewer
	const [logViewerOpen, setLogViewerOpen] = useState(false);

	// Process Monitor
	const [processMonitorOpen, setProcessMonitorOpen] = useState(false);

	// Usage Dashboard
	const [usageDashboardOpen, setUsageDashboardOpen] = useState(false);

	// Keyboard Mastery Celebration
	const [pendingKeyboardMasteryLevel, setPendingKeyboardMasteryLevel] = useState<number | null>(
		null
	);

	// Playground Panel
	const [playgroundOpen, setPlaygroundOpen] = useState(false);

	// Debug Wizard Modal
	const [debugWizardModalOpen, setDebugWizardModalOpen] = useState(false);

	// Debug Package Modal
	const [debugPackageModalOpen, setDebugPackageModalOpen] = useState(false);

	// Confirmation Modal
	const [confirmModalOpen, setConfirmModalOpen] = useState(false);
	const [confirmModalMessage, setConfirmModalMessage] = useState('');
	const [confirmModalOnConfirm, setConfirmModalOnConfirm] = useState<(() => void) | null>(null);

	// Quit Confirmation Modal
	const [quitConfirmModalOpen, setQuitConfirmModalOpen] = useState(false);

	// Rename Instance Modal
	const [renameInstanceModalOpen, setRenameInstanceModalOpen] = useState(false);
	const [renameInstanceValue, setRenameInstanceValue] = useState('');
	const [renameInstanceSessionId, setRenameInstanceSessionId] = useState<string | null>(null);

	// Rename Tab Modal
	const [renameTabModalOpen, setRenameTabModalOpen] = useState(false);
	const [renameTabId, setRenameTabId] = useState<string | null>(null);
	const [renameTabInitialName, setRenameTabInitialName] = useState('');

	// Rename Group Modal
	const [renameGroupModalOpen, setRenameGroupModalOpen] = useState(false);
	const [renameGroupId, setRenameGroupId] = useState<string | null>(null);
	const [renameGroupValue, setRenameGroupValue] = useState('');
	const [renameGroupEmoji, setRenameGroupEmoji] = useState('📂');

	// Agent Sessions Browser
	const [agentSessionsOpen, setAgentSessionsOpen] = useState(false);
	const [activeAgentSessionId, setActiveAgentSessionId] = useState<string | null>(null);

	// Execution Queue Browser Modal
	const [queueBrowserOpen, setQueueBrowserOpen] = useState(false);

	// Batch Runner Modal
	const [batchRunnerModalOpen, setBatchRunnerModalOpen] = useState(false);

	// Auto Run Setup Modal
	const [autoRunSetupModalOpen, setAutoRunSetupModalOpen] = useState(false);

	// Marketplace Modal
	const [marketplaceModalOpen, setMarketplaceModalOpen] = useState(false);

	// Wizard Resume Modal
	const [wizardResumeModalOpen, setWizardResumeModalOpen] = useState(false);
	const [wizardResumeState, setWizardResumeState] = useState<SerializableWizardState | null>(null);

	// Agent Error Modal
	const [agentErrorModalSessionId, setAgentErrorModalSessionId] = useState<string | null>(null);

	// Worktree Modals
	const [worktreeConfigModalOpen, setWorktreeConfigModalOpen] = useState(false);
	const [createWorktreeModalOpen, setCreateWorktreeModalOpen] = useState(false);
	const [createWorktreeSession, setCreateWorktreeSession] = useState<Session | null>(null);
	const [createPRModalOpen, setCreatePRModalOpen] = useState(false);
	const [createPRSession, setCreatePRSession] = useState<Session | null>(null);
	const [deleteWorktreeModalOpen, setDeleteWorktreeModalOpen] = useState(false);
	const [deleteWorktreeSession, setDeleteWorktreeSession] = useState<Session | null>(null);

	// Tab Switcher Modal
	const [tabSwitcherOpen, setTabSwitcherOpen] = useState(false);

	// Fuzzy File Search Modal
	const [fuzzyFileSearchOpen, setFuzzyFileSearchOpen] = useState(false);

	// Prompt Composer Modal
	const [promptComposerOpen, setPromptComposerOpen] = useState(false);

	// Merge Session Modal
	const [mergeSessionModalOpen, setMergeSessionModalOpen] = useState(false);

	// Send to Agent Modal
	const [sendToAgentModalOpen, setSendToAgentModalOpen] = useState(false);

	// Group Chat Modals
	const [showNewGroupChatModal, setShowNewGroupChatModal] = useState(false);
	const [showDeleteGroupChatModal, setShowDeleteGroupChatModal] = useState<string | null>(null);
	const [showRenameGroupChatModal, setShowRenameGroupChatModal] = useState<string | null>(null);
	const [showEditGroupChatModal, setShowEditGroupChatModal] = useState<string | null>(null);
	const [showGroupChatInfo, setShowGroupChatInfo] = useState(false);

	// Git Diff Viewer
	const [gitDiffPreview, setGitDiffPreview] = useState<string | null>(null);

	// Git Log Viewer
	const [gitLogOpen, setGitLogOpen] = useState(false);

	// Tour Overlay
	const [tourOpen, setTourOpen] = useState(false);
	const [tourFromWizard, setTourFromWizard] = useState(false);

	// Convenience methods
	const openSettings = useCallback((tab?: SettingsTab) => {
		if (tab) setSettingsTab(tab);
		setSettingsModalOpen(true);
	}, []);

	const closeSettings = useCallback(() => {
		setSettingsModalOpen(false);
	}, []);

	const showConfirmation = useCallback((message: string, onConfirm: () => void) => {
		setConfirmModalMessage(message);
		setConfirmModalOnConfirm(() => onConfirm);
		setConfirmModalOpen(true);
	}, []);

	const closeConfirmation = useCallback(() => {
		setConfirmModalOpen(false);
		setConfirmModalMessage('');
		setConfirmModalOnConfirm(null);
	}, []);

	// Memoize the context value to prevent unnecessary re-renders
	const value = useMemo<ModalContextValue>(
		() => ({
			// Settings Modal
			settingsModalOpen,
			setSettingsModalOpen,
			settingsTab,
			setSettingsTab,
			openSettings,
			closeSettings,

			// New Instance Modal
			newInstanceModalOpen,
			setNewInstanceModalOpen,
			duplicatingSessionId,
			setDuplicatingSessionId,

			// Edit Agent Modal
			editAgentModalOpen,
			setEditAgentModalOpen,
			editAgentSession,
			setEditAgentSession,

			// Shortcuts Help Modal
			shortcutsHelpOpen,
			setShortcutsHelpOpen,
			setShortcutsSearchQuery,

			// Quick Actions Modal
			quickActionOpen,
			setQuickActionOpen,
			quickActionInitialMode,
			setQuickActionInitialMode,

			// Lightbox Modal
			lightboxImage,
			setLightboxImage,
			lightboxImages,
			setLightboxImages,
			setLightboxSource,
			lightboxIsGroupChatRef,
			lightboxAllowDeleteRef,

			// About Modal
			aboutModalOpen,
			setAboutModalOpen,

			// Update Check Modal
			updateCheckModalOpen,
			setUpdateCheckModalOpen,

			// Leaderboard Registration Modal
			leaderboardRegistrationOpen,
			setLeaderboardRegistrationOpen,

			// Standing Ovation Overlay
			standingOvationData,
			setStandingOvationData,

			// First Run Celebration
			firstRunCelebrationData,
			setFirstRunCelebrationData,

			// Log Viewer
			logViewerOpen,
			setLogViewerOpen,

			// Process Monitor
			processMonitorOpen,
			setProcessMonitorOpen,

			// Usage Dashboard
			usageDashboardOpen,
			setUsageDashboardOpen,

			// Keyboard Mastery Celebration
			pendingKeyboardMasteryLevel,
			setPendingKeyboardMasteryLevel,

			// Playground Panel
			playgroundOpen,
			setPlaygroundOpen,

			// Debug Wizard Modal
			debugWizardModalOpen,
			setDebugWizardModalOpen,

			// Debug Package Modal
			debugPackageModalOpen,
			setDebugPackageModalOpen,

			// Confirmation Modal
			confirmModalOpen,
			setConfirmModalOpen,
			confirmModalMessage,
			setConfirmModalMessage,
			confirmModalOnConfirm,
			setConfirmModalOnConfirm,
			showConfirmation,
			closeConfirmation,

			// Quit Confirmation Modal
			quitConfirmModalOpen,
			setQuitConfirmModalOpen,

			// Rename Instance Modal
			renameInstanceModalOpen,
			setRenameInstanceModalOpen,
			renameInstanceValue,
			setRenameInstanceValue,
			renameInstanceSessionId,
			setRenameInstanceSessionId,

			// Rename Tab Modal
			renameTabModalOpen,
			setRenameTabModalOpen,
			renameTabId,
			setRenameTabId,
			renameTabInitialName,
			setRenameTabInitialName,

			// Rename Group Modal
			renameGroupModalOpen,
			setRenameGroupModalOpen,
			renameGroupId,
			setRenameGroupId,
			renameGroupValue,
			setRenameGroupValue,
			renameGroupEmoji,
			setRenameGroupEmoji,

			// Agent Sessions Browser
			agentSessionsOpen,
			setAgentSessionsOpen,
			activeAgentSessionId,
			setActiveAgentSessionId,

			// Execution Queue Browser Modal
			queueBrowserOpen,
			setQueueBrowserOpen,

			// Batch Runner Modal
			batchRunnerModalOpen,
			setBatchRunnerModalOpen,

			// Auto Run Setup Modal
			autoRunSetupModalOpen,
			setAutoRunSetupModalOpen,

			// Marketplace Modal
			marketplaceModalOpen,
			setMarketplaceModalOpen,

			// Wizard Resume Modal
			wizardResumeModalOpen,
			setWizardResumeModalOpen,
			wizardResumeState,
			setWizardResumeState,

			// Agent Error Modal
			agentErrorModalSessionId,
			setAgentErrorModalSessionId,

			// Worktree Modals
			worktreeConfigModalOpen,
			setWorktreeConfigModalOpen,
			createWorktreeModalOpen,
			setCreateWorktreeModalOpen,
			createWorktreeSession,
			setCreateWorktreeSession,
			createPRModalOpen,
			setCreatePRModalOpen,
			createPRSession,
			setCreatePRSession,
			deleteWorktreeModalOpen,
			setDeleteWorktreeModalOpen,
			deleteWorktreeSession,
			setDeleteWorktreeSession,

			// Tab Switcher Modal
			tabSwitcherOpen,
			setTabSwitcherOpen,

			// Fuzzy File Search Modal
			fuzzyFileSearchOpen,
			setFuzzyFileSearchOpen,

			// Prompt Composer Modal
			promptComposerOpen,
			setPromptComposerOpen,

			// Merge Session Modal
			mergeSessionModalOpen,
			setMergeSessionModalOpen,

			// Send to Agent Modal
			sendToAgentModalOpen,
			setSendToAgentModalOpen,

			// Group Chat Modals
			showNewGroupChatModal,
			setShowNewGroupChatModal,
			showDeleteGroupChatModal,
			setShowDeleteGroupChatModal,
			showRenameGroupChatModal,
			setShowRenameGroupChatModal,
			showEditGroupChatModal,
			setShowEditGroupChatModal,
			showGroupChatInfo,
			setShowGroupChatInfo,

			// Git Diff Viewer
			gitDiffPreview,
			setGitDiffPreview,

			// Git Log Viewer
			gitLogOpen,
			setGitLogOpen,

			// Tour Overlay
			tourOpen,
			setTourOpen,
			tourFromWizard,
			setTourFromWizard,
		}),
		[
			// Settings Modal
			settingsModalOpen,
			settingsTab,
			openSettings,
			closeSettings,
			// New Instance Modal
			newInstanceModalOpen,
			duplicatingSessionId,
			// Edit Agent Modal
			editAgentModalOpen,
			editAgentSession,
			// Shortcuts Help Modal
			shortcutsHelpOpen,
			// Quick Actions Modal
			quickActionOpen,
			quickActionInitialMode,
			// Lightbox Modal
			lightboxImage,
			lightboxImages,
			// About Modal
			aboutModalOpen,
			// Update Check Modal
			updateCheckModalOpen,
			// Leaderboard Registration Modal
			leaderboardRegistrationOpen,
			// Standing Ovation Overlay
			standingOvationData,
			// First Run Celebration
			firstRunCelebrationData,
			// Log Viewer
			logViewerOpen,
			// Process Monitor
			processMonitorOpen,
			// Usage Dashboard
			usageDashboardOpen,
			// Keyboard Mastery Celebration
			pendingKeyboardMasteryLevel,
			// Playground Panel
			playgroundOpen,
			// Debug Wizard Modal
			debugWizardModalOpen,
			// Debug Package Modal
			debugPackageModalOpen,
			// Confirmation Modal
			confirmModalOpen,
			confirmModalMessage,
			confirmModalOnConfirm,
			showConfirmation,
			closeConfirmation,
			// Quit Confirmation Modal
			quitConfirmModalOpen,
			// Rename Instance Modal
			renameInstanceModalOpen,
			renameInstanceValue,
			renameInstanceSessionId,
			// Rename Tab Modal
			renameTabModalOpen,
			renameTabId,
			renameTabInitialName,
			// Rename Group Modal
			renameGroupModalOpen,
			renameGroupId,
			renameGroupValue,
			renameGroupEmoji,
			// Agent Sessions Browser
			agentSessionsOpen,
			activeAgentSessionId,
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
			wizardResumeState,
			// Agent Error Modal
			agentErrorModalSessionId,
			// Worktree Modals
			worktreeConfigModalOpen,
			createWorktreeModalOpen,
			createWorktreeSession,
			createPRModalOpen,
			createPRSession,
			deleteWorktreeModalOpen,
			deleteWorktreeSession,
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
			showNewGroupChatModal,
			showDeleteGroupChatModal,
			showRenameGroupChatModal,
			showEditGroupChatModal,
			showGroupChatInfo,
			// Git Diff Viewer
			gitDiffPreview,
			// Git Log Viewer
			gitLogOpen,
			// Tour Overlay
			tourOpen,
			tourFromWizard,
		]
	);

	return <ModalContext.Provider value={value}>{children}</ModalContext.Provider>;
}

/**
 * useModalContext - Hook to access modal state management
 *
 * Must be used within a ModalProvider. Throws an error if used outside.
 *
 * @returns ModalContextValue - All modal states and their setters
 *
 * @example
 * const { settingsModalOpen, openSettings, closeSettings } = useModalContext();
 *
 * // Open settings to a specific tab
 * openSettings('keyboard');
 *
 * // Close settings
 * closeSettings();
 */
export function useModalContext(): ModalContextValue {
	const context = useContext(ModalContext);

	if (!context) {
		throw new Error('useModalContext must be used within a ModalProvider');
	}

	return context;
}
