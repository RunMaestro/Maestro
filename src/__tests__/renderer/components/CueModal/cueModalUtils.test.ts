import { describe, it, expect } from 'vitest';
import { cleanStderrForDisplay } from '../../../../renderer/components/CueModal/cueModalUtils';

describe('cleanStderrForDisplay', () => {
	it('returns empty input unchanged', () => {
		expect(cleanStderrForDisplay('')).toBe('');
	});

	it('strips Codex "Reading additional input from stdin" line', () => {
		expect(cleanStderrForDisplay('Reading additional input from stdin...\n')).toBe('');
	});

	it('strips the diagnostic with or without trailing dots', () => {
		expect(cleanStderrForDisplay('Reading additional input from stdin\n')).toBe('');
		expect(cleanStderrForDisplay('Reading additional input from stdin.\n')).toBe('');
		expect(cleanStderrForDisplay('Reading additional input from stdin...\n')).toBe('');
	});

	it('is case-insensitive and tolerates leading/trailing whitespace', () => {
		expect(cleanStderrForDisplay('  reading Additional Input FROM stdin...   \n')).toBe('');
	});

	it('preserves real errors while dropping the benign diagnostic', () => {
		const input = 'Reading additional input from stdin...\nError: rate limited\n';
		const cleaned = cleanStderrForDisplay(input);
		expect(cleaned).toContain('Error: rate limited');
		expect(cleaned).not.toMatch(/reading additional input/i);
	});

	it('collapses to empty when only benign lines remain after filtering', () => {
		const input = 'Reading additional input from stdin...\n\n\n';
		expect(cleanStderrForDisplay(input)).toBe('');
	});

	it('leaves unrelated stderr content untouched', () => {
		const input = 'Error: model unavailable\nretry after 60s\n';
		expect(cleanStderrForDisplay(input)).toBe(input);
	});

	it('does not match lines that merely contain the phrase later on', () => {
		// Only line-prefix matches are stripped — a legitimate error that happens
		// to mention stdin somewhere inside the line must survive.
		const input = 'Error while reading additional input from stdin\n';
		expect(cleanStderrForDisplay(input)).toBe(input);
	});
});
