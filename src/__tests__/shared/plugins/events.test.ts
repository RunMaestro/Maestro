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
});
