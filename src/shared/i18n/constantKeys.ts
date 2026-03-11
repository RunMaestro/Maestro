/**
 * Typed i18n Key Constants for Non-React Contexts
 *
 * Constants files (shortcuts.ts, conductorBadges.ts, etc.) cannot use
 * React hooks like useTranslation(). This module exports typed key
 * constants that can be resolved at render time via i18n.t().
 *
 * Usage:
 *   import { SHORTCUT_LABELS } from '@shared/i18n/constantKeys';
 *   const label = i18n.t(SHORTCUT_LABELS.toggleSidebar);
 */

// -- Shortcut Labels --
// Maps shortcut IDs (camelCase, matching shortcuts.ts keys) to
// their translation keys in the 'shortcuts' namespace.

export const SHORTCUT_LABELS = {
	// DEFAULT_SHORTCUTS
	toggleSidebar: 'shortcuts:toggle_sidebar' as const,
	toggleRightPanel: 'shortcuts:toggle_right_panel' as const,
	cyclePrev: 'shortcuts:cycle_prev' as const,
	cycleNext: 'shortcuts:cycle_next' as const,
	navBack: 'shortcuts:nav_back' as const,
	navForward: 'shortcuts:nav_forward' as const,
	newInstance: 'shortcuts:new_instance' as const,
	newGroupChat: 'shortcuts:new_group_chat' as const,
	killInstance: 'shortcuts:kill_instance' as const,
	moveToGroup: 'shortcuts:move_to_group' as const,
	toggleMode: 'shortcuts:toggle_mode' as const,
	quickAction: 'shortcuts:quick_action' as const,
	help: 'shortcuts:help' as const,
	settings: 'shortcuts:settings' as const,
	agentSettings: 'shortcuts:agent_settings' as const,
	goToFiles: 'shortcuts:go_to_files' as const,
	goToHistory: 'shortcuts:go_to_history' as const,
	goToAutoRun: 'shortcuts:go_to_auto_run' as const,
	copyFilePath: 'shortcuts:copy_file_path' as const,
	toggleMarkdownMode: 'shortcuts:toggle_markdown_mode' as const,
	toggleAutoRunExpanded: 'shortcuts:toggle_auto_run_expanded' as const,
	focusInput: 'shortcuts:focus_input' as const,
	focusSidebar: 'shortcuts:focus_sidebar' as const,
	viewGitDiff: 'shortcuts:view_git_diff' as const,
	viewGitLog: 'shortcuts:view_git_log' as const,
	agentSessions: 'shortcuts:agent_sessions' as const,
	systemLogs: 'shortcuts:system_logs' as const,
	processMonitor: 'shortcuts:process_monitor' as const,
	usageDashboard: 'shortcuts:usage_dashboard' as const,
	jumpToBottom: 'shortcuts:jump_to_bottom' as const,
	prevTab: 'shortcuts:prev_tab' as const,
	nextTab: 'shortcuts:next_tab' as const,
	openImageCarousel: 'shortcuts:open_image_carousel' as const,
	toggleTabStar: 'shortcuts:toggle_tab_star' as const,
	openPromptComposer: 'shortcuts:open_prompt_composer' as const,
	openWizard: 'shortcuts:open_wizard' as const,
	fuzzyFileSearch: 'shortcuts:fuzzy_file_search' as const,
	toggleBookmark: 'shortcuts:toggle_bookmark' as const,
	openSymphony: 'shortcuts:open_symphony' as const,
	toggleAutoScroll: 'shortcuts:toggle_auto_scroll' as const,
	directorNotes: 'shortcuts:director_notes' as const,

	// FIXED_SHORTCUTS
	jumpToSession: 'shortcuts:jump_to_session' as const,
	filterFiles: 'shortcuts:filter_files' as const,
	filterSessions: 'shortcuts:filter_sessions' as const,
	filterHistory: 'shortcuts:filter_history' as const,
	searchLogs: 'shortcuts:search_logs' as const,
	searchOutput: 'shortcuts:search_output' as const,
	searchDirectorNotes: 'shortcuts:search_director_notes' as const,
	filePreviewBack: 'shortcuts:file_preview_back' as const,
	filePreviewForward: 'shortcuts:file_preview_forward' as const,

	// TAB_SHORTCUTS
	tabSwitcher: 'shortcuts:tab_switcher' as const,
	newTab: 'shortcuts:new_tab' as const,
	closeTab: 'shortcuts:close_tab' as const,
	closeAllTabs: 'shortcuts:close_all_tabs' as const,
	closeOtherTabs: 'shortcuts:close_other_tabs' as const,
	closeTabsLeft: 'shortcuts:close_tabs_left' as const,
	closeTabsRight: 'shortcuts:close_tabs_right' as const,
	reopenClosedTab: 'shortcuts:reopen_closed_tab' as const,
	renameTab: 'shortcuts:rename_tab' as const,
	toggleReadOnlyMode: 'shortcuts:toggle_read_only_mode' as const,
	toggleSaveToHistory: 'shortcuts:toggle_save_to_history' as const,
	toggleShowThinking: 'shortcuts:toggle_show_thinking' as const,
	filterUnreadTabs: 'shortcuts:filter_unread_tabs' as const,
	toggleTabUnread: 'shortcuts:toggle_tab_unread' as const,
	goToTab1: 'shortcuts:go_to_tab_1' as const,
	goToTab2: 'shortcuts:go_to_tab_2' as const,
	goToTab3: 'shortcuts:go_to_tab_3' as const,
	goToTab4: 'shortcuts:go_to_tab_4' as const,
	goToTab5: 'shortcuts:go_to_tab_5' as const,
	goToTab6: 'shortcuts:go_to_tab_6' as const,
	goToTab7: 'shortcuts:go_to_tab_7' as const,
	goToTab8: 'shortcuts:go_to_tab_8' as const,
	goToTab9: 'shortcuts:go_to_tab_9' as const,
	goToLastTab: 'shortcuts:go_to_last_tab' as const,
} as const;

/** Union of all shortcut translation keys */
export type ShortcutLabelKey = (typeof SHORTCUT_LABELS)[keyof typeof SHORTCUT_LABELS];
