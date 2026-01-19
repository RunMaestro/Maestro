/**
 * Modal Priority Constants
 *
 * Defines the priority/z-index values for all modals and overlays in the application.
 * Higher values appear on top. The layer stack system uses these priorities to determine
 * which layer should handle the Escape key and which layer should be visually on top.
 *
 * Priority Ranges:
 * - 1000+: Critical modals (confirmations)
 * - 900-999: High priority modals (rename, create)
 * - 700-899: Standard modals (new instance, quick actions)
 * - 400-699: Settings and informational modals
 * - 100-399: Overlays and previews
 * - 1-99: Search and autocomplete
 */
export const MODAL_PRIORITIES = {
	/** Standing ovation achievement overlay - celebration! */
	STANDING_OVATION: 1100,

	/** Keyboard mastery level-up celebration - high priority celebration */
	KEYBOARD_MASTERY: 1095,

	/** Onboarding tour overlay - above wizard, guides new users */
	TOUR: 1050,

	/** Quit confirmation modal - highest priority, blocks app quit */
	QUIT_CONFIRM: 1020,

	/** Agent error modal - critical, shows recovery options */
	AGENT_ERROR: 1010,

	/** Confirmation dialogs - highest priority, always on top */
	CONFIRM: 1000,

	/** Gist publish confirmation modal - high priority */
	GIST_PUBLISH: 980,

	/** Playbook delete confirmation - high priority, appears on top of BatchRunner */
	PLAYBOOK_DELETE_CONFIRM: 950,

	/** Playbook name input modal - appears on top of BatchRunner */
	PLAYBOOK_NAME: 940,

	/** Rename instance modal */
	RENAME_INSTANCE: 900,

	/** Rename tab modal */
	RENAME_TAB: 875,

	/** Rename group modal */
	RENAME_GROUP: 850,

	/** Create new group modal */
	CREATE_GROUP: 800,

	/** Delete group chat confirmation */
	DELETE_GROUP_CHAT: 660,

	/** New group chat creation modal */
	NEW_GROUP_CHAT: 650,

	/** Edit group chat modal */
	EDIT_GROUP_CHAT: 645,

	/** Rename group chat modal */
	RENAME_GROUP_CHAT: 640,

	/** Group chat info overlay */
	GROUP_CHAT_INFO: 630,

	/** Wizard exit confirmation dialog - appears above wizard when exiting mid-flow */
	WIZARD_EXIT_CONFIRM: 770,

	/** Existing Auto Run docs detection modal - appears above wizard during directory selection */
	EXISTING_AUTORUN_DOCS: 768,

	/** Wizard resume dialog - appears above wizard to ask about resuming */
	WIZARD_RESUME: 765,

	/** Onboarding wizard - high priority, guides new users through setup */
	WIZARD: 760,

	/** Inline wizard mode prompt - appears when user runs /wizard with existing docs */
	WIZARD_MODE_PROMPT: 762,

	/** Inline wizard exit confirmation dialog - appears when user presses Escape during wizard */
	INLINE_WIZARD_EXIT_CONFIRM: 775,

	/** Create PR modal (from worktree) */
	CREATE_PR: 755,

	/** Create worktree modal (quick create from context menu) */
	CREATE_WORKTREE: 753,

	/** Worktree configuration modal */
	WORKTREE_CONFIG: 752,

	/** New instance creation modal */
	NEW_INSTANCE: 750,

	/** Batch runner modal for scratchpad auto mode */
	BATCH_RUNNER: 720,

	/** Tab switcher modal (Opt+Cmd+T) */
	TAB_SWITCHER: 710,

	/** Tab context menu (right-click on tab) */
	TAB_CONTEXT_MENU: 708,

	/** Prompt composer modal for long prompts */
	PROMPT_COMPOSER: 725,

	/** Agent prompt composer modal (opens from batch runner) */
	AGENT_PROMPT_COMPOSER: 730,

	/** Auto Run setup/folder selection modal */
	AUTORUN_SETUP: 710,

	/** Auto Run expanded view modal */
	AUTORUN_EXPANDED: 705,

	/** Auto Run search bar (within expanded modal) */
	AUTORUN_SEARCH: 706,

	/** Playbook Exchange modal - browse and import community playbooks */
	MARKETPLACE: 708,

	/** Auto Run lightbox (above expanded modal so Escape closes it first) */
	AUTORUN_LIGHTBOX: 715,

	/** Auto Run reset tasks confirmation modal */
	AUTORUN_RESET_TASKS: 712,

	/** Quick actions command palette (Cmd+K) */
	QUICK_ACTION: 700,

	/** Fuzzy file search modal (Cmd+G) */
	FUZZY_FILE_SEARCH: 690,

	/** Merge session contexts modal (via Command Palette or right-click menu) */
	MERGE_SESSION: 685,

	/** Send to agent modal (cross-agent context transfer) */
	SEND_TO_AGENT: 686,

	/** Merge progress modal (appears during merge operation) */
	MERGE_PROGRESS: 684,

	/** Transfer progress modal (appears during cross-agent transfer operation) */
	TRANSFER_PROGRESS: 683,

	/** Transfer error modal (appears when cross-agent transfer fails) */
	TRANSFER_ERROR: 682,

	/** Summarization progress modal (appears during context compaction) */
	SUMMARIZE_PROGRESS: 681,

	/** Agent sessions browser (Cmd+Shift+L) */
	AGENT_SESSIONS: 680,

	/** Execution queue browser modal */
	EXECUTION_QUEUE_BROWSER: 670,

	/** Keyboard shortcuts help modal */
	SHORTCUTS_HELP: 650,

	/** Leaderboard registration modal */
	LEADERBOARD_REGISTRATION: 620,

	/** Debug package generation modal */
	DEBUG_PACKAGE: 605,

	/** About/info modal */
	ABOUT: 600,

	/** Update check modal */
	UPDATE_CHECK: 610,

	/** Process monitor modal */
	PROCESS_MONITOR: 550,

	/** Document Graph modal */
	DOCUMENT_GRAPH: 545,

	/** Usage Dashboard modal */
	USAGE_DASHBOARD: 540,

	/** System log viewer overlay */
	LOG_VIEWER: 500,

	/** SSH Remote configuration modal (above settings) */
	SSH_REMOTE: 460,

	/** Settings modal */
	SETTINGS: 450,

	/** Git diff preview overlay */
	GIT_DIFF: 200,

	/** Git log viewer overlay */
	GIT_LOG: 190,

	/** Image lightbox overlay */
	LIGHTBOX: 150,

	/** File preview overlay */
	FILE_PREVIEW: 100,

	/** Slash command autocomplete */
	SLASH_AUTOCOMPLETE: 50,

	/** File tree filter input */
	FILE_TREE_FILTER: 30,
} as const;

/**
 * Type for modal priority keys
 */
export type ModalPriorityKey = keyof typeof MODAL_PRIORITIES;

/**
 * Type for modal priority values
 */
export type ModalPriorityValue = (typeof MODAL_PRIORITIES)[ModalPriorityKey];
