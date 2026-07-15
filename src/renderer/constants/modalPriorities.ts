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

	/** Claude Code standard-mode permission prompt - blocks until the user decides */
	PERMISSION_PROMPT: 1008,

	/** Forced parallel execution warning - one-time acknowledgment */
	FORCED_PARALLEL_WARNING: 1005,

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

	/** Terminal tab startup command configuration modal */
	TERMINAL_STARTUP_COMMAND: 873,

	/** Director's Notes modal - unified history and AI overview */
	DIRECTOR_NOTES: 848,

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

	/** New agent choice modal (Manual vs Wizard) */
	NEW_AGENT_CHOICE: 756,

	/** New instance creation modal */
	NEW_INSTANCE: 750,

	/** Batch runner modal for scratchpad auto mode */
	BATCH_RUNNER: 720,

	/** Document selector modal (opens from BatchRunner to add documents) */
	DOCUMENT_SELECTOR: 725,

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

	/** Auto Run document selector dropdown (above expanded modal so Esc closes
	 * the dropdown first, leaving the modal open for a second Esc). */
	AUTORUN_DOC_SELECTOR: 707,

	/** Playbook Exchange modal - browse and import community playbooks (opens from BatchRunner or AutoRunExpanded, so needs higher priority than both) */
	MARKETPLACE: 735,

	/** Symphony modal - browse and contribute to open source projects */
	SYMPHONY: 710,

	/** Symphony agent creation dialog - appears above Symphony modal for agent selection */
	SYMPHONY_AGENT_CREATION: 711,

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

	/** New memory filename modal (appears above Memory Viewer) */
	MEMORY_CREATE: 695,

	/** Execution queue browser modal */
	EXECUTION_QUEUE_BROWSER: 670,

	/** Keyboard shortcuts help modal */
	SHORTCUTS_HELP: 650,

	/** Leaderboard registration modal */
	LEADERBOARD_REGISTRATION: 620,

	/** Debug package generation modal */
	DEBUG_PACKAGE: 605,

	/** Debug: View Application Stats modal */
	DEBUG_APPLICATION_STATS: 604,

	/** Debug: Re-Probe Agents modal */
	DEBUG_AGENT_PROBE: 603,

	/** Debug: Widget Gallery (shared widget-library preview) */
	DEBUG_WIDGET_GALLERY: 602,

	/** Debug: Performance-profiling capture progress modal */
	DEBUG_PROFILING_CAPTURE: 606,

	/** Windows warning modal - shown on startup for Windows users */
	WINDOWS_WARNING: 615,

	/** About/info modal */
	ABOUT: 600,

	/** Update check modal */
	UPDATE_CHECK: 610,

	/** Feedback modal */
	FEEDBACK: 595,

	/** Process monitor modal */
	PROCESS_MONITOR: 550,

	/** Document Graph modal */
	DOCUMENT_GRAPH: 545,

	/** Usage Dashboard modal */
	USAGE_DASHBOARD: 540,

	/** AgentRun ledger dashboard modal */
	AGENT_RUN_DASHBOARD: 542,

	/** Per-agent detail sub-modal opened from the Usage Dashboard's Agents tab */
	USAGE_DASHBOARD_AGENT_DETAIL: 541,

	/** System log viewer overlay */
	LOG_VIEWER: 500,

	/** Maestro Cue backup diff viewer (above Cue modal + help) */
	CUE_BACKUP_DIFF: 470,

	/** Maestro Cue help modal (above Cue modal) */
	CUE_HELP: 465,

	/** Maestro Cue pattern preview modal (above YAML editor) */
	CUE_PATTERN_PREVIEW: 464,

	/** Maestro Cue YAML editor modal (above Cue modal, below help) */
	CUE_YAML_EDITOR: 463,

	/** Maestro Cue dashboard modal */
	CUE_MODAL: 460,

	/** Pianola dashboard modal (autonomous manager: rules + decision log) */
	PIANOLA_MODAL: 459,

	/** Pianola rule editor (above the Pianola dashboard so Escape closes it first) */
	PIANOLA_RULE_EDITOR: 461,

	/** SSH Remote configuration modal (above settings) */
	SSH_REMOTE: 458,

	/** Reserved band for community-plugin panels/modals. Plugin UI is allocated
	 * sequentially from PLUGIN_PANEL_BASE up to (but not reaching) SSH_REMOTE/
	 * Settings, so plugins always sit below first-party settings-level modals and
	 * never above critical/confirmation modals. Use pluginPanelPriority(index). */
	PLUGIN_PANEL_BASE: 420,

	/** Custom theme base-theme picker dropdown (above settings so Escape closes
	 * the dropdown first, leaving the Settings modal open for a second Esc). */
	CUSTOM_THEME_BASE_SELECTOR: 451,

	/** Settings modal */
	SETTINGS: 450,

	/** Thought Stream introspection panel - floating, non-blocking; sits below
	 * real modals so they take Escape/focus first, above git overlays. */
	THOUGHT_STREAM: 210,

	/** Git diff preview overlay */
	GIT_DIFF: 200,

	/** Branch switcher dropdown (opens from header branch chip) */
	BRANCH_SWITCHER: 195,

	/** Git log viewer overlay */
	GIT_LOG: 190,

	/** Save markdown modal */
	SAVE_MARKDOWN: 160,

	/** Image save destination modal (overwrite vs save-as) - above the annotator
	 * so it layers correctly if the annotator is still settling closed. */
	IMAGE_SAVE: 168,

	/** Image annotator modal - above lightbox so Escape closes annotator first */
	IMAGE_ANNOTATOR: 165,

	/** Image lightbox overlay */
	LIGHTBOX: 150,

	/** Edit-queued-item modal (below lightbox/annotator so those open on top of it
	 * and Escape closes them first while editing a queued message's images). */
	QUEUED_ITEM_EDIT: 145,

	/** File preview overlay */
	FILE_PREVIEW: 100,

	/** Slash command autocomplete */
	SLASH_AUTOCOMPLETE: 50,

	/** File tree filter input */
	FILE_TREE_FILTER: 30,
} as const;

/** Top of the reserved plugin band (exclusive). Plugin priorities are clamped
 * below this so a plugin can never outrank SSH_REMOTE (458) / Settings (450). */
const PLUGIN_PANEL_BAND_TOP = 449;

/**
 * Allocate a modal priority for the Nth open plugin panel within the reserved
 * plugin band. Later panels sit above earlier ones, but the whole band stays
 * below first-party settings-level modals. Clamped so it cannot escape the band.
 */
export function pluginPanelPriority(index: number): number {
	const base = MODAL_PRIORITIES.PLUGIN_PANEL_BASE;
	const safeIndex = Number.isFinite(index) && index > 0 ? Math.floor(index) : 0;
	return Math.min(base + safeIndex, PLUGIN_PANEL_BAND_TOP);
}

/**
 * Type for modal priority keys
 */
export type ModalPriorityKey = keyof typeof MODAL_PRIORITIES;

/**
 * Type for modal priority values
 */
export type ModalPriorityValue = (typeof MODAL_PRIORITIES)[ModalPriorityKey];
