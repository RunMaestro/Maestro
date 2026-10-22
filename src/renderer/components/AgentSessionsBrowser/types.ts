import type { Theme, Session, ToolType } from '../../types';
import type { UseAgentSessionManagementReturn } from '../../hooks/agent/useAgentSessionManagement';

export type SearchMode = 'title' | 'user' | 'assistant' | 'all';

export interface SearchResult {
	sessionId: string;
	matchType: 'title' | 'user' | 'assistant';
	matchPreview: string;
	matchCount: number;
}

export interface AggregateStats {
	totalSessions: number;
	totalMessages: number;
	totalCostUsd: number;
	totalSizeBytes: number;
	/** Every billed token: input, output, cache reads and cache writes. */
	totalTokens: number;
	/** `totalTokens` by kind, when the source knows it (hover breakdown). */
	tokenSplit?: {
		inputTokens: number;
		outputTokens: number;
		cacheReadTokens: number;
		cacheCreationTokens: number;
	};
	/** Part of `totalTokens` with no record of its kind (sessions archived before the split). */
	unsplitTokens?: number;
	oldestTimestamp: string | null;
	isComplete: boolean;
}

export interface AgentSessionsBrowserProps {
	theme: Theme;
	activeSession: Session | undefined;
	activeAgentSessionId: string | null;
	onClose: () => void;
	/** Explicit scope for a provider browser; omitted means the active conversation at open. */
	provider?: ToolType;
	onResumeSession: (
		...args: Parameters<UseAgentSessionManagementReturn['handleResumeSession']>
	) => void;
	onNewSession: () => void;
	onUpdateTab?: (
		agentSessionId: string,
		updates: { name?: string | null; starred?: boolean },
		provider?: ToolType,
		sessionId?: string
	) => void;
}
