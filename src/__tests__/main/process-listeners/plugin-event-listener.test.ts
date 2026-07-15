/**
 * @file plugin-event-listener.test.ts
 * @description The plugin event listener bridges ProcessManager lifecycle events
 * to the metadata-only plugin event bus. Asserts each topic emits the right
 * scalar payload, that no message body / raw / secret text leaks, and that it is
 * a no-op when no emitter is wired. Includes the rich agent.completed terminal
 * event (FC4): shape, usage accumulation, provider session id, queue depth,
 * group-chat containment, and per-session state cleanup.
 */

import { describe, it, expect, vi, type Mock } from 'vitest';
import { EventEmitter } from 'events';
import { setupPluginEventListener } from '../../../main/process-listeners/plugin-event-listener';
import type { ProcessManager } from '../../../main/process-manager';
import type { ManagedProcess } from '../../../main/process-manager/types';
import type { CueEngine } from '../../../main/cue/cue-engine';
import type { PluginEvent, PluginEventPayloads } from '../../../shared/plugins/events';

/** EventEmitter standing in for the ProcessManager. `get` mirrors the real
 * manager: the exit event fires BEFORE the process is dropped, so the listener
 * may read the ManagedProcess snapshot during exit handling. */
function makePm(proc?: Partial<ManagedProcess>): ProcessManager & EventEmitter {
	const pm = new EventEmitter() as unknown as ProcessManager & EventEmitter;
	pm.get = (sessionId: string) => (proc ? ({ sessionId, ...proc } as ManagedProcess) : undefined);
	return pm;
}

function makeCueEngine(queueBySession: Record<string, number>): CueEngine {
	const status = new Map(Object.entries(queueBySession));
	return { getQueueStatus: () => status } as unknown as CueEngine;
}

/** The emit sink handed to the listener under test. */
type EmitMock = Mock<(e: PluginEvent) => void>;

/** Typed agent.completed payloads captured by an emit mock, in emit order.
 * Narrowing on the topic discriminant keeps property reads type-checked
 * without inline shape casts. */
function completedPayloads(emit: EmitMock): PluginEventPayloads['agent.completed'][] {
	const payloads: PluginEventPayloads['agent.completed'][] = [];
	for (const [event] of emit.mock.calls) {
		if (event.topic === 'agent.completed') {
			payloads.push((event as PluginEvent<'agent.completed'>).payload);
		}
	}
	return payloads;
}

/** Free-form content must never appear in any payload value. */
const SECRET_MARKER = /SECRET|stdout body|transcript text/;

