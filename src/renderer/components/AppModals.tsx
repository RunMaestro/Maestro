/**
 * AppModals.tsx - Extracted Modal Components from App.tsx
 * ========================================================
 *
 * This file consolidates modal components that were previously rendered inline
 * in App.tsx. Modals are grouped by their purpose for easier maintenance.
 *
 * Current Groups:
 * - AppInfoModals: Info/display modals (AboutModal, ShortcutsHelpModal, etc.)
 * - AppConfirmModals: Confirmation modals (ConfirmModal, QuitConfirmModal)
 * - AppSessionModals: Session management modals (NewInstanceModal, EditAgentModal, RenameSessionModal, RenameTabModal)
 * - AppGroupModals: Group management modals (CreateGroupModal, RenameGroupModal)
 * - AppWorktreeModals: Worktree/PR management modals
 * - AppUtilityModals: Utility and workflow modals
 * - AppGroupChatModals: Group Chat management modals
 * - AppAgentModals: Agent error and context transfer modals
 *
 * NOTE: LogViewer is NOT included here because it's a content replacement component
 * (replaces center content area) rather than an overlay modal. It requires specific
 * positioning in the flex layout and must remain in App.tsx.
 */

import React from 'react';
import type {
  Theme,
  Session,
  Group,
  GroupChat,
  GroupChatMessage,
  ModeratorConfig,
  Shortcut,
  KeyboardMasteryStats,
  AutoRunStats,
  MaestroUsageStats,
  RightPanelTab,
  SettingsTab,
  BatchRunConfig,
  AgentError,
  ToolType,
  LeaderboardRegistration,
} from '../types';
import type { FileNode } from '../types/fileTree';
import type { WizardStep } from './Wizard/WizardContext';
import type { GroomingProgress, MergeResult } from '../types/contextMerge';

// Info/Display Modal Components
import { AboutModal } from './AboutModal';
import { ShortcutsHelpModal } from './ShortcutsHelpModal';
import { UpdateCheckModal } from './UpdateCheckModal';
import { ProcessMonitor } from './ProcessMonitor';

// Confirmation Modal Components
import { ConfirmModal } from './ConfirmModal';
import { QuitConfirmModal } from './QuitConfirmModal';

// Session Management Modal Components
import { NewInstanceModal, EditAgentModal } from './NewInstanceModal';
import { RenameSessionModal } from './RenameSessionModal';
import { RenameTabModal } from './RenameTabModal';

// Group Modal Components
import { CreateGroupModal } from './CreateGroupModal';
import { RenameGroupModal } from './RenameGroupModal';

// Worktree Modal Components
import { WorktreeConfigModal } from './WorktreeConfigModal';
import { CreateWorktreeModal } from './CreateWorktreeModal';
import { CreatePRModal, PRDetails } from './CreatePRModal';
import { DeleteWorktreeModal } from './DeleteWorktreeModal';

// Utility Modal Components
import { QuickActionsModal } from './QuickActionsModal';
import { TabSwitcherModal } from './TabSwitcherModal';
import { FileSearchModal, type FlatFileItem } from './FileSearchModal';
import { PromptComposerModal } from './PromptComposerModal';
import { ExecutionQueueBrowser } from './ExecutionQueueBrowser';
import { BatchRunnerModal } from './BatchRunnerModal';
import { AutoRunSetupModal } from './AutoRunSetupModal';
import { LightboxModal } from './LightboxModal';
import { GitDiffViewer } from './GitDiffViewer';
import { GitLogViewer } from './GitLogViewer';

// Group Chat Modal Components
import { NewGroupChatModal } from './NewGroupChatModal';
import { DeleteGroupChatModal } from './DeleteGroupChatModal';
import { RenameGroupChatModal } from './RenameGroupChatModal';
import { EditGroupChatModal } from './EditGroupChatModal';
import { GroupChatInfoOverlay } from './GroupChatInfoOverlay';

// Agent/Transfer Modal Components
import { AgentErrorModal, type RecoveryAction } from './AgentErrorModal';
import { MergeSessionModal, type MergeOptions } from './MergeSessionModal';
import { SendToAgentModal, type SendToAgentOptions } from './SendToAgentModal';
import { TransferProgressModal } from './TransferProgressModal';
import { LeaderboardRegistrationModal } from './LeaderboardRegistrationModal';

// Re-export types for consumers
export type { PRDetails, FlatFileItem, RecoveryAction, MergeOptions, SendToAgentOptions };

// ============================================================================
// APP INFO MODALS - Simple info/display modals
// ============================================================================

/**
 * Props for the AppInfoModals component
 */
export interface AppInfoModalsProps {
  theme: Theme;

  // Shortcuts Help Modal
  shortcutsHelpOpen: boolean;
  onCloseShortcutsHelp: () => void;
  shortcuts: Record<string, Shortcut>;
  tabShortcuts: Record<string, Shortcut>;
  hasNoAgents: boolean;
  keyboardMasteryStats: KeyboardMasteryStats;

  // About Modal
  aboutModalOpen: boolean;
  onCloseAboutModal: () => void;
  sessions: Session[];
  autoRunStats: AutoRunStats;
  usageStats?: MaestroUsageStats | null;
  onOpenLeaderboardRegistration: () => void;
  isLeaderboardRegistered: boolean;

  // Update Check Modal
  updateCheckModalOpen: boolean;
  onCloseUpdateCheckModal: () => void;

  // Process Monitor
  processMonitorOpen: boolean;
  onCloseProcessMonitor: () => void;
  groups: Group[];
  groupChats: GroupChat[];
  onNavigateToSession: (sessionId: string, tabId?: string) => void;
  onNavigateToGroupChat: (groupChatId: string) => void;
}

/**
 * AppInfoModals - Renders info/display modals (overlay modals only)
 *
 * Contains:
 * - ShortcutsHelpModal: Shows keyboard shortcuts reference
 * - AboutModal: Shows app info and stats
 * - UpdateCheckModal: Shows update status
 * - ProcessMonitor: Shows running processes
 *
 * NOTE: LogViewer is intentionally excluded - it's a content replacement component
 * that needs to be positioned in the flex layout, not an overlay modal.
 */
export function AppInfoModals({
  theme,
  // Shortcuts Help Modal
  shortcutsHelpOpen,
  onCloseShortcutsHelp,
  shortcuts,
  tabShortcuts,
  hasNoAgents,
  keyboardMasteryStats,
  // About Modal
  aboutModalOpen,
  onCloseAboutModal,
  sessions,
  autoRunStats,
  usageStats,
  onOpenLeaderboardRegistration,
  isLeaderboardRegistered,
  // Update Check Modal
  updateCheckModalOpen,
  onCloseUpdateCheckModal,
  // Process Monitor
  processMonitorOpen,
  onCloseProcessMonitor,
  groups,
  groupChats,
  onNavigateToSession,
  onNavigateToGroupChat,
}: AppInfoModalsProps) {
  return (
    <>
      {/* --- SHORTCUTS HELP MODAL --- */}
      {shortcutsHelpOpen && (
        <ShortcutsHelpModal
          theme={theme}
          shortcuts={shortcuts}
          tabShortcuts={tabShortcuts}
          onClose={onCloseShortcutsHelp}
          hasNoAgents={hasNoAgents}
          keyboardMasteryStats={keyboardMasteryStats}
        />
      )}

      {/* --- ABOUT MODAL --- */}
      {aboutModalOpen && (
        <AboutModal
          theme={theme}
          sessions={sessions}
          autoRunStats={autoRunStats}
          usageStats={usageStats}
          onClose={onCloseAboutModal}
          onOpenLeaderboardRegistration={onOpenLeaderboardRegistration}
          isLeaderboardRegistered={isLeaderboardRegistered}
        />
      )}

      {/* --- UPDATE CHECK MODAL --- */}
      {updateCheckModalOpen && (
        <UpdateCheckModal
          theme={theme}
          onClose={onCloseUpdateCheckModal}
        />
      )}

      {/* --- PROCESS MONITOR --- */}
      {processMonitorOpen && (
        <ProcessMonitor
          theme={theme}
          sessions={sessions}
          groups={groups}
          groupChats={groupChats}
          onClose={onCloseProcessMonitor}
          onNavigateToSession={onNavigateToSession}
          onNavigateToGroupChat={onNavigateToGroupChat}
        />
      )}
    </>
  );
}

// ============================================================================
// APP CONFIRM MODALS - Confirmation modals
// ============================================================================

/**
 * Props for the AppConfirmModals component
 */
export interface AppConfirmModalsProps {
  theme: Theme;
  sessions: Session[];

  // Confirm Modal
  confirmModalOpen: boolean;
  confirmModalMessage: string;
  confirmModalOnConfirm: (() => void) | null;
  onCloseConfirmModal: () => void;

  // Quit Confirm Modal
  quitConfirmModalOpen: boolean;
  onConfirmQuit: () => void;
  onCancelQuit: () => void;
}

/**
 * AppConfirmModals - Renders confirmation modals
 *
 * Contains:
 * - ConfirmModal: General-purpose confirmation dialog
 * - QuitConfirmModal: Quit app confirmation with busy agent warnings
 */
export function AppConfirmModals({
  theme,
  sessions,
  // Confirm Modal
  confirmModalOpen,
  confirmModalMessage,
  confirmModalOnConfirm,
  onCloseConfirmModal,
  // Quit Confirm Modal
  quitConfirmModalOpen,
  onConfirmQuit,
  onCancelQuit,
}: AppConfirmModalsProps) {
  // Compute busy agents for QuitConfirmModal
  const busyAgents = sessions.filter(
    s => s.state === 'busy' && s.busySource === 'ai' && s.toolType !== 'terminal'
  );

  return (
    <>
      {/* --- CONFIRMATION MODAL --- */}
      {confirmModalOpen && (
        <ConfirmModal
          theme={theme}
          message={confirmModalMessage}
          onConfirm={confirmModalOnConfirm}
          onClose={onCloseConfirmModal}
        />
      )}

      {/* --- QUIT CONFIRMATION MODAL --- */}
      {quitConfirmModalOpen && (
        <QuitConfirmModal
          theme={theme}
          busyAgentCount={busyAgents.length}
          busyAgentNames={busyAgents.map(s => s.name)}
          onConfirmQuit={onConfirmQuit}
          onCancel={onCancelQuit}
        />
      )}
    </>
  );
}

// ============================================================================
// APP SESSION MODALS - Session management modals
// ============================================================================

/**
 * Props for the AppSessionModals component
 */
export interface AppSessionModalsProps {
  theme: Theme;
  sessions: Session[];
  activeSessionId: string;
  activeSession: Session | null;

  // NewInstanceModal
  newInstanceModalOpen: boolean;
  onCloseNewInstanceModal: () => void;
  onCreateSession: (
    agentId: string,
    workingDir: string,
    name: string,
    nudgeMessage?: string,
    customPath?: string,
    customArgs?: string,
    customEnvVars?: Record<string, string>,
    customModel?: string
  ) => void;
  existingSessions: Session[];

