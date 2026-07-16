export const OMP_RPC_VERSION = '16.4.8' as const;

export type OmpCommandType =
	| 'prompt'
	| 'steer'
	| 'follow_up'
	| 'abort'
	| 'abort_and_prompt'
	| 'new_session'
	| 'get_state'
	| 'get_available_commands'
	| 'set_todos'
	| 'set_host_tools'
	| 'set_host_uri_schemes'
	| 'set_subagent_subscription'
	| 'get_subagents'
	| 'get_subagent_messages'
	| 'set_model'
	| 'cycle_model'
	| 'get_available_models'
	| 'set_thinking_level'
	| 'cycle_thinking_level'
	| 'set_steering_mode'
	| 'set_follow_up_mode'
	| 'set_interrupt_mode'
	| 'compact'
	| 'set_auto_compaction'
	| 'set_auto_retry'
	| 'abort_retry'
	| 'bash'
	| 'abort_bash'
	| 'get_session_stats'
	| 'export_html'
	| 'switch_session'
	| 'branch'
	| 'get_branch_messages'
	| 'get_last_assistant_text'
	| 'set_session_name'
	| 'handoff'
	| 'get_messages'
	| 'get_login_providers'
	| 'login';

export type OmpThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type OmpQueueMode = 'all' | 'one-at-a-time';
export type OmpInterruptMode = 'immediate' | 'wait';
export type OmpSubagentSubscription = 'off' | 'progress' | 'events';
export type OmpHostUriOperation = 'read' | 'write';

interface OmpCommandBase<TType extends OmpCommandType> {
	readonly id?: string;
	readonly type: TType;
}

export type OmpRpcCommand =
	| (OmpCommandBase<'prompt'> & {
			readonly message: string;
			readonly images?: readonly unknown[];
			readonly streamingBehavior?: 'steer' | 'followUp';
	  })
	| (OmpCommandBase<'steer' | 'follow_up' | 'abort_and_prompt'> & {
			readonly message: string;
			readonly images?: readonly unknown[];
	  })
	| OmpCommandBase<
			| 'abort'
			| 'cycle_model'
			| 'get_available_models'
			| 'cycle_thinking_level'
			| 'abort_retry'
			| 'abort_bash'
			| 'get_state'
			| 'get_available_commands'
			| 'get_subagents'
			| 'get_session_stats'
			| 'get_branch_messages'
			| 'get_last_assistant_text'
			| 'get_messages'
			| 'get_login_providers'
	  >
	| (OmpCommandBase<'new_session'> & { readonly parentSession?: string })
	| (OmpCommandBase<'set_todos'> & { readonly phases: readonly unknown[] })
	| (OmpCommandBase<'set_host_tools'> & { readonly tools: readonly OmpHostToolDefinition[] })
	| (OmpCommandBase<'set_host_uri_schemes'> & {
			readonly schemes: readonly OmpHostUriSchemeDefinition[];
	  })
	| (OmpCommandBase<'set_subagent_subscription'> & { readonly level: OmpSubagentSubscription })
	| (OmpCommandBase<'get_subagent_messages'> & {
			readonly subagentId?: string;
			readonly sessionFile?: string;
			readonly fromByte?: number;
	  })
	| (OmpCommandBase<'set_model'> & { readonly provider: string; readonly modelId: string })
	| (OmpCommandBase<'set_thinking_level'> & { readonly level: OmpThinkingLevel })
	| (OmpCommandBase<'set_steering_mode' | 'set_follow_up_mode'> & { readonly mode: OmpQueueMode })
	| (OmpCommandBase<'set_interrupt_mode'> & { readonly mode: OmpInterruptMode })
	| (OmpCommandBase<'compact' | 'handoff'> & { readonly customInstructions?: string })
	| (OmpCommandBase<'set_auto_compaction' | 'set_auto_retry'> & { readonly enabled: boolean })
	| (OmpCommandBase<'bash'> & { readonly command: string })
	| (OmpCommandBase<'export_html'> & { readonly outputPath?: string })
	| (OmpCommandBase<'switch_session'> & { readonly sessionPath: string })
	| (OmpCommandBase<'branch'> & { readonly entryId: string })
	| (OmpCommandBase<'set_session_name'> & { readonly name: string })
	| (OmpCommandBase<'login'> & { readonly providerId: string });

