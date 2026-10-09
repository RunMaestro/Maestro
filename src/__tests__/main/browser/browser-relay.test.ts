import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserRelay, validateInput } from '../../../main/browser/browser-relay';
import type { BrowserRelayHostResult, BrowserRelayRequest } from '../../../shared/browserRelay';

const { tabSession } = vi.hoisted(() => ({ tabSession: {} }));
vi.mock('electron', () => ({
	BrowserWindow: {},
	ipcMain: {},
	webContents: {},
	session: { fromPartition: () => tabSession },
}));

const target = { sessionId: 'host-session', tabId: 'host-tab' };
const viewport = { width: 800, height: 600 };

afterEach(() => vi.useRealTimers());

describe('host browser relay leases', () => {
	it('refuses another client’s lease and another controller for the same canonical tab', async () => {
		const relay = new BrowserRelay(async () => ({ ok: true }));
		const id = await relay.open('client-a', target, viewport);
		await expect(relay.run('client-b', id, 'resolve')).rejects.toThrow('another client');
		await expect(relay.open('client-b', target, viewport)).rejects.toThrow('already controlled');
		relay.close('client-b', id);
		await expect(relay.open('client-b', target, viewport)).rejects.toThrow('already controlled');
		relay.close('client-a', id);
		await expect(relay.open('client-b', target, viewport)).resolves.toEqual(expect.any(String));
	});

	it('rejects missing host tabs and invalid dimensions without reserving their target', async () => {
		const hostTabs = new Set([target.tabId]);
		const relay = new BrowserRelay(async (request) => ({
			ok: hostTabs.has(request.tabId),
			error: 'Host tab not found',
		}));
		await expect(
			relay.open('client', { ...target, tabId: 'unregistered' }, viewport)
		).rejects.toThrow('Host tab not found');
		await expect(relay.open('client', target, { width: 3000, height: 600 })).rejects.toThrow(
			'viewport'
		);
		await expect(relay.open('client', target, viewport)).resolves.toEqual(expect.any(String));
	});

	it('permits only one capture in flight and caps capture start rate at eight frames per second', async () => {
		vi.useFakeTimers();
		const capture = Promise.withResolvers<BrowserRelayHostResult>();
		let frames = 0;
		const relay = new BrowserRelay(async (request) => {
			if (request.kind === 'frame') {
				frames++;
				if (frames === 1) return capture.promise;
			}
			return { ok: true };
		});
		const id = await relay.open('client', target, viewport);
		const first = relay.run('client', id, 'frame');
		await expect(relay.run('client', id, 'frame')).rejects.toThrow('in flight');
		capture.resolve({ ok: true });
		await first;
		const second = relay.run('client', id, 'frame');
		await vi.advanceTimersByTimeAsync(124);
		expect(frames).toBe(1);
		await vi.advanceTimersByTimeAsync(1);
		await second;
		expect(frames).toBe(2);
	});

	it('disconnect releases the view, rejects a late capture, and never destroys the host tab', async () => {
		const capture = Promise.withResolvers<BrowserRelayHostResult>();
		const hostTabs = new Set([target.tabId]);
		const released: string[] = [];
		const relay = new BrowserRelay(async (request) => {
			if (request.kind === 'frame') return capture.promise;
			if (request.kind === 'release') released.push(request.tabId);
			return { ok: hostTabs.has(request.tabId) };
		});
		const id = await relay.open('client', target, viewport);
		const frame = relay.run('client', id, 'frame');
		relay.closeClient('client');
		capture.resolve({ ok: true });
		await expect(frame).rejects.toThrow('expired');
		// Release immediately and again after the pending capture settles, since
		// a frame request may recreate a page after its original guest disappears.
		expect(released).toEqual([target.tabId, target.tabId]);
		expect(hostTabs.has(target.tabId)).toBe(true);
		await expect(relay.open('new-client', target, viewport)).resolves.toEqual(expect.any(String));
	});

	it('idle views expire and a closing host tab fails subsequent operations', async () => {
		let now = 0;
		let live = true;
		const relay = new BrowserRelay(
			async (request: Omit<BrowserRelayRequest, 'requestId'>) => ({
				ok: request.kind === 'release' || live,
				error: 'Host tab closed',
			}),
			() => now
		);
		const id = await relay.open('client', target, viewport);
		live = false;
		await expect(relay.run('client', id, 'resolve')).rejects.toThrow('Host tab closed');
		now = 15_001;
		relay.expire();
		await expect(relay.run('client', id, 'resolve')).rejects.toThrow('expired');
	});

	it.each([
		{ kind: 'resolve' as const, hasSuccessor: false },
		{ kind: 'resolve' as const, hasSuccessor: true },
		{ kind: 'frame' as const, hasSuccessor: false },
		{ kind: 'frame' as const, hasSuccessor: true },
	])(
		'cleans up a disconnected pending $kind without suspending a successor (successor: $hasSuccessor)',
		async ({ kind, hasSuccessor }) => {
			const creation = Promise.withResolvers<void>();
			let requests = 0;
			let remoteActive = false;
			const relay = new BrowserRelay(async (request) => {
				if (request.kind === 'release') {
					remoteActive = false;
				} else {
					if (++requests === 2) await creation.promise;
					// A destroyed guest can be recreated by an in-flight resolve or frame.
					remoteActive = true;
				}
				return { ok: true };
			});
			const id = await relay.open('disconnected-client', target, viewport);
			const pending = relay.run('disconnected-client', id, kind);
			relay.closeClient('disconnected-client');
			expect(remoteActive).toBe(false);
			const successor = hasSuccessor
				? await relay.open('successor-client', target, viewport)
				: undefined;
			creation.resolve();
			await expect(pending).rejects.toThrow('expired');
			expect(remoteActive).toBe(hasSuccessor);
			if (successor) {
				relay.assertActive('successor-client', successor);
				relay.close('successor-client', successor);
				expect(remoteActive).toBe(false);
			}
		}
	);

	it.each([false, true])(
		'cleans up a disconnected pending open without suspending a successor (successor: %s)',
		async (hasSuccessor) => {
			const firstResolve = Promise.withResolvers<void>();
			let opens = 0;
			let remoteActive = false;
			const relay = new BrowserRelay(async (request) => {
				if (request.kind === 'resolve') {
					if (++opens === 1) await firstResolve.promise;
					// Page creation can finish after the disconnect's early release.
					remoteActive = true;
				} else if (request.kind === 'release') {
					remoteActive = false;
				}
				return { ok: true };
			});
			const opening = relay.open('disconnected-client', target, viewport);
			relay.closeClient('disconnected-client');
			expect(remoteActive).toBe(false);
			const successor = hasSuccessor
				? await relay.open('successor-client', target, viewport)
				: undefined;
			firstResolve.resolve();
			await expect(opening).rejects.toThrow('disconnected while opening');
			expect(remoteActive).toBe(hasSuccessor);
			if (successor) {
				relay.assertActive('successor-client', successor);
				relay.close('successor-client', successor);
				expect(remoteActive).toBe(false);
			}
		}
	);
});

describe('browser target and input authorization', () => {
	it('refuses nonfinite coordinates, unbounded paste/scroll, unsupported events and injected modifiers', () => {
		for (const input of [
			{ type: 'mouseDown', x: NaN, y: 1 },
			{ type: 'mouseDown', x: 1, y: -1 },
			{ type: 'mouseWheel', x: 1, y: 1, deltaX: 0, deltaY: Infinity },
			{ type: 'text', text: 'x'.repeat(16_385) },
			{ type: 'keyDown', keyCode: 'A', modifiers: ['capsLock'] },
			{ type: 'touchStart', x: 1, y: 1 },
		])
			expect(() => validateInput(input as never)).toThrow('Invalid browser');
	});
});
