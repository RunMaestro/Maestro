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
import type { Session, SettingsTab, AgentError } from '../types';
import type { GitStreamingOperation } from '../../shared/gitUtils';
import type { SerializableWizardState } from '../components/Wizard';
import type { ConductorBadge } from '../constants/conductorBadges';
import { UI_SURFACES } from '../../shared/uiSurfaces';
import { logger } from '../utils/logger';

// ============================================================================
// Prompt Composer full-screen preference (persisted)
// ============================================================================
// The Prompt Composer remembers whether the user last left it windowed or
// full-screen ("expanded-expanded"). The open-composer hotkey cycles between
// the two while the modal is open, so this lives in the store (shared by the
// keyboard handler and the modal) rather than as component-local state.

const PROMPT_COMPOSER_FULLSCREEN_KEY = 'maestro.promptComposer.fullscreen';

function readStoredPromptComposerFullscreen(): boolean {
	if (typeof window === 'undefined') return false;
	try {
		return window.localStorage.getItem(PROMPT_COMPOSER_FULLSCREEN_KEY) === 'true';
	} catch {
		return false;
	}
}

function writeStoredPromptComposerFullscreen(value: boolean): void {
	if (typeof window === 'undefined') return;
	try {
		window.localStorage.setItem(PROMPT_COMPOSER_FULLSCREEN_KEY, String(value));
	} catch {
		// Ignore quota / privacy-mode errors - preference just won't persist.
	}
}

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
	/** When omitted, SettingsModal restores the last in-session tab and falls
	 *  back to 'general' on first open. Set to a specific tab to deep-link. */
	tab?: SettingsTab;
	promptId?: string;
}

/** New instance modal data */
export interface NewInstanceModalData {
	duplicatingSessionId: string | null;
	/** When set, the new agent is created inside this group (ignored if duplicatingSessionId is set - duplicates inherit the source's group). */
	presetGroupId?: string | null;
	/** When set, seeds the working directory (and a default name from its basename). Ignored if duplicatingSessionId is set - duplicates inherit the source's cwd. */
	presetWorkingDir?: string | null;
}

/** Edit agent modal data */
export interface EditAgentModalData {
	session: Session;
}

