/** Runtime source of truth for messages accepted by the web-server handler. */
export const WEB_CLIENT_MESSAGE_TYPES = [
	'ping',
	'subscribe',
	'send_command',
	'switch_mode',
	'select_session',
	'get_sessions',
	'get_app_info',
	'select_tab',
	'new_tab',
	'close_tab',
	'rename_tab',
	'star_tab',
	'reorder_tab',
	'toggle_bookmark',
	'open_file_tab',
	'open_browser_tab',
	'open_terminal_tab',
	'new_ai_tab_with_prompt',
	'refresh_file_tree',
	'get_file_tree',
	'refresh_auto_run_docs',
	'configure_auto_run',
	'create_worktree_session',
	'set_auto_run_folder',
	'get_auto_run_docs',
	'get_auto_run_state',
	'get_auto_run_document',
	'save_auto_run_document',
	'stop_auto_run',
	'reset_auto_run_doc_tasks',
	'resume_auto_run_error',
	'skip_auto_run_document',
	'abort_auto_run_error',
	'list_playbooks',
	'create_playbook',
	'update_playbook',
	'delete_playbook',
	'get_settings',
	'set_setting',
	'create_session',
	'delete_session',
	'rename_session',
	'update_session_cwd',
	'update_session_ssh',
	'update_session_config',
	'get_groups',
	'create_group',
	'rename_group',
	'delete_group',
	'move_session_to_group',
	'get_git_status',
	'get_git_diff',
	'get_git_branches',
	'list_worktrees',
	'get_group_chats',
	'start_group_chat',
	'get_group_chat_state',
	'send_group_chat_message',
	'stop_group_chat',
	'merge_context',
	'transfer_context',
	'summarize_context',
	'create_gist',
	'get_cue_subscriptions',
	'toggle_cue_subscription',
	'get_cue_activity',
	'trigger_cue_subscription',
	'cue_pipeline_list',
	'cue_pipeline_get',
	'cue_pipeline_set',
	'cue_pipeline_remove',
	'get_usage_dashboard',
	'get_achievements',
	'get_stats_aggregation',
	'stats_query',
	'generate_director_notes_synopsis',
	'terminal_write',
	'terminal_resize',
	'notify_toast',
	'movement',
	'get_movement_state',
	'cadenza',
	'notify_center_flash',
	'profiling_start',
	'profiling_stop',
	'profiling_status',
	'marketplace_get_manifest',
	'marketplace_get_document',
	'marketplace_get_readme',
	'marketplace_import_playbook',
	'list_desktop_sessions',
	'plugins_list_tools',
	'plugins_call_tool',
	'get_session_history',
	'bridge.invoke',
] as const;

export type WebClientMessageType = (typeof WEB_CLIENT_MESSAGE_TYPES)[number];

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

const hasOptionalString = (message: UnknownRecord, key: string): boolean =>
	message[key] === undefined || typeof message[key] === 'string';

const hasOptionalBoolean = (message: UnknownRecord, key: string): boolean =>
	message[key] === undefined || typeof message[key] === 'boolean';

const hasOptionalInputMode = (message: UnknownRecord, key: string): boolean =>
	message[key] === undefined || message[key] === 'ai' || message[key] === 'terminal';

/**
 * Transport-only client envelope. Socket ownership stays in main; handler-specific
 * values are intentionally a strict superset of the historical server envelope.
 */
export interface WebClientMessage {
	type: WebClientMessageType;
	requestId?: string;
	sessionId?: string;
	tabId?: string;
	command?: string;
	mode?: 'ai' | 'terminal';
	inputMode?: 'ai' | 'terminal';
	newName?: string;
	filePath?: string;
	focus?: boolean;
	force?: boolean;
	[key: string]: unknown;
}

export function isWebClientMessageType(value: unknown): value is WebClientMessageType {
	return (
		typeof value === 'string' && (WEB_CLIENT_MESSAGE_TYPES as readonly string[]).includes(value)
	);
}

/**
 * Rejects unknown discriminants and malformed transport envelopes before main
 * dispatches a web-client command. Command-specific validation remains with
 * each handler because command payloads intentionally evolve independently.
 */
export function isWebClientMessage(value: unknown): value is WebClientMessage {
	if (!isRecord(value) || !isWebClientMessageType(value.type)) return false;

	return (
		hasOptionalString(value, 'requestId') &&
		hasOptionalString(value, 'sessionId') &&
		hasOptionalString(value, 'tabId') &&
		hasOptionalString(value, 'command') &&
		hasOptionalInputMode(value, 'mode') &&
		hasOptionalInputMode(value, 'inputMode') &&
		hasOptionalString(value, 'newName') &&
		hasOptionalString(value, 'filePath') &&
		hasOptionalBoolean(value, 'focus') &&
		hasOptionalBoolean(value, 'force')
	);
}
