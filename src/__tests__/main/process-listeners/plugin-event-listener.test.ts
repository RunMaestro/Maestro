/**
 * @file plugin-event-listener.test.ts
 * @description The plugin event listener bridges ProcessManager lifecycle events
 * to the metadata-only plugin event bus. Asserts each topic emits the right
 * scalar payload, that no message body / raw / secret text leaks, and that it is
 * a no-op when no emitter is wired.
 */

import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { setupPluginEventListener } from '../../../main/process-listeners/plugin-event-listener';
import type { ProcessManager } from '../../../main/process-manager';
import type { PluginEvent } from '../../../shared/plugins/events';

function makePm(): ProcessManager & EventEmitter {
	return new EventEmitter() as unknown as ProcessManager & EventEmitter;
}

describe('setupPluginEventListener', () => {
	it('emits agent.exited with sessionId + exit code only', () => {
		const pm = makePm();
		const emit = vi.fn<(e: PluginEvent) => void>();
		setupPluginEventListener(pm, { emitPluginEvent: emit });

		pm.emit('exit', 's1', 0);

		expect(emit).toHaveBeenCalledTimes(1);
		const ev = emit.mock.calls[0][0];
		expect(ev.topic).toBe('agent.exited');
		expect(ev.payload).toEqual({ sessionId: 's1', exitCode: 0 });
		expect(typeof ev.at).toBe('string');
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
});
