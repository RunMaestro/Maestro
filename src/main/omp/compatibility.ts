import type { OmpCommandType, OmpExtensionUiMethod, OmpRpcEventType } from './types';

/** Source: OMP v16.4.8 packages/coding-agent/src/modes/rpc/rpc-types.ts. */
export const OMP_16_4_8_COMMAND_TYPES = [
	'prompt',
	'steer',
	'follow_up',
	'abort',
	'abort_and_prompt',
	'new_session',
	'get_state',
	'get_available_commands',
	'set_todos',
	'set_host_tools',
	'set_host_uri_schemes',
	'set_subagent_subscription',
	'get_subagents',
	'get_subagent_messages',
	'set_model',
	'cycle_model',
	'get_available_models',
	'set_thinking_level',
	'cycle_thinking_level',
	'set_steering_mode',
	'set_follow_up_mode',
	'set_interrupt_mode',
	'compact',
	'set_auto_compaction',
	'set_auto_retry',
	'abort_retry',
	'bash',
	'abort_bash',
	'get_session_stats',
	'export_html',
	'switch_session',
	'branch',
	'get_branch_messages',
	'get_last_assistant_text',
	'set_session_name',
	'handoff',
	'get_messages',
	'get_login_providers',
	'login',
] as const satisfies readonly OmpCommandType[];

/** Sources: OMP v16.4.8 packages/agent/src/types.ts and packages/coding-agent/src/session/agent-session.ts. */
export const OMP_16_4_8_EVENT_TYPES = [
	'agent_start',
	'agent_end',
	'turn_start',
	'turn_end',
	'message_start',
	'message_update',
	'message_end',
	'tool_execution_start',
	'tool_execution_update',
	'tool_execution_end',
	'auto_compaction_start',
	'auto_compaction_end',
	'auto_retry_start',
	'auto_retry_end',
	'retry_fallback_applied',
	'retry_fallback_succeeded',
	'ttsr_triggered',
	'todo_reminder',
	'todo_auto_clear',
	'irc_message',
	'notice',
	'thinking_level_changed',
	'goal_updated',
] as const satisfies readonly OmpRpcEventType[];

/** Source: OMP v16.4.8 packages/coding-agent/src/modes/rpc/rpc-types.ts. */
export const OMP_16_4_8_INBOUND_CALLBACK_TYPES = [
	'extension_ui_response',
	'host_tool_update',
	'host_tool_result',
	'host_uri_result',
] as const;

/** Source: OMP v16.4.8 docs/rpc.md and packages/coding-agent/src/modes/rpc/rpc-types.ts. */
export const OMP_16_4_8_OUTBOUND_CALLBACK_TYPES = [
	'ready',
	'response',
	'extension_ui_request',
	'host_tool_call',
	'host_tool_cancel',
	'host_uri_request',
	'host_uri_cancel',
	'extension_error',
	'available_commands_update',
	'prompt_result',
	'subagent_lifecycle',
	'subagent_progress',
	'subagent_event',
	'command_output',
	'session_info_update',
	'config_update',
] as const;

export const OMP_16_4_8_EXTENSION_UI_METHODS = [
	'extension_ui.select',
	'extension_ui.confirm',
	'extension_ui.input',
	'extension_ui.editor',
	'extension_ui.cancel',
	'extension_ui.notify',
	'extension_ui.setStatus',
	'extension_ui.setWidget',
	'extension_ui.setTitle',
	'extension_ui.set_editor_text',
	'extension_ui.open_url',
] as const satisfies readonly `extension_ui.${OmpExtensionUiMethod}`[];

export type OmpStableMember =
	| OmpCommandType
	| OmpRpcEventType
	| (typeof OMP_16_4_8_INBOUND_CALLBACK_TYPES)[number]
	| (typeof OMP_16_4_8_OUTBOUND_CALLBACK_TYPES)[number]
	| (typeof OMP_16_4_8_EXTENSION_UI_METHODS)[number];

export interface OmpCompatibilityDisposition {
	readonly version: '16.4.8';
	readonly disposition: 'supported';
}

const supported: OmpCompatibilityDisposition = { version: '16.4.8', disposition: 'supported' };
const allStableMembers: readonly OmpStableMember[] = [
	...OMP_16_4_8_COMMAND_TYPES,
	...OMP_16_4_8_EVENT_TYPES,
	...OMP_16_4_8_INBOUND_CALLBACK_TYPES,
	...OMP_16_4_8_OUTBOUND_CALLBACK_TYPES,
	...OMP_16_4_8_EXTENSION_UI_METHODS,
];

/** Explicit 16.4.8 disposition for every stable protocol member; unknown members fail closed. */
export const OMP_16_4_8_COMPATIBILITY: Record<OmpStableMember, OmpCompatibilityDisposition> =
	Object.fromEntries(allStableMembers.map((member) => [member, supported])) as Record<
		OmpStableMember,
		OmpCompatibilityDisposition
	>;

export function assertOmpProtocolVersion(
	versionOutput: string
): asserts versionOutput is 'omp/16.4.8' {
	if (versionOutput.trim() !== 'omp/16.4.8') {
		throw new Error(
			`Unsupported OMP runtime ${JSON.stringify(versionOutput.trim())}; expected omp/16.4.8`
		);
	}
}
