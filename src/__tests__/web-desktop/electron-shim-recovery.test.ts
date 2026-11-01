import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class Socket {
	static CONNECTING = 0;
	static OPEN = 1;
	static instances: Socket[] = [];
	readyState = 0;
	sent: Array<Record<string, any>> = [];
	listeners = new Map<string, Set<(event: any) => void>>();
	constructor(readonly url: string) {
		Socket.instances.push(this);
	}
	addEventListener(type: string, listener: (event: any) => void) {
		if (!this.listeners.has(type)) this.listeners.set(type, new Set());
		this.listeners.get(type)!.add(listener);
	}
	send(data: string) {
		this.sent.push(JSON.parse(data));
	}
	close() {
		this.readyState = 3;
		this.emit('close', {});
	}
	emit(type: string, event: any) {
		for (const listener of this.listeners.get(type) ?? []) listener(event);
	}
	frame(packet: object) {
		this.emit('message', { data: JSON.stringify(packet) });
	}
	open() {
		this.readyState = 1;
		this.emit('open', {});
		this.frame({ type: 'connected', bridgeEpoch: 'run', bridgeSeq: 0 });
	}
}
const recoveryHandlers: Array<(event: Event) => void> = [];
function duringRecovery(work: () => Promise<void>) {
	const listener = (event: Event) => {
		const detail = (event as CustomEvent).detail;
		if (detail?.authoritative) detail.waitUntil(work());
	};
	recoveryHandlers.push(listener);
	window.addEventListener('maestro:webBridgeReconcile', listener);
}
const originalLocation = window.location;
const originalAddEventListener = window.addEventListener;
const windowListeners: Array<{
	type: string;
	listener: EventListenerOrEventListenerObject;
	options?: boolean | AddEventListenerOptions;
}> = [];
beforeEach(() => {
	vi.resetModules();
	vi.useFakeTimers();
	Socket.instances = [];
	vi.stubGlobal('WebSocket', Socket);
	Object.defineProperty(window, 'location', {
		configurable: true,
		value: { ...originalLocation, reload: vi.fn() },
	});
	vi.spyOn(window, 'addEventListener').mockImplementation((type, listener, options) => {
		windowListeners.push({ type, listener, options });
		originalAddEventListener.call(window, type, listener, options);
	});
	sessionStorage.clear();
	document.body.replaceChildren();
});
afterEach(() => {
	for (const listener of recoveryHandlers.splice(0))
		window.removeEventListener('maestro:webBridgeReconcile', listener);
	for (const { type, listener, options } of windowListeners.splice(0))
		window.removeEventListener(type, listener, options);
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
});

async function aliveFor(socket: Socket, milliseconds: number) {
	for (let elapsed = 0; elapsed < milliseconds; ) {
		const step = Math.min(1000, milliseconds - elapsed);
		await vi.advanceTimersByTimeAsync(step);
		socket.frame({ type: 'pong' });
		elapsed += step;
	}
}

