/**
 * @file encore.test.ts
 * @description Tests for the encore CLI commands
 */

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';

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
		vi.mocked(readSettingValue).mockReturnValue({ symphony: true, maestroCue: false });
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
		expect(parsed.features.pianola).toBe(false);
	});

	it('list falls back to the shipped default for a flag never saved', () => {
		vi.mocked(readSettingValue).mockReturnValue({ symphony: true, directorNotes: false });
		encoreList({ json: true });
		const parsed = JSON.parse(consoleSpy.mock.calls[0][0]);
		expect(parsed.features.maestroCue).toBe(true);
		expect(parsed.features.directorNotes).toBe(false);
	});

	it('list falls back to the shipped defaults for keys the user never stored', () => {
		// Nothing persisted yet: every feature must read at its default (all on)
		// rather than at `false`, which would contradict the running app.
		vi.mocked(readSettingValue).mockReturnValue(undefined);
		encoreList({ json: true });
		const parsed = JSON.parse(consoleSpy.mock.calls[0][0]);
		// rc's CLI also exposes Pianola and Computer History, which have not
		// graduated and ship off, Quick Chat, which ships on, and Throughput Gauge,
		// which ships off. MaestroRun is
		// macOS only, so it is covered by its own platform tests below.
		const { maestroRun: _maestroRun, ...everywhere } = parsed.features;
		expect(everywhere).toEqual({
			directorNotes: true,
			usageStats: true,
			symphony: true,
			maestroCue: true,
			pianola: false,
			computerHistory: false,
			quickChat: true,
			aCappella: false,
			throughputGauge: false,
		});
	});

	// A Cappella is an Encore tile like the others. Until it was listed here the
	// only way to switch voice on from a terminal was to hand-write the whole
	// `encoreFeatures` object, which `encore enable` exists to prevent.
	it('lists A Cappella, off until it is switched on', () => {
		encoreList({ json: true });
		expect(JSON.parse(consoleSpy.mock.calls[0][0]).features.aCappella).toBe(false);
	});

	it.each(['aCappella', 'voice', 'a-cappella', 'acappella'])(
		'enables A Cappella when asked as "%s"',
		async (name) => {
			const getPayload = mockSend({ success: true });
			await encoreSet(name, true, {});
			const value = getPayload().value as Record<string, boolean>;
			expect(value.aCappella).toBe(true);
			// The flags the user already had travel with it, untouched.
			expect(value.symphony).toBe(true);
		}
	);

	describe('a macOS-only feature (MaestroRun)', () => {
		const realPlatform = process.platform;
		const setPlatform = (value: string) =>
			Object.defineProperty(process, 'platform', { value, configurable: true });
		afterEach(() => setPlatform(realPlatform));

		it('is listed and can be enabled on macOS', async () => {
			setPlatform('darwin');
			encoreList({ json: true });
			expect(JSON.parse(consoleSpy.mock.calls[0][0]).features.maestroRun).toBe(false);

			const getPayload = mockSend({ success: true });
			await encoreSet('maestro-run', true, {});
			expect((getPayload().value as Record<string, boolean>).maestroRun).toBe(true);
		});

		it.each(['win32', 'linux'])('is not listed and refuses to enable on %s', async (platform) => {
			setPlatform(platform);
			encoreList({ json: true });
			expect(JSON.parse(consoleSpy.mock.calls[0][0]).features).not.toHaveProperty('maestroRun');

			await expect(encoreSet('maestroRun', true, {})).rejects.toThrow('__exit__');
			expect(formatError).toHaveBeenCalledWith(
				expect.stringContaining('not available on this operating system')
			);
			expect(withMaestroClient).not.toHaveBeenCalled();
		});

		it('can still be switched off anywhere', async () => {
			setPlatform('linux');
			mockSend({ success: true });
			await encoreSet('maestroRun', false, {});
			expect(withMaestroClient).toHaveBeenCalled();
		});
	});

	it('enable sends the full merged encoreFeatures object', async () => {
		const getPayload = mockSend({ success: true });
		await encoreSet('maestroCue', true, {});
		const p = getPayload();
		expect(p.type).toBe('set_setting');
		expect(p.key).toBe('encoreFeatures');
		expect(p.value).toMatchObject({ symphony: true, maestroCue: true });
	});

	it.each([
		['directorNotes', false],
		['usageStats', false],
		['symphony', false],
		['maestroCue', true],
		['pianola', true],
		['computerHistory', true],
		['quickChat', false],
		['maestroRun', false],
	] as const)('changing %s preserves other saved Encore flags', async (feature, enabled) => {
		vi.mocked(readSettingValue).mockReturnValue(
			Object.freeze({
				plugins: true,
				concerto: true,
				webLogin: false,
				futureFeature: true,
			})
		);
		const getPayload = mockSend({ success: true });

		await encoreSet(feature, enabled, {});

		expect(getPayload().value).toMatchObject({
			[feature]: enabled,
			plugins: true,
			concerto: true,
			webLogin: false,
			futureFeature: true,
		});
	});

	it('disable flips a flag off', async () => {
		const getPayload = mockSend({ success: true });
		await encoreSet('symphony', false, {});
		expect((getPayload().value as Record<string, boolean>).symphony).toBe(false);
	});

	it('resolves friendly aliases (e.g. "maestro-symphony" -> symphony)', async () => {
		const getPayload = mockSend({ success: true });
		await encoreSet('maestro-symphony', true, {});
		expect((getPayload().value as Record<string, boolean>).symphony).toBe(true);
	});

	it('does not map "group-chat" onto Symphony (Group Chat has no Encore flag)', async () => {
		await expect(encoreSet('group-chat', false, {})).rejects.toThrow('__exit__');
		expect(formatError).toHaveBeenCalledWith(expect.stringContaining('Unknown Encore feature'));
		expect(withMaestroClient).not.toHaveBeenCalled();
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

	it.each(['throughput-gauge', 'throughput', 'gauge', 'tps'])(
		'resolves the "%s" alias to throughputGauge',
		async (alias) => {
			const getPayload = mockSend({ success: true });
			await encoreSet(alias, true, {});
			expect((getPayload().value as Record<string, boolean>).throughputGauge).toBe(true);
		}
	);

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
