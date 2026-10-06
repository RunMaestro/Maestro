/**
 * @file plugin-session-events.test.ts
 * @description The session-store -> plugin lifecycle differ produces
 * metadata-only events (session.created / removed, agent.statusChanged /
 * awaiting) and NEVER leaks transcript text, prompt text, agent output, file
 * contents, or secrets - the inviolable events.ts contract.
 */

import { describe, it, expect } from 'vitest';
import {
	buildSessionLifecycleEvents,
	type SessionLifecycleSnapshot,
} from '../../../main/ipc/handlers/plugin-session-events';
import { isPluginEventTopic } from '../../../shared/plugins/events';
import type { PluginEvent, PluginEventPayloads } from '../../../shared/plugins/events';

const AT = '2026-06-27T00:00:00.000Z';

function mapOf(...sessions: SessionLifecycleSnapshot[]): Map<string, SessionLifecycleSnapshot> {
	return new Map(sessions.map((s) => [s.id, s]));
}

/** Keys that would prove a payload carries free-form content. None may appear. */
const FORBIDDEN_KEY = /prompt|transcript|message|body|content|output|secret|token|text|stdout/i;
const ALLOWED_COUNTER_KEY = new Set([
	'inputTokens',
	'outputTokens',
	'cacheReadInputTokens',
	'cacheCreationInputTokens',
	'reasoningTokens',
	'totalTokens',
]);

function assertMetadataOnly(events: PluginEvent[]): void {
	for (const event of events) {
		expect(isPluginEventTopic(event.topic)).toBe(true);
		for (const key of Object.keys(event.payload as Record<string, unknown>)) {
			const value = (event.payload as Record<string, unknown>)[key];
			if (ALLOWED_COUNTER_KEY.has(key)) {
				expect(typeof value).toBe('number');
				continue;
			}
			expect(key).not.toMatch(FORBIDDEN_KEY);
			// Every surviving value is primitive metadata: ids/labels/statuses/counters,
			// never nested free-form bodies.
			expect(['string', 'number', 'boolean']).toContain(typeof value);
		}
	}
}