describe('bounded bridge requests and failed application recovery', () => {
	it('retries recovery before its owner is mounted without an unhandled abort rejection', async () => {
		await import('../../web-desktop/electron-shim');
		vi.spyOn(Math, 'random').mockReturnValue(0);
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const first = Socket.instances.at(-1)!;
		first.open();
		first.close();
		await vi.advanceTimersByTimeAsync(1000);
		const second = Socket.instances.at(-1)!;
		second.open();
		await vi.advanceTimersByTimeAsync(0);
		expect((window as any).__MAESTRO_BRIDGE_STATE__).toBe('reconnecting');
		// Mount the real recovery participant after the failed initial attempt.
		duringRecovery(async () => {});
		await aliveFor(second, 1001);
		expect((window as any).__MAESTRO_BRIDGE_STATE__).toBe('connected');
	});

	it('types unsent reconnect requests separately from uncertain submitted mutations', async () => {
		const { ipcRenderer } = await import('../../web-desktop/electron-shim');
		const first = Socket.instances.at(-1)!;
		first.open();
		const submitted = ipcRenderer.invoke('process:spawn', {});
		const uncertain = expect(submitted).rejects.toMatchObject({
			name: 'BridgeTransportError',
			code: 'BRIDGE_SUBMISSION_UNCERTAIN',
			submission: 'unknown',
		});
		first.close();
		await uncertain;
		await expect(ipcRenderer.invoke('sessions:getBootstrap')).rejects.toMatchObject({
			name: 'BridgeTransportError',
			code: 'BRIDGE_RECONNECTING',
			submission: 'not-sent',
		});
	});

	it('keeps offline debug local and deduplicates real warnings at their original level', async () => {
		const { ipcRenderer } = await import('../../web-desktop/electron-shim');
		const { BridgeTransportError } = await import('../../shared/bridgeError');
		const first = Socket.instances.at(-1)!;
		first.open();
		first.close();
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		for (let i = 0; i < 50; i++) {
			await ipcRenderer.invoke('logger:log', 'debug', 'refresh tick', 'Files');
			await ipcRenderer.invoke(
				'logger:log',
				'warn',
				'read paused',
				'Files',
				new BridgeTransportError('restoring', 'BRIDGE_RESTORING')
			);
			await ipcRenderer.invoke('logger:log', 'error', 'real filesystem failure', 'Files');
		}
		expect(warn).not.toHaveBeenCalled();
		expect(error).toHaveBeenCalledTimes(1);
		expect(error.mock.calls[0]).toContain('real filesystem failure');
		expect(first.sent.filter((packet) => packet.channel === 'logger:log')).toEqual([]);
	});

	it('does not spin or repeatedly warn for the same recoverable restoration failure', async () => {
		await import('../../web-desktop/electron-shim');
		const { BridgeTransportError } = await import('../../shared/bridgeError');
		vi.spyOn(Math, 'random').mockReturnValue(0);
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const first = Socket.instances.at(-1)!;
		first.open();
		let attempts = 0;
		duringRecovery(async () => {
			attempts++;
			throw new BridgeTransportError(
				'owner snapshot unavailable',
				'BRIDGE_RECOVERY_PENDING',
				'read-only'
			);
		});
		first.close();
		await vi.advanceTimersByTimeAsync(1000);
		const second = Socket.instances.at(-1)!;
		second.open();
		await aliveFor(second, 5000);
		expect(attempts).toBeLessThanOrEqual(6);
		expect(warn.mock.calls.filter((args) => String(args[0]).includes('In-place'))).toHaveLength(1);
	});

	it('cancels reads from an expired recovery attempt before starting its retry', async () => {
		const { ipcRenderer } = await import('../../web-desktop/electron-shim');
		vi.spyOn(Math, 'random').mockReturnValue(0);
		const first = Socket.instances.at(-1)!;
		first.open();
		let pendingRead!: Promise<unknown>;
		let attempts = 0;
		duringRecovery(async () => {
			if (++attempts === 1) {
				// Long read proves cancellation is tied to the recovery budget, not its own timeout.
				pendingRead = ipcRenderer.invoke('fs:directorySize', '/repo');
				await pendingRead;
			}
		});
		first.close();
		await vi.advanceTimersByTimeAsync(1000);
		const second = Socket.instances.at(-1)!;
		second.open();
		const rejected = expect(pendingRead).rejects.toMatchObject({ code: 'BRIDGE_RECOVERY_PENDING' });
		await aliveFor(second, 31001);
		await rejected;
		expect((window as any).__MAESTRO_BRIDGE_STATE__).toBe('connected');
	});

	it('starts a fresh recovery before an old controller settles and ignores its stale work', async () => {
		const { ipcRenderer } = await import('../../web-desktop/electron-shim');
		vi.spyOn(Math, 'random').mockReturnValue(0);
		const first = Socket.instances.at(-1)!;
		first.open();
		const finish: Array<() => void> = [];
		duringRecovery(() => new Promise<void>((resolve) => finish.push(resolve)));
		first.close();
		await vi.advanceTimersByTimeAsync(1000);
		const second = Socket.instances.at(-1)!;
		second.open();
		expect(finish).toHaveLength(1);
		second.close();
		// Deliberately do not flush promise reactions: the retired controller's
		// finally block has not run when the new socket receives its handshake.
		vi.advanceTimersByTime(1000);
		const third = Socket.instances.at(-1)!;
		third.open();
		expect(finish).toHaveLength(2);
		finish[0]();
		await vi.advanceTimersByTimeAsync(0);
		await expect(ipcRenderer.invoke('process:spawn', {})).rejects.toMatchObject({
			code: 'BRIDGE_RESTORING',
		});
		finish[1]();
		await vi.advanceTimersByTimeAsync(0);
		expect((window as any).__MAESTRO_BRIDGE_STATE__).toBe('connected');
		await aliveFor(third, 3000);
		expect(finish).toHaveLength(2);
		expect(Socket.instances).toHaveLength(3);
	});

	it('allows recovery reads while fencing mutations and preserves optional reads after success', async () => {
		const { ipcRenderer } = await import('../../web-desktop/electron-shim');
		const first = Socket.instances.at(-1)!;
		first.open();
		let optional!: Promise<unknown>;
		duringRecovery(async () => {
			await Promise.all(
				[
					'sessions:getBootstrap',
					'groups:getAll',
					'settings:getAll',
					'logger:getLogLevel',
					'web:getAutoRunStates',
				].map((channel) => ipcRenderer.invoke(channel))
			);
			optional = ipcRenderer.invoke('groupChat:list');
		});
		first.close();
		await vi.advanceTimersByTimeAsync(1000);
		const second = Socket.instances.at(-1)!;
		second.open();
		await expect(ipcRenderer.invoke('sessions:setMany', [])).rejects.toMatchObject({
			code: 'BRIDGE_RESTORING',
		});
		for (const packet of second.sent.filter((p) => p.type === 'bridge.invoke'))
			second.frame({ type: 'bridge.response', requestId: packet.requestId, ok: true, result: [] });
		await vi.advanceTimersByTimeAsync(0);
		expect((window as any).__MAESTRO_BRIDGE_STATE__).toBe('connected');
		const packet = second.sent.find((p) => p.channel === 'groupChat:list')!;
		second.frame({
			type: 'bridge.response',
			requestId: packet.requestId,
			ok: true,
			result: ['chat'],
		});
		await expect(optional).resolves.toEqual(['chat']);
	});

	it('recovers a missed replay without remounting the active workflow or replaying its action', async () => {
		const { ipcRenderer } = await import('../../web-desktop/electron-shim');
		const first = Socket.instances.at(-1)!;
		first.open();
		const editor = document.createElement('textarea');
		editor.value = 'unfinished workflow';
		document.body.append(editor);
		let finish!: () => void;
		const reconcile = vi.fn((event: Event) => {
			const detail = (event as CustomEvent).detail;
			if (detail?.authoritative)
				detail.waitUntil(
					new Promise<void>((resolve) => {
						finish = resolve;
					})
				);
		});
		window.addEventListener('maestro:webBridgeReconcile', reconcile);
		try {
			first.close();
			await vi.advanceTimersByTimeAsync(1000);
			const second = Socket.instances.at(-1)!;
			second.open();
			expect(reconcile).toHaveBeenCalled();
			expect(window.location.reload).not.toHaveBeenCalled();
			await expect(ipcRenderer.invoke('process:spawn', {})).rejects.toThrow(/recover|restor/i);
			const read = ipcRenderer.invoke('sessions:getBootstrap');
			await Promise.resolve();
			const packet = second.sent.at(-1)!;
			second.frame({ type: 'bridge.response', requestId: packet.requestId, ok: true, result: [] });
			await expect(read).resolves.toEqual([]);
			finish();
			await vi.advanceTimersByTimeAsync(0);
			expect((window as any).__MAESTRO_BRIDGE_STATE__).toBe('connected');
			expect(document.body.contains(editor)).toBe(true);
			expect(editor.value).toBe('unfinished workflow');
			expect(second.sent.filter((p) => p.channel === 'process:spawn')).toEqual([]);
		} finally {
			window.removeEventListener('maestro:webBridgeReconcile', reconcile);
		}
	});
	it('bounds initial readiness without later delivering the unsent request', async () => {
		const { ipcRenderer } = await import('../../web-desktop/electron-shim');
		const socket = Socket.instances.at(-1)!;
		const result = expect(ipcRenderer.invoke('sessions:getBootstrap')).rejects.toThrow(
			/connection.*timed out/i
		);
		await vi.advanceTimersByTimeAsync(30001);
		await result;
		socket.open();
		await Promise.resolve();
		expect(socket.sent.filter((packet) => packet.type === 'bridge.invoke')).toEqual([]);
	});

	it('times out an unanswered read despite healthy heartbeats and permits a fresh read', async () => {
		const { ipcRenderer } = await import('../../web-desktop/electron-shim');
		const socket = Socket.instances.at(-1)!;
		socket.open();
		const result = expect(ipcRenderer.invoke('sessions:getBootstrap')).rejects.toThrow(
			/timed out/i
		);
		await aliveFor(socket, 30001);
		await result;
		expect((window as any).__MAESTRO_BRIDGE_STATE__).toBe('connected');
		const next = ipcRenderer.invoke('groups:getAll');
		await Promise.resolve();
		const request = socket.sent.at(-1)!;
		socket.frame({ type: 'bridge.response', requestId: request.requestId, ok: true, result: [] });
		await expect(next).resolves.toEqual([]);
		expect(document.getElementById('maestro-submission-notice')).toBeNull();
	});

	it('reports mutation timeout as ambiguous, without resubmitting or killing a healthy connection', async () => {
		const { ipcRenderer } = await import('../../web-desktop/electron-shim');
		const socket = Socket.instances.at(-1)!;
		socket.open();
		const result = expect(ipcRenderer.invoke('process:spawn', { sessionId: 's' })).rejects.toThrow(
			/Submission uncertainty/
		);
		await aliveFor(socket, 120001);
		await result;
		expect(socket.sent.filter((packet) => packet.channel === 'process:spawn')).toHaveLength(1);
		expect((window as any).__MAESTRO_BRIDGE_STATE__).toBe('connected');
		expect(document.getElementById('maestro-submission-notice')?.textContent).toContain(
			'not automatically retried'
		);
	});

	it('resolves a lost save acknowledgement from a snapshot, never replaying the save', async () => {
		const { ipcRenderer } = await import('../../web-desktop/electron-shim');
		const socket = Socket.instances.at(-1)!;
		socket.open();
		let finish!: () => void;
		duringRecovery(
			() =>
				new Promise<void>((resolve) => {
					finish = resolve;
				})
		);
		const result = expect(ipcRenderer.invoke('groups:setAll', [], [])).rejects.toThrow(
			/Submission uncertainty/
		);
		await aliveFor(socket, 120001);
		await result;
		expect(window.location.reload).not.toHaveBeenCalled();
		await expect(ipcRenderer.invoke('groups:setAll', [], [])).rejects.toThrow(
			/restoring authoritative/i
		);
		finish();
		await vi.advanceTimersByTimeAsync(0);
		const fresh = ipcRenderer.invoke('groups:setAll', [{ id: 'fresh' }], []);
		await Promise.resolve();
		const packet = socket.sent.at(-1)!;
		socket.frame({ type: 'bridge.response', requestId: packet.requestId, ok: true, result: true });
		await expect(fresh).resolves.toBe(true);
		expect(
			socket.sent
				.filter((packet) => packet.channel === 'groups:setAll')
				.map((packet) => packet.args[0])
		).toEqual([[], [{ id: 'fresh' }]]);
	});

	it.each(['sync', 'async'] as const)(
		'recovers in place after a failed %s state listener',
		async (kind) => {
			const { ipcRenderer } = await import('../../web-desktop/electron-shim');
			const socket = Socket.instances.at(-1)!;
			socket.open();
			let finish!: () => void;
			duringRecovery(
				() =>
					new Promise<void>((resolve) => {
						finish = resolve;
					})
			);
			let fail = true;
			const later = vi.fn();
			ipcRenderer.on('sessions:lifecycleSync', () => {
				if (!fail) return;
				fail = false;
				if (kind === 'async') return Promise.reject(new Error('application failed'));
				throw new Error('application failed');
			});
			ipcRenderer.on('sessions:lifecycleSync', later);
			socket.frame({ type: 'bridge.event', channel: 'sessions:lifecycleSync', args: [{}], seq: 1 });
			await vi.advanceTimersByTimeAsync(0);
			socket.frame({ type: 'bridge.event', channel: 'sessions:lifecycleSync', args: [{}], seq: 2 });
			await expect(ipcRenderer.invoke('process:spawn', {})).rejects.toThrow(
				/restoring authoritative/i
			);
			expect(window.location.reload).not.toHaveBeenCalled();
			finish();
			await vi.advanceTimersByTimeAsync(0);
			expect(later).toHaveBeenCalledTimes(kind === 'sync' ? 1 : 2);
			expect((window as any).__MAESTRO_BRIDGE_STATE__).toBe('connected');
			expect(socket.sent.filter((packet) => packet.type === 'bridge.invoke')).toEqual([]);
		}
	);

	it('replaces a half-open socket without waiting for close and ignores its late events', async () => {
		const { ipcRenderer } = await import('../../web-desktop/electron-shim');
		const first = Socket.instances.at(-1)!;
		first.open();
		first.close = () => {
			first.readyState = 2;
		};
		await vi.advanceTimersByTimeAsync(24000);
		const second = Socket.instances.at(-1)!;
		expect(second).not.toBe(first);
		second.readyState = 1;
		second.emit('open', {});
		second.frame({ type: 'connected', bridgeEpoch: 'run', bridgeSeq: 0, resumed: true });
		first.emit('close', { code: 1006 });
		first.frame({ type: 'connected', bridgeEpoch: 'stale', bridgeSeq: 100 });
		first.emit('open', {});
		const read = ipcRenderer.invoke('groups:getAll');
		await Promise.resolve();
		const request = second.sent.at(-1)!;
		second.frame({
			type: 'bridge.response',
			requestId: request.requestId,
			ok: true,
			result: ['current'],
		});
		await expect(read).resolves.toEqual(['current']);
		await vi.advanceTimersByTimeAsync(1001);
		expect(Socket.instances).toHaveLength(2);
		expect((window as any).__MAESTRO_BRIDGE_STATE__).toBe('connected');
	});

	it('reprobes after renderer suspension rather than treating a delayed timer as a dead peer', async () => {
		await import('../../web-desktop/electron-shim');
		const socket = Socket.instances.at(-1)!;
		socket.open();
		await vi.advanceTimersByTimeAsync(15000);
		vi.setSystemTime(Date.now() + 30000);
		await vi.advanceTimersByTimeAsync(8000);
		expect(Socket.instances).toHaveLength(1);
		expect(socket.readyState).toBe(1);
		expect(socket.sent.filter((packet) => packet.type === 'ping')).toHaveLength(2);
		socket.frame({ type: 'pong' });
		await aliveFor(socket, 16000);
		expect((window as any).__MAESTRO_BRIDGE_STATE__).toBe('connected');
	});

	it('replaces a socket whose opening handshake never completes', async () => {
		await import('../../web-desktop/electron-shim');
		const first = Socket.instances[0];
		await vi.advanceTimersByTimeAsync(11000);
		expect(first.readyState).toBe(3);
		expect(Socket.instances).toHaveLength(2);
		expect(Socket.instances[1]).not.toBe(first);
	});

	it('replaces a stale opening handshake immediately on wake', async () => {
		await import('../../web-desktop/electron-shim');
		const first = Socket.instances[0];
		window.dispatchEvent(new Event('pageshow'));
		expect(first.readyState).toBe(3);
		await vi.advanceTimersByTimeAsync(1000);
		expect(Socket.instances.at(-1)).not.toBe(first);
	});

	it('aborts a hung authoritative recovery and retries without staying fenced', async () => {
		const { ipcRenderer } = await import('../../web-desktop/electron-shim');
		const random = vi.spyOn(Math, 'random').mockReturnValue(0);
		const first = Socket.instances[0];
		first.open();
		let attempts = 0;
		const reconcile = (event: Event) => {
			const detail = (event as CustomEvent).detail;
			if (!detail?.authoritative) return;
			attempts++;
			detail.waitUntil(attempts === 1 ? new Promise<void>(() => {}) : Promise.resolve());
		};
		window.addEventListener('maestro:webBridgeReconcile', reconcile);
		try {
			first.close();
			await vi.advanceTimersByTimeAsync(1000);
			Socket.instances[1].open();
			expect(attempts).toBe(1);
			await aliveFor(Socket.instances[1], 31001);
			expect(attempts).toBe(2);
			await vi.advanceTimersByTimeAsync(0);
			expect((window as unknown as Record<string, unknown>).__MAESTRO_BRIDGE_STATE__).toBe(
				'connected'
			);
			const read = ipcRenderer.invoke('groups:getAll');
			await Promise.resolve();
			const request = Socket.instances[1].sent.at(-1)!;
			Socket.instances[1].frame({
				type: 'bridge.response',
				requestId: request.requestId,
				ok: true,
				result: [],
			});
			await expect(read).resolves.toEqual([]);
		} finally {
			window.removeEventListener('maestro:webBridgeReconcile', reconcile);
			random.mockRestore();
		}
	});
	it.each([4403, 1008])('does not retry terminal policy close %i', async (code) => {
		await import('../../web-desktop/electron-shim');
		const socket = Socket.instances[0];
		socket.open();
		socket.emit('close', { code });
		expect((window as unknown as Record<string, unknown>).__MAESTRO_BRIDGE_STATE__).toBe(
			'disconnected'
		);
		expect(Socket.instances).toHaveLength(1);
		window.dispatchEvent(new Event('online'));
		window.dispatchEvent(new Event('pageshow'));
		await vi.advanceTimersByTimeAsync(60000);
		expect(Socket.instances).toHaveLength(1);
		expect((window as unknown as Record<string, unknown>).__MAESTRO_BRIDGE_STATE__).toBe(
			'disconnected'
		);
	});
});
