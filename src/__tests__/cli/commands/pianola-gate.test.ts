import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../cli/services/storage', () => ({ readSettingValue: vi.fn() }));

import { readSettingValue } from '../../../cli/services/storage';
import {
	createPianolaPollingGate,
	parsePianolaIntervalSeconds,
	pianolaEnabledNow,
} from '../../../cli/commands/pianola-gate';

describe('parsePianolaIntervalSeconds', () => {
	it('preserves the CLI default, seconds suffix, and one-second lower bound', () => {
		expect(parsePianolaIntervalSeconds()).toBe(5);
		expect(parsePianolaIntervalSeconds(' 12S ')).toBe(12);
		expect(parsePianolaIntervalSeconds('0')).toBe(1);
		expect(parsePianolaIntervalSeconds('0s')).toBe(1);
	});

	it('falls back to the default for invalid units and non-integers', () => {
		expect(parsePianolaIntervalSeconds('1m')).toBe(5);
		expect(parsePianolaIntervalSeconds('1.5')).toBe(5);
		expect(parsePianolaIntervalSeconds('never')).toBe(5);
	});
});

describe('Pianola polling gate', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	it('owns a single timer when start is repeated and releases it after the interval', async () => {
		const gate = createPianolaPollingGate('2');
		const first = gate.wait();
		const repeated = gate.wait();

		expect(repeated).toBe(first);
		expect(vi.getTimerCount()).toBe(1);
		await vi.advanceTimersByTimeAsync(2000);
		await expect(first).resolves.toBeUndefined();
		expect(vi.getTimerCount()).toBe(0);
	});

	it('cancels a pending delay immediately and never creates a replacement timer', async () => {
		const gate = createPianolaPollingGate('5');
		const pending = gate.wait();
		gate.stop();

		await expect(pending).resolves.toBeUndefined();
		expect(gate.stopped).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
		await gate.wait();
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe('pianolaEnabledNow', () => {
	it('re-reads Settings so an explicit mid-run disable wins', () => {
		vi.mocked(readSettingValue)
			.mockReturnValueOnce({ pianola: true })
			.mockReturnValueOnce({ pianola: false });

		expect(pianolaEnabledNow()).toBe(true);
		expect(pianolaEnabledNow()).toBe(false);
		expect(readSettingValue).toHaveBeenCalledTimes(2);
	});
});
