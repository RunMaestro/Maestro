/**
 * @file bookmark.test.ts
 * @description Tests for the bookmark / unbookmark CLI commands
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';

vi.mock('../../../cli/services/maestro-client', () => ({ withMaestroClient: vi.fn() }));
vi.mock('../../../cli/services/storage', () => ({
	resolveAgentId: vi.fn((id: string) => id),
}));
vi.mock('../../../cli/output/formatter', () => ({
	formatError: vi.fn((msg) => `Error: ${msg}`),
	formatSuccess: vi.fn((msg) => `Success: ${msg}`),
}));

import { setBookmark } from '../../../cli/commands/bookmark';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import { resolveAgentId } from '../../../cli/services/storage';
import { formatError } from '../../../cli/output/formatter';

function mockClient(result: Record<string, unknown>) {
	let captured: Record<string, unknown> = {};
	vi.mocked(withMaestroClient).mockImplementation(async (action) =>
		action({
			sendCommand: vi.fn().mockImplementation((payload: Record<string, unknown>) => {
				captured = payload;
				return Promise.resolve(result);
			}),
		} as never)
	);
	return () => captured;
}

describe('bookmark commands', () => {
	let consoleSpy: MockInstance;
	let processExitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(resolveAgentId).mockImplementation((id: string) => id);
		consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('__exit__');
		});
	});

	it('bookmark sends an explicit bookmarked:true config patch', async () => {
		const getPayload = mockClient({ success: true });
		await setBookmark('agent-1', true, {});
		const p = getPayload();
		expect(p.type).toBe('update_session_config');
		expect(p.sessionId).toBe('agent-1');
		expect(p.configPatch).toEqual({ bookmarked: true });
	});

	it('unbookmark sends bookmarked:false rather than toggling', async () => {
		const getPayload = mockClient({ success: true });
		await setBookmark('agent-1', false, {});
		expect(getPayload().configPatch).toEqual({ bookmarked: false });
	});

	it('resolves a partial agent id before sending', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('session-full-id');
		const getPayload = mockClient({ success: true });
		await setBookmark('sess', true, {});
		expect(resolveAgentId).toHaveBeenCalledWith('sess');
		expect(getPayload().sessionId).toBe('session-full-id');
	});

	it('emits JSON with the resulting state for scripting', async () => {
		mockClient({ success: true });
		await setBookmark('agent-1', true, { json: true });
		expect(JSON.parse(consoleSpy.mock.calls[0][0] as string)).toEqual({
			success: true,
			agentId: 'agent-1',
			bookmarked: true,
		});
	});

	it('exits non-zero when the desktop rejects the write', async () => {
		mockClient({ success: false, error: 'Agent not found' });
		await expect(setBookmark('agent-1', true, {})).rejects.toThrow('__exit__');
		expect(formatError).toHaveBeenCalledWith('Agent not found');
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('exits non-zero when the desktop app is unreachable', async () => {
		vi.mocked(withMaestroClient).mockRejectedValue(new Error('Maestro is not running'));
		await expect(setBookmark('agent-1', true, {})).rejects.toThrow('__exit__');
		expect(formatError).toHaveBeenCalledWith('Maestro is not running');
	});
});
