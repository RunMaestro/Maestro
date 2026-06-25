/**
 * @file encore.test.ts
 * @description Tests for the encore CLI commands
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';

vi.mock('../../../cli/services/maestro-client', () => ({ withMaestroClient: vi.fn() }));
vi.mock('../../../cli/services/storage', () => ({
	readSettingValue: vi.fn(),
	resolveAgentId: vi.fn((id: string) => id),
}));
vi.mock('../../../cli/output/formatter', () => ({
	formatError: vi.fn((msg) => `Error: ${msg}`),
	formatSuccess: vi.fn((msg) => `Success: ${msg}`),
}));

import { encoreList, encoreSet } from '../../../cli/commands/encore';
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

describe('encore commands', () => {
	let consoleSpy: MockInstance;
	let processExitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(readSettingValue).mockReturnValue({ symphony: true });
		consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('__exit__');
		});
	});

	it('list emits current flags as JSON', () => {
		encoreList({ json: true });
		const parsed = JSON.parse(consoleSpy.mock.calls[0][0]);
		expect(parsed.features.symphony).toBe(true);
		expect(parsed.features.maestroCue).toBe(false);
	});

	it('enable sends the full merged encoreFeatures object', async () => {
		const getPayload = mockSend({ success: true });
		await encoreSet('maestroCue', true, {});
		const p = getPayload();
		expect(p.type).toBe('set_setting');
		expect(p.key).toBe('encoreFeatures');
		expect(p.value).toMatchObject({ symphony: true, maestroCue: true });
	});

	it('disable flips a flag off', async () => {
		const getPayload = mockSend({ success: true });
		await encoreSet('symphony', false, {});
		expect((getPayload().value as Record<string, boolean>).symphony).toBe(false);
	});

	it('resolves friendly aliases (e.g. "group-chat" -> symphony)', async () => {
		const getPayload = mockSend({ success: true });
		await encoreSet('group-chat', true, {});
		expect((getPayload().value as Record<string, boolean>).symphony).toBe(true);
	});

	it('lists pianola, defaulting off when unset', () => {
		encoreList({ json: true });
		const parsed = JSON.parse(consoleSpy.mock.calls[0][0]);
		expect(parsed.features).toHaveProperty('pianola');
		expect(parsed.features.pianola).toBe(false);
	});

	it('resolves pianola aliases (e.g. "auto-pilot" / "manager" -> pianola)', async () => {
		const getPayload = mockSend({ success: true });
		await encoreSet('auto-pilot', true, {});
		expect((getPayload().value as Record<string, boolean>).pianola).toBe(true);

		const getPayload2 = mockSend({ success: true });
		await encoreSet('manager', true, {});
		expect((getPayload2().value as Record<string, boolean>).pianola).toBe(true);
	});

	it('rejects an unknown feature without connecting', async () => {
		await expect(encoreSet('telepathy', true, {})).rejects.toThrow('__exit__');
		expect(formatError).toHaveBeenCalledWith(expect.stringContaining('Unknown Encore feature'));
		expect(withMaestroClient).not.toHaveBeenCalled();
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('reports a server failure', async () => {
		mockSend({ success: false, error: 'nope' });
		await expect(encoreSet('maestroCue', true, {})).rejects.toThrow('__exit__');
		expect(formatError).toHaveBeenCalledWith('nope');
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});
});