export interface OmpSessionState {
	readonly model?: {
		readonly provider: string;
		readonly id: string;
		readonly [key: string]: unknown;
	};
	readonly thinkingLevel: OmpThinkingLevel | undefined;
	readonly isStreaming: boolean;
	readonly isCompacting: boolean;
	readonly steeringMode: OmpQueueMode;
	readonly followUpMode: OmpQueueMode;
	readonly interruptMode: OmpInterruptMode;
	readonly sessionFile?: string;
	readonly sessionId: string;
	readonly sessionName?: string;
	readonly autoCompactionEnabled: boolean;
	readonly messageCount: number;
	readonly queuedMessageCount: number;
	readonly todoPhases: readonly unknown[];
	readonly systemPrompt?: readonly string[];
	readonly dumpTools?: readonly {
		readonly name: string;
		readonly description: string;
		readonly parameters: unknown;
		readonly examples?: readonly unknown[];
	}[];
	readonly contextUsage?: Readonly<Record<string, unknown>>;
	readonly [key: string]: unknown;
}

/** OMP slash-command metadata is presentation-only; it does not authorize RPC methods. */
export interface OmpAvailableSlashCommand {
	readonly name: string;
	readonly source: 'builtin' | 'skill' | 'extension' | 'custom' | 'mcp_prompt' | 'file';
	readonly description?: string;
	readonly aliases?: readonly string[];
	readonly input?: { readonly hint?: string };
	readonly subcommands?: readonly {
		readonly name: string;
		readonly description?: string;
		readonly usage?: string;
	}[];
}

export type OmpRpcEventType =
	| 'agent_start'
	| 'agent_end'
	| 'turn_start'
	| 'turn_end'
	| 'message_start'
	| 'message_update'
	| 'message_end'
	| 'tool_execution_start'
	| 'tool_execution_update'
	| 'tool_execution_end'
	| 'auto_compaction_start'
	| 'auto_compaction_end'
	| 'auto_retry_start'
	| 'auto_retry_end'
	| 'retry_fallback_applied'
	| 'retry_fallback_succeeded'
	| 'ttsr_triggered'
	| 'todo_reminder'
	| 'todo_auto_clear'
	| 'irc_message'
	| 'notice'
	| 'thinking_level_changed'
	| 'goal_updated';

export interface OmpRpcEvent {
	readonly type: OmpRpcEventType;
	readonly [key: string]: unknown;
}

export interface OmpRpcResponse {
	readonly type: 'response';
	readonly id?: string;
	readonly command: string;
	readonly success: boolean;
	readonly data?: unknown;
	readonly error?: string;
}

export interface OmpHostToolDefinition {
	readonly name: string;
	readonly label?: string;
	readonly description: string;
	readonly parameters: Record<string, unknown>;
	readonly hidden?: boolean;
}

export interface OmpHostUriSchemeDefinition {
	readonly scheme: string;
	readonly description?: string;
	readonly writable?: boolean;
	readonly immutable?: boolean;
}

export type OmpInboundCallback =
	| {
			readonly type: 'extension_ui_response';
			readonly id: string;
			readonly value?: string;
			readonly confirmed?: boolean;
			readonly cancelled?: true;
			readonly timedOut?: boolean;
	  }
	| { readonly type: 'host_tool_update'; readonly id: string; readonly partialResult: unknown }
	| {
			readonly type: 'host_tool_result';
			readonly id: string;
			readonly result: unknown;
			readonly isError?: boolean;
	  }
	| {
			readonly type: 'host_uri_result';
			readonly id: string;
			readonly content?: string;
			readonly contentType?: 'text/markdown' | 'application/json' | 'text/plain';
			readonly notes?: readonly string[];
			readonly immutable?: boolean;
			readonly isError?: boolean;
			readonly error?: string;
	  };

export type OmpOutboundCallbackType =
	| 'ready'
	| 'extension_ui_request'
	| 'host_tool_call'
	| 'host_tool_cancel'
	| 'host_uri_request'
	| 'host_uri_cancel'
	| 'extension_error'
	| 'available_commands_update'
	| 'prompt_result'
	| 'subagent_lifecycle'
	| 'subagent_progress'
	| 'subagent_event'
	| 'command_output'
	| 'session_info_update'
	| 'config_update';

export interface OmpOutboundCallback {
	readonly type: OmpOutboundCallbackType;
	readonly [key: string]: unknown;
}

export type OmpExtensionUiMethod =
	| 'select'
	| 'confirm'
	| 'input'
	| 'editor'
	| 'cancel'
	| 'notify'
	| 'setStatus'
	| 'setWidget'
	| 'setTitle'
	| 'set_editor_text'
	| 'open_url';
export type OmpRpcFrame = OmpRpcResponse | OmpRpcEvent | OmpOutboundCallback;

/**
 * Plugin-side endpoint supplied by the host's generic managed JSONL runtime broker.
 * It is intentionally transport-only: plugins cannot inspect, spawn, or kill processes.
 */
export interface OmpRpcTransport {
	send(frame: string): void | Promise<void>;
	onFrame(listener: (chunk: Uint8Array | string) => void): () => void;
	onDiagnostic(listener: (chunk: Uint8Array | string) => void): () => void;
	onClosed(listener: (reason?: string) => void): () => void;
}
