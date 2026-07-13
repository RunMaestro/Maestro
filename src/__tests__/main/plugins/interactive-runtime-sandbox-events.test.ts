import { describe, expect, it, vi } from 'vitest';

import {
	InteractiveRuntimeSandboxEventForwarder,
	type InteractiveRuntimeEventDto,
} from '../../../main/plugins/interactive-runtime-sandbox-events';
import type {
	InteractiveRuntimeHandle,
	RuntimeEvent,
	RuntimeMessage,
} from '../../../shared/plugins/interactive-runtime';

interface FakeHandle extends InteractiveRuntimeHandle {
	emit(event: RuntimeEvent): void;
	emitMessage(message: RuntimeMessage): void;
	listenerCount(): number;
	messageListenerCount(): number;
}

function makeHandle(runtimeId: string, generation: bigint): FakeHandle {
	const listeners = new Set<(event: RuntimeEvent) => void>();
	const messageListeners = new Set<(message: RuntimeMessage) => void>();
	return {
		runtimeId: runtimeId as FakeHandle['runtimeId'],
		generation,
		writeCanonicalJson: async () => undefined,
		onEvent: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		onMessage: (listener) => {
			messageListeners.add(listener);
			return () => messageListeners.delete(listener);
		},
		stop: async () => undefined,
		emit: (event) => {
			for (const listener of listeners) listener(event);
		},
		emitMessage: (message) => {
			for (const listener of messageListeners) listener(message);
		},
		listenerCount: () => listeners.size,
		messageListenerCount: () => messageListeners.size,
	};
}

describe('InteractiveRuntimeSandboxEventForwarder', () => {
	it('delivers typed ready, state-error, and exit events only to the owning sandbox generation', () => {
		const sink = { pushEvent: vi.fn(() => true) };
		const forwarder = new InteractiveRuntimeSandboxEventForwarder(sink);
		const handle = makeHandle('runtime-a', 7n);
		forwarder.attach('com.maestro.omp', 7n, handle);

		handle.emit({ kind: 'started', sequence: 1n });
		handle.emit({ kind: 'safe_error', sequence: 2n, class: 'runtime_stopped' });
		handle.emit({ kind: 'exit', sequence: 3n, code: 17 });

		expect(sink.pushEvent).toHaveBeenCalledTimes(3);
		expect(sink.pushEvent).toHaveBeenNthCalledWith(
			1,
			'com.maestro.omp',
			expect.objectContaining({
				topic: '__interactiveRuntimeEvent:runtime-a',
				payload: {
					runtimeId: 'runtime-a',
					generation: '7',
					event: { kind: 'started', sequence: '1' },
				} satisfies InteractiveRuntimeEventDto,
			})
		);
		expect(sink.pushEvent).toHaveBeenNthCalledWith(
			2,
			'com.maestro.omp',
			expect.objectContaining({
				payload: {
					runtimeId: 'runtime-a',
					generation: '7',
					event: { kind: 'safe_error', sequence: '2', class: 'runtime_stopped' },
				},
			})
		);
		expect(sink.pushEvent).toHaveBeenNthCalledWith(
			3,
			'com.maestro.omp',
			expect.objectContaining({
				payload: {
					runtimeId: 'runtime-a',
					generation: '7',
					event: { kind: 'exit', sequence: '3', code: 17 },
				},
			})
		);
	});

	it('delivers bounded stdout messages only to the current owner and generation', () => {
		const sink = { pushEvent: vi.fn(() => true) };
		const forwarder = new InteractiveRuntimeSandboxEventForwarder(sink);
		const handle = makeHandle('runtime-message', 8n);
		forwarder.attach('com.maestro.omp', 8n, handle);

		handle.emitMessage({ sequence: 1, value: { response: 'ok' } });

		expect(sink.pushEvent).toHaveBeenCalledWith(
			'com.maestro.omp',
			expect.objectContaining({
				topic: '__interactiveRuntimeMessage:runtime-message',
				payload: {
					runtimeId: 'runtime-message',
					generation: '8',
					message: { sequence: 1, value: { response: 'ok' } },
				},
			})
		);
	});

	it('isolates a replacement owner and generation from late events from its replaced handle', () => {
		const sink = { pushEvent: vi.fn(() => true) };
		const forwarder = new InteractiveRuntimeSandboxEventForwarder(sink);
		const stale = makeHandle('shared-runtime', 1n);
		const current = makeHandle('shared-runtime', 2n);
		forwarder.attach('owner-a', 1n, stale);
		forwarder.attach('owner-b', 2n, current);

		stale.emit({ kind: 'exit', sequence: 1n, code: null });
		current.emit({ kind: 'started', sequence: 1n });

		expect(stale.listenerCount()).toBe(0);
		expect(sink.pushEvent).toHaveBeenCalledTimes(1);
		expect(sink.pushEvent).toHaveBeenCalledWith(
			'owner-b',
			expect.objectContaining({
				payload: expect.objectContaining({ generation: '2' }),
			})
		);
	});

	it('unsubscribes before stop or owner revoke so late events cannot reach a stopped sandbox', () => {
		const sink = { pushEvent: vi.fn(() => true) };
		const forwarder = new InteractiveRuntimeSandboxEventForwarder(sink);
		const omp = makeHandle('omp-runtime', 4n);
		const other = makeHandle('other-runtime', 1n);
		forwarder.attach('com.maestro.omp', 4n, omp);
		forwarder.attach('other-plugin', 1n, other);

		expect(forwarder.detach('com.maestro.omp', 'omp-runtime', 4n)).toBe(omp);
		omp.emit({ kind: 'exit', sequence: 2n, code: null });
		forwarder.revokeOwner('other-plugin');
		other.emit({ kind: 'exit', sequence: 2n, code: null });

		expect(omp.listenerCount()).toBe(0);
		expect(omp.messageListenerCount()).toBe(0);
		expect(other.listenerCount()).toBe(0);
		expect(other.messageListenerCount()).toBe(0);
		expect(sink.pushEvent).not.toHaveBeenCalled();
	});

	it('does not let a sandbox transport failure escape a runtime event callback', () => {
		const sink = {
			pushEvent: vi.fn(() => {
				throw new Error('child gone');
			}),
		};
		const forwarder = new InteractiveRuntimeSandboxEventForwarder(sink);
		const handle = makeHandle('runtime-a', 7n);
		forwarder.attach('com.maestro.omp', 7n, handle);

		expect(() => handle.emit({ kind: 'started', sequence: 1n })).not.toThrow();
		expect(sink.pushEvent).toHaveBeenCalledTimes(1);
	});
});
