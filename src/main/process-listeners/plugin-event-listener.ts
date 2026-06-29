/**
 * Plugin event listener.
 *
 * Bridges ProcessManager lifecycle events to the metadata-only plugin event bus
 * (`deps.emitPluginEvent`). Kept separate from the other process listeners so the
 * plugin-facing surface is isolated and unit-testable. Emits ONLY scalar metadata
 * — never message bodies, prompts, agent output, or error text — per the contract
 * in src/shared/plugins/events.ts (the bus additionally sanitizes + re-authorizes
 * every delivery against live grants). A no-op when no emitter is wired.
 */

import type { ProcessManager } from '../process-manager';
import type {
	ProcessListenerDependencies,
	AgentError,
	UsageStats,
	QueryCompleteData,
} from './types';

export function setupPluginEventListener(
	processManager: ProcessManager,
	deps: Pick<ProcessListenerDependencies, 'emitPluginEvent'>
): void {
	const emit = deps.emitPluginEvent;
	if (!emit) return;
	const at = (): string => new Date().toISOString();

	// Agent/process exit — sessionId + exit code only (no output).
	processManager.on('exit', (sessionId: string, code: number) => {
		emit({ topic: 'agent.exited', at: at(), payload: { sessionId, exitCode: code } });
	});

	// Agent error — type + recoverability only (never the provider message / raw).
	processManager.on('agent-error', (sessionId: string, agentError: AgentError) => {
		emit({
			topic: 'agent.error',
			at: at(),
			payload: {
				sessionId,
				...(agentError.agentId ? { agentId: agentError.agentId } : {}),
				errorType: agentError.type,
				recoverable: agentError.recoverable,
			},
		});
	});

	// Token/cost usage — counts only.
	processManager.on('usage', (sessionId: string, usage: UsageStats) => {
		emit({
			topic: 'usage.updated',
			at: at(),
			payload: {
				sessionId,
				inputTokens: usage.inputTokens,
				outputTokens: usage.outputTokens,
				cacheReadInputTokens: usage.cacheReadInputTokens,
				cacheCreationInputTokens: usage.cacheCreationInputTokens,
				totalCostUsd: usage.totalCostUsd,
				contextWindow: usage.contextWindow,
				...(typeof usage.reasoningTokens === 'number'
					? { reasoningTokens: usage.reasoningTokens }
					: {}),
			},
		});
	});

	// Batch query / auto-run completion — timing + source (user|auto), no output.
	processManager.on('query-complete', (_sessionId: string, q: QueryCompleteData) => {
		emit({
			topic: 'run.completed',
			at: at(),
			payload: {
				sessionId: q.sessionId,
				agentType: q.agentType,
				source: q.source,
				durationMs: q.duration,
				...(q.projectPath ? { projectPath: q.projectPath } : {}),
				...(q.tabId ? { tabId: q.tabId } : {}),
			},
		});
	});
}
