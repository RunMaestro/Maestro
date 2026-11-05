import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RetirementRenderer } from '../../../main/git/worktreeRetirementHost';
const mocks = vi.hoisted(() => ({
	handlers: new Map<string, (...args: unknown[]) => unknown>(),
	from: vi.fn(),
	prepare: vi.fn(),
	abort: vi.fn(),
	remove: vi.fn(),
	request: vi.fn(),
	recoveries: vi.fn(),
	cancel: vi.fn(),
	recover: vi.fn(),
}));
vi.mock('electron', () => ({
	BrowserWindow: { fromWebContents: mocks.from },
	ipcMain: {
		handle: (name: string, handler: (...args: unknown[]) => unknown) =>
			mocks.handlers.set(name, handler),
	},
}));
vi.mock('../../../main/git/worktreeRetirement', () => ({
	worktreeRetirement: {
		pendingRecoveries: mocks.recoveries,
		cancelRecoveredRemoval: mocks.cancel,
	},
}));
vi.mock('../../../main/git/worktreeRetirementHost', () => ({
	WorktreeRetirementHost: class {
		prepare = mocks.prepare;
		abort = mocks.abort;
		remove = mocks.remove;
		recover = mocks.recover;
	},
}));
vi.mock('../../../main/web-server/callbacks/remoteRequest', () => ({
	requestFromRenderer: mocks.request,
}));
import { registerRetirementHandlers } from '../../../main/ipc/handlers/git/retirement';
import {
	__resetDesktopOnlyChannelsForTests,
	isDesktopOnlyChannel,
} from '../../../main/ipc/desktop-only-channels';

beforeEach(() => {
	vi.clearAllMocks();
	mocks.handlers.clear();
	__resetDesktopOnlyChannelsForTests();
	registerRetirementHandlers();
});
const invoke = (channel: string, ...args: unknown[]) =>
	mocks.handlers.get(`git:${channel}`)!(...args);
