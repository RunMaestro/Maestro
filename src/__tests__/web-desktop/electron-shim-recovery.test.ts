import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class Socket {
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
beforeEach(() => {
	vi.resetModules();
	vi.useFakeTimers();
	Socket.instances = [];
	vi.stubGlobal('WebSocket', Socket);
	Object.defineProperty(window, 'location', {
		configurable: true,
		value: { ...originalLocation, reload: vi.fn() },
	});
	sessionStorage.clear();
	document.body.replaceChildren();
});
afterEach(() => {
	for (const listener of recoveryHandlers.splice(0))
		window.removeEventListener('maestro:webBridgeReconcile', listener);
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.unstubAllGlobals();
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
});
