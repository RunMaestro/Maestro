// Minimal ambient declaration of the subset of the omp
// (`@oh-my-pi/pi-coding-agent`) extension API that the maestro-bridge extension
// depends on. omp provides the real implementation at runtime (the extension is
// loaded by omp under Bun); this declaration exists only so the extension and
// its tests typecheck in isolation without installing the omp package.
//
// This is the pinned integration contract. Bump deliberately when targeting a
// newer omp extension API. Verified against omp >= 16.1 (see omp docs
// `extensions.md`).
declare module '@oh-my-pi/pi-coding-agent' {
	export interface ContentBlockText {
		type: 'text';
		text: string;
	}
	export type ContentBlock = ContentBlockText;
	export interface AgentToolResult {
		content: ContentBlock[];
		details?: unknown;
	}

	// `pi.zod` is the zod module omp injects. Only the constructors the bridge
	// uses are declared; the chainable surface is intentionally narrow.
	export interface ZodType {
		optional(): ZodType;
		default(value: unknown): ZodType;
		describe(text: string): ZodType;
	}
	export interface ZodModule {
		object(shape: Record<string, ZodType>): ZodType;
		string(): ZodType;
		number(): ZodType;
		boolean(): ZodType;
	}

	export interface SessionManagerView {
		getSessionFile(): string | undefined;
	}
	export type NotifyLevel = 'info' | 'warn' | 'error';
	export interface ExtensionUIContext {
		notify(message: string, level?: NotifyLevel): void;
	}

	export interface ExtensionContext {
		cwd: string;
		hasUI: boolean;
		sessionManager: SessionManagerView;
		ui: ExtensionUIContext;
	}

	export interface ToolExecuteFn {
		(
			toolCallId: string,
			params: unknown,
			signal: AbortSignal | undefined,
			onUpdate: ((update: AgentToolResult) => void) | undefined,
			ctx: ExtensionContext
		): Promise<AgentToolResult>;
	}
	export interface ToolDefinition {
		name: string;
		label?: string;
		description: string;
		parameters: ZodType;
		hidden?: boolean;
		execute: ToolExecuteFn;
	}

	export type ExtensionEventName =
		| 'session_start'
		| 'session_shutdown'
		| 'session_stop'
		| 'turn_start'
		| 'turn_end'
		| 'message_start'
		| 'message_update'
		| 'message_end'
		| 'tool_execution_start'
		| 'tool_execution_update'
		| 'tool_execution_end'
		| 'tool_call'
		| 'tool_result'
		| 'agent_start'
		| 'agent_end';

	// Event payloads vary per event; the bridge reads a few optional fields
	// defensively and otherwise treats the payload as opaque.
	export interface ExtensionEvent {
		readonly [key: string]: unknown;
	}
	export interface ExtensionEventHandler {
		(event: ExtensionEvent, ctx: ExtensionContext): void | Promise<void>;
	}

	export interface ExtensionCommandDefinition {
		description: string;
		handler: (args: string, ctx: ExtensionContext) => void | Promise<void>;
	}
	export interface ExtensionLogger {
		info(message: string): void;
		warn(message: string): void;
		error(message: string): void;
	}

	export interface ExtensionAPI {
		setLabel(label: string): void;
		on(event: ExtensionEventName, handler: ExtensionEventHandler): void;
		registerTool(def: ToolDefinition): void;
		registerCommand(name: string, def: ExtensionCommandDefinition): void;
		appendEntry(customType: string, data: unknown): void;
		setSessionName(name: string): Promise<void>;
		readonly zod: ZodModule;
		readonly logger: ExtensionLogger;
	}
	export type ExtensionFactory = (pi: ExtensionAPI) => void;
}