  // EditAgentModal
  editAgentModalOpen: boolean;
  onCloseEditAgentModal: () => void;
  onSaveEditAgent: (
    sessionId: string,
    name: string,
    nudgeMessage?: string,
    customPath?: string,
    customArgs?: string,
    customEnvVars?: Record<string, string>,
    customModel?: string,
    customContextWindow?: number
  ) => void;
  editAgentSession: Session | null;

  // RenameSessionModal
  renameSessionModalOpen: boolean;
  renameSessionValue: string;
  setRenameSessionValue: (value: string) => void;
  onCloseRenameSessionModal: () => void;
  setSessions: React.Dispatch<React.SetStateAction<Session[]>>;
  renameSessionTargetId: string | null;
  onAfterRename?: () => void;

  // RenameTabModal
  renameTabModalOpen: boolean;
  renameTabId: string | null;
  renameTabInitialName: string;
  onCloseRenameTabModal: () => void;
  onRenameTab: (newName: string) => void;
}

/**
 * AppSessionModals - Renders session management modals
 *
 * Contains:
 * - NewInstanceModal: Create new agent session
 * - EditAgentModal: Edit existing agent settings
 * - RenameSessionModal: Rename an agent session
 * - RenameTabModal: Rename a conversation tab
 */
export function AppSessionModals({
  theme,
  sessions,
  activeSessionId,
  activeSession,
  // NewInstanceModal
  newInstanceModalOpen,
  onCloseNewInstanceModal,
  onCreateSession,
  existingSessions,
  // EditAgentModal
  editAgentModalOpen,
  onCloseEditAgentModal,
  onSaveEditAgent,
  editAgentSession,
  // RenameSessionModal
  renameSessionModalOpen,
  renameSessionValue,
  setRenameSessionValue,
  onCloseRenameSessionModal,
  setSessions,
  renameSessionTargetId,
  onAfterRename,
  // RenameTabModal
  renameTabModalOpen,
  renameTabId,
  renameTabInitialName,
  onCloseRenameTabModal,
  onRenameTab,
}: AppSessionModalsProps) {
  return (
    <>
      {/* --- NEW INSTANCE MODAL --- */}
      <NewInstanceModal
        isOpen={newInstanceModalOpen}
        onClose={onCloseNewInstanceModal}
        onCreate={onCreateSession}
        theme={theme}
        existingSessions={existingSessions}
      />

      {/* --- EDIT AGENT MODAL --- */}
      <EditAgentModal
        isOpen={editAgentModalOpen}
        onClose={onCloseEditAgentModal}
        onSave={onSaveEditAgent}
        theme={theme}
        session={editAgentSession}
        existingSessions={existingSessions}
      />

      {/* --- RENAME SESSION MODAL --- */}
      {renameSessionModalOpen && (
        <RenameSessionModal
          theme={theme}
          value={renameSessionValue}
          setValue={setRenameSessionValue}
          onClose={onCloseRenameSessionModal}
          sessions={sessions}
          setSessions={setSessions}
          activeSessionId={activeSessionId}
          targetSessionId={renameSessionTargetId || undefined}
          onAfterRename={onAfterRename}
        />
      )}

      {/* --- RENAME TAB MODAL --- */}
      {renameTabModalOpen && renameTabId && (
        <RenameTabModal
          theme={theme}
          initialName={renameTabInitialName}
          agentSessionId={activeSession?.aiTabs?.find(t => t.id === renameTabId)?.agentSessionId}
          onClose={onCloseRenameTabModal}
          onRename={onRenameTab}
        />
      )}
    </>
  );
}

// ============================================================================
// APP GROUP MODALS - Group management modals
// ============================================================================

/**
 * Props for the AppGroupModals component
 */
export interface AppGroupModalsProps {
  theme: Theme;
  groups: Group[];
  setGroups: React.Dispatch<React.SetStateAction<Group[]>>;

  // CreateGroupModal
  createGroupModalOpen: boolean;
  onCloseCreateGroupModal: () => void;

  // RenameGroupModal
  renameGroupModalOpen: boolean;
  renameGroupId: string | null;
  renameGroupValue: string;
  setRenameGroupValue: (value: string) => void;
  renameGroupEmoji: string;
  setRenameGroupEmoji: (emoji: string) => void;
  onCloseRenameGroupModal: () => void;
}

/**
 * AppGroupModals - Renders group management modals
 *
 * Contains:
 * - CreateGroupModal: Create a new session group
 * - RenameGroupModal: Rename an existing group
 */
export function AppGroupModals({
  theme,
  groups,
  setGroups,
  // CreateGroupModal
  createGroupModalOpen,
  onCloseCreateGroupModal,
  // RenameGroupModal
  renameGroupModalOpen,
  renameGroupId,
  renameGroupValue,
  setRenameGroupValue,
  renameGroupEmoji,
  setRenameGroupEmoji,
  onCloseRenameGroupModal,
}: AppGroupModalsProps) {
  return (
    <>
      {/* --- CREATE GROUP MODAL --- */}
      {createGroupModalOpen && (
        <CreateGroupModal
          theme={theme}
          onClose={onCloseCreateGroupModal}
          groups={groups}
          setGroups={setGroups}
        />
      )}

      {/* --- RENAME GROUP MODAL --- */}
      {renameGroupModalOpen && renameGroupId && (
        <RenameGroupModal
          theme={theme}
          groupId={renameGroupId}
          groupName={renameGroupValue}
          setGroupName={setRenameGroupValue}
          groupEmoji={renameGroupEmoji}
          setGroupEmoji={setRenameGroupEmoji}
          onClose={onCloseRenameGroupModal}
          groups={groups}
          setGroups={setGroups}
        />
      )}
    </>
  );
}

// ============================================================================
// APP WORKTREE MODALS - Worktree/PR management modals
// ============================================================================

/**
 * Props for the AppWorktreeModals component
 */
export interface AppWorktreeModalsProps {
  theme: Theme;
  activeSession: Session | null;

  // WorktreeConfigModal
  worktreeConfigModalOpen: boolean;
  onCloseWorktreeConfigModal: () => void;
  onSaveWorktreeConfig: (config: { basePath: string; watchEnabled: boolean }) => void;
  onCreateWorktreeFromConfig: (branchName: string, basePath: string) => void;
  onDisableWorktreeConfig: () => void;

  // CreateWorktreeModal
  createWorktreeModalOpen: boolean;
  createWorktreeSession: Session | null;
  onCloseCreateWorktreeModal: () => void;
  onCreateWorktree: (branchName: string) => Promise<void>;

  // CreatePRModal
  createPRModalOpen: boolean;
  createPRSession: Session | null;
  onCloseCreatePRModal: () => void;
  onPRCreated: (prDetails: PRDetails) => void;

  // DeleteWorktreeModal
  deleteWorktreeModalOpen: boolean;
  deleteWorktreeSession: Session | null;
  onCloseDeleteWorktreeModal: () => void;
  onConfirmDeleteWorktree: () => void;
  onConfirmAndDeleteWorktreeOnDisk: () => Promise<void>;
}

/**
 * AppWorktreeModals - Renders worktree and PR management modals
 *
 * Contains:
 * - WorktreeConfigModal: Configure worktree directory and settings
 * - CreateWorktreeModal: Quick create worktree from context menu
 * - CreatePRModal: Create a pull request from a worktree branch
 * - DeleteWorktreeModal: Remove a worktree session (optionally delete on disk)
 */
export function AppWorktreeModals({
  theme,
  activeSession,
  // WorktreeConfigModal
  worktreeConfigModalOpen,
  onCloseWorktreeConfigModal,
  onSaveWorktreeConfig,
  onCreateWorktreeFromConfig,
  onDisableWorktreeConfig,
  // CreateWorktreeModal
  createWorktreeModalOpen,
  createWorktreeSession,
  onCloseCreateWorktreeModal,
  onCreateWorktree,
  // CreatePRModal
  createPRModalOpen,
  createPRSession,
  onCloseCreatePRModal,
  onPRCreated,
  // DeleteWorktreeModal
  deleteWorktreeModalOpen,
  deleteWorktreeSession,
  onCloseDeleteWorktreeModal,
  onConfirmDeleteWorktree,
  onConfirmAndDeleteWorktreeOnDisk,
}: AppWorktreeModalsProps) {
  // Determine session for PR modal - uses createPRSession if set, otherwise activeSession
  const prSession = createPRSession || activeSession;

  return (
    <>
      {/* --- WORKTREE CONFIG MODAL --- */}
      {worktreeConfigModalOpen && activeSession && (
        <WorktreeConfigModal
          isOpen={worktreeConfigModalOpen}
          onClose={onCloseWorktreeConfigModal}
          theme={theme}
          session={activeSession}
          onSaveConfig={onSaveWorktreeConfig}
          onCreateWorktree={onCreateWorktreeFromConfig}
          onDisableConfig={onDisableWorktreeConfig}
        />
      )}

      {/* --- CREATE WORKTREE MODAL (quick create from context menu) --- */}
      {createWorktreeModalOpen && createWorktreeSession && (
        <CreateWorktreeModal
          isOpen={createWorktreeModalOpen}
          onClose={onCloseCreateWorktreeModal}
          theme={theme}
          session={createWorktreeSession}
          onCreateWorktree={onCreateWorktree}
        />
      )}

      {/* --- CREATE PR MODAL --- */}
      {createPRModalOpen && prSession && (
        <CreatePRModal
          isOpen={createPRModalOpen}
          onClose={onCloseCreatePRModal}
          theme={theme}
          worktreePath={prSession.cwd}
          worktreeBranch={prSession.worktreeBranch || prSession.gitBranches?.[0] || 'main'}
          availableBranches={prSession.gitBranches || ['main', 'master']}
          onPRCreated={onPRCreated}
        />
      )}

      {/* --- DELETE WORKTREE MODAL --- */}
      {deleteWorktreeModalOpen && deleteWorktreeSession && (
        <DeleteWorktreeModal
          theme={theme}
          session={deleteWorktreeSession}
          onClose={onCloseDeleteWorktreeModal}
          onConfirm={onConfirmDeleteWorktree}
          onConfirmAndDelete={onConfirmAndDeleteWorktreeOnDisk}
        />
      )}
    </>
  );
}

// ============================================================================
// APP UTILITY MODALS - Utility and workflow modals
// ============================================================================

/**
 * Props for the AppUtilityModals component
 *
 * NOTE: This is a large props interface because it wraps 10 different modals,
 * each with their own prop requirements. The complexity is intentional to
 * consolidate all utility modals in one place.
 */
export interface AppUtilityModalsProps {
  theme: Theme;
  sessions: Session[];
  setSessions: React.Dispatch<React.SetStateAction<Session[]>>;
  activeSessionId: string;
  activeSession: Session | null;
  groups: Group[];
  setGroups: React.Dispatch<React.SetStateAction<Group[]>>;
  shortcuts: Record<string, Shortcut>;
  tabShortcuts: Record<string, Shortcut>;

