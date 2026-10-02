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
		expect(released).toEqual([target.tabId]);
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
