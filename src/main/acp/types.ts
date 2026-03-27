/**
 * ACP (Agent Client Protocol) Type Definitions
 *
 * Based on the ACP specification at https://agentclientprotocol.com/protocol/schema
 * These types define the JSON-RPC messages for communicating with ACP-compatible agents.
 */

// ============================================================================
// Core JSON-RPC Types
// ============================================================================

export type RequestId = string | number | null;

export interface JsonRpcRequest {
	jsonrpc: '2.0';
	id: RequestId;
	method: string;
	params?: unknown;
}

export interface JsonRpcResponse {
	jsonrpc: '2.0';
	id: RequestId;
	result?: unknown;
	error?: JsonRpcError;
}

export interface JsonRpcNotification {
	jsonrpc: '2.0';
	method: string;
	params?: unknown;
}

export interface JsonRpcError {
	code: number;
	message: string;
	data?: unknown;
}

// ============================================================================
// Protocol Version
// ============================================================================

export type ProtocolVersion = number;
export const CURRENT_PROTOCOL_VERSION: ProtocolVersion = 1;

// ============================================================================
// Implementation Info
// ============================================================================

export interface Implementation {
	name: string;
	version: string;
	title?: string;
}

// ============================================================================
// Capabilities
// ============================================================================

export interface ClientCapabilities {
	fs?: {
		readTextFile?: boolean;
		writeTextFile?: boolean;
	};
	terminal?: boolean;
}

export interface AgentCapabilities {
	loadSession?: boolean;
	mcpCapabilities?: {
		http?: boolean;
		sse?: boolean;
	};
	promptCapabilities?: {
		audio?: boolean;
		embeddedContext?: boolean;
		image?: boolean;
	};
	sessionCapabilities?: Record<string, unknown>;
}

// ============================================================================
// Initialize
// ============================================================================

export interface InitializeRequest {
	protocolVersion: ProtocolVersion;
	clientInfo?: Implementation;
	clientCapabilities?: ClientCapabilities;
}

export interface InitializeResponse {
	protocolVersion: ProtocolVersion;
	agentInfo?: Implementation;
	agentCapabilities?: AgentCapabilities;
	authMethods?: AuthMethod[];
}

export interface AuthMethod {
	id: string;
	name: string;
	description?: string;
}

// ============================================================================
// Authentication
// ============================================================================

/**
 * Authentication request sent after initialize when the agent
 * reports authMethods in the InitializeResponse.
 *
 * Some agents (e.g., Gemini CLI) require an explicit authenticate call
 * between initialize and session/new. The client selects which auth
 * method to use from the list provided in InitializeResponse.authMethods.
 */
export interface AuthenticateRequest {
	/** The selected auth method ID (from InitializeResponse.authMethods) */
	authMethodId: string;
	/** Optional auth parameters (e.g., API key, token) */
	params?: Record<string, unknown>;
}

export interface AuthenticateResponse {
	/** Whether authentication was successful */
	success: boolean;
	/** Error message if authentication failed */
	error?: string;
}

// ============================================================================
// Session Management
// ============================================================================

export type SessionId = string;

export interface McpServerStdio {
	name: string;
	command: string;
	args: string[];
	env: EnvVariable[];
}

export interface EnvVariable {
	name: string;
	value: string;
}

export type McpServer = { stdio: McpServerStdio };

export interface NewSessionRequest {
	cwd: string;
	mcpServers: McpServer[];
}

export interface NewSessionResponse {
	sessionId: SessionId;
	modes?: SessionModeState;
}

export interface LoadSessionRequest {
	sessionId: SessionId;
	cwd: string;
	mcpServers: McpServer[];
}

export interface LoadSessionResponse {
	modes?: SessionModeState;
}

export interface SessionModeState {
	availableModes: SessionMode[];
	currentModeId: SessionModeId;
}

export type SessionModeId = string;

export interface SessionMode {
	id: SessionModeId;
	name: string;
	description?: string;
}