  // QuickActionsModal
  quickActionOpen: boolean;
  quickActionInitialMode: 'main' | 'move-to-group';
  setQuickActionOpen: (open: boolean) => void;
  setActiveSessionId: (id: string) => void;
  addNewSession: () => void;
  setRenameInstanceValue: (value: string) => void;
  setRenameInstanceModalOpen: (open: boolean) => void;
  setRenameGroupId: (id: string) => void;
  setRenameGroupValue: (value: string) => void;
  setRenameGroupEmoji: (emoji: string) => void;
  setRenameGroupModalOpen: (open: boolean) => void;
  setCreateGroupModalOpen: (open: boolean) => void;
  setLeftSidebarOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
  setRightPanelOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
  toggleInputMode: () => void;
  deleteSession: (id: string) => void;
  setSettingsModalOpen: (open: boolean) => void;
  setSettingsTab: (tab: SettingsTab) => void;
  setShortcutsHelpOpen: (open: boolean) => void;
  setAboutModalOpen: (open: boolean) => void;
  setLogViewerOpen: (open: boolean) => void;
  setProcessMonitorOpen: (open: boolean) => void;
  setActiveRightTab: (tab: RightPanelTab) => void;
  setAgentSessionsOpen: (open: boolean) => void;
  setActiveAgentSessionId: (id: string | null) => void;
  setGitDiffPreview: (diff: string | null) => void;
  setGitLogOpen: (open: boolean) => void;
  isAiMode: boolean;
  onRenameTab: () => void;
  onToggleReadOnlyMode: () => void;
  onToggleTabShowThinking: () => void;
  onOpenTabSwitcher: () => void;
  setPlaygroundOpen?: (open: boolean) => void;
  onRefreshGitFileState: () => Promise<void>;
  onDebugReleaseQueuedItem: () => void;
  markdownEditMode: boolean;
  onToggleMarkdownEditMode: () => void;
  setUpdateCheckModalOpen?: (open: boolean) => void;
  openWizard: () => void;
  wizardGoToStep: (step: WizardStep) => void;
  setDebugWizardModalOpen?: (open: boolean) => void;
  setDebugPackageModalOpen?: (open: boolean) => void;
  startTour: () => void;
  setFuzzyFileSearchOpen: (open: boolean) => void;
  onEditAgent: (session: Session) => void;
  groupChats: GroupChat[];
  onNewGroupChat: () => void;
  onOpenGroupChat: (id: string) => void;
  onCloseGroupChat: () => void;
  onDeleteGroupChat: (id: string) => void;
  activeGroupChatId: string | null;
  hasActiveSessionCapability: (capability: 'supportsSessionStorage' | 'supportsSlashCommands' | 'supportsContextMerge' | 'supportsThinkingDisplay') => boolean;
  onOpenMergeSession: () => void;
  onOpenSendToAgent: () => void;
  onOpenCreatePR: (session: Session) => void;
  onSummarizeAndContinue: () => void;
  canSummarizeActiveTab: boolean;
  onToggleRemoteControl: () => Promise<void>;
  autoRunSelectedDocument: string | null;
  autoRunCompletedTaskCount: number;
  onAutoRunResetTasks: () => void;

  // LightboxModal
  lightboxImage: string | null;
  lightboxImages: string[];
  stagedImages: string[];
  onCloseLightbox: () => void;
  onNavigateLightbox: (img: string) => void;
  onDeleteLightboxImage?: (img: string) => void;

  // GitDiffViewer
  gitDiffPreview: string | null;
  gitViewerCwd: string;
  onCloseGitDiff: () => void;

  // GitLogViewer
  gitLogOpen: boolean;
  onCloseGitLog: () => void;

  // AutoRunSetupModal
  autoRunSetupModalOpen: boolean;
  onCloseAutoRunSetup: () => void;
  onAutoRunFolderSelected: (folderPath: string) => void;

  // BatchRunnerModal
  batchRunnerModalOpen: boolean;
  onCloseBatchRunner: () => void;
  onStartBatchRun: (config: BatchRunConfig) => void;
  onSaveBatchPrompt: (prompt: string) => void;
  showConfirmation: (message: string, onConfirm: () => void) => void;
  autoRunDocumentList: string[];
  autoRunDocumentTree?: Array<{ name: string; type: 'file' | 'folder'; path: string; children?: unknown[] }>;
  getDocumentTaskCount: (filename: string) => Promise<number>;
  onAutoRunRefresh: () => Promise<void>;

  // TabSwitcherModal
  tabSwitcherOpen: boolean;
  onCloseTabSwitcher: () => void;
  onTabSelect: (tabId: string) => void;
  onNamedSessionSelect: (agentSessionId: string, projectPath: string, sessionName: string, starred?: boolean) => void;

  // FileSearchModal
  fuzzyFileSearchOpen: boolean;
  filteredFileTree: FileNode[];
  onCloseFileSearch: () => void;
  onFileSearchSelect: (file: FlatFileItem) => void;

  // PromptComposerModal
  promptComposerOpen: boolean;
  onClosePromptComposer: () => void;
  promptComposerInitialValue: string;
  onPromptComposerSubmit: (value: string) => void;
  onPromptComposerSend: (value: string) => void;
  promptComposerSessionName?: string;
  promptComposerStagedImages: string[];
  setPromptComposerStagedImages?: React.Dispatch<React.SetStateAction<string[]>>;
  onPromptImageAttachBlocked?: () => void;
  onPromptOpenLightbox: (image: string, contextImages?: string[], source?: 'staged' | 'history') => void;
  promptTabSaveToHistory: boolean;
  onPromptToggleTabSaveToHistory?: () => void;
  promptTabReadOnlyMode: boolean;
  onPromptToggleTabReadOnlyMode: () => void;
  promptTabShowThinking: boolean;
  onPromptToggleTabShowThinking?: () => void;
  promptSupportsThinking: boolean;
  promptEnterToSend: boolean;
  onPromptToggleEnterToSend: () => void;

  // ExecutionQueueBrowser
  queueBrowserOpen: boolean;
  onCloseQueueBrowser: () => void;
  onRemoveQueueItem: (sessionId: string, itemId: string) => void;
  onSwitchQueueSession: (sessionId: string) => void;
  onReorderQueueItems: (sessionId: string, fromIndex: number, toIndex: number) => void;
}

/**
 * AppUtilityModals - Renders utility and workflow modals
 *
 * Contains:
 * - QuickActionsModal: Command palette (Cmd+K)
 * - TabSwitcherModal: Switch between conversation tabs
 * - FileSearchModal: Fuzzy file search
 * - PromptComposerModal: Full-screen prompt editor
 * - ExecutionQueueBrowser: View and manage execution queue
 * - BatchRunnerModal: Configure batch/Auto Run execution
 * - AutoRunSetupModal: Set up Auto Run folder
 * - LightboxModal: Image lightbox/carousel
 * - GitDiffViewer: View git diffs
 * - GitLogViewer: View git log
 */
