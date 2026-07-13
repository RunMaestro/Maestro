export type OmpConnectionState = 'loading' | 'ready' | 'offline' | 'incompatible' | 'error';
export type OmpSessionStatus = 'idle' | 'streaming' | 'queued' | 'waiting-approval' | 'error';
export type OmpComposerMode = 'build' | 'plan' | 'ask';
export type OmpThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface OmpTodoPhase {
	id?: string;
	label?: string;
	status?: string;
}

export interface OmpAttachment {
	id?: string;
	name: string;
	mediaType: string;
	size: number;
}

export interface OmpUsage {
	inputTokens: number;
	outputTokens: number;
	costUsd?: number;
}

export interface OmpTreeNode {
	id: string;
	label: string;
	children?: OmpTreeNode[];
}

export interface OmpSubagent {
	id: string;
	label: string;
	status: 'idle' | 'running' | 'complete' | 'error';
}

export type OmpWorkspaceEvent =
	| { id: string; kind: 'user' | 'assistant'; text: string }
	| { id: string; kind: 'thinking'; text: string; expanded?: boolean }
	| {
			id: string;
			kind: 'tool';
			name: string;
			status: 'running' | 'complete' | 'error';
			input?: string;
			output?: string;
	  }
	| { id: string; kind: 'approval'; requestId: string; description: string }
	| { id: string; kind: 'artifact'; name: string; artifactType: string }
	| ({ id: string; kind: 'usage' } & OmpUsage)
	| { id: string; kind: 'error'; message: string; recoverable?: boolean };

export interface OmpWorkspaceSession {
	id: string;
	title: string;
	updatedAt: number;
	status: OmpSessionStatus;
	model: string;
	mode: OmpComposerMode;
	branch?: string;
	events: OmpWorkspaceEvent[];
	tree: OmpTreeNode[];
	subagents: OmpSubagent[];
	usage: OmpUsage;
	thinkingLevel?: OmpThinkingLevel;
	queuedMessageCount?: number;
	todoPhases?: OmpTodoPhase[];
}

export interface OmpWorkspaceSnapshot {
	connection: OmpConnectionState;
	models: string[];
	sessions: OmpWorkspaceSession[];
	activeSessionId: string | null;
	incompatibilityReason?: string;
	error?: string;
}

/**
 * Renderer-only contract. A transport adapter will translate the runtime's RPC
 * protocol into this intentional UI surface without exposing Electron bridges
 * to individual workspace components.
 */
export interface OmpWorkspaceAdapter {
	getSnapshot(): Promise<OmpWorkspaceSnapshot>;
	subscribe(listener: (snapshot: OmpWorkspaceSnapshot) => void): () => void;
	selectSession(sessionId: string): Promise<void>;
	renameSession(sessionId: string, name: string): Promise<void>;
	branchSession(sessionId: string, entryId: string): Promise<void>;
	createSession(): Promise<void>;
	sendMessage(sessionId: string, text: string, attachments: File[]): Promise<void>;
	abort(sessionId: string): Promise<void>;
	setModel(sessionId: string, model: string): Promise<void>;
	setThinkingLevel(sessionId: string, level: OmpThinkingLevel): Promise<void>;
	setMode(sessionId: string, mode: OmpComposerMode): Promise<void>;
	resolveApproval(sessionId: string, requestId: string, approved: boolean): Promise<void>;
	retry(): Promise<void>;
}
