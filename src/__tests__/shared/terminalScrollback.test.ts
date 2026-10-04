import { describe, expect, it, vi } from 'vitest';
import {
	isValidTerminalScrollbackKey,
	serializeScrollbackWithinCap,
} from '../../shared/terminalScrollback';

describe('serializeScrollbackWithinCap', () => {
	it('returns the full snapshot when it fits', () => {
		const serialize = vi.fn((rows: number) => 'x'.repeat(rows));
		expect(serializeScrollbackWithinCap(serialize, 100, 1000)).toBe('x'.repeat(100));
		expect(serialize).toHaveBeenCalledTimes(1);
	});

	it('halves the row count until the snapshot fits', () => {
		const serialize = vi.fn((rows: number) => 'x'.repeat(rows * 10));
		expect(serializeScrollbackWithinCap(serialize, 100, 300)).toBe('x'.repeat(250));
		expect(serialize.mock.calls.map((call) => call[0])).toEqual([100, 50, 25]);
	});

	it('gives up with an empty snapshot when even one row is too big', () => {
		expect(serializeScrollbackWithinCap(() => 'too big', 8, 3)).toBe('');
	});
});

describe('isValidTerminalScrollbackKey', () => {
	it('accepts a terminal routing key', () => {
		expect(
			isValidTerminalScrollbackKey(
				'1b4e28ba-2fa1-11d2-883f-0016d3cca427-terminal-6fa459ea-ee8a-3ca4-894e-db77e160355e'
			)
		).toBe(true);
	});

	it.each(['', '../escape', 'a/b', 'a\\b', 'a.ansi', 'x'.repeat(257), 42, null])(
		'refuses %s',
		(key) => {
			expect(isValidTerminalScrollbackKey(key)).toBe(false);
		}
	);
});