export function AppUtilityModals({
  theme,
  sessions,
  setSessions,
  activeSessionId,
  activeSession,
  groups,
  setGroups,
  shortcuts,
  tabShortcuts,
  // QuickActionsModal
  quickActionOpen,
  quickActionInitialMode,
  setQuickActionOpen,
  setActiveSessionId,
  addNewSession,
  setRenameInstanceValue,
  setRenameInstanceModalOpen,
  setRenameGroupId,
  setRenameGroupValue,
  setRenameGroupEmoji,
  setRenameGroupModalOpen,
  setCreateGroupModalOpen,
  setLeftSidebarOpen,
  setRightPanelOpen,
  toggleInputMode,
  deleteSession,
  setSettingsModalOpen,
  setSettingsTab,
  setShortcutsHelpOpen,
  setAboutModalOpen,
  setLogViewerOpen,
  setProcessMonitorOpen,
  setActiveRightTab,
  setAgentSessionsOpen,
  setActiveAgentSessionId,
  setGitDiffPreview,
  setGitLogOpen,
  isAiMode,
  onRenameTab,
  onToggleReadOnlyMode,
  onToggleTabShowThinking,
  onOpenTabSwitcher,
  setPlaygroundOpen,
  onRefreshGitFileState,
  onDebugReleaseQueuedItem,
  markdownEditMode,
  onToggleMarkdownEditMode,
  setUpdateCheckModalOpen,
  openWizard,
  wizardGoToStep,
  setDebugWizardModalOpen,
  setDebugPackageModalOpen,
  startTour,
  setFuzzyFileSearchOpen,
  onEditAgent,
  groupChats,
  onNewGroupChat,
  onOpenGroupChat,
  onCloseGroupChat,
  onDeleteGroupChat,
  activeGroupChatId,
  hasActiveSessionCapability,
  onOpenMergeSession,
  onOpenSendToAgent,
  onOpenCreatePR,
  onSummarizeAndContinue,
  canSummarizeActiveTab,
  onToggleRemoteControl,
  autoRunSelectedDocument,
  autoRunCompletedTaskCount,
  onAutoRunResetTasks,
  // LightboxModal
  lightboxImage,
  lightboxImages,
  stagedImages,
  onCloseLightbox,
  onNavigateLightbox,
  onDeleteLightboxImage,
  // GitDiffViewer
  gitDiffPreview,
  gitViewerCwd,
  onCloseGitDiff,
  // GitLogViewer
  gitLogOpen,
  onCloseGitLog,
  // AutoRunSetupModal
  autoRunSetupModalOpen,
  onCloseAutoRunSetup,
  onAutoRunFolderSelected,
  // BatchRunnerModal
  batchRunnerModalOpen,
  onCloseBatchRunner,
  onStartBatchRun,
  onSaveBatchPrompt,
  showConfirmation,
  autoRunDocumentList,
  autoRunDocumentTree,
  getDocumentTaskCount,
  onAutoRunRefresh,
  // TabSwitcherModal
  tabSwitcherOpen,
  onCloseTabSwitcher,
  onTabSelect,
  onNamedSessionSelect,
  // FileSearchModal
  fuzzyFileSearchOpen,
  filteredFileTree,
  onCloseFileSearch,
  onFileSearchSelect,
  // PromptComposerModal
  promptComposerOpen,
  onClosePromptComposer,
  promptComposerInitialValue,
  onPromptComposerSubmit,
  onPromptComposerSend,
  promptComposerSessionName,
  promptComposerStagedImages,
  setPromptComposerStagedImages,
  onPromptImageAttachBlocked,
  onPromptOpenLightbox,
  promptTabSaveToHistory,
  onPromptToggleTabSaveToHistory,
  promptTabReadOnlyMode,
  onPromptToggleTabReadOnlyMode,
  promptTabShowThinking,
  onPromptToggleTabShowThinking,
  promptSupportsThinking,
  promptEnterToSend,
  onPromptToggleEnterToSend,
  // ExecutionQueueBrowser
  queueBrowserOpen,
  onCloseQueueBrowser,
  onRemoveQueueItem,
  onSwitchQueueSession,
  onReorderQueueItems,
}: AppUtilityModalsProps) {
  return (
    <>
      {/* --- QUICK ACTIONS MODAL (Cmd+K) --- */}
      {quickActionOpen && (
        <QuickActionsModal
          theme={theme}
          sessions={sessions}
          setSessions={setSessions}
          activeSessionId={activeSessionId}
          groups={groups}
          setGroups={setGroups}
          shortcuts={shortcuts}
          initialMode={quickActionInitialMode}
          setQuickActionOpen={setQuickActionOpen}
          setActiveSessionId={setActiveSessionId}
          addNewSession={addNewSession}
          setRenameInstanceValue={setRenameInstanceValue}
          setRenameInstanceModalOpen={setRenameInstanceModalOpen}
          setRenameGroupId={setRenameGroupId}
          setRenameGroupValue={setRenameGroupValue}
          setRenameGroupEmoji={setRenameGroupEmoji}
          setRenameGroupModalOpen={setRenameGroupModalOpen}
          setCreateGroupModalOpen={setCreateGroupModalOpen}
          setLeftSidebarOpen={setLeftSidebarOpen}
          setRightPanelOpen={setRightPanelOpen}
          toggleInputMode={toggleInputMode}
          deleteSession={deleteSession}
          setSettingsModalOpen={setSettingsModalOpen}
          setSettingsTab={setSettingsTab}
          setShortcutsHelpOpen={setShortcutsHelpOpen}
          setAboutModalOpen={setAboutModalOpen}
          setLogViewerOpen={setLogViewerOpen}
          setProcessMonitorOpen={setProcessMonitorOpen}
          setActiveRightTab={setActiveRightTab}
          setAgentSessionsOpen={setAgentSessionsOpen}
          setActiveAgentSessionId={setActiveAgentSessionId}
          setGitDiffPreview={setGitDiffPreview}
          setGitLogOpen={setGitLogOpen}
          isAiMode={isAiMode}
          tabShortcuts={tabShortcuts}
          onRenameTab={onRenameTab}
          onToggleReadOnlyMode={onToggleReadOnlyMode}
          onToggleTabShowThinking={onToggleTabShowThinking}
          onOpenTabSwitcher={onOpenTabSwitcher}
          setPlaygroundOpen={setPlaygroundOpen}
          onRefreshGitFileState={onRefreshGitFileState}
          onDebugReleaseQueuedItem={onDebugReleaseQueuedItem}
          markdownEditMode={markdownEditMode}
          onToggleMarkdownEditMode={onToggleMarkdownEditMode}
          setUpdateCheckModalOpen={setUpdateCheckModalOpen}
          openWizard={openWizard}
          wizardGoToStep={wizardGoToStep}
          setDebugWizardModalOpen={setDebugWizardModalOpen}
          setDebugPackageModalOpen={setDebugPackageModalOpen}
          startTour={startTour}
          setFuzzyFileSearchOpen={setFuzzyFileSearchOpen}
          onEditAgent={onEditAgent}
          groupChats={groupChats}
          onNewGroupChat={onNewGroupChat}
          onOpenGroupChat={onOpenGroupChat}
          onCloseGroupChat={onCloseGroupChat}
          onDeleteGroupChat={onDeleteGroupChat}
          activeGroupChatId={activeGroupChatId}
          hasActiveSessionCapability={hasActiveSessionCapability}
          onOpenMergeSession={onOpenMergeSession}
          onOpenSendToAgent={onOpenSendToAgent}
          onOpenCreatePR={onOpenCreatePR}
          onSummarizeAndContinue={onSummarizeAndContinue}
          canSummarizeActiveTab={canSummarizeActiveTab}
          onToggleRemoteControl={onToggleRemoteControl}
          autoRunSelectedDocument={autoRunSelectedDocument}
          autoRunCompletedTaskCount={autoRunCompletedTaskCount}
          onAutoRunResetTasks={onAutoRunResetTasks}
        />
      )}

      {/* --- LIGHTBOX MODAL --- */}
      {lightboxImage && (
        <LightboxModal
          image={lightboxImage}
          stagedImages={lightboxImages.length > 0 ? lightboxImages : stagedImages}
          onClose={onCloseLightbox}
          onNavigate={onNavigateLightbox}
          onDelete={onDeleteLightboxImage}
          theme={theme}
        />
      )}

      {/* --- GIT DIFF VIEWER --- */}
      {gitDiffPreview && activeSession && (
        <GitDiffViewer
          diffText={gitDiffPreview}
          cwd={gitViewerCwd}
          theme={theme}
          onClose={onCloseGitDiff}
        />
      )}

      {/* --- GIT LOG VIEWER --- */}
      {gitLogOpen && activeSession && (
        <GitLogViewer
          cwd={gitViewerCwd}
          theme={theme}
          onClose={onCloseGitLog}
        />
      )}

      {/* --- AUTO RUN SETUP MODAL --- */}
      {autoRunSetupModalOpen && (
        <AutoRunSetupModal
          theme={theme}
          onClose={onCloseAutoRunSetup}
          onFolderSelected={onAutoRunFolderSelected}
          currentFolder={activeSession?.autoRunFolderPath}
          sessionName={activeSession?.name}
        />
      )}

      {/* --- BATCH RUNNER MODAL --- */}
      {batchRunnerModalOpen && activeSession && activeSession.autoRunFolderPath && (
        <BatchRunnerModal
          theme={theme}
          onClose={onCloseBatchRunner}
          onGo={onStartBatchRun}
          onSave={onSaveBatchPrompt}
          initialPrompt={activeSession.batchRunnerPrompt || ''}
          lastModifiedAt={activeSession.batchRunnerPromptModifiedAt}
          showConfirmation={showConfirmation}
          folderPath={activeSession.autoRunFolderPath}
          currentDocument={activeSession.autoRunSelectedFile || ''}
          allDocuments={autoRunDocumentList}
          documentTree={autoRunDocumentTree}
          getDocumentTaskCount={getDocumentTaskCount}
          onRefreshDocuments={onAutoRunRefresh}
          sessionId={activeSession.id}
        />
      )}

      {/* --- TAB SWITCHER MODAL --- */}
      {tabSwitcherOpen && activeSession?.aiTabs && (
        <TabSwitcherModal
          theme={theme}
          tabs={activeSession.aiTabs}
          activeTabId={activeSession.activeTabId}
          projectRoot={activeSession.projectRoot}
          agentId={activeSession.toolType}
          shortcut={tabShortcuts.tabSwitcher}
          onTabSelect={onTabSelect}
          onNamedSessionSelect={onNamedSessionSelect}
          onClose={onCloseTabSwitcher}
        />
      )}

      {/* --- FUZZY FILE SEARCH MODAL --- */}
      {fuzzyFileSearchOpen && activeSession && (
        <FileSearchModal
          theme={theme}
          fileTree={filteredFileTree}
          shortcut={shortcuts.fuzzyFileSearch}
          onFileSelect={onFileSearchSelect}
          onClose={onCloseFileSearch}
        />
      )}

      {/* --- PROMPT COMPOSER MODAL --- */}
      <PromptComposerModal
        isOpen={promptComposerOpen}
        onClose={onClosePromptComposer}
        theme={theme}
        initialValue={promptComposerInitialValue}
        onSubmit={onPromptComposerSubmit}
        onSend={onPromptComposerSend}
        sessionName={promptComposerSessionName}
        stagedImages={promptComposerStagedImages}
        setStagedImages={setPromptComposerStagedImages}
        onImageAttachBlocked={onPromptImageAttachBlocked}
        onOpenLightbox={onPromptOpenLightbox}
        tabSaveToHistory={promptTabSaveToHistory}
        onToggleTabSaveToHistory={onPromptToggleTabSaveToHistory}
        tabReadOnlyMode={promptTabReadOnlyMode}
        onToggleTabReadOnlyMode={onPromptToggleTabReadOnlyMode}
        tabShowThinking={promptTabShowThinking}
        onToggleTabShowThinking={onPromptToggleTabShowThinking}
        supportsThinking={promptSupportsThinking}
        enterToSend={promptEnterToSend}
        onToggleEnterToSend={onPromptToggleEnterToSend}
      />

      {/* --- EXECUTION QUEUE BROWSER --- */}
      <ExecutionQueueBrowser
        isOpen={queueBrowserOpen}
        onClose={onCloseQueueBrowser}
        sessions={sessions}
        activeSessionId={activeSessionId}
        theme={theme}
        onRemoveItem={onRemoveQueueItem}
        onSwitchSession={onSwitchQueueSession}
        onReorderItems={onReorderQueueItems}
      />
    </>
  );
}

// ============================================================================
// APP GROUP CHAT MODALS - Group Chat management modals
// ============================================================================

/**
 * Props for the AppGroupChatModals component
 */
export interface AppGroupChatModalsProps {
  theme: Theme;
  groupChats: GroupChat[];

  // NewGroupChatModal
  showNewGroupChatModal: boolean;
  onCloseNewGroupChatModal: () => void;
  onCreateGroupChat: (
    name: string,
    moderatorAgentId: string,
    moderatorConfig?: ModeratorConfig
  ) => void;

  // DeleteGroupChatModal
  showDeleteGroupChatModal: string | null;
  onCloseDeleteGroupChatModal: () => void;
  onConfirmDeleteGroupChat: () => void;

  // RenameGroupChatModal
  showRenameGroupChatModal: string | null;
  onCloseRenameGroupChatModal: () => void;
  onRenameGroupChat: (newName: string) => void;

  // EditGroupChatModal
  showEditGroupChatModal: string | null;
  onCloseEditGroupChatModal: () => void;
  onUpdateGroupChat: (
    id: string,
    name: string,
    moderatorAgentId: string,
    moderatorConfig?: ModeratorConfig
  ) => void;

  // GroupChatInfoOverlay
  showGroupChatInfo: boolean;
  activeGroupChatId: string | null;
  groupChatMessages: GroupChatMessage[];
  onCloseGroupChatInfo: () => void;
  onOpenModeratorSession: (moderatorSessionId: string) => void;
}

/**
 * AppGroupChatModals - Renders Group Chat management modals
 *
 * Contains:
 * - NewGroupChatModal: Create a new group chat
 * - DeleteGroupChatModal: Confirm deletion of a group chat
 * - RenameGroupChatModal: Rename an existing group chat
 * - EditGroupChatModal: Edit group chat settings (name, moderator)
 * - GroupChatInfoOverlay: View group chat info and statistics
 */
