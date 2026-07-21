/**
 * @file events.test.ts
 * @description The host->plugin event catalog is a fixed, metadata-only set.
 */

import { describe, it, expect } from 'vitest';
import {
	isPluginEventTopic,
	PLUGIN_EVENT_TOPICS,
	type PluginEventPayloads,
} from '../../../shared/plugins/events';

describe('plugin event topics', () => {
	it('recognizes exactly the catalog topics', () => {
		for (const t of PLUGIN_EVENT_TOPICS) expect(isPluginEventTopic(t)).toBe(true);
		expect(isPluginEventTopic('')).toBe(false);
		expect(isPluginEventTopic(42)).toBe(false);
		expect(isPluginEventTopic('not.a.topic')).toBe(false);
	});

	it('catalog carries NO raw-content topic (metadata-only guarantee)', () => {
		// A plugin must never receive message bodies / agent output over the bus.
		expect(PLUGIN_EVENT_TOPICS).not.toContain('agent.output');
		expect(PLUGIN_EVENT_TOPICS).not.toContain('session.message');
		expect(PLUGIN_EVENT_TOPICS).not.toContain('transcript.appended');
	});

	it('agent.completed payload supports rich metadata without raw output', () => {
		const completed: PluginEventPayloads['agent.completed'] = {
			sessionId: 's1',
			agentId: 'claude',
			tabId: 's1',
			status: 'completed',
			providerSessionId: 'provider-session-1',
			queueDepth: 2,
			inputTokens: 100,
			outputTokens: 25,
			cacheReadInputTokens: 10,
			cacheCreationInputTokens: 5,
			reasoningTokens: 3,
			totalTokens: 143,
			runId: 'run-1',
			parentRunId: 'run-0',
			chainRootId: 'root-1',
			parentEventId: 'event-0',
			pipelineId: 'pipe-1',
			pipelineName: 'Review',
			lineageDepth: 3,
		};

		expect(completed.providerSessionId).toBe('provider-session-1');
		expect(completed.queueDepth).toBe(2);
		expect(completed.totalTokens).toBe(143);
		expect(completed.chainRootId).toBe('root-1');
	});

	it('carries the four board topics', () => {
		expect(PLUGIN_EVENT_TOPICS).toContain('board.cardStatusChanged');
		expect(PLUGIN_EVENT_TOPICS).toContain('board.cardCompleted');
		expect(PLUGIN_EVENT_TOPICS).toContain('board.cardBlocked');
		expect(PLUGIN_EVENT_TOPICS).toContain('board.decomposed');
		for (const t of ['board.cardStatusChanged', 'board.decomposed']) {
			expect(isPluginEventTopic(t)).toBe(true);
		}
		// A near-miss must not sneak through the guard.
		expect(isPluginEventTopic('board.cardOutput')).toBe(false);
	});

	it('board payloads are metadata only (ids, statuses, counts)', () => {
		const changed: PluginEventPayloads['board.cardStatusChanged'] = {
			boardId: 'b1',
			cardId: 'c1',
			cardTitle: 'Ship the parser',
			fromStatus: 'ready',
			toStatus: 'running',
			attempt: 1,
			workerAgentId: 'worker-7',
			projectPath: '/repo',
		};
		const blocked: PluginEventPayloads['board.cardBlocked'] = {
			boardId: 'b1',
			cardId: 'c1',
			cardTitle: 'Ship the parser',
			outcome: 'error',
		};
		const decomposed: PluginEventPayloads['board.decomposed'] = {
			boardId: 'b1',
			triageCardCount: 3,
		};

		expect(changed.toStatus).toBe('running');
		// Classification, never the free-form block reason (which quotes output).
		expect(blocked.outcome).toBe('error');
		expect(decomposed.triageCardCount).toBe(3);
		// No key on any board payload may carry generated prose.
		for (const payload of [changed, blocked, decomposed] as Record<string, unknown>[]) {
			for (const key of Object.keys(payload)) {
				expect(['summary', 'output', 'prompt', 'body', 'reason']).not.toContain(key);
			}
		}
	});
});