describe('buildSessionLifecycleEvents', () => {
	it('emits session.created with id/title/agentId/projectPath for a new session', () => {
		const events = buildSessionLifecycleEvents(
			mapOf(),
			[{ id: 's1', name: 'Tab One', toolType: 'claude', cwd: '/home/u/proj', state: 'idle' }],
			AT
		);
		expect(events).toEqual([
			{
				topic: 'session.created',
				at: AT,
				payload: {
					sessionId: 's1',
					title: 'Tab One',
					agentId: 'claude',
					projectPath: '/home/u/proj',
				},
			},
		]);
		assertMetadataOnly(events);
	});

	it('omits optional created fields that are absent', () => {
		const events = buildSessionLifecycleEvents(mapOf(), [{ id: 's2' }], AT);
		expect(events).toEqual([{ topic: 'session.created', at: AT, payload: { sessionId: 's2' } }]);
	});

	it('emits session.removed for a session that disappeared', () => {
		const prev = mapOf({ id: 's1', name: 'Gone', toolType: 'codex', cwd: '/x' });
		const events = buildSessionLifecycleEvents(prev, [], AT);
		expect(events).toEqual([{ topic: 'session.removed', at: AT, payload: { sessionId: 's1' } }]);
	});

	it('emits agent.statusChanged only when the run state string flips', () => {
		const prev = mapOf({ id: 's1', toolType: 'claude', state: 'idle' });
		const unchanged = buildSessionLifecycleEvents(
			prev,
			[{ id: 's1', toolType: 'claude', state: 'idle' }],
			AT
		);
		expect(unchanged).toEqual([]);

		const flipped = buildSessionLifecycleEvents(
			prev,
			[{ id: 's1', toolType: 'claude', state: 'busy' }],
			AT
		);
		expect(flipped).toEqual([
			{
				topic: 'agent.statusChanged',
				at: AT,
				payload: { agentId: 'claude', tabId: 's1', status: 'busy' },
			},
		]);
		assertMetadataOnly(flipped);
	});

	it('additionally emits agent.awaiting when state flips to waiting_input', () => {
		const prev = mapOf({ id: 's1', toolType: 'claude', state: 'busy' });
		const events = buildSessionLifecycleEvents(
			prev,
			[{ id: 's1', toolType: 'claude', state: 'waiting_input' }],
			AT
		);
		expect(events).toEqual([
			{
				topic: 'agent.statusChanged',
				at: AT,
				payload: { agentId: 'claude', tabId: 's1', status: 'waiting_input' },
			},
			{ topic: 'agent.awaiting', at: AT, payload: { agentId: 'claude', tabId: 's1' } },
		]);
		assertMetadataOnly(events);
	});

	it('falls back to the session id for agentId when toolType is absent', () => {
		const prev = mapOf({ id: 's1', state: 'idle' });
		const events = buildSessionLifecycleEvents(prev, [{ id: 's1', state: 'busy' }], AT);
		expect(events[0].payload).toEqual({ agentId: 's1', tabId: 's1', status: 'busy' });
	});

	it('handles a mixed batch (create + remove + status flip) keyed by one timestamp', () => {
		const prev = mapOf(
			{ id: 'keep', toolType: 'claude', state: 'idle' },
			{ id: 'drop', toolType: 'codex', state: 'idle' }
		);
		const events = buildSessionLifecycleEvents(
			prev,
			[
				{ id: 'keep', toolType: 'claude', state: 'busy' },
				{ id: 'new', name: 'Fresh', toolType: 'claude', cwd: '/p' },
			],
			AT
		);
		const topics = events.map((e) => e.topic).sort();
		expect(topics).toEqual(['agent.statusChanged', 'session.created', 'session.removed']);
		for (const e of events) expect(e.at).toBe(AT);
		assertMetadataOnly(events);
	});

	it('ignores entries without a string id', () => {
		const events = buildSessionLifecycleEvents(
			mapOf(),
			[{ id: undefined as unknown as string }, { id: 'ok' }],
			AT
		);
		expect(events).toEqual([{ topic: 'session.created', at: AT, payload: { sessionId: 'ok' } }]);
	});
});

describe('PluginEventPayloads metadata-only contract', () => {
	it('typed payloads compile and carry ids/labels/status only', () => {
		// A compile-time fixture: each constructed value is checked against the
		// canonical PluginEventPayloads shape. If the contract gained a content
		// field this object would either fail to compile or trip the key guard.
		const created: PluginEventPayloads['session.created'] = {
			sessionId: 's1',
			title: 'Tab',
			agentId: 'claude',
			projectPath: '/p',
		};
		const removed: PluginEventPayloads['session.removed'] = { sessionId: 's1' };
		const status: PluginEventPayloads['agent.statusChanged'] = {
			agentId: 'claude',
			tabId: 's1',
			status: 'busy',
		};
		const awaiting: PluginEventPayloads['agent.awaiting'] = { agentId: 'claude', tabId: 's1' };
		const cue: PluginEventPayloads['cue.fired'] = { cueType: 'file.changed' };
		const history: PluginEventPayloads['history.entryAdded'] = {
			entryId: 'h1',
			sessionId: 's1',
			agentId: 'claude',
			projectPath: '/p',
			kind: 'agent',
			source: 'auto',
			createdAt: AT,
		};
		const completed: PluginEventPayloads['agent.completed'] = {
			sessionId: 's1',
			agentId: 'claude',
			tabId: 's1',
			status: 'completed',
			durationMs: 1200,
			projectPath: '/p',
			source: 'auto',
			startedAt: AT,
			completedAt: AT,
			costUsd: 0.01,
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
		const events: PluginEvent[] = [
			{ topic: 'session.created', at: AT, payload: created },
			{ topic: 'session.removed', at: AT, payload: removed },
			{ topic: 'agent.statusChanged', at: AT, payload: status },
			{ topic: 'agent.awaiting', at: AT, payload: awaiting },
			{ topic: 'cue.fired', at: AT, payload: cue },
			{ topic: 'history.entryAdded', at: AT, payload: history },
			{ topic: 'agent.completed', at: AT, payload: completed },
		];
		assertMetadataOnly(events);
	});
});
