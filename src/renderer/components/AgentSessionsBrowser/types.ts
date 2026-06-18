import type { Theme, Session, LogEntry, UsageStats } from '../../types';

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
	totalTokens: number;
	oldestTimestamp: string | null;
	isComplete: boolean;
}

export interface AgentSessionsBrowserProps {
	theme: Theme;
	activeSession: Session | undefined;
	activeAgentSessionId: string | null;
	onClose: () => void;
	onResumeSession: (
		agentSessionId: string,
		messages: LogEntry[],
		sessionName?: string,
		starred?: boolean,
		usageStats?: UsageStats
	) => void;
	onNewSession: () => void;
	onUpdateTab?: (
		agentSessionId: string,
		updates: { name?: string | null; starred?: boolean }
	) => void;
}
