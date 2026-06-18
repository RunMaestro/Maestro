import { FALLBACK_CONTEXT_WINDOW } from '../../../../shared/agentConstants';
import type { UsageStats } from '../../../types';
import type { AgentSession } from '../../../hooks/agent/useSessionViewer';

// Token counts from stored sessions are LIFETIME TOTALS, not current context.
// We only preserve the cost for display. Token fields are intentionally zeroed so
// restored tabs start at 0% context and get updated when Claude Code sends fresh
// usage data. This prevents the bug where resumed sessions showed 100% context.
export function buildUsageStats(session: AgentSession): UsageStats | undefined {
	if (!session.costUsd) return undefined;
	return {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadInputTokens: 0,
		cacheCreationInputTokens: 0,
		totalCostUsd: session.costUsd,
		contextWindow: FALLBACK_CONTEXT_WINDOW,
	};
}
