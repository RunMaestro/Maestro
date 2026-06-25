/**
 * @file pianola.test.ts
 * @description Tests for the Pianola CLI command gating and read commands.
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';

vi.mock('../../../cli/services/storage', () => ({ readSettingValue: vi.fn() }));
vi.mock('../../../cli/services/pianola-store', () => ({
	readPianolaRules: vi.fn(() => []),
	appendPianolaDecision: vi.fn(),
	readPianolaDecisions: vi.fn(() => []),
}));

import { pianolaRules, pianolaLog } from '../../../cli/commands/pianola';
import { readSettingValue } from '../../../cli/services/storage';
import { readPianolaRules, readPianolaDecisions } from '../../../cli/services/pianola-store';

describe('pianola command gating', () => {
	let consoleSpy: MockInstance;
	let errorSpy: MockInstance;
	let exitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('__exit__');
		});
	});

	it('blocks rules when the pianola Encore flag is off', () => {
		vi.mocked(readSettingValue).mockReturnValue({ pianola: false });
		expect(() => pianolaRules({})).toThrow('__exit__');
		expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('encore set pianola on'));
		expect(readPianolaRules).not.toHaveBeenCalled();
		expect(exitSpy).toHaveBeenCalledWith(1);
	});

	it('emits a JSON disabled error when --json is set', () => {
		vi.mocked(readSettingValue).mockReturnValue(undefined);
		expect(() => pianolaLog({ json: true })).toThrow('__exit__');
		const payload = JSON.parse(consoleSpy.mock.calls[0][0]);
		expect(payload).toMatchObject({ success: false, code: 'PIANOLA_DISABLED' });
	});

	it('lists rules when the flag is on', () => {
		vi.mocked(readSettingValue).mockReturnValue({ pianola: true });
		pianolaRules({});
		expect(readPianolaRules).toHaveBeenCalled();
		expect(consoleSpy).toHaveBeenCalledWith('No Pianola rules defined.');
	});

	it('shows the decision log when the flag is on', () => {
		vi.mocked(readSettingValue).mockReturnValue({ pianola: true });
		pianolaLog({});
		expect(readPianolaDecisions).toHaveBeenCalled();
		expect(consoleSpy).toHaveBeenCalledWith('No Pianola decisions recorded yet.');
	});
});
