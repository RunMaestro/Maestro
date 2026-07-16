export const OMP_RPC_VERSION = '16.4.8' as const;

/** Frames Maestro accepts from the pinned OMP JSONL RPC process. */
export const OMP_16_4_8_RECEIVED_FRAME_TYPES = [
	'ready',
	'response',
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

export type OmpReceivedFrameType = (typeof OMP_16_4_8_RECEIVED_FRAME_TYPES)[number];

export const OMP_IMAGE_MEDIA_TYPES = [
	'image/png',
	'image/jpeg',
	'image/gif',
	'image/webp',
] as const;

export type OmpImageMediaType = (typeof OMP_IMAGE_MEDIA_TYPES)[number];

/** Exact image envelope accepted by the OMP 16.4.8 `prompt` RPC command. */
export interface OmpRpcImage {
	image: {
		data: string;
		mimeType: OmpImageMediaType;
	};
}

export interface OmpRpcCommand {
	id?: string;
	type: string;
	[key: string]: unknown;
}

export interface OmpRpcResponse {
	type: 'response';
	id: string;
	command: string;
	success: boolean;
	data?: unknown;
	error?: string;
}

export interface OmpRpcEvent {
	type: string;
	sequence?: number;
	[key: string]: unknown;
}

export interface OmpRpcTransport {
	send(frame: string): void | Promise<void>;
	onFrame(listener: (chunk: Uint8Array | string) => void): () => void;
	onDiagnostic(listener: (chunk: Uint8Array | string) => void): () => void;
	onClosed(listener: (reason?: string) => void): () => void;
}