export function AppGroupChatModals({
  theme,
  groupChats,
  // NewGroupChatModal
  showNewGroupChatModal,
  onCloseNewGroupChatModal,
  onCreateGroupChat,
  // DeleteGroupChatModal
  showDeleteGroupChatModal,
  onCloseDeleteGroupChatModal,
  onConfirmDeleteGroupChat,
  // RenameGroupChatModal
  showRenameGroupChatModal,
  onCloseRenameGroupChatModal,
  onRenameGroupChat,
  // EditGroupChatModal
  showEditGroupChatModal,
  onCloseEditGroupChatModal,
  onUpdateGroupChat,
  // GroupChatInfoOverlay
  showGroupChatInfo,
  activeGroupChatId,
  groupChatMessages,
  onCloseGroupChatInfo,
  onOpenModeratorSession,
}: AppGroupChatModalsProps) {
  // Find group chats by ID for modal props
  const deleteGroupChat = showDeleteGroupChatModal
    ? groupChats.find(c => c.id === showDeleteGroupChatModal)
    : null;

  const renameGroupChat = showRenameGroupChatModal
    ? groupChats.find(c => c.id === showRenameGroupChatModal)
    : null;

  const editGroupChat = showEditGroupChatModal
    ? groupChats.find(c => c.id === showEditGroupChatModal)
    : null;

  const infoGroupChat = activeGroupChatId
    ? groupChats.find(c => c.id === activeGroupChatId)
    : null;

  return (
    <>
      {/* --- NEW GROUP CHAT MODAL --- */}
      {showNewGroupChatModal && (
        <NewGroupChatModal
          theme={theme}
          isOpen={showNewGroupChatModal}
          onClose={onCloseNewGroupChatModal}
          onCreate={onCreateGroupChat}
        />
      )}

      {/* --- DELETE GROUP CHAT MODAL --- */}
      {showDeleteGroupChatModal && deleteGroupChat && (
        <DeleteGroupChatModal
          theme={theme}
          isOpen={!!showDeleteGroupChatModal}
          groupChatName={deleteGroupChat.name}
          onClose={onCloseDeleteGroupChatModal}
          onConfirm={onConfirmDeleteGroupChat}
        />
      )}

      {/* --- RENAME GROUP CHAT MODAL --- */}
      {showRenameGroupChatModal && renameGroupChat && (
        <RenameGroupChatModal
          theme={theme}
          isOpen={!!showRenameGroupChatModal}
          currentName={renameGroupChat.name}
          onClose={onCloseRenameGroupChatModal}
          onRename={onRenameGroupChat}
        />
      )}

      {/* --- EDIT GROUP CHAT MODAL --- */}
      {showEditGroupChatModal && (
        <EditGroupChatModal
          theme={theme}
          isOpen={!!showEditGroupChatModal}
          groupChat={editGroupChat || null}
          onClose={onCloseEditGroupChatModal}
          onSave={onUpdateGroupChat}
        />
      )}

      {/* --- GROUP CHAT INFO OVERLAY --- */}
      {showGroupChatInfo && activeGroupChatId && infoGroupChat && (
        <GroupChatInfoOverlay
          theme={theme}
          isOpen={showGroupChatInfo}
          groupChat={infoGroupChat}
          messages={groupChatMessages}
          onClose={onCloseGroupChatInfo}
          onOpenModeratorSession={onOpenModeratorSession}
        />
      )}
    </>
  );
}

// ============================================================================
// APP AGENT MODALS - Agent error and context transfer modals
// ============================================================================

/**
 * Group chat error structure (used for displaying agent errors in group chat context)
 */
export interface GroupChatErrorInfo {
  groupChatId: string;
  participantId?: string;
  participantName?: string;
  error: AgentError;
}

/**
 * Props for the AppAgentModals component
 */
export interface AppAgentModalsProps {
  theme: Theme;
  sessions: Session[];
  activeSession: Session | null;
  groupChats: GroupChat[];

  // LeaderboardRegistrationModal
  leaderboardRegistrationOpen: boolean;
  onCloseLeaderboardRegistration: () => void;
  autoRunStats: AutoRunStats;
  keyboardMasteryStats: KeyboardMasteryStats;
  leaderboardRegistration: LeaderboardRegistration | null;
  onSaveLeaderboardRegistration: (registration: LeaderboardRegistration) => void;
  onLeaderboardOptOut: () => void;

  // AgentErrorModal (for individual agents)
  errorSession: Session | null | undefined;
  recoveryActions: RecoveryAction[];
  onDismissAgentError: () => void;

  // AgentErrorModal (for group chats)
  groupChatError: GroupChatErrorInfo | null;
  groupChatRecoveryActions: RecoveryAction[];
  onClearGroupChatError: () => void;

  // MergeSessionModal
  mergeSessionModalOpen: boolean;
  onCloseMergeSession: () => void;
  onMerge: (
    targetSessionId: string,
    targetTabId: string | undefined,
    options: MergeOptions
  ) => Promise<MergeResult>;

  // TransferProgressModal
  transferState: 'idle' | 'grooming' | 'creating' | 'complete' | 'error';
  transferProgress: GroomingProgress | null;
  transferSourceAgent: ToolType | null;
  transferTargetAgent: ToolType | null;
  onCancelTransfer: () => void;
  onCompleteTransfer: () => void;

  // SendToAgentModal
  sendToAgentModalOpen: boolean;
  onCloseSendToAgent: () => void;
  onSendToAgent: (
    targetSessionId: string,
    options: SendToAgentOptions
  ) => Promise<MergeResult>;
}

/**
 * AppAgentModals - Renders agent error and context transfer modals
 *
 * Contains:
 * - LeaderboardRegistrationModal: Register for the runmaestro.ai leaderboard
 * - AgentErrorModal: Display agent errors with recovery options (agents and group chats)
 * - MergeSessionModal: Merge current context into another session
 * - TransferProgressModal: Show progress during cross-agent context transfer
 * - SendToAgentModal: Send session context to another Maestro session
 */
export function AppAgentModals({
  theme,
  sessions,
  activeSession,
  groupChats,
  // LeaderboardRegistrationModal
  leaderboardRegistrationOpen,
  onCloseLeaderboardRegistration,
  autoRunStats,
  keyboardMasteryStats,
  leaderboardRegistration,
  onSaveLeaderboardRegistration,
  onLeaderboardOptOut,
  // AgentErrorModal (for individual agents)
  errorSession,
  recoveryActions,
  onDismissAgentError,
  // AgentErrorModal (for group chats)
  groupChatError,
  groupChatRecoveryActions,
  onClearGroupChatError,
  // MergeSessionModal
  mergeSessionModalOpen,
  onCloseMergeSession,
  onMerge,
  // TransferProgressModal
  transferState,
  transferProgress,
  transferSourceAgent,
  transferTargetAgent,
  onCancelTransfer,
  onCompleteTransfer,
  // SendToAgentModal
  sendToAgentModalOpen,
  onCloseSendToAgent,
  onSendToAgent,
}: AppAgentModalsProps) {
  return (
    <>
      {/* --- LEADERBOARD REGISTRATION MODAL --- */}
      {leaderboardRegistrationOpen && (
        <LeaderboardRegistrationModal
          theme={theme}
          autoRunStats={autoRunStats}
          keyboardMasteryStats={keyboardMasteryStats}
          existingRegistration={leaderboardRegistration}
          onClose={onCloseLeaderboardRegistration}
          onSave={onSaveLeaderboardRegistration}
          onOptOut={onLeaderboardOptOut}
        />
      )}

      {/* --- AGENT ERROR MODAL (individual agents) --- */}
      {errorSession?.agentError && (
        <AgentErrorModal
          theme={theme}
          error={errorSession.agentError}
          agentName={errorSession.toolType === 'claude-code' ? 'Claude Code' : errorSession.toolType}
          sessionName={errorSession.name}
          recoveryActions={recoveryActions}
          onDismiss={onDismissAgentError}
          dismissible={errorSession.agentError.recoverable}
        />
      )}

      {/* --- AGENT ERROR MODAL (group chats) --- */}
      {groupChatError && (
        <AgentErrorModal
          theme={theme}
          error={groupChatError.error}
          agentName={groupChatError.participantName || 'Group Chat'}
          sessionName={groupChats.find(c => c.id === groupChatError.groupChatId)?.name || 'Unknown'}
          recoveryActions={groupChatRecoveryActions}
          onDismiss={onClearGroupChatError}
          dismissible={groupChatError.error.recoverable}
        />
      )}

      {/* --- MERGE SESSION MODAL --- */}
      {mergeSessionModalOpen && activeSession && activeSession.activeTabId && (
        <MergeSessionModal
          theme={theme}
          isOpen={mergeSessionModalOpen}
          sourceSession={activeSession}
          sourceTabId={activeSession.activeTabId}
          allSessions={sessions}
          onClose={onCloseMergeSession}
          onMerge={onMerge}
        />
      )}

      {/* --- TRANSFER PROGRESS MODAL --- */}
      {(transferState === 'grooming' || transferState === 'creating' || transferState === 'complete') &&
        transferProgress &&
        transferSourceAgent &&
        transferTargetAgent && (
        <TransferProgressModal
          theme={theme}
          isOpen={true}
          progress={transferProgress}
          sourceAgent={transferSourceAgent}
          targetAgent={transferTargetAgent}
          onCancel={onCancelTransfer}
          onComplete={onCompleteTransfer}
        />
      )}

      {/* --- SEND TO AGENT MODAL --- */}
      {sendToAgentModalOpen && activeSession && activeSession.activeTabId && (
        <SendToAgentModal
          theme={theme}
          isOpen={sendToAgentModalOpen}
          sourceSession={activeSession}
          sourceTabId={activeSession.activeTabId}
          allSessions={sessions}
          onClose={onCloseSendToAgent}
          onSend={onSendToAgent}
        />
      )}
    </>
  );
}

// ============================================================================
// UNIFIED APP MODALS - Single component combining all modal groups
// ============================================================================

/**
 * Combined props interface for the unified AppModals component.
 * This consolidates all modal group props into a single interface for simpler
 * usage in App.tsx.
 */
export interface AppModalsProps {
  // Common props
  theme: Theme;
  sessions: Session[];
  setSessions: React.Dispatch<React.SetStateAction<Session[]>>;
  activeSessionId: string;
  activeSession: Session | null;
  groups: Group[];
  setGroups: React.Dispatch<React.SetStateAction<Group[]>>;
  groupChats: GroupChat[];
  shortcuts: Record<string, Shortcut>;
  tabShortcuts: Record<string, Shortcut>;

  // --- AppInfoModals props ---
  shortcutsHelpOpen: boolean;
  onCloseShortcutsHelp: () => void;
  hasNoAgents: boolean;
  keyboardMasteryStats: KeyboardMasteryStats;
  aboutModalOpen: boolean;
  onCloseAboutModal: () => void;
  autoRunStats: AutoRunStats;
  usageStats?: MaestroUsageStats | null;
  onOpenLeaderboardRegistration: () => void;
  isLeaderboardRegistered: boolean;
  updateCheckModalOpen: boolean;
  onCloseUpdateCheckModal: () => void;
  processMonitorOpen: boolean;
  onCloseProcessMonitor: () => void;
  onNavigateToSession: (sessionId: string, tabId?: string) => void;
  onNavigateToGroupChat: (groupChatId: string) => void;

  // --- AppConfirmModals props ---
  confirmModalOpen: boolean;
  confirmModalMessage: string;
  confirmModalOnConfirm: (() => void) | null;
  onCloseConfirmModal: () => void;
  quitConfirmModalOpen: boolean;
  onConfirmQuit: () => void;
  onCancelQuit: () => void;

