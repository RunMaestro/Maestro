import { EventEmitter } from 'events';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { awaitSynopsisWriters } from '../synopsisWriterGate';

type FakeProcess = { sessionId: string; agentSessionId?: string };

function makeRegistry(initial: FakeProcess[]) {
	const processes = new Map(initial.map((p) => [p.sessionId, p]));
	const emitter = new EventEmitter();
	const exit = (sessionId: string) => {
		processes.delete(sessionId);
		emitter.emit('exit', sessionId, 0);
	};
	const registry = {
		getAll: vi.fn(() => Array.from(processes.values())),
		get: vi.fn((id: string) => processes.get(id)),
		kill: vi.fn((id: string) => {
			exit(id);
			return true;
		}),
		on: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
			emitter.on(event, fn);
			return registry;
		}),
		off: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
			emitter.off(event, fn);
			return registry;
		}),
	};
	return { registry, exit, emitter };
}

describe('awaitSynopsisWriters', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('returns at once when no synopsis holds the provider session', async () => {
		const { registry } = makeRegistry([
			{ sessionId: 'agent-1-ai-tab-1', agentSessionId: 'thread-a' },
			{ sessionId: 'agent-1-synopsis-123', agentSessionId: 'thread-b' },
		]);
		const result = await awaitSynopsisWriters(registry as never, 'thread-a');
		expect(result).toEqual({ waitedFor: [], killed: [], elapsedMs: 0 });
		expect(registry.on).not.toHaveBeenCalled();
	});

	it('waits for a synopsis resuming the same session to exit', async () => {
		const { registry, exit, emitter } = makeRegistry([
			{ sessionId: 'agent-1-synopsis-123', agentSessionId: 'thread-a' },
		]);
		let settled = false;
		const pending = awaitSynopsisWriters(registry as never, 'thread-a').then((r) => {
			settled = true;
			return r;
		});
		await vi.advanceTimersByTimeAsync(5_000);
		expect(settled).toBe(false);

		exit('agent-1-synopsis-123');
		const result = await pending;
		expect(result.waitedFor).toEqual(['agent-1-synopsis-123']);
		expect(result.killed).toEqual([]);
		expect(registry.kill).not.toHaveBeenCalled();
		expect(emitter.listenerCount('exit')).toBe(0);
	});

	it('kills a synopsis that outlives the wait', async () => {
		const { registry } = makeRegistry([
			{ sessionId: 'agent-1-synopsis-123', agentSessionId: 'thread-a' },
		]);
		const pending = awaitSynopsisWriters(registry as never, 'thread-a', {
			waitMs: 1_000,
			killGraceMs: 500,
		});
		await vi.advanceTimersByTimeAsync(1_000);
		const result = await pending;
		expect(registry.kill).toHaveBeenCalledWith('agent-1-synopsis-123');
		expect(result.killed).toEqual(['agent-1-synopsis-123']);
	});

	it('cancels a wait without killing the synopsis or retaining listeners', async () => {
		const { registry, emitter } = makeRegistry([
			{ sessionId: 'agent-1-synopsis-123', agentSessionId: 'thread-a' },
		]);
		const controller = new AbortController();
		const pending = awaitSynopsisWriters(registry as never, 'thread-a', {
			waitMs: 1_000,
			signal: controller.signal,
		}).then(
			() => null,
			(error: Error) => error
		);
		controller.abort();
		await vi.advanceTimersByTimeAsync(2_000);
		expect(await pending).toBeInstanceOf(Error);
		expect(registry.kill).not.toHaveBeenCalled();
		expect(emitter.listenerCount('exit')).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('does not wait on a non-synopsis process holding the session', async () => {
		const { registry } = makeRegistry([
			{ sessionId: 'agent-1-ai-tab-1', agentSessionId: 'thread-a' },
			{ sessionId: 'agent-1-batch-123', agentSessionId: 'thread-a' },
		]);
		const result = await awaitSynopsisWriters(registry as never, 'thread-a');
		expect(result.waitedFor).toEqual([]);
	});
});
