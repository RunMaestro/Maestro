import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock('electron', () => ({
	ipcRenderer: {
		invoke: invokeMock,
	},
}));

import { createMemoryApi } from '../../main/preload/memory';

describe('memory preload API', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('uses the registered read-only memory channels without exposing new ones', async () => {
		invokeMock.mockResolvedValue({ success: true });
		const memory = createMemoryApi();

		await memory.list('/project', 'codex');
		await memory.read('/project', 'entry.md');
		await memory.getPath('/project');

		expect(invokeMock).toHaveBeenNthCalledWith(1, 'memory:list', '/project', 'codex');
		expect(invokeMock).toHaveBeenNthCalledWith(
			2,
			'memory:read',
			'/project',
			'entry.md',
			'claude-code'
		);
		expect(invokeMock).toHaveBeenNthCalledWith(3, 'memory:getPath', '/project', 'claude-code');
	});
});