// ============================================================================
// Content Blocks
// ============================================================================

export interface TextContent {
	text: string;
	annotations?: Annotations;
}

export interface ImageContent {
	data: string;
	mimeType: string;
	uri?: string;
	annotations?: Annotations;
}

export interface ResourceLink {
	uri: string;
	name: string;
	mimeType?: string;
	description?: string;
	title?: string;
	size?: number;
	annotations?: Annotations;
}

export interface EmbeddedResource {
	resource: TextResourceContents | BlobResourceContents;
	annotations?: Annotations;
}

export interface TextResourceContents {
	uri: string;
	text: string;
	mimeType?: string;
}

export interface BlobResourceContents {
	uri: string;
	blob: string;
	mimeType?: string;
}

export interface Annotations {
	audience?: Role[];
	lastModified?: string;
	priority?: number;
}

export type Role = 'assistant' | 'user';

/**
 * ContentBlock represents a unit of content in prompts and responses.
 *
 * Note: There are two formats in use:
 * 1. Spec format (nested): { text: { text: 'content' } }
 * 2. OpenCode format (flat): { type: 'text', text: 'content' }
 *
 * We define the spec format here. The flat format is handled via type casting
 * in acp-client.ts for OpenCode compatibility.
 */
export type ContentBlock =
	| { text: TextContent }
	| { image: ImageContent }
	| { resource_link: ResourceLink }
	| { resource: EmbeddedResource };

/**
 * Alternative flat format used by some agents (e.g., OpenCode).
 * Use this for agents that expect { type: 'text', text: '...' } instead of { text: { text: '...' } }
 */
export type ContentBlockFlat =
	| { type: 'text'; text: string }
	| { type: 'image'; data: string; mimeType: string }
	| { type: 'resource_link'; uri: string; name: string }
	| { type: 'resource'; resource: TextResourceContents | BlobResourceContents };

// ============================================================================
// Prompt
// ============================================================================

export interface PromptRequest {
	sessionId: SessionId;
	prompt: ContentBlock[];
}

export type StopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled';

export interface PromptResponse {
	stopReason: StopReason;
	usage?: {
		inputTokens?: number;
		outputTokens?: number;
		totalTokens?: number;
	};
}

// ============================================================================
// Session Updates (Notifications)
// ============================================================================

export interface SessionNotification {
	sessionId: SessionId;
	update: SessionUpdate;
}

export type SessionUpdate =
	| { user_message_chunk: ContentChunk }
	| { agent_message_chunk: ContentChunk }
	| { agent_thought_chunk: ContentChunk }
	| { tool_call: ToolCall }
	| { tool_call_update: ToolCallUpdate }
	| { plan: Plan }
	| { available_commands_update: AvailableCommandsUpdate }
	| { current_mode_update: CurrentModeUpdate }
	| { usage_update: UsageUpdate }
	| { config_option_update: ConfigOptionUpdate };

export interface ContentChunk {
	content: ContentBlock;
}

// ============================================================================
// Tool Calls
// ============================================================================

export type ToolCallId = string;

export type ToolKind =
	| 'read'
	| 'edit'
	| 'delete'
	| 'move'
	| 'search'
	| 'execute'
	| 'think'
	| 'fetch'
	| 'switch_mode'
	| 'other';

export type ToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export interface ToolCall {
	toolCallId: ToolCallId;
	title: string;
	kind?: ToolKind;
	status?: ToolCallStatus;
	rawInput?: unknown;
	rawOutput?: unknown;
	content?: ToolCallContent[];
	locations?: ToolCallLocation[];
}

export interface ToolCallUpdate {
	toolCallId: ToolCallId;
	title?: string;
	kind?: ToolKind;
	status?: ToolCallStatus;
	rawInput?: unknown;
	rawOutput?: unknown;
	content?: ToolCallContent[];
	locations?: ToolCallLocation[];
}

