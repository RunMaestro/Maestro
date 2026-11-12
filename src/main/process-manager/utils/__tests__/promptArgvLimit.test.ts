import { describe, it, expect } from 'vitest';
import { POSIX_PROMPT_ARGV_MAX_BYTES, promptExceedsPosixArgvLimit } from '../promptArgvLimit';

describe('promptExceedsPosixArgvLimit', () => {
	it('allows a prompt at the limit and refuses one byte past it', () => {
		expect(promptExceedsPosixArgvLimit('x'.repeat(POSIX_PROMPT_ARGV_MAX_BYTES))).toBe(false);
		expect(promptExceedsPosixArgvLimit('x'.repeat(POSIX_PROMPT_ARGV_MAX_BYTES + 1))).toBe(true);
	});

	it('counts UTF-8 bytes, not characters', () => {
		// 40,000 three-byte characters are 120,000 bytes: under the limit by
		// length, over it by bytes.
		const cjk = '漢'.repeat(40_000);
		expect(cjk.length).toBeLessThan(POSIX_PROMPT_ARGV_MAX_BYTES);
		expect(promptExceedsPosixArgvLimit(cjk)).toBe(true);
	});

	it('allows an ordinary prompt', () => {
		expect(promptExceedsPosixArgvLimit('Summarize the last turn.')).toBe(false);
		expect(promptExceedsPosixArgvLimit('')).toBe(false);
	});
});
