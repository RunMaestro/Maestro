import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcRenderer } from 'electron';
import { createCoworkingApi } from '../../../main/preload/coworking';

vi.mock('electron', () => ({
	ipcRenderer: { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
}));

describe('coworking provider ownership preload', () => {
	beforeEach(() => vi.clearAllMocks());

	it('mirrors per-provider permission and confirmation policies', async () => {
		const policies = { codex: { interactionEnabled: true, confirmPolicy: 'all' as const } };
		await createCoworkingApi().syncSessionBrowsers('s1', [], false, undefined, 'all', policies);
		expect(ipcRenderer.invoke).toHaveBeenCalledWith(
			'coworking:syncSessionBrowsers',
			's1',
			[],
			false,
			undefined,
			'all',
			policies
		);
	});

	it('forwards the captured launch identity with the main confirmation requirement', () => {
		const callback = vi.fn();
		const stop = createCoworkingApi().onRequestBrowserOp(callback);
		const handler = vi.mocked(ipcRenderer.on).mock.calls[0][1];
		const caller = { sessionId: 's1', processSessionId: 's1-ai-t1', provider: 'codex' as const };
		handler(
			{} as Electron.IpcRendererEvent,
			'browser-tab',
			's1',
			{ kind: 'reload' },
			'reply',
			true,
			caller
		);
		expect(callback).toHaveBeenCalledWith(
			'browser-tab',
			's1',
			{ kind: 'reload' },
			'reply',
			true,
			caller
		);
		stop();
		expect(ipcRenderer.removeListener).toHaveBeenCalledWith('coworking:requestBrowserOp', handler);
	});
});