export type ToolCallContent =
	| { content: { content: ContentBlock } }
	| { diff: Diff }
	| { terminal: Terminal };

export interface Diff {
	path: string;
	oldText?: string;
	newText: string;
}

export interface Terminal {
	terminalId: string;
}

export interface ToolCallLocation {
	path: string;
	line?: number;
}

// ============================================================================
// Plan
// ============================================================================

export interface Plan {
	entries: PlanEntry[];
}

export interface PlanEntry {
	content: string;
	priority: PlanEntryPriority;
	status: PlanEntryStatus;
}

export type PlanEntryPriority = 'high' | 'medium' | 'low';
export type PlanEntryStatus = 'pending' | 'in_progress' | 'completed';

// ============================================================================
// Commands
// ============================================================================

export interface AvailableCommandsUpdate {
	availableCommands: AvailableCommand[];
}

export interface AvailableCommand {
	name: string;
	description: string;
	input?: AvailableCommandInput;
}

export interface AvailableCommandInput {
	hint: string;
}

export interface CurrentModeUpdate {
	currentModeId: SessionModeId;
}

// ============================================================================
// Usage Update
// ============================================================================

/**
 * Usage update sent by agents to report token usage and cost.
 * Based on OpenCode's ACP implementation:
 * - used: number of tokens used in the current context
 * - size: total context window size
 * - cost: optional cost information with amount and currency
 */
export interface UsageUpdate {
	/** Number of tokens used in the current context */
	used: number;
	/** Total context window size */
	size: number;
	/** Optional cost information */
	cost?: UsageCost;
}

export interface UsageCost {
	/** Cost amount (e.g., 0.0025) */
	amount: number;
	/** Currency code (e.g., "USD") */
	currency: string;
}

// ============================================================================
// Config Option Update
// ============================================================================

/**
 * Config option update sent by agents when session configuration changes.
 * Used to notify the client of configuration changes that occurred during the session.
 */
export interface ConfigOptionUpdate {
	/** The configuration option that changed */
	key: string;
	/** The new value for the configuration option */
	value: unknown;
}

// ============================================================================
// Permission Request (Client → Agent response)
// ============================================================================

export interface RequestPermissionRequest {
	sessionId: SessionId;
	toolCall: ToolCallUpdate;
	options: PermissionOption[];
}

export interface PermissionOption {
	optionId: PermissionOptionId;
	name: string;
	kind: PermissionOptionKind;
}

export type PermissionOptionId = string;
export type PermissionOptionKind = 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';

export interface RequestPermissionResponse {
	outcome: RequestPermissionOutcome;
}

export type RequestPermissionOutcome =
	| { cancelled: Record<string, never> }
	| { selected: { optionId: PermissionOptionId } };

// ============================================================================
// File System (Client methods)
// ============================================================================

export interface ReadTextFileRequest {
	sessionId: SessionId;
	path: string;
	line?: number;
	limit?: number;
}

export interface ReadTextFileResponse {
	content: string;
}

export interface WriteTextFileRequest {
	sessionId: SessionId;
	path: string;
	content: string;
}

export interface WriteTextFileResponse {
	// Empty response
}

// ============================================================================
// Terminal (Client methods)
// ============================================================================

export interface CreateTerminalRequest {
	sessionId: SessionId;
	command: string;
	args?: string[];
	cwd?: string;
	env?: EnvVariable[];
	outputByteLimit?: number;
}

export interface CreateTerminalResponse {
	terminalId: string;
}

export interface TerminalOutputRequest {
	sessionId: SessionId;
	terminalId: string;
}

export interface TerminalOutputResponse {
	output: string;
	truncated: boolean;
	exitStatus?: TerminalExitStatus;
}

export interface TerminalExitStatus {
	exitCode?: number;
	signal?: string;
}

// ============================================================================
// Cancel
// ============================================================================

export interface CancelNotification {
	sessionId: SessionId;
}
