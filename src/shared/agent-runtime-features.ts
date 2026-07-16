export interface AgentApprovalTextInput {
	kind: 'input' | 'editor';
	placeholder?: string;
	prefill?: string;
	promptStyle?: boolean;
}

export interface AgentApprovalRequest {
	id: string;
	sessionId: string;
	toolType: string;
	title: string;
	detail?: string;
	options: { id: string; label: string; kind: 'approve' | 'deny' | 'custom' }[];
	textInput?: AgentApprovalTextInput;
	createdAt: string;
}

export interface AgentApprovalResponse {
	sessionId: string;
	requestId: string;
	optionId?: string;
	value?: string;
	cancelled?: boolean;
}

export interface AgentTreeNode {
	id: string;
	label: string;
	children?: AgentTreeNode[];
}

export interface AgentTodoPhase {
	name: string;
	items: { content: string; state: 'open' | 'in_progress' | 'done' | 'dropped' }[];
}

export interface AgentSubagent {
	id: string;
	label: string;
	status: 'running' | 'idle' | 'complete' | 'error';
	detail?: string;
}

export interface AgentControlOption {
	id: string;
	label: string;
}

export interface AgentControl {
	id: string;
	label: string;
	kind: 'select' | 'toggle' | 'action';
	options?: AgentControlOption[];
	value?: string | boolean;
}

/** Native runtime connection state when the capability surface is projected before startup. */
export interface AgentRuntimeReadiness {
	state: 'dormant';
	message: string;
}

export interface AgentRuntimeFeatureState {
	controls: AgentControl[];
	tree: AgentTreeNode[] | null;
	todos: AgentTodoPhase[] | null;
	subagents: AgentSubagent[] | null;
	stats: Record<string, number | string> | null;
	/** Login providers discovered from the native runtime; never free-form when present. */
	loginProviders?: AgentControlOption[] | null;
	/** Present only when native capabilities are visible but the runtime has not started yet. */
	readiness?: AgentRuntimeReadiness;
}
