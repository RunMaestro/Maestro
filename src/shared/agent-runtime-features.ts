export interface AgentApprovalRequest {
	id: string;
	sessionId: string;
	toolType: string;
	title: string;
	detail?: string;
	options: { id: string; label: string; kind: 'approve' | 'deny' | 'custom' }[];
	createdAt: string;
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

export interface AgentRuntimeFeatureState {
	controls: AgentControl[];
	tree: AgentTreeNode[] | null;
	todos: AgentTodoPhase[] | null;
	subagents: AgentSubagent[] | null;
	stats: Record<string, number | string> | null;
}
