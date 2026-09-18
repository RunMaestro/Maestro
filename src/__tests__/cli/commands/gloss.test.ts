/**
 * @file gloss.test.ts
 * @description Tests for the gloss CLI command
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';

vi.mock('../../../cli/services/maestro-client', () => ({ withMaestroClient: vi.fn() }));
vi.mock('../../../cli/services/storage', () => ({ readSettingValue: vi.fn() }));
vi.mock('../../../cli/output/formatter', () => ({
	formatError: vi.fn((msg) => `Error: ${msg}`),
	formatSuccess: vi.fn((msg) => `Success: ${msg}`),
}));

import { gloss } from '../../../cli/commands/gloss';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import { readSettingValue } from '../../../cli/services/storage';
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

describe('gloss command', () => {
	let consoleSpy: MockInstance;
	let processExitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(readSettingValue).mockReturnValue('off');
		consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('__exit__');
		});
	});

	it('sets a level via set_setting/themeGloss', async () => {
		const getPayload = mockSend({ success: true });
		await gloss('strong', {});
		const p = getPayload();
		expect(p.type).toBe('set_setting');
		expect(p.key).toBe('themeGloss');
		expect(p.value).toBe('strong');
	});

	it('accepts a level in any case', async () => {
		const getPayload = mockSend({ success: true });
		await gloss('  MAX ', {});
		expect(getPayload().value).toBe('max');
	});

	it('rejects an unknown level without connecting', async () => {
		// A typo must fail loudly here. Written through `settings set` instead it
		// lands on <html data-gloss>, matches no CSS rule, and renders as off with
		// no error anywhere.
		await expect(gloss('shiny', {})).rejects.toThrow('__exit__');
		expect(formatError).toHaveBeenCalledWith(expect.stringContaining('Unknown gloss level'));
		expect(withMaestroClient).not.toHaveBeenCalled();
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('reports the current level without connecting when no level is given', async () => {
		vi.mocked(readSettingValue).mockReturnValue('sheen');
		await gloss(undefined, {});
		expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Gloss levels'));
		expect(withMaestroClient).not.toHaveBeenCalled();
	});

	it('reports an unrecognized stored level as off rather than echoing it back', async () => {
		vi.mocked(readSettingValue).mockReturnValue('nonsense');
		await gloss(undefined, { json: true });
		const parsed = JSON.parse(consoleSpy.mock.calls[0][0]);
		expect(parsed.level).toBe('off');
		expect(parsed.levels.map((l: { value: string }) => l.value)).toEqual([
			'off',
			'sheen',
			'strong',
			'max',
		]);
	});

	it('reports a server failure', async () => {
		mockSend({ success: false, error: 'Setting modification not configured' });
		await expect(gloss('max', {})).rejects.toThrow('__exit__');
		expect(formatError).toHaveBeenCalledWith('Setting modification not configured');
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});
});