/** Quick action modal data */
export interface QuickActionModalData {
	initialMode: 'main' | 'move-to-group' | 'agents';
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

/**
 * Snooze tab modal data - what is being snoozed, how to label it, and what the
 * dialog may offer for it. Openers build this with `resolveSnoozeTarget()`
 * (utils/snoozeHelpers.ts) rather than assembling it by hand: `tabId` can name
 * a tab of any kind OR a tiled group, and only that resolver knows which.
 */
export interface SnoozeTabModalData {
	tabId: string;
	tabLabel: string;
	/**
	 * Whether the parked tab can be prompted on return. Only a conversation
	 * can, so a file, terminal, or browser tab answers false and the dialog
	 * hides the prompt field rather than collecting one that could never be
	 * sent. Required rather than optional so a new opener has to answer it.
	 */
	canRunWakePrompt: boolean;
}

/**
 * Model & effort modal data. Only the tab id travels: the modal resolves the
 * agent, the option lists, and the tab > session > agent-default ladder from
 * the stores itself, so an opener can't hand it a stale snapshot.
 */
export interface ModelEffortModalData {
	tabId: string;
}

/** Terminal tab startup command modal data */
export interface TerminalStartupCommandModalData {
	sessionId: string;
	tabId: string;
	initialCommand: string;
	initialCwd: string;
	defaultCwd: string;
}

/** Rename group modal data */
export interface RenameGroupModalData {
	groupId: string;
	value: string;
	emoji: string;
	icon?: string;
	color?: string;
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
	/** Direct error for displaying historical errors from chat log entries */
	historicalError?: AgentError;
}

/**
 * Provider re-authentication modal data.
 *
 * Addressed by PROVIDER, not by agent: one expired token blocks every agent
 * that shares the credential store, and they are all fixed by one login. The
 * roster of blocked agents (and the error text) lives in `authOutageStore`
 * keyed by this value, so it stays correct as more agents fail while the prompt
 * is already open.
 */
export interface ReauthModalData {
	providerKey: string;
}

/** Delete agent modal data */
export interface DeleteAgentModalData {
	session: Session;
}

/** Director's Notes modal data */
export interface DirectorNotesData {
	initialTab?: 'overview' | 'history' | 'ai-overview';
}

/** Quit confirmation modal data */
export interface QuitConfirmModalData {
	activeTerminalTasks?: string[];
	activeCueRunCount?: number;
	activeGroupChatCount?: number;
	hasFeedbackDraft?: boolean;
}

export interface CueModalData {
	/** Tab the modal opens on. Values match `CueModalTab` in
	 *  `components/CueModal/CueModalHeader.tsx` and the `cue` entry in
	 *  `shared/uiSurfaces.ts`. */
	initialTab?: 'dashboard' | 'scheduled' | 'pipeline' | 'pipeline-list' | 'activity' | 'backup';
	/**
	 * Agent to highlight and scroll to in the dashboard's session table.
	 *
	 * The Left Bar's per-agent "Configure Maestro Cue" opens a table of EVERY
	 * Cue-enabled agent, so without this the menu item promises one agent and
	 * delivers a list with nothing marking which row you asked for.
	 *
	 * Deliberately NOT a filter: cue.yaml is a per-PROJECT file and several
	 * agents can share one projectRoot, so narrowing the table to one agent
	 * would hide the sibling that actually owns the config - which is exactly
	 * the row that explains why this agent shows zero subscriptions.
	 *
	 * Optional: the keyboard shortcut, command palette and Settings entry
	 * points open the dashboard with no agent in hand and nothing to
	 * disambiguate.
	 */
	focusSessionId?: string;
}

/** Cue YAML editor data */
export interface CueYamlEditorData {
	sessionId: string;
	projectRoot: string;
}

/** Worktree modal data (create/delete/PR) */
export interface WorktreeModalData {
	session: Session;
	/**
	 * PR only: the branch to open the PR from. Worktree children carry it on the
	 * session, but a plain git agent doesn't - the opener knows the live branch,
	 * so it passes it rather than making the modal host re-derive it.
	 */
	sourceBranch?: string;
}

/** Group chat modal data (delete/rename/edit) */
export interface GroupChatModalData {
	groupChatId: string;
}

/** Git diff preview data */
export interface GitDiffModalData {
	diff: string;
	/**
	 * Repo the diff was taken from, used to resolve files clicked inside the
	 * viewer. Optional: opened without it (keyboard shortcut, command palette)
	 * the viewer follows the active agent. The Left Bar's right-click menu passes
	 * it so it can diff an agent that isn't active.
	 */
	cwd?: string;
	/**
	 * Agent the diff was taken for, used to name it in the header. Optional for
	 * the same reason as `cwd`: the keyboard shortcut and command palette follow
	 * the active agent, so there is nothing to disambiguate.
	 */
	sessionId?: string;
}

/**
 * Git log viewer data. Optional: opened without it (keyboard shortcut, command
 * palette) the viewer follows the active agent. The Left Bar's right-click menu
 * passes an explicit target so it can show the log of an agent that isn't active.
 */
export interface GitLogModalData {
	cwd: string;
	sshRemoteId?: string;
	/** Agent the log belongs to, used to name it in the header. */
	sessionId?: string;
}

/** Git command runner data - which streaming operation the console modal runs */
export interface GitCommandRunnerData {
	sessionId: string;
	operation: GitStreamingOperation;
	/** Repo directory the command runs in (already resolved for terminal/worktree agents). */
	cwd: string;
	sshRemoteId?: string;
	/** Current branch, shown in the modal title. */
	branch?: string;
}

/** Branch switcher data - fuzzy branch picker for an agent's repo */
export interface BranchSwitcherModalData {
	sessionId: string;
	cwd: string;
	sshRemoteId?: string;
	currentBranch?: string;
}

/** Tour modal data */
export interface TourModalData {
	fromWizard: boolean;
}

/** Keyboard mastery celebration data */
export interface KeyboardMasteryData {
	level: number;
}

/** Batch Runner modal data - used to pre-seed the doc list when opened programmatically (e.g. from the inline wizard's "Start Auto Run" button). */
export interface BatchRunnerModalData {
	/** Document filenames (without `.md`) to pre-populate the run list with. When omitted, the run list opens empty. */
	presetDocuments?: string[];
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
	| 'feedback'
	| 'updateCheck'
	// Instance Management
	| 'newAgentChoice'
	| 'newInstance'
	| 'editAgent'
	| 'deleteAgent'
	| 'renameInstance'
	| 'agentError'
	| 'reauth'
	// Quick Actions
	| 'quickAction'
	| 'tabSwitcher'
	| 'crossTabSearch'
	| 'fuzzyFileSearch'
	| 'promptComposer'
	// Tab Management
	| 'renameTab'
	| 'terminalStartupCommand'
	| 'snoozeTab'
	| 'modelEffort'
	| 'snoozedTabs'
	// Group Management
	| 'renameGroup'
	// Session Operations
	| 'mergeSession'
	| 'sendToAgent'
	| 'agentSessions'
	// Batch & Auto Run
	| 'memoryViewer'
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
	| 'gitCommandRunner'
	| 'branchSwitcher'
	// Wizard & Tour
	| 'wizardResume'
	| 'tour'
	// Debug & Dev
	| 'debugPackage'
	| 'debugApplicationStats'
	| 'debugAgentProbe'
	| 'widgetGallery'
	| 'profilingCapture'
	| 'playground'
	| 'logViewer'
	| 'processMonitor'
	| 'usageDashboard'
	| 'agentRunDashboard'
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
	// First-run typography chooser
	| 'typographyChoice'
	// Director's Notes
	| 'directorNotes'
	// Maestro Cue
	| 'cueModal'
	| 'cueYamlEditor'
	// Pianola (autonomous manager)
	| 'pianolaModal'
	// Concerto (agent-composed views)
	| 'concertoStage';

// ============================================================================
// Destination surfaces (mutually exclusive)
// ============================================================================

/**
 * Destination surfaces: full-window views that are a PLACE YOU GO, not a dialog
 * you answer. Only one is ever open - opening any of them closes whichever
 * other one was up.
 *
 * Without this rule, every one of these surfaces had a fixed rank in
 * `MODAL_PRIORITIES`, so what you saw after a hotkey depended on which surface
 * happened to rank higher rather than on what you just asked for. Opening the
 * Usage Dashboard (540) while Director's Notes (848) was up rendered it BEHIND
 * the notes, and opening a main-panel destination (System Logs, Agent Sessions,
 * Memory) while any overlay was up changed nothing on screen at all. Both read
 * as a dead keystroke.
 *
 * Membership test: does it fill the window, own its own header/tabs, and is it
 * reachable on its own from a hotkey, the command palette, the Left Bar footer,
 * or `maestro-cli open`? Dialogs that answer a question ABOUT the surface
 * beneath them are not members and are meant to layer: confirmations, rename
 * prompts, the Cue YAML editor, the Playbook name box, the Usage Dashboard's
 * per-agent detail, the Symphony agent picker.
 *
 * `documentGraph` is a destination too but lives in `fileExplorerStore`, so it
 * registers itself through `registerExternalDestination` instead of appearing
 * here.
 */
export const DESTINATION_MODALS: ReadonlySet<ModalId> = new Set<ModalId>([
	// Full-window overlays
	'settings',
	'usageDashboard',
	'directorNotes',
	'symphony',
	'cueModal',
	'marketplace',
	'processMonitor',
	// Main-panel destinations - these replace the whole center workspace, so an
	// overlay left open on top of one hides it completely.
	'logViewer',
	'agentSessions',
	'memoryViewer',
]);

/**
 * Shortcut ids that open a destination surface.
 *
 * The window-level keyboard handler blocks most shortcuts while a modal is up,
 * so a destination hotkey only reaches its branch if it is on that guard's
 * allowlist. The allowlist used to be a hardcoded chord test (Alt+Cmd plus
 * l/p/u/s), which let exactly three destinations through and killed the rest:
 * Director's Notes to Usage Dashboard worked, Usage Dashboard back to
 * Director's Notes did nothing, because `Opt+Cmd+U` matched the chord and
 * `Cmd+Shift+O` did not. Switching between two surfaces worked in one
 * direction only, which reads as a dead key.
 *
 * Derived from `UI_SURFACES` rather than hand-listed, so adding a destination
 * (or rebinding one) cannot silently drop it back out of the guard. A user who
 * rebinds a surface keeps a working hotkey, which a chord test cannot promise.
 */
export const DESTINATION_SHORTCUT_IDS: ReadonlySet<string> = new Set(
	UI_SURFACES.filter(
		(surface) => DESTINATION_MODALS.has(surface.modal as ModalId) && surface.shortcutId
	).map((surface) => surface.shortcutId as string)
);

/**
 * Destinations that are not modal-store entries (currently just the Document
 * Graph, which lives in `fileExplorerStore`). Each registered closer runs when
 * a `DESTINATION_MODALS` member opens, so an external surface obeys the same
 * one-at-a-time rule without this store having to import that one - which would
 * be a cycle, since the external store imports this one to close modal
 * destinations on its own way in.
 */
type DestinationCloser = () => void;
const externalDestinationClosers = new Set<DestinationCloser>();

/** Register an out-of-store destination. Returns an unregister function. */
export function registerExternalDestination(close: DestinationCloser): () => void {
	externalDestinationClosers.add(close);
	return () => externalDestinationClosers.delete(close);
}

/**
 * Close every open destination surface EXCEPT `keep`. Exported for stores that
 * own a destination of their own (see `registerExternalDestination`) and need
 * to clear the modal-store ones before opening it.
 */
export function closeOtherDestinations(keep?: ModalId): void {
	useModalStore.setState((state) => {
		let changed = false;
		const newModals = new Map(state.modals);
		for (const [id, entry] of newModals) {
			if (entry.open && id !== keep && DESTINATION_MODALS.has(id)) {
				newModals.set(id, { open: false, data: undefined });
				changed = true;
			}
		}
		return changed ? { modals: newModals } : state;
	});
}

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
	snoozeTab: SnoozeTabModalData;
	modelEffort: ModelEffortModalData;
	terminalStartupCommand: TerminalStartupCommandModalData;
	renameGroup: RenameGroupModalData;
	agentSessions: AgentSessionsModalData;
	batchRunner: BatchRunnerModalData;
	wizardResume: WizardResumeModalData;
	agentError: AgentErrorModalData;
	reauth: ReauthModalData;
	deleteAgent: DeleteAgentModalData;
	/**
	 * Present when opened from the Left Bar's right-click menu, naming the agent
	 * to configure. Absent when opened from the header or Settings, where the
	 * modal follows the active agent.
	 */
	worktreeConfig: WorktreeModalData;
	createWorktree: WorktreeModalData;
	createPR: WorktreeModalData;
	deleteWorktree: WorktreeModalData;
	deleteGroupChat: GroupChatModalData;
	renameGroupChat: GroupChatModalData;
	editGroupChat: GroupChatModalData;
	gitDiff: GitDiffModalData;
	gitLog: GitLogModalData;
	gitCommandRunner: GitCommandRunnerData;
	branchSwitcher: BranchSwitcherModalData;
	tour: TourModalData;
	standingOvation: StandingOvationData;
	firstRunCelebration: FirstRunCelebrationData;
	keyboardMastery: KeyboardMasteryData;
	lightbox: LightboxData;
	directorNotes: DirectorNotesData;
	cueModal: CueModalData;
	cueYamlEditor: CueYamlEditorData;
	quitConfirm: QuitConfirmModalData;
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
	/** Whether the Prompt Composer is in full-screen ("expanded-expanded") mode. */
	promptComposerFullscreen: boolean;
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