describe('setupPluginEventListener', () => {
	it('emits agent.exited with sessionId + exit code only', () => {
		const pm = makePm();
		const emit = vi.fn<(e: PluginEvent) => void>();
		setupPluginEventListener(pm, { emitPluginEvent: emit });

		pm.emit('exit', 's1', 0);

		const exited = emit.mock.calls.map(([e]) => e).find((e) => e.topic === 'agent.exited');
		expect(exited).toBeDefined();
		expect(exited!.payload).toEqual({ sessionId: 's1', exitCode: 0 });
		expect(typeof exited!.at).toBe('string');
	});

	it('emits agent.error with type + recoverable, never the message/raw', () => {
		const pm = makePm();
		const emit = vi.fn<(e: PluginEvent) => void>();
		setupPluginEventListener(pm, { emitPluginEvent: emit });

		pm.emit('agent-error', 's2', {
			type: 'auth_expired',
			message: 'SECRET provider token text',
			recoverable: true,
			agentId: 'claude-code',
			timestamp: 1,
		});

		const ev = emit.mock.calls[0][0];
		expect(ev.topic).toBe('agent.error');
		expect(ev.payload).toEqual({
			sessionId: 's2',
			agentId: 'claude-code',
			errorType: 'auth_expired',
			recoverable: true,
		});
		expect(JSON.stringify(ev.payload)).not.toContain('SECRET');
	});

	it('emits usage.updated with counts only', () => {
		const pm = makePm();
		const emit = vi.fn<(e: PluginEvent) => void>();
		setupPluginEventListener(pm, { emitPluginEvent: emit });

		pm.emit('usage', 's3', {
			inputTokens: 10,
			outputTokens: 20,
			cacheReadInputTokens: 1,
			cacheCreationInputTokens: 2,
			totalCostUsd: 0.5,
			contextWindow: 200000,
		});

		const ev = emit.mock.calls[0][0];
		expect(ev.topic).toBe('usage.updated');
		expect(ev.payload).toMatchObject({
			sessionId: 's3',
			inputTokens: 10,
			outputTokens: 20,
			totalCostUsd: 0.5,
			contextWindow: 200000,
		});
	});

	it('emits run.completed with timing + source discriminator', () => {
		const pm = makePm();
		const emit = vi.fn<(e: PluginEvent) => void>();
		setupPluginEventListener(pm, { emitPluginEvent: emit });

		pm.emit('query-complete', 's4', {
			sessionId: 's4',
			agentType: 'claude-code',
			source: 'auto',
			startTime: 0,
			duration: 1234,
			projectPath: '/repo',
			tabId: 't1',
		});

		const ev = emit.mock.calls[0][0];
		expect(ev.topic).toBe('run.completed');
		expect(ev.payload).toEqual({
			sessionId: 's4',
			agentType: 'claude-code',
			source: 'auto',
			durationMs: 1234,
			projectPath: '/repo',
			tabId: 't1',
		});
	});

	it('is a no-op when no emitter is wired', () => {
		const pm = makePm();
		expect(() => setupPluginEventListener(pm, {})).not.toThrow();
		expect(() => pm.emit('exit', 's', 0)).not.toThrow();
	});

	describe('agent.completed (FC4 terminal event)', () => {
		it('emits beside agent.exited with minimal payload when no metadata is known', () => {
			const pm = makePm(); // get() returns undefined - process already gone
			const emit = vi.fn<(e: PluginEvent) => void>();
			setupPluginEventListener(pm, { emitPluginEvent: emit });

			pm.emit('exit', 's1', 0);

			expect(emit).toHaveBeenCalledTimes(2);
			expect(emit.mock.calls[0][0].topic).toBe('agent.exited');
			const completed = emit.mock.calls[1][0];
			expect(completed.topic).toBe('agent.completed');
			expect(completed.payload).toMatchObject({
				sessionId: 's1',
				status: 'completed',
				exitCode: 0,
			});
			expect(completed.payload).toMatchObject({ completedAt: expect.any(String) });
		});

		it('maps a non-zero exit code to status failed', () => {
			const pm = makePm();
			const emit = vi.fn<(e: PluginEvent) => void>();
			setupPluginEventListener(pm, { emitPluginEvent: emit });

			pm.emit('exit', 's1', 3);

			const completed = emit.mock.calls[1][0];
			expect(completed.payload).toMatchObject({ status: 'failed', exitCode: 3 });
		});

		it('carries process metadata (agentId/tabId/projectPath/source/timing) when the snapshot is readable', () => {
			const startTime = Date.now() - 5000;
			const pm = makePm({
				toolType: 'claude-code',
				tabId: 'tab-9',
				projectPath: '/repo',
				querySource: 'auto',
				startTime,
				// Content-bearing fields that must NEVER leak:
				streamedText: 'SECRET stdout body',
				stdoutBuffer: 'SECRET stdout body',
				stderrBuffer: 'SECRET stdout body',
				prompt: 'SECRET prompt',
			} as Partial<ManagedProcess>);
			const emit = vi.fn<(e: PluginEvent) => void>();
			setupPluginEventListener(pm, { emitPluginEvent: emit });

			pm.emit('exit', 's1', 0);

			const completed = emit.mock.calls[1][0];
			expect(completed.payload).toMatchObject({
				sessionId: 's1',
				status: 'completed',
				agentId: 'claude-code',
				tabId: 'tab-9',
				projectPath: '/repo',
				source: 'auto',
				startedAt: expect.any(String),
				durationMs: expect.any(Number),
			});
			expect(completedPayloads(emit)[0].durationMs).toBeGreaterThanOrEqual(5000);
			// Metadata only - no output/content field may survive.
			expect(JSON.stringify(completed.payload)).not.toMatch(SECRET_MARKER);
		});

		it('accumulates usage deltas across events into session token totals', () => {
			const pm = makePm({ toolType: 'codex' });
			const emit = vi.fn<(e: PluginEvent) => void>();
			setupPluginEventListener(pm, { emitPluginEvent: emit });

			const usage = (input: number, output: number, cost: number) => ({
				inputTokens: input,
				outputTokens: output,
				cacheReadInputTokens: 1,
				cacheCreationInputTokens: 2,
				totalCostUsd: cost,
				contextWindow: 200000,
				reasoningTokens: 5,
			});
			pm.emit('usage', 's1', usage(10, 20, 0.1));
			pm.emit('usage', 's1', usage(30, 40, 0.2));
			pm.emit('exit', 's1', 0);

			const completed = emit.mock.calls.map(([e]) => e).find((e) => e.topic === 'agent.completed');
			expect(completed!.payload).toMatchObject({
				inputTokens: 40,
				outputTokens: 60,
				cacheReadInputTokens: 2,
				cacheCreationInputTokens: 4,
				reasoningTokens: 10,
				totalTokens: 40 + 60 + 2 + 4,
				// usageIsCumulative undefined -> per-turn costs are summed
				costUsd: expect.closeTo(0.3, 10),
			});
		});

		it('uses the LAST reported cost (not the sum) for cumulative reporters', () => {
			const pm = makePm({ toolType: 'claude-code', usageIsCumulative: true });
			const emit = vi.fn<(e: PluginEvent) => void>();
			setupPluginEventListener(pm, { emitPluginEvent: emit });

			const usage = (cost: number) => ({
				inputTokens: 10,
				outputTokens: 10,
				cacheReadInputTokens: 0,
				cacheCreationInputTokens: 0,
				totalCostUsd: cost,
				contextWindow: 200000,
			});
			// Claude keeps a running cost total in every event: 0.1 then 0.3.
			pm.emit('usage', 's1', usage(0.1));
			pm.emit('usage', 's1', usage(0.3));
			pm.emit('exit', 's1', 0);

			expect(completedPayloads(emit)[0].costUsd).toBeCloseTo(0.3, 10);
		});

		it('carries the provider session id announced on the stream', () => {
			const pm = makePm();
			const emit = vi.fn<(e: PluginEvent) => void>();
			setupPluginEventListener(pm, { emitPluginEvent: emit });

			pm.emit('session-id', 's1', 'provider-abc');
			pm.emit('exit', 's1', 0);

			const completed = emit.mock.calls.map(([e]) => e).find((e) => e.topic === 'agent.completed');
			expect(completed!.payload).toMatchObject({ providerSessionId: 'provider-abc' });
		});

		it('carries the Cue queue depth for the session when Cue is enabled', () => {
			const pm = makePm();
			const emit = vi.fn<(e: PluginEvent) => void>();
			setupPluginEventListener(pm, {
				emitPluginEvent: emit,
				isCueEnabled: () => true,
				getCueEngine: () => makeCueEngine({ s1: 3 }),
			});

			pm.emit('exit', 's1', 1);

			const completed = emit.mock.calls.map(([e]) => e).find((e) => e.topic === 'agent.completed');
			expect(completed!.payload).toMatchObject({ queueDepth: 3 });
		});

		it('omits queueDepth when Cue is disabled', () => {
			const pm = makePm();
			const emit = vi.fn<(e: PluginEvent) => void>();
			setupPluginEventListener(pm, {
				emitPluginEvent: emit,
				isCueEnabled: () => false,
				getCueEngine: () => makeCueEngine({ s1: 3 }),
			});

			pm.emit('exit', 's1', 0);

			const completed = emit.mock.calls.map(([e]) => e).find((e) => e.topic === 'agent.completed');
			expect(completed!.payload).not.toHaveProperty('queueDepth');
		});

		it('does NOT emit agent.completed for group-chat sessions (containment), but still emits agent.exited', () => {
			const pm = makePm();
			const emit = vi.fn<(e: PluginEvent) => void>();
			setupPluginEventListener(pm, { emitPluginEvent: emit });

			pm.emit('exit', 'group-chat-123-participant-a', 0);

			const topics = emit.mock.calls.map(([e]) => e.topic);
			expect(topics).toContain('agent.exited');
			expect(topics).not.toContain('agent.completed');
		});

		it('clears accumulated usage + provider session id after exit (no bleed into a later run)', () => {
			const pm = makePm();
			const emit = vi.fn<(e: PluginEvent) => void>();
			setupPluginEventListener(pm, { emitPluginEvent: emit });

			pm.emit('session-id', 's1', 'provider-abc');
			pm.emit('usage', 's1', {
				inputTokens: 10,
				outputTokens: 20,
				cacheReadInputTokens: 0,
				cacheCreationInputTokens: 0,
				totalCostUsd: 0.1,
				contextWindow: 200000,
			});
			pm.emit('exit', 's1', 0);
			emit.mockClear();

			// Same session id spawns again and exits without usage/session-id.
			pm.emit('exit', 's1', 0);

			const completed = emit.mock.calls.map(([e]) => e).find((e) => e.topic === 'agent.completed');
			expect(completed!.payload).not.toHaveProperty('inputTokens');
			expect(completed!.payload).not.toHaveProperty('totalTokens');
			expect(completed!.payload).not.toHaveProperty('costUsd');
			expect(completed!.payload).not.toHaveProperty('providerSessionId');
		});

		it('never leaks lineage it does not have: chain fields absent on the non-Cue exit path', () => {
			const pm = makePm({ toolType: 'claude-code' });
			const emit = vi.fn<(e: PluginEvent) => void>();
			setupPluginEventListener(pm, { emitPluginEvent: emit });

			pm.emit('exit', 's1', 0);

			const completed = emit.mock.calls.map(([e]) => e).find((e) => e.topic === 'agent.completed');
			for (const field of ['runId', 'parentRunId', 'chainRootId', 'parentEventId', 'pipelineId']) {
				expect(completed!.payload).not.toHaveProperty(field);
			}
		});
	});
});
