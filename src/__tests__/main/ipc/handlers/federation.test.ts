/**
 * Tests for the Federation peer mirror IPC (`federation:*`): what each channel answers while the
 * Federation Encore Feature is off (no service), and the pass-throughs and argument checks while
 * it is on, including `federation:act`, the input path to a mirrored agent (FED-SSH-06).
 */

import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { ipcMain } from 'electron';

vi.mock('electron', () => ({
	ipcMain: { handle: vi.fn() },
}));
vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../../main/utils/sentry', () => ({
	captureException: vi.fn(),
}));

import { registerFederationHandlers } from '../../../../main/ipc/handlers/federation';
import { setPeerMirrorServiceForTests, type PeerMirrorService } from '../../../../main/federation';
import { encoreDisabledMessage } from '../../../../shared/encoreFeatureDefaults';

const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
const call = (channel: string, ...args: unknown[]) => {
	const handler = handlers.get(channel);
	if (!handler) throw new Error(`No handler for ${channel}`);
	return handler({}, ...args);
};

function fakeService() {
	return {
		peers: vi.fn(() => [{ peerId: 'a', connection: 'connected', agentCount: 2 }]),
		snapshot: vi.fn(() => ({ peers: [{ peerId: 'a' }] })),
		transcript: vi.fn(async () => [{ id: 'e1' }]),
		reconnect: vi.fn(async (peerId: string) => ({ ok: true, peer: { peerId } })),
		act: vi.fn(async () => ({ ok: true, result: { kind: 'new-tab', tabId: 't9' } })),
	};
}

describe('federation IPC handlers', () => {
	beforeEach(() => {
		handlers.clear();
		(ipcMain.handle as Mock).mockImplementation(
			(channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
				handlers.set(channel, handler);
			}
		);
		setPeerMirrorServiceForTests(null);
		registerFederationHandlers();
	});

	it('registers the six federation channels', () => {
		expect([...handlers.keys()].sort()).toEqual([
			'federation:act',
			'federation:peers',
			'federation:reconnect',
			'federation:snapshot',
			'federation:status',
			'federation:transcript',
		]);
	});

	describe('while the Federation Encore Feature is off', () => {
		it('answers disabled and empty, and refuses the calls that need a peer', async () => {
			const off = encoreDisabledMessage('federation');
			expect(await call('federation:status')).toEqual({ enabled: false });
			expect(await call('federation:peers')).toEqual([]);
			expect(await call('federation:snapshot')).toEqual({ peers: [] });
			await expect(call('federation:transcript', 'a', 'x', 't1')).rejects.toThrow(off);
			expect(await call('federation:reconnect', 'a')).toEqual({ ok: false, error: off });
			expect(await call('federation:act', 'a', 'x', { kind: 'new-tab' })).toEqual({
				ok: false,
				error: off,
			});
		});
	});

	describe('while it is on', () => {
		let service: ReturnType<typeof fakeService>;

		beforeEach(() => {
			service = fakeService();
			setPeerMirrorServiceForTests(service as unknown as PeerMirrorService);
		});

		it('passes the reads through to the one service', async () => {
			expect(await call('federation:status')).toEqual({ enabled: true });
			expect(await call('federation:peers')).toEqual(service.peers());
			expect(await call('federation:snapshot')).toEqual({ peers: [{ peerId: 'a' }] });
			expect(await call('federation:transcript', 'a', 'x', 't1', { tail: 50 })).toEqual([
				{ id: 'e1' },
			]);
			expect(service.transcript).toHaveBeenCalledWith('a', 'x', 't1', { tail: 50 });
			expect(await call('federation:transcript', 'a', 'x', 't1')).toHaveLength(1);
			expect(service.transcript).toHaveBeenLastCalledWith('a', 'x', 't1', {});
		});

		it('forwards a reconnect and answers with its result', async () => {
			expect(await call('federation:reconnect', 'a')).toEqual({ ok: true, peer: { peerId: 'a' } });
			expect(service.reconnect).toHaveBeenCalledWith('a');
		});

		it('forwards a parsed action and answers with its result', async () => {
			expect(await call('federation:act', 'a', 'x', { kind: 'new-tab' })).toEqual({
				ok: true,
				result: { kind: 'new-tab', tabId: 't9' },
			});
			expect(service.act).toHaveBeenCalledWith('a', 'x', { kind: 'new-tab' });
			await call('federation:act', 'a', 'x', {
				kind: 'rename-tab',
				tabId: 't1',
				name: '  Plan  ',
				extra: 'dropped',
			});
			expect(service.act).toHaveBeenLastCalledWith('a', 'x', {
				kind: 'rename-tab',
				tabId: 't1',
				name: 'Plan',
			});
		});

		it('refuses a bad action before the service is touched', async () => {
			await expect(call('federation:act', 'a', 'x', { kind: 'close-tab' })).rejects.toThrow(
				/Unknown action/
			);
			await expect(
				call('federation:act', 'a', 'x', { kind: 'send', tabId: 't1', text: ' ' })
			).rejects.toThrow(/nothing to send/);
			await expect(
				call('federation:act', 'a', 'x', { kind: 'star-tab', tabId: 't1' })
			).rejects.toThrow(/starred/);
			await expect(call('federation:act', '', 'x', { kind: 'new-tab' })).rejects.toThrow(/peer id/);
			expect(service.act).not.toHaveBeenCalled();
		});

		it('refuses a missing id or a bad tail before the service is touched', async () => {
			await expect(call('federation:transcript', '', 'x', 't1')).rejects.toThrow(/peer id/);
			await expect(call('federation:transcript', 'a', 7, 't1')).rejects.toThrow(/agent id/);
			await expect(call('federation:transcript', 'a', 'x', undefined)).rejects.toThrow(/tab id/);
			await expect(call('federation:transcript', 'a', 'x', 't1', { tail: -1 })).rejects.toThrow(
				/whole number/
			);
			await expect(call('federation:transcript', 'a', 'x', 't1', { tail: 1.5 })).rejects.toThrow(
				/whole number/
			);
			await expect(call('federation:reconnect', '  ')).rejects.toThrow(/peer id/);
			expect(service.transcript).not.toHaveBeenCalled();
			expect(service.reconnect).not.toHaveBeenCalled();
		});
	});
});