	/**
	 * Toggle the Prompt Composer between full-screen and windowed mode.
	 * Persists the preference so the next open restores the same size.
	 */
	togglePromptComposerFullscreen: () => void;

	/**
	 * Keyboard entry point for the open-composer hotkey. Opens the Prompt
	 * Composer when it's closed, otherwise cycles it between windowed and
	 * full-screen - so repeated presses switch sizes instead of doing nothing.
	 */
	cyclePromptComposer: () => void;
}

export type ModalStore = ModalStoreState & ModalStoreActions;

// ============================================================================
// Store Implementation
// ============================================================================

export const useModalStore = create<ModalStore>()((set, get) => ({
	modals: new Map(),
	promptComposerFullscreen: readStoredPromptComposerFullscreen(),

	openModal: (id, data) => {
		const isDestination = DESTINATION_MODALS.has(id);
		// Hand the window over from any non-modal destination (Document Graph)
		// before this one opens, so the two can't be up at once.
		if (isDestination && externalDestinationClosers.size > 0) {
			for (const close of externalDestinationClosers) close();
		}
		set((state) => {
			const current = state.modals.get(id);
			// Skip if already open with same data reference
			if (current?.open && current.data === data) return state;
			const newModals = new Map(state.modals);
			// One destination at a time - see DESTINATION_MODALS.
			if (isDestination) {
				for (const [openId, entry] of newModals) {
					if (entry.open && openId !== id && DESTINATION_MODALS.has(openId)) {
						newModals.set(openId, { open: false, data: undefined });
					}
				}
			}
			newModals.set(id, { open: true, data });
			// DEBUG: Trace rename modal open/close
			if (id === 'renameTab') {
				logger.info('[DEBUG renameTab] openModal called', undefined, {
					data,
					wasOpen: current?.open,
					hadData: !!current?.data,
				});
			}
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
			// DEBUG: Trace rename modal close
			if (id === 'renameTab') {
				logger.info('[DEBUG renameTab] closeModal called', undefined, new Error().stack);
			}
			return { modals: newModals };
		});
	},

	toggleModal: (id, data) => {
		// Routed through open/close rather than flipping the entry inline, so a
		// toggled destination surface still evicts the other destinations.
		if (get().isOpen(id)) get().closeModal(id);
		else get().openModal(id, data);
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

	togglePromptComposerFullscreen: () => {
		set((state) => {
			const next = !state.promptComposerFullscreen;
			writeStoredPromptComposerFullscreen(next);
			return { promptComposerFullscreen: next };
		});
	},

	cyclePromptComposer: () => {
		const state = get();
		if (state.modals.get('promptComposer')?.open) {
			state.togglePromptComposerFullscreen();
		} else {
			state.openModal('promptComposer');
		}
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
	const { openModal, closeModal, toggleModal, updateModalData } = useModalStore.getState();

	return {
		// Settings Modal
		// Pass `tab: undefined` (not a default of 'general') when no tab is
		// requested - the modal restores the last tab the user viewed in this
		// session and falls back to General internally.
		setSettingsModalOpen: (open: boolean) =>
			open ? openModal('settings', { tab: undefined }) : closeModal('settings'),
		setSettingsTab: (tab: SettingsTab) => updateModalData('settings', { tab }),
		openSettings: (tab?: SettingsTab) => openModal('settings', { tab }),
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
		setQuickActionOpen: (open: boolean, mode?: 'main' | 'move-to-group' | 'agents') =>
			open ? openModal('quickAction', { initialMode: mode ?? 'main' }) : closeModal('quickAction'),
		setQuickActionInitialMode: (mode: 'main' | 'move-to-group' | 'agents') =>
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

		// Feedback Modal
		setFeedbackModalOpen: (open: boolean) =>
			open ? openModal('feedback') : closeModal('feedback'),

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

		// AgentRun Dashboard
		setAgentRunDashboardOpen: (open: boolean) =>
			open ? openModal('agentRunDashboard') : closeModal('agentRunDashboard'),

		// Keyboard Mastery Celebration
		setPendingKeyboardMasteryLevel: (level: number | null) =>
			level !== null ? openModal('keyboardMastery', { level }) : closeModal('keyboardMastery'),

		// Playground Panel
		setPlaygroundOpen: (open: boolean) =>
			open ? openModal('playground') : closeModal('playground'),

		// Debug Package Modal
		setDebugPackageModalOpen: (open: boolean) =>
			open ? openModal('debugPackage') : closeModal('debugPackage'),

		// Debug Application Stats Modal
		setDebugApplicationStatsOpen: (open: boolean) =>
			open ? openModal('debugApplicationStats') : closeModal('debugApplicationStats'),

		// Debug Agent Probe Modal
		setDebugAgentProbeOpen: (open: boolean) =>
			open ? openModal('debugAgentProbe') : closeModal('debugAgentProbe'),

		// Profiling Capture (stop + bundle progress) Modal
		setProfilingCaptureOpen: (open: boolean) =>
			open ? openModal('profilingCapture') : closeModal('profilingCapture'),

		// Confirmation Modal
		setConfirmModalOpen: (open: boolean) => (open ? openModal('confirm') : closeModal('confirm')),
		setConfirmModalMessage: (message: string) => updateModalData('confirm', { message }),
		setConfirmModalOnConfirm: (fn: (() => void) | null) =>
			fn ? updateModalData('confirm', { onConfirm: fn }) : null,
		showConfirmation: (message: string, onConfirm: () => void) =>
			openModal('confirm', { message, onConfirm }),
		closeConfirmation: () => closeModal('confirm'),

		// Quit Confirmation Modal
		setQuitConfirmModalOpen: (open: boolean, data?: QuitConfirmModalData) =>
			open ? openModal('quitConfirm', data) : closeModal('quitConfirm'),

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

		// Terminal Tab Startup Command Modal
		openTerminalStartupCommandModal: (data: TerminalStartupCommandModalData) =>
			openModal('terminalStartupCommand', data),
		closeTerminalStartupCommandModal: () => closeModal('terminalStartupCommand'),

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
				icon: current?.icon,
				color: current?.color,
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
		setRenameGroupIcon: (icon: string | undefined) => {
			const current = useModalStore.getState().getData('renameGroup');
			if (current) {
				updateModalData('renameGroup', { icon });
			} else {
				openModal('renameGroup', { groupId: '', value: '', emoji: '📂', icon });
			}
		},
		setRenameGroupColor: (color: string | undefined) => {
			const current = useModalStore.getState().getData('renameGroup');
			if (current) {
				updateModalData('renameGroup', { color });
			} else {
				openModal('renameGroup', { groupId: '', value: '', emoji: '📂', color });
			}
		},

		// Agent Sessions Browser
		setAgentSessionsOpen: (open: boolean) =>
			open
				? openModal('agentSessions', { activeAgentSessionId: null })
				: closeModal('agentSessions'),
		setActiveAgentSessionId: (activeAgentSessionId: string | null) =>
			updateModalData('agentSessions', { activeAgentSessionId }),

		// Memory Viewer (Claude Code per-project memory)
		setMemoryViewerOpen: (open: boolean) =>
			open ? openModal('memoryViewer') : closeModal('memoryViewer'),

		// Execution Queue Browser Modal
		setQueueBrowserOpen: (open: boolean) =>
			open ? openModal('queueBrowser') : closeModal('queueBrowser'),

		// Batch Runner Modal
		setBatchRunnerModalOpen: (open: boolean) =>
			open ? openModal('batchRunner', {}) : closeModal('batchRunner'),
		openBatchRunnerWithPresets: (presetDocuments: string[]) =>
			openModal('batchRunner', { presetDocuments }),

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
		showHistoricalAgentError: (sessionId: string, error: AgentError) =>
			openModal('agentError', { sessionId, historicalError: error }),

		// Provider Re-authentication Modal
		openReauthModal: (data: ReauthModalData) => openModal('reauth', data),
		closeReauthModal: () => closeModal('reauth'),

		// Worktree Modals
		// Opened WITHOUT a target (header pill, Settings): follows the active agent.
		setWorktreeConfigModalOpen: (open: boolean) =>
			open ? openModal('worktreeConfig') : closeModal('worktreeConfig'),
		// Opened WITH a target (Left Bar right-click): configures that agent
		// wherever the selection happens to be. This used to be done by
		// force-activating the right-clicked agent first, which silently moved
		// the user's selection as a side effect of opening a dialog.
		setWorktreeConfigSession: (session: Session | null) =>
			session ? openModal('worktreeConfig', { session }) : closeModal('worktreeConfig'),
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

		// Cross-Tab Message Search Modal
		setCrossTabSearchOpen: (open: boolean) =>
			open ? openModal('crossTabSearch') : closeModal('crossTabSearch'),

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

		// Git command runner (streaming pull/push/fetch console)
		openGitCommandRunner: (data: GitCommandRunnerData) => openModal('gitCommandRunner', data),
		closeGitCommandRunner: () => closeModal('gitCommandRunner'),

		// Branch switcher (fuzzy branch picker)
		openBranchSwitcher: (data: BranchSwitcherModalData) => openModal('branchSwitcher', data),
		closeBranchSwitcher: () => closeModal('branchSwitcher'),

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

		// Typography Choice Modal (first run / first launch after the update)
		setTypographyChoiceModalOpen: (open: boolean) =>
			open ? openModal('typographyChoice') : closeModal('typographyChoice'),

		// Director's Notes Modal
		setDirectorNotesOpen: (open: boolean) =>
			open ? openModal('directorNotes') : closeModal('directorNotes'),

		// Maestro Cue Modal
		setCueModalOpen: (open: boolean) => (open ? openModal('cueModal') : closeModal('cueModal')),
		openCueModalWithTab: (tab: NonNullable<CueModalData['initialTab']>, focusSessionId?: string) =>
			openModal('cueModal', { initialTab: tab, focusSessionId }),

		// Maestro Cue YAML Editor (standalone, bypasses CueModal dashboard)
		openCueYamlEditor: (sessionId: string, projectRoot: string) =>
			openModal('cueYamlEditor', { sessionId, projectRoot }),
		closeCueYamlEditor: () => closeModal('cueYamlEditor'),

		// Pianola Modal (autonomous manager: rules + decision log)
		setPianolaModalOpen: (open: boolean) =>
			open ? openModal('pianolaModal') : closeModal('pianolaModal'),

		// Concerto stage. This one flag is the whole truth about whether the stage
		// is up: the movement store reads it back rather than keeping its own
		// `hidden` copy, so the hotkey, the palette, the CLI and an agent adding a
		// panel cannot disagree about it.
		setConcertoStageOpen: (open: boolean) =>
			open ? openModal('concertoStage') : closeModal('concertoStage'),
		toggleConcertoStage: () => toggleModal('concertoStage'),

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
 * will re-evaluate all selectors on any modal state change - the same behavior
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
	const feedbackModalOpen = useModalStore(selectModalOpen('feedback'));
	const updateCheckModalOpen = useModalStore(selectModalOpen('updateCheck'));
	const leaderboardRegistrationOpen = useModalStore(selectModalOpen('leaderboard'));
	const standingOvationData = useModalStore(selectModalData('standingOvation'));
	const firstRunCelebrationData = useModalStore(selectModalData('firstRunCelebration'));
	const logViewerOpen = useModalStore(selectModalOpen('logViewer'));
	const processMonitorOpen = useModalStore(selectModalOpen('processMonitor'));
	const usageDashboardOpen = useModalStore(selectModalOpen('usageDashboard'));
	const agentRunDashboardOpen = useModalStore(selectModalOpen('agentRunDashboard'));
	const keyboardMasteryData = useModalStore(selectModalData('keyboardMastery'));
	const playgroundOpen = useModalStore(selectModalOpen('playground'));
	const debugPackageModalOpen = useModalStore(selectModalOpen('debugPackage'));
	const debugApplicationStatsOpen = useModalStore(selectModalOpen('debugApplicationStats'));
	const debugAgentProbeOpen = useModalStore(selectModalOpen('debugAgentProbe'));
	const profilingCaptureOpen = useModalStore(selectModalOpen('profilingCapture'));
	const confirmModalOpen = useModalStore(selectModalOpen('confirm'));
	const confirmData = useModalStore(selectModalData('confirm'));
	const quitConfirmModalOpen = useModalStore(selectModalOpen('quitConfirm'));
	const quitConfirmData = useModalStore(selectModalData('quitConfirm'));
	const renameInstanceModalOpen = useModalStore(selectModalOpen('renameInstance'));
	const renameInstanceData = useModalStore(selectModalData('renameInstance'));
	const renameTabModalOpen = useModalStore(selectModalOpen('renameTab'));
	const renameTabData = useModalStore(selectModalData('renameTab'));
	const renameGroupModalOpen = useModalStore(selectModalOpen('renameGroup'));
	const renameGroupData = useModalStore(selectModalData('renameGroup'));
	const agentSessionsOpen = useModalStore(selectModalOpen('agentSessions'));
	const agentSessionsData = useModalStore(selectModalData('agentSessions'));
	const memoryViewerOpen = useModalStore(selectModalOpen('memoryViewer'));
	const queueBrowserOpen = useModalStore(selectModalOpen('queueBrowser'));
	const batchRunnerModalOpen = useModalStore(selectModalOpen('batchRunner'));
	const autoRunSetupModalOpen = useModalStore(selectModalOpen('autoRunSetup'));
	const marketplaceModalOpen = useModalStore(selectModalOpen('marketplace'));
	const wizardResumeModalOpen = useModalStore(selectModalOpen('wizardResume'));
	const wizardResumeData = useModalStore(selectModalData('wizardResume'));
	const agentErrorData = useModalStore(selectModalData('agentError'));
	const reauthData = useModalStore(selectModalData('reauth'));
	const worktreeConfigModalOpen = useModalStore(selectModalOpen('worktreeConfig'));
	const createWorktreeModalOpen = useModalStore(selectModalOpen('createWorktree'));
	const createWorktreeData = useModalStore(selectModalData('createWorktree'));
	const createPRModalOpen = useModalStore(selectModalOpen('createPR'));
	const createPRData = useModalStore(selectModalData('createPR'));
	const deleteWorktreeModalOpen = useModalStore(selectModalOpen('deleteWorktree'));
	const deleteWorktreeData = useModalStore(selectModalData('deleteWorktree'));
	const tabSwitcherOpen = useModalStore(selectModalOpen('tabSwitcher'));
	const crossTabSearchOpen = useModalStore(selectModalOpen('crossTabSearch'));
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
	const gitLogData = useModalStore(selectModalData('gitLog'));
	const tourOpen = useModalStore(selectModalOpen('tour'));
	const tourData = useModalStore(selectModalData('tour'));
	const symphonyModalOpen = useModalStore(selectModalOpen('symphony'));
	const windowsWarningModalOpen = useModalStore(selectModalOpen('windowsWarning'));
	const typographyChoiceModalOpen = useModalStore(selectModalOpen('typographyChoice'));
	const directorNotesOpen = useModalStore(selectModalOpen('directorNotes'));
	const cueModalOpen = useModalStore(selectModalOpen('cueModal'));
	const cueYamlEditorOpen = useModalStore(selectModalOpen('cueYamlEditor'));
	const cueYamlEditorData = useModalStore(selectModalData('cueYamlEditor'));
	const pianolaModalOpen = useModalStore(selectModalOpen('pianolaModal'));

	// Get stable actions
	const actions = getModalActions();

	return {
		// Settings Modal
		settingsModalOpen,
		// `undefined` means "no explicit tab requested" - SettingsModal restores
		// the last in-session tab, falling back to 'general' on first open.
		settingsTab: settingsData?.tab,
		settingsPromptId: settingsData?.promptId,
		...actions,

		// New Instance Modal
		newInstanceModalOpen,
		duplicatingSessionId: newInstanceData?.duplicatingSessionId ?? null,
		newInstancePresetGroupId: newInstanceData?.presetGroupId ?? null,
		newInstancePresetWorkingDir: newInstanceData?.presetWorkingDir ?? null,

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
		feedbackModalOpen,

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

		// AgentRun Dashboard
		agentRunDashboardOpen,

		// Keyboard Mastery Celebration
		pendingKeyboardMasteryLevel: keyboardMasteryData?.level ?? null,

		// Playground Panel
		playgroundOpen,

		// Debug Package Modal
		debugPackageModalOpen,

		// Debug Application Stats Modal
		debugApplicationStatsOpen,

		// Debug Agent Probe Modal
		debugAgentProbeOpen,

		// Profiling Capture Modal
		profilingCaptureOpen,

		// Confirmation Modal
		confirmModalOpen,
		confirmModalMessage: confirmData?.message ?? '',
		confirmModalOnConfirm: confirmData?.onConfirm ?? null,
		confirmModalTitle: confirmData?.title,
		confirmModalDestructive: confirmData?.destructive,

		// Quit Confirmation Modal
		quitConfirmModalOpen,
		activeTerminalTasks: (quitConfirmData?.activeTerminalTasks as string[]) ?? [],
		hasFeedbackDraft: quitConfirmData?.hasFeedbackDraft ?? false,

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
		renameGroupIcon: renameGroupData?.icon,
		renameGroupColor: renameGroupData?.color,

		// Agent Sessions Browser
		agentSessionsOpen,
		activeAgentSessionId: agentSessionsData?.activeAgentSessionId ?? null,

		// Memory Viewer (Claude Code per-project memory)
		memoryViewerOpen,

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

		// Provider Re-authentication Modal
		reauthModalData: reauthData ?? null,

		// Worktree Modals
		worktreeConfigModalOpen,
		createWorktreeModalOpen,
		createWorktreeSession: createWorktreeData?.session ?? null,
		createPRModalOpen,
		createPRSession: createPRData?.session ?? null,
		createPRSourceBranch: createPRData?.sourceBranch,
		deleteWorktreeModalOpen,
		deleteWorktreeSession: deleteWorktreeData?.session ?? null,

		// Tab Switcher Modal
		tabSwitcherOpen,

		// Cross-Tab Message Search Modal
		crossTabSearchOpen,

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

		// Git Diff Viewer. `gitDiffCwd` is set only when the diff was taken for a
		// specific agent (Left Bar menu); otherwise the viewer follows the active one.
		gitDiffPreview: gitDiffData?.diff ?? null,
		gitDiffCwd: gitDiffData?.cwd ?? null,

		// Git Log Viewer. The target is set only when the log was opened for a
		// specific agent (Left Bar menu); otherwise the viewer follows the active one.
		gitLogOpen,
		gitLogTarget: gitLogData ?? null,

		// Tour Overlay
		tourOpen,
		tourFromWizard: tourData?.fromWizard ?? false,

		// Symphony Modal
		symphonyModalOpen,

		// Windows Warning Modal
		windowsWarningModalOpen,

		// Typography Choice Modal
		typographyChoiceModalOpen,

		// Director's Notes Modal
		directorNotesOpen,

		// Maestro Cue Modal
		cueModalOpen,

		// Maestro Cue YAML Editor (standalone)
		cueYamlEditorOpen,
		cueYamlEditorSessionId: cueYamlEditorData?.sessionId ?? null,
		cueYamlEditorProjectRoot: cueYamlEditorData?.projectRoot ?? null,

		// Pianola Modal (autonomous manager)
		pianolaModalOpen,

		// Lightbox ref replacements (now stored as data)
		lightboxIsGroupChat: lightboxData?.isGroupChat ?? false,
		lightboxAllowDelete: lightboxData?.allowDelete ?? false,
	};
}