  // --- AppSessionModals props ---
  newInstanceModalOpen: boolean;
  onCloseNewInstanceModal: () => void;
  onCreateSession: (
    agentId: string,
    workingDir: string,
    name: string,
    nudgeMessage?: string,
    customPath?: string,
    customArgs?: string,
    customEnvVars?: Record<string, string>,
    customModel?: string
  ) => void;
  existingSessions: Session[];
  editAgentModalOpen: boolean;
  onCloseEditAgentModal: () => void;
  onSaveEditAgent: (
    sessionId: string,
    name: string,
    nudgeMessage?: string,
    customPath?: string,
    customArgs?: string,
    customEnvVars?: Record<string, string>,
    customModel?: string,
    customContextWindow?: number
  ) => void;
  editAgentSession: Session | null;
  renameSessionModalOpen: boolean;
  renameSessionValue: string;
  setRenameSessionValue: (value: string) => void;
  onCloseRenameSessionModal: () => void;
  renameSessionTargetId: string | null;
  onAfterRename?: () => void;
  renameTabModalOpen: boolean;
  renameTabId: string | null;
  renameTabInitialName: string;
  onCloseRenameTabModal: () => void;
  onRenameTab: (newName: string) => void;

  // --- AppGroupModals props ---
  createGroupModalOpen: boolean;
  onCloseCreateGroupModal: () => void;
  renameGroupModalOpen: boolean;
  renameGroupId: string | null;
  renameGroupValue: string;
  setRenameGroupValue: (value: string) => void;
  renameGroupEmoji: string;
  setRenameGroupEmoji: (emoji: string) => void;
  onCloseRenameGroupModal: () => void;

  // --- AppWorktreeModals props ---
  worktreeConfigModalOpen: boolean;
  onCloseWorktreeConfigModal: () => void;
  onSaveWorktreeConfig: (config: { basePath: string; watchEnabled: boolean }) => void;
  onCreateWorktreeFromConfig: (branchName: string, basePath: string) => void;
  onDisableWorktreeConfig: () => void;
  createWorktreeModalOpen: boolean;
  createWorktreeSession: Session | null;
  onCloseCreateWorktreeModal: () => void;
  onCreateWorktree: (branchName: string) => Promise<void>;
  createPRModalOpen: boolean;
  createPRSession: Session | null;
  onCloseCreatePRModal: () => void;
  onPRCreated: (prDetails: PRDetails) => void;
  deleteWorktreeModalOpen: boolean;
  deleteWorktreeSession: Session | null;
  onCloseDeleteWorktreeModal: () => void;
  onConfirmDeleteWorktree: () => void;
  onConfirmAndDeleteWorktreeOnDisk: () => Promise<void>;

  // --- AppUtilityModals props ---
  quickActionOpen: boolean;
  quickActionInitialMode: 'main' | 'move-to-group';
  setQuickActionOpen: (open: boolean) => void;
  setActiveSessionId: (id: string) => void;
  addNewSession: () => void;
  setRenameInstanceValue: (value: string) => void;
  setRenameInstanceModalOpen: (open: boolean) => void;
  setRenameGroupId: (id: string) => void;
  setRenameGroupValueForQuickActions: (value: string) => void;
  setRenameGroupEmojiForQuickActions: (emoji: string) => void;
  setRenameGroupModalOpenForQuickActions: (open: boolean) => void;
  setCreateGroupModalOpenForQuickActions: (open: boolean) => void;
  setLeftSidebarOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
  setRightPanelOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
  toggleInputMode: () => void;
  deleteSession: (id: string) => void;
  setSettingsModalOpen: (open: boolean) => void;
  setSettingsTab: (tab: SettingsTab) => void;
  setShortcutsHelpOpen: (open: boolean) => void;
  setAboutModalOpen: (open: boolean) => void;
  setLogViewerOpen: (open: boolean) => void;
  setProcessMonitorOpen: (open: boolean) => void;
  setActiveRightTab: (tab: RightPanelTab) => void;
  setAgentSessionsOpen: (open: boolean) => void;
  setActiveAgentSessionId: (id: string | null) => void;
  setGitDiffPreview: (diff: string | null) => void;
  setGitLogOpen: (open: boolean) => void;
  isAiMode: boolean;
  onQuickActionsRenameTab: () => void;
  onQuickActionsToggleReadOnlyMode: () => void;
  onQuickActionsToggleTabShowThinking: () => void;
  onQuickActionsOpenTabSwitcher: () => void;
  setPlaygroundOpen?: (open: boolean) => void;
  onQuickActionsRefreshGitFileState: () => Promise<void>;
  onQuickActionsDebugReleaseQueuedItem: () => void;
  markdownEditMode: boolean;
  onQuickActionsToggleMarkdownEditMode: () => void;
  setUpdateCheckModalOpenForQuickActions?: (open: boolean) => void;
  openWizard: () => void;
  wizardGoToStep: (step: WizardStep) => void;
  setDebugWizardModalOpen?: (open: boolean) => void;
  setDebugPackageModalOpen?: (open: boolean) => void;
  startTour: () => void;
  setFuzzyFileSearchOpen: (open: boolean) => void;
  onEditAgent: (session: Session) => void;
  onNewGroupChat: () => void;
  onOpenGroupChat: (id: string) => void;
  onCloseGroupChat: () => void;
  onDeleteGroupChat: (id: string) => void;
  activeGroupChatId: string | null;
  hasActiveSessionCapability: (capability: 'supportsSessionStorage' | 'supportsSlashCommands' | 'supportsContextMerge' | 'supportsThinkingDisplay') => boolean;
  onOpenMergeSession: () => void;
  onOpenSendToAgent: () => void;
  onOpenCreatePR: (session: Session) => void;
  onSummarizeAndContinue: () => void;
  canSummarizeActiveTab: boolean;
  onToggleRemoteControl: () => Promise<void>;
  autoRunSelectedDocument: string | null;
  autoRunCompletedTaskCount: number;
  onAutoRunResetTasks: () => void;
  lightboxImage: string | null;
  lightboxImages: string[];
  stagedImages: string[];
  onCloseLightbox: () => void;
  onNavigateLightbox: (img: string) => void;
  onDeleteLightboxImage?: (img: string) => void;
  gitDiffPreview: string | null;
  gitViewerCwd: string;
  onCloseGitDiff: () => void;
  gitLogOpen: boolean;
  onCloseGitLog: () => void;
  autoRunSetupModalOpen: boolean;
  onCloseAutoRunSetup: () => void;
  onAutoRunFolderSelected: (folderPath: string) => void;
  batchRunnerModalOpen: boolean;
  onCloseBatchRunner: () => void;
  onStartBatchRun: (config: BatchRunConfig) => void;
  onSaveBatchPrompt: (prompt: string) => void;
  showConfirmation: (message: string, onConfirm: () => void) => void;
  autoRunDocumentList: string[];
  autoRunDocumentTree?: Array<{ name: string; type: 'file' | 'folder'; path: string; children?: unknown[] }>;
  getDocumentTaskCount: (filename: string) => Promise<number>;
  onAutoRunRefresh: () => Promise<void>;
  tabSwitcherOpen: boolean;
  onCloseTabSwitcher: () => void;
  onTabSelect: (tabId: string) => void;
  onNamedSessionSelect: (agentSessionId: string, projectPath: string, sessionName: string, starred?: boolean) => void;
  fuzzyFileSearchOpen: boolean;
  filteredFileTree: FileNode[];
  onCloseFileSearch: () => void;
  onFileSearchSelect: (file: FlatFileItem) => void;
  promptComposerOpen: boolean;
  onClosePromptComposer: () => void;
  promptComposerInitialValue: string;
  onPromptComposerSubmit: (value: string) => void;
  onPromptComposerSend: (value: string) => void;
  promptComposerSessionName?: string;
  promptComposerStagedImages: string[];
  setPromptComposerStagedImages?: React.Dispatch<React.SetStateAction<string[]>>;
  onPromptImageAttachBlocked?: () => void;
  onPromptOpenLightbox: (image: string, contextImages?: string[], source?: 'staged' | 'history') => void;
  promptTabSaveToHistory: boolean;
  onPromptToggleTabSaveToHistory?: () => void;
  promptTabReadOnlyMode: boolean;
  onPromptToggleTabReadOnlyMode: () => void;
  promptTabShowThinking: boolean;
  onPromptToggleTabShowThinking?: () => void;
  promptSupportsThinking: boolean;
  promptEnterToSend: boolean;
  onPromptToggleEnterToSend: () => void;
  queueBrowserOpen: boolean;
  onCloseQueueBrowser: () => void;
  onRemoveQueueItem: (sessionId: string, itemId: string) => void;
  onSwitchQueueSession: (sessionId: string) => void;
  onReorderQueueItems: (sessionId: string, fromIndex: number, toIndex: number) => void;

  // --- AppGroupChatModals props ---
  showNewGroupChatModal: boolean;
  onCloseNewGroupChatModal: () => void;
  onCreateGroupChat: (name: string, moderatorAgentId: string, moderatorConfig?: ModeratorConfig) => void;
  showDeleteGroupChatModal: string | null;
  onCloseDeleteGroupChatModal: () => void;
  onConfirmDeleteGroupChat: () => void;
  showRenameGroupChatModal: string | null;
  onCloseRenameGroupChatModal: () => void;
  onRenameGroupChatFromModal: (newName: string) => void;
  showEditGroupChatModal: string | null;
  onCloseEditGroupChatModal: () => void;
  onUpdateGroupChat: (id: string, name: string, moderatorAgentId: string, moderatorConfig?: ModeratorConfig) => void;
  showGroupChatInfo: boolean;
  groupChatMessages: GroupChatMessage[];
  onCloseGroupChatInfo: () => void;
  onOpenModeratorSession: (moderatorSessionId: string) => void;

  // --- AppAgentModals props ---
  leaderboardRegistrationOpen: boolean;
  onCloseLeaderboardRegistration: () => void;
  leaderboardRegistration: LeaderboardRegistration | null;
  onSaveLeaderboardRegistration: (registration: LeaderboardRegistration) => void;
  onLeaderboardOptOut: () => void;
  errorSession: Session | null | undefined;
  recoveryActions: RecoveryAction[];
  onDismissAgentError: () => void;
  groupChatError: GroupChatErrorInfo | null;
  groupChatRecoveryActions: RecoveryAction[];
  onClearGroupChatError: () => void;
  mergeSessionModalOpen: boolean;
  onCloseMergeSession: () => void;
  onMerge: (targetSessionId: string, targetTabId: string | undefined, options: MergeOptions) => Promise<MergeResult>;
  transferState: 'idle' | 'grooming' | 'creating' | 'complete' | 'error';
  transferProgress: GroomingProgress | null;
  transferSourceAgent: ToolType | null;
  transferTargetAgent: ToolType | null;
  onCancelTransfer: () => void;
  onCompleteTransfer: () => void;
  sendToAgentModalOpen: boolean;
  onCloseSendToAgent: () => void;
  onSendToAgent: (targetSessionId: string, options: SendToAgentOptions) => Promise<MergeResult>;
}

/**
 * AppModals - Unified component that renders all modal groups
 *
 * This is the single entry point for all modals in App.tsx, consolidating:
 * - AppInfoModals: Info/display modals
 * - AppConfirmModals: Confirmation modals
 * - AppSessionModals: Session management modals
 * - AppGroupModals: Group management modals
 * - AppWorktreeModals: Worktree/PR modals
 * - AppUtilityModals: Utility and workflow modals
 * - AppGroupChatModals: Group Chat modals
 * - AppAgentModals: Agent error and transfer modals
 */
