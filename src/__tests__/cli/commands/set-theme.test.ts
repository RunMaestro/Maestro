/**
 * @file set-theme.test.ts
 * @description Tests for the set-theme CLI command
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';

vi.mock('../../../cli/services/maestro-client', () => ({ withMaestroClient: vi.fn() }));
vi.mock('../../../cli/output/formatter', () => ({
	formatError: vi.fn((msg) => `Error: ${msg}`),
	formatSuccess: vi.fn((msg) => `Success: ${msg}`),
}));

import { setTheme } from '../../../cli/commands/set-theme';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import { formatError } from '../../../cli/output/formatter';

function mockSend(result: Record<string, unknown>) {
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

describe('set-theme command', () => {
	let consoleSpy: MockInstance;
	let processExitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('__exit__');
		});
	});

	it('sets a theme by id via set_setting/activeThemeId', async () => {
		const getPayload = mockSend({ success: true });
		await setTheme('dracula', {});
		const p = getPayload();
		expect(p.type).toBe('set_setting');
		expect(p.key).toBe('activeThemeId');
		expect(p.value).toBe('dracula');
	});

	it('matches a theme by display name (case-insensitive)', async () => {
		const getPayload = mockSend({ success: true });
		await setTheme('dracula', {});
		expect(getPayload().value).toBe('dracula');
	});

	it('rejects an unknown theme without connecting', async () => {
		await expect(setTheme('not-a-real-theme', {})).rejects.toThrow('__exit__');
		expect(formatError).toHaveBeenCalledWith(expect.stringContaining('Unknown theme'));
		expect(withMaestroClient).not.toHaveBeenCalled();
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('--list prints themes and does not connect', async () => {
		await setTheme(undefined, { list: true });
		expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Available themes'));
		expect(withMaestroClient).not.toHaveBeenCalled();
	});

	it('lists as JSON when --list --json', async () => {
		await setTheme(undefined, { list: true, json: true });
		const parsed = JSON.parse(consoleSpy.mock.calls[0][0]);
		expect(Array.isArray(parsed)).toBe(true);
		expect(parsed[0]).toHaveProperty('id');
	});

	it('reports a server failure', async () => {
		mockSend({ success: false, error: 'Setting modification not configured' });
		await expect(setTheme('dracula', {})).rejects.toThrow('__exit__');
		expect(formatError).toHaveBeenCalledWith('Setting modification not configured');
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});
});