function sender() {
	const sender = Object.assign(new EventEmitter(), { mainFrame: {}, send: vi.fn() });
	return { sender, senderFrame: sender.mainFrame };
}
describe('retirement Git IPC adapter', () => {
	it.each([
		'prepareWorktreeRetirement',
		'abortWorktreeRetirement',
		'removeWorktreeRetirement',
		'getWorktreeRetirementRecoveries',
		'cancelWorktreeRetirementRecovery',
		'completeWorktreeRetirementRecovery',
		'retirementRendererRequest',
		'retirementRendererRelease',
	])('marks %s desktop-only at registration', (name) => {
		expect(isDesktopOnlyChannel(`git:${name}`)).toBe(true);
	});
	it('commits only an opaque preparation owned by the actual desktop main-frame sender', async () => {
		const event = sender();
		mocks.from.mockReturnValue({});
		mocks.remove.mockResolvedValue({ status: 'removed' });
		expect(await invoke('removeWorktreeRetirement', event, 'opaque', { path: '/forged' })).toEqual({
			status: 'removed',
		});
		expect(mocks.remove).toHaveBeenCalledWith('opaque', event.sender);
		for (const invalid of ['', undefined, { token: 'opaque' }])
			expect(await invoke('removeWorktreeRetirement', event, invalid)).toMatchObject({
				status: 'blocked',
			});
		expect(
			await invoke('removeWorktreeRetirement', { ...event, senderFrame: {} }, 'opaque')
		).toMatchObject({ status: 'blocked' });
		mocks.from.mockReturnValue(null);
		expect(await invoke('removeWorktreeRetirement', event, 'opaque')).toMatchObject({
			status: 'blocked',
		});
		expect(mocks.remove).toHaveBeenCalledOnce();
	});
	it('reads recovery ids and binds cancellation to the actual desktop sender', async () => {
		const event = sender();
		mocks.from.mockReturnValue({});
		mocks.recoveries.mockReturnValue([{ id: 'archive', sessionId: 'child', path: '/owned' }]);
		mocks.cancel.mockResolvedValue({ ok: true });
		expect(await invoke('getWorktreeRetirementRecoveries', event)).toHaveLength(1);
		expect(
			await invoke('cancelWorktreeRetirementRecovery', event, 'archive', { identity: {} })
		).toEqual({ ok: true });
		expect(mocks.cancel).toHaveBeenCalledWith('archive', event.sender);
	});

	it('binds removed recovery completion to the desktop sender, refusing subframes and absent windows', async () => {
		const event = sender();
		mocks.from.mockReturnValue({});
		mocks.recover.mockResolvedValue({ status: 'removed' });
		expect(
			await invoke('completeWorktreeRetirementRecovery', event, 'archive', { path: '/forged' })
		).toEqual({ status: 'removed' });
		const [id, adapter] = mocks.recover.mock.calls[0] as [string, RetirementRenderer];
		expect(id).toBe('archive');
		expect(adapter.identity).toBe(event.sender);
		expect(
			await invoke('completeWorktreeRetirementRecovery', { ...event, senderFrame: {} }, 'archive')
		).toMatchObject({ status: 'blocked' });
		mocks.from.mockReturnValue(null);
		expect(await invoke('completeWorktreeRetirementRecovery', event, 'archive')).toMatchObject({
			status: 'blocked',
		});
		expect(mocks.recover).toHaveBeenCalledOnce();
	});
	it('refuses recovery cancellation from subframes, absent windows and invalid ids', async () => {
		const event = sender();
		mocks.from.mockReturnValue({});
		expect(
			await invoke('cancelWorktreeRetirementRecovery', { ...event, senderFrame: {} }, 'archive')
		).toMatchObject({ ok: false });
		expect(await invoke('cancelWorktreeRetirementRecovery', event, '')).toMatchObject({
			ok: false,
		});
		mocks.from.mockReturnValue(null);
		expect(await invoke('cancelWorktreeRetirementRecovery', event, 'archive')).toMatchObject({
			ok: false,
		});
		expect(mocks.cancel).not.toHaveBeenCalled();
	});
	it('refuses recovery listing outside a desktop main frame', async () => {
		const event = sender();
		mocks.from.mockReturnValue({});
		await expect(
			invoke('getWorktreeRetirementRecoveries', { ...event, senderFrame: {} })
		).rejects.toThrow('desktop main frame');
		mocks.from.mockReturnValue(null);
		await expect(invoke('getWorktreeRetirementRecoveries', event)).rejects.toThrow(
			'desktop main frame'
		);
		expect(mocks.recoveries).not.toHaveBeenCalled();
	});
	it('refuses subframes and missing BrowserWindows before any preparation', async () => {
		const event = sender();
		mocks.from.mockReturnValue({});
		expect(
			await invoke('prepareWorktreeRetirement', { ...event, senderFrame: {} }, 'child')
		).toMatchObject({ ok: false });
		mocks.from.mockReturnValue(null);
		expect(await invoke('prepareWorktreeRetirement', event, 'child')).toMatchObject({ ok: false });
		expect(mocks.prepare).not.toHaveBeenCalled();
	});
	it('uses actual IPC sender and window for both request/reply and matching release', async () => {
		const event = sender();
		const win = {};
		mocks.from.mockReturnValue(win);
		await invoke('prepareWorktreeRetirement', event, 'child', {
			identity: 'forged',
			path: '/forged',
		});
		const [id, renderer] = mocks.prepare.mock.calls[0] as [string, RetirementRenderer];
		expect(id).toBe('child');
		expect(renderer.identity).toBe(event.sender);
		const command = { kind: 'check' as const, sessionId: 'child', token: 'opaque', revision: 3 };
		await renderer.request(command);
		expect(mocks.request).toHaveBeenCalledWith(
			win,
			'git:retirementRendererRequest',
			expect.objectContaining({
				args: [command],
				fallback: { ok: false, reason: 'renderer preparation timed out' },
			})
		);
		renderer.release('child', 'opaque');
		expect(event.sender.send).toHaveBeenCalledWith(
			'git:retirementRendererRelease',
			'child',
			'opaque'
		);
	});
	it('invalidates only main-frame navigation, crash or destruction and detaches on release', async () => {
		const event = sender();
		mocks.from.mockReturnValue({});
		await invoke('prepareWorktreeRetirement', event, 'child');
		const renderer = mocks.prepare.mock.calls[0][1] as RetirementRenderer;
		const invalidated = vi.fn();
		const detach = renderer.onInvalidated(invalidated);
		event.sender.emit('did-start-navigation', {}, 'url', false, false);
		expect(invalidated).not.toHaveBeenCalled();
		event.sender.emit('did-start-navigation', {}, 'url', false, true);
		event.sender.emit('render-process-gone');
		event.sender.emit('destroyed');
		expect(invalidated).toHaveBeenCalledTimes(3);
		detach();
		event.sender.emit('destroyed');
		expect(invalidated).toHaveBeenCalledTimes(3);
	});
	it('passes abort only for the real main-frame sender', async () => {
		const event = sender();
		mocks.abort.mockReturnValue(true);
		expect(await invoke('abortWorktreeRetirement', { ...event, senderFrame: {} }, 'opaque')).toBe(
			false
		);
		expect(mocks.abort).not.toHaveBeenCalled();
		expect(await invoke('abortWorktreeRetirement', event, 'opaque')).toBe(true);
		expect(mocks.abort).toHaveBeenCalledWith('opaque', event.sender);
	});
});