export function AppModals(props: AppModalsProps) {
  const {
    // Common props
    theme,
    sessions,
    setSessions,
    activeSessionId,
    activeSession,
    groups,
    setGroups,
    groupChats,
    shortcuts,
    tabShortcuts,
    // Info modals
    shortcutsHelpOpen,
    onCloseShortcutsHelp,
    hasNoAgents,
    keyboardMasteryStats,
    aboutModalOpen,
    onCloseAboutModal,
    autoRunStats,
    usageStats,
    onOpenLeaderboardRegistration,
    isLeaderboardRegistered,
    updateCheckModalOpen,
    onCloseUpdateCheckModal,
    processMonitorOpen,
    onCloseProcessMonitor,
    onNavigateToSession,
    onNavigateToGroupChat,
    // Confirm modals
    confirmModalOpen,
    confirmModalMessage,
    confirmModalOnConfirm,
    onCloseConfirmModal,
    quitConfirmModalOpen,
    onConfirmQuit,
    onCancelQuit,
    // Session modals
    newInstanceModalOpen,
    onCloseNewInstanceModal,
    onCreateSession,
    existingSessions,
    editAgentModalOpen,
    onCloseEditAgentModal,
    onSaveEditAgent,
    editAgentSession,
    renameSessionModalOpen,
    renameSessionValue,
    setRenameSessionValue,
    onCloseRenameSessionModal,
    renameSessionTargetId,
    onAfterRename,
    renameTabModalOpen,
    renameTabId,
    renameTabInitialName,
    onCloseRenameTabModal,
    onRenameTab,
    // Group modals
    createGroupModalOpen,
    onCloseCreateGroupModal,
    renameGroupModalOpen,
    renameGroupId,
    renameGroupValue,
    setRenameGroupValue,
    renameGroupEmoji,
    setRenameGroupEmoji,
    onCloseRenameGroupModal,
    // Worktree modals
    worktreeConfigModalOpen,
    onCloseWorktreeConfigModal,
    onSaveWorktreeConfig,
    onCreateWorktreeFromConfig,
    onDisableWorktreeConfig,
    createWorktreeModalOpen,
    createWorktreeSession,
    onCloseCreateWorktreeModal,
    onCreateWorktree,
    createPRModalOpen,
    createPRSession,
    onCloseCreatePRModal,
    onPRCreated,
    deleteWorktreeModalOpen,
    deleteWorktreeSession,
    onCloseDeleteWorktreeModal,
    onConfirmDeleteWorktree,
    onConfirmAndDeleteWorktreeOnDisk,
    // Utility modals
    quickActionOpen,
    quickActionInitialMode,
    setQuickActionOpen,
    setActiveSessionId,
    addNewSession,
    setRenameInstanceValue,
    setRenameInstanceModalOpen,
    setRenameGroupId,
    setRenameGroupValueForQuickActions,
    setRenameGroupEmojiForQuickActions,
    setRenameGroupModalOpenForQuickActions,
    setCreateGroupModalOpenForQuickActions,
    setLeftSidebarOpen,
    setRightPanelOpen,
    toggleInputMode,
    deleteSession,
    setSettingsModalOpen,
    setSettingsTab,
    setShortcutsHelpOpen,
    setAboutModalOpen,
    setLogViewerOpen,
    setProcessMonitorOpen,
    setActiveRightTab,
    setAgentSessionsOpen,
    setActiveAgentSessionId,
    setGitDiffPreview,
    setGitLogOpen,
    isAiMode,
    onQuickActionsRenameTab,
    onQuickActionsToggleReadOnlyMode,
    onQuickActionsToggleTabShowThinking,
    onQuickActionsOpenTabSwitcher,
    setPlaygroundOpen,
    onQuickActionsRefreshGitFileState,
    onQuickActionsDebugReleaseQueuedItem,
    markdownEditMode,
    onQuickActionsToggleMarkdownEditMode,
    setUpdateCheckModalOpenForQuickActions,
    openWizard,
    wizardGoToStep,
    setDebugWizardModalOpen,
    setDebugPackageModalOpen,
    startTour,
    setFuzzyFileSearchOpen,
    onEditAgent,
    onNewGroupChat,
    onOpenGroupChat,
    onCloseGroupChat,
    onDeleteGroupChat,
    activeGroupChatId,
    hasActiveSessionCapability,
    onOpenMergeSession,
    onOpenSendToAgent,
    onOpenCreatePR,
    onSummarizeAndContinue,
    canSummarizeActiveTab,
    onToggleRemoteControl,
    autoRunSelectedDocument,
    autoRunCompletedTaskCount,
    onAutoRunResetTasks,
    lightboxImage,
    lightboxImages,
    stagedImages,
    onCloseLightbox,
    onNavigateLightbox,
    onDeleteLightboxImage,
    gitDiffPreview,
    gitViewerCwd,
    onCloseGitDiff,
    gitLogOpen,
    onCloseGitLog,
    autoRunSetupModalOpen,
    onCloseAutoRunSetup,
    onAutoRunFolderSelected,
    batchRunnerModalOpen,
    onCloseBatchRunner,
    onStartBatchRun,
    onSaveBatchPrompt,
    showConfirmation,
    autoRunDocumentList,
    autoRunDocumentTree,
    getDocumentTaskCount,
    onAutoRunRefresh,
    tabSwitcherOpen,
    onCloseTabSwitcher,
    onTabSelect,
    onNamedSessionSelect,
    fuzzyFileSearchOpen,
    filteredFileTree,
    onCloseFileSearch,
    onFileSearchSelect,
    promptComposerOpen,
    onClosePromptComposer,
    promptComposerInitialValue,
    onPromptComposerSubmit,
    onPromptComposerSend,
    promptComposerSessionName,
    promptComposerStagedImages,
    setPromptComposerStagedImages,
    onPromptImageAttachBlocked,
    onPromptOpenLightbox,
    promptTabSaveToHistory,
    onPromptToggleTabSaveToHistory,
    promptTabReadOnlyMode,
    onPromptToggleTabReadOnlyMode,
    promptTabShowThinking,
    onPromptToggleTabShowThinking,
    promptSupportsThinking,
    promptEnterToSend,
    onPromptToggleEnterToSend,
    queueBrowserOpen,
    onCloseQueueBrowser,
    onRemoveQueueItem,
    onSwitchQueueSession,
    onReorderQueueItems,
    // Group Chat modals
    showNewGroupChatModal,
    onCloseNewGroupChatModal,
    onCreateGroupChat,
    showDeleteGroupChatModal,
    onCloseDeleteGroupChatModal,
    onConfirmDeleteGroupChat,
    showRenameGroupChatModal,
    onCloseRenameGroupChatModal,
    onRenameGroupChatFromModal,
    showEditGroupChatModal,
    onCloseEditGroupChatModal,
    onUpdateGroupChat,
    showGroupChatInfo,
    groupChatMessages,
    onCloseGroupChatInfo,
    onOpenModeratorSession,
    // Agent modals
    leaderboardRegistrationOpen,
    onCloseLeaderboardRegistration,
    leaderboardRegistration,
    onSaveLeaderboardRegistration,
    onLeaderboardOptOut,
    errorSession,
    recoveryActions,
    onDismissAgentError,
    groupChatError,
    groupChatRecoveryActions,
    onClearGroupChatError,
    mergeSessionModalOpen,
    onCloseMergeSession,
    onMerge,
    transferState,
    transferProgress,
    transferSourceAgent,
    transferTargetAgent,
    onCancelTransfer,
    onCompleteTransfer,
    sendToAgentModalOpen,
    onCloseSendToAgent,
    onSendToAgent,
  } = props;

  return (
    <>
      {/* Info/Display Modals */}
      <AppInfoModals
        theme={theme}
        shortcutsHelpOpen={shortcutsHelpOpen}
        onCloseShortcutsHelp={onCloseShortcutsHelp}
        shortcuts={shortcuts}
        tabShortcuts={tabShortcuts}
        hasNoAgents={hasNoAgents}
        keyboardMasteryStats={keyboardMasteryStats}
        aboutModalOpen={aboutModalOpen}
        onCloseAboutModal={onCloseAboutModal}
        sessions={sessions}
        autoRunStats={autoRunStats}
        usageStats={usageStats}
        onOpenLeaderboardRegistration={onOpenLeaderboardRegistration}
        isLeaderboardRegistered={isLeaderboardRegistered}
        updateCheckModalOpen={updateCheckModalOpen}
        onCloseUpdateCheckModal={onCloseUpdateCheckModal}
        processMonitorOpen={processMonitorOpen}
        onCloseProcessMonitor={onCloseProcessMonitor}
        groups={groups}
        groupChats={groupChats}
        onNavigateToSession={onNavigateToSession}
        onNavigateToGroupChat={onNavigateToGroupChat}
      />

      {/* Confirmation Modals */}
      <AppConfirmModals
        theme={theme}
        sessions={sessions}
        confirmModalOpen={confirmModalOpen}
        confirmModalMessage={confirmModalMessage}
        confirmModalOnConfirm={confirmModalOnConfirm}
        onCloseConfirmModal={onCloseConfirmModal}
        quitConfirmModalOpen={quitConfirmModalOpen}
        onConfirmQuit={onConfirmQuit}
        onCancelQuit={onCancelQuit}
      />

      {/* Session Management Modals */}
      <AppSessionModals
        theme={theme}
        sessions={sessions}
        activeSessionId={activeSessionId}
        activeSession={activeSession}
        newInstanceModalOpen={newInstanceModalOpen}
        onCloseNewInstanceModal={onCloseNewInstanceModal}
        onCreateSession={onCreateSession}
        existingSessions={existingSessions}
        editAgentModalOpen={editAgentModalOpen}
        onCloseEditAgentModal={onCloseEditAgentModal}
        onSaveEditAgent={onSaveEditAgent}
        editAgentSession={editAgentSession}
        renameSessionModalOpen={renameSessionModalOpen}
        renameSessionValue={renameSessionValue}
        setRenameSessionValue={setRenameSessionValue}
        onCloseRenameSessionModal={onCloseRenameSessionModal}
        setSessions={setSessions}
        renameSessionTargetId={renameSessionTargetId}
        onAfterRename={onAfterRename}
        renameTabModalOpen={renameTabModalOpen}
        renameTabId={renameTabId}
        renameTabInitialName={renameTabInitialName}
        onCloseRenameTabModal={onCloseRenameTabModal}
        onRenameTab={onRenameTab}
      />

      {/* Group Management Modals */}
      <AppGroupModals
        theme={theme}
        groups={groups}
        setGroups={setGroups}
        createGroupModalOpen={createGroupModalOpen}
        onCloseCreateGroupModal={onCloseCreateGroupModal}
        renameGroupModalOpen={renameGroupModalOpen}
        renameGroupId={renameGroupId}
        renameGroupValue={renameGroupValue}
        setRenameGroupValue={setRenameGroupValue}
        renameGroupEmoji={renameGroupEmoji}
        setRenameGroupEmoji={setRenameGroupEmoji}
        onCloseRenameGroupModal={onCloseRenameGroupModal}
      />

      {/* Worktree/PR Modals */}
      <AppWorktreeModals
        theme={theme}
        activeSession={activeSession}
        worktreeConfigModalOpen={worktreeConfigModalOpen}
        onCloseWorktreeConfigModal={onCloseWorktreeConfigModal}
        onSaveWorktreeConfig={onSaveWorktreeConfig}
        onCreateWorktreeFromConfig={onCreateWorktreeFromConfig}
        onDisableWorktreeConfig={onDisableWorktreeConfig}
        createWorktreeModalOpen={createWorktreeModalOpen}
        createWorktreeSession={createWorktreeSession}
        onCloseCreateWorktreeModal={onCloseCreateWorktreeModal}
        onCreateWorktree={onCreateWorktree}
        createPRModalOpen={createPRModalOpen}
        createPRSession={createPRSession}
        onCloseCreatePRModal={onCloseCreatePRModal}
        onPRCreated={onPRCreated}
        deleteWorktreeModalOpen={deleteWorktreeModalOpen}
        deleteWorktreeSession={deleteWorktreeSession}
        onCloseDeleteWorktreeModal={onCloseDeleteWorktreeModal}
        onConfirmDeleteWorktree={onConfirmDeleteWorktree}
        onConfirmAndDeleteWorktreeOnDisk={onConfirmAndDeleteWorktreeOnDisk}
      />

      {/* Utility/Workflow Modals */}
      <AppUtilityModals
        theme={theme}
        sessions={sessions}
        setSessions={setSessions}
        activeSessionId={activeSessionId}
        activeSession={activeSession}
        groups={groups}
        setGroups={setGroups}
        shortcuts={shortcuts}
        tabShortcuts={tabShortcuts}
        quickActionOpen={quickActionOpen}
        quickActionInitialMode={quickActionInitialMode}
        setQuickActionOpen={setQuickActionOpen}
        setActiveSessionId={setActiveSessionId}
        addNewSession={addNewSession}
        setRenameInstanceValue={setRenameInstanceValue}
        setRenameInstanceModalOpen={setRenameInstanceModalOpen}
        setRenameGroupId={setRenameGroupId}
        setRenameGroupValue={setRenameGroupValueForQuickActions}
        setRenameGroupEmoji={setRenameGroupEmojiForQuickActions}
        setRenameGroupModalOpen={setRenameGroupModalOpenForQuickActions}
        setCreateGroupModalOpen={setCreateGroupModalOpenForQuickActions}
        setLeftSidebarOpen={setLeftSidebarOpen}
        setRightPanelOpen={setRightPanelOpen}
        toggleInputMode={toggleInputMode}
        deleteSession={deleteSession}
        setSettingsModalOpen={setSettingsModalOpen}
        setSettingsTab={setSettingsTab}
        setShortcutsHelpOpen={setShortcutsHelpOpen}
        setAboutModalOpen={setAboutModalOpen}
        setLogViewerOpen={setLogViewerOpen}
        setProcessMonitorOpen={setProcessMonitorOpen}
        setActiveRightTab={setActiveRightTab}
        setAgentSessionsOpen={setAgentSessionsOpen}
        setActiveAgentSessionId={setActiveAgentSessionId}
        setGitDiffPreview={setGitDiffPreview}
        setGitLogOpen={setGitLogOpen}
        isAiMode={isAiMode}
        onRenameTab={onQuickActionsRenameTab}
        onToggleReadOnlyMode={onQuickActionsToggleReadOnlyMode}
        onToggleTabShowThinking={onQuickActionsToggleTabShowThinking}
        onOpenTabSwitcher={onQuickActionsOpenTabSwitcher}
        setPlaygroundOpen={setPlaygroundOpen}
        onRefreshGitFileState={onQuickActionsRefreshGitFileState}
        onDebugReleaseQueuedItem={onQuickActionsDebugReleaseQueuedItem}
        markdownEditMode={markdownEditMode}
        onToggleMarkdownEditMode={onQuickActionsToggleMarkdownEditMode}
        setUpdateCheckModalOpen={setUpdateCheckModalOpenForQuickActions}
        openWizard={openWizard}
        wizardGoToStep={wizardGoToStep}
        setDebugWizardModalOpen={setDebugWizardModalOpen}
        setDebugPackageModalOpen={setDebugPackageModalOpen}
        startTour={startTour}
        setFuzzyFileSearchOpen={setFuzzyFileSearchOpen}
        onEditAgent={onEditAgent}
        groupChats={groupChats}
        onNewGroupChat={onNewGroupChat}
        onOpenGroupChat={onOpenGroupChat}
        onCloseGroupChat={onCloseGroupChat}
        onDeleteGroupChat={onDeleteGroupChat}
        activeGroupChatId={activeGroupChatId}
        hasActiveSessionCapability={hasActiveSessionCapability}
        onOpenMergeSession={onOpenMergeSession}
        onOpenSendToAgent={onOpenSendToAgent}
        onOpenCreatePR={onOpenCreatePR}
        onSummarizeAndContinue={onSummarizeAndContinue}
        canSummarizeActiveTab={canSummarizeActiveTab}
        onToggleRemoteControl={onToggleRemoteControl}
        autoRunSelectedDocument={autoRunSelectedDocument}
        autoRunCompletedTaskCount={autoRunCompletedTaskCount}
        onAutoRunResetTasks={onAutoRunResetTasks}
        lightboxImage={lightboxImage}
        lightboxImages={lightboxImages}
        stagedImages={stagedImages}
        onCloseLightbox={onCloseLightbox}
        onNavigateLightbox={onNavigateLightbox}
        onDeleteLightboxImage={onDeleteLightboxImage}
        gitDiffPreview={gitDiffPreview}
        gitViewerCwd={gitViewerCwd}
        onCloseGitDiff={onCloseGitDiff}
        gitLogOpen={gitLogOpen}
        onCloseGitLog={onCloseGitLog}
        autoRunSetupModalOpen={autoRunSetupModalOpen}
        onCloseAutoRunSetup={onCloseAutoRunSetup}
        onAutoRunFolderSelected={onAutoRunFolderSelected}
        batchRunnerModalOpen={batchRunnerModalOpen}
        onCloseBatchRunner={onCloseBatchRunner}
        onStartBatchRun={onStartBatchRun}
        onSaveBatchPrompt={onSaveBatchPrompt}
        showConfirmation={showConfirmation}
        autoRunDocumentList={autoRunDocumentList}
        autoRunDocumentTree={autoRunDocumentTree}
        getDocumentTaskCount={getDocumentTaskCount}
        onAutoRunRefresh={onAutoRunRefresh}
        tabSwitcherOpen={tabSwitcherOpen}
        onCloseTabSwitcher={onCloseTabSwitcher}
        onTabSelect={onTabSelect}
        onNamedSessionSelect={onNamedSessionSelect}
        fuzzyFileSearchOpen={fuzzyFileSearchOpen}
        filteredFileTree={filteredFileTree}
        onCloseFileSearch={onCloseFileSearch}
        onFileSearchSelect={onFileSearchSelect}
        promptComposerOpen={promptComposerOpen}
        onClosePromptComposer={onClosePromptComposer}
        promptComposerInitialValue={promptComposerInitialValue}
        onPromptComposerSubmit={onPromptComposerSubmit}
        onPromptComposerSend={onPromptComposerSend}
        promptComposerSessionName={promptComposerSessionName}
        promptComposerStagedImages={promptComposerStagedImages}
        setPromptComposerStagedImages={setPromptComposerStagedImages}
        onPromptImageAttachBlocked={onPromptImageAttachBlocked}
        onPromptOpenLightbox={onPromptOpenLightbox}
        promptTabSaveToHistory={promptTabSaveToHistory}
        onPromptToggleTabSaveToHistory={onPromptToggleTabSaveToHistory}
        promptTabReadOnlyMode={promptTabReadOnlyMode}
        onPromptToggleTabReadOnlyMode={onPromptToggleTabReadOnlyMode}
        promptTabShowThinking={promptTabShowThinking}
        onPromptToggleTabShowThinking={onPromptToggleTabShowThinking}
        promptSupportsThinking={promptSupportsThinking}
        promptEnterToSend={promptEnterToSend}
        onPromptToggleEnterToSend={onPromptToggleEnterToSend}
        queueBrowserOpen={queueBrowserOpen}
        onCloseQueueBrowser={onCloseQueueBrowser}
        onRemoveQueueItem={onRemoveQueueItem}
        onSwitchQueueSession={onSwitchQueueSession}
        onReorderQueueItems={onReorderQueueItems}
      />

      {/* Group Chat Modals */}
      <AppGroupChatModals
        theme={theme}
        groupChats={groupChats}
        showNewGroupChatModal={showNewGroupChatModal}
        onCloseNewGroupChatModal={onCloseNewGroupChatModal}
        onCreateGroupChat={onCreateGroupChat}
        showDeleteGroupChatModal={showDeleteGroupChatModal}
        onCloseDeleteGroupChatModal={onCloseDeleteGroupChatModal}
        onConfirmDeleteGroupChat={onConfirmDeleteGroupChat}
        showRenameGroupChatModal={showRenameGroupChatModal}
        onCloseRenameGroupChatModal={onCloseRenameGroupChatModal}
        onRenameGroupChat={onRenameGroupChatFromModal}
        showEditGroupChatModal={showEditGroupChatModal}
        onCloseEditGroupChatModal={onCloseEditGroupChatModal}
        onUpdateGroupChat={onUpdateGroupChat}
        showGroupChatInfo={showGroupChatInfo}
        activeGroupChatId={activeGroupChatId}
        groupChatMessages={groupChatMessages}
        onCloseGroupChatInfo={onCloseGroupChatInfo}
        onOpenModeratorSession={onOpenModeratorSession}
      />

      {/* Agent/Transfer Modals */}
      <AppAgentModals
        theme={theme}
        sessions={sessions}
        activeSession={activeSession}
        groupChats={groupChats}
        leaderboardRegistrationOpen={leaderboardRegistrationOpen}
        onCloseLeaderboardRegistration={onCloseLeaderboardRegistration}
        autoRunStats={autoRunStats}
        keyboardMasteryStats={keyboardMasteryStats}
        leaderboardRegistration={leaderboardRegistration}
        onSaveLeaderboardRegistration={onSaveLeaderboardRegistration}
        onLeaderboardOptOut={onLeaderboardOptOut}
        errorSession={errorSession}
        recoveryActions={recoveryActions}
        onDismissAgentError={onDismissAgentError}
        groupChatError={groupChatError}
        groupChatRecoveryActions={groupChatRecoveryActions}
        onClearGroupChatError={onClearGroupChatError}
        mergeSessionModalOpen={mergeSessionModalOpen}
        onCloseMergeSession={onCloseMergeSession}
        onMerge={onMerge}
        transferState={transferState}
        transferProgress={transferProgress}
        transferSourceAgent={transferSourceAgent}
        transferTargetAgent={transferTargetAgent}
        onCancelTransfer={onCancelTransfer}
        onCompleteTransfer={onCompleteTransfer}
        sendToAgentModalOpen={sendToAgentModalOpen}
        onCloseSendToAgent={onCloseSendToAgent}
        onSendToAgent={onSendToAgent}
      />
    </>
  );
}
