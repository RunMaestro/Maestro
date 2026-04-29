/**
 * Tests for terminalCommandPolicy.ts — whitelist/blacklist policy resolver
 * for the terminal-persistence restart re-execution flow.
 */

import { describe, it, expect } from 'vitest';
import { checkCommandPolicy } from '../../../renderer/utils/terminalCommandPolicy';

// Mirrors the default `terminalRestartBlacklist` shipped in
// `src/shared/settingsMetadata.ts`. Kept as a fixture so any future drift in
// the defaults is caught loudly here rather than silently weakening safety
// at runtime.
const DEFAULT_BLACKLIST = ['rm ', 'sudo rm', 'dd ', 'mkfs'];

describe('checkCommandPolicy', () => {
	describe('default (no patterns)', () => {
		it('returns ask when both lists are empty', () => {
			expect(checkCommandPolicy('btop', [], [])).toBe('ask');
		});

		it('returns ask for an empty command with empty lists', () => {
			expect(checkCommandPolicy('', [], [])).toBe('ask');
		});

		it('returns ask for a whitespace-only command with empty lists', () => {
			expect(checkCommandPolicy('   \t\n', [], [])).toBe('ask');
		});
	});

	describe('whitelist matching', () => {
		it('allows when the base command exactly equals a whitelist pattern', () => {
			expect(checkCommandPolicy('btop', ['btop'], [])).toBe('allow');
		});

		it('allows when the command starts with a whitelist pattern', () => {
			expect(checkCommandPolicy('npm run dev', ['npm'], [])).toBe('allow');
		});

		it('allows when a later whitelist pattern matches', () => {
			expect(checkCommandPolicy('claude --resume', ['btop', 'claude'], [])).toBe('allow');
		});

		it('does not allow when no whitelist pattern matches', () => {
			expect(checkCommandPolicy('htop', ['btop', 'claude'], [])).toBe('ask');
		});

		it('trims leading and trailing whitespace before matching', () => {
			expect(checkCommandPolicy('  btop  ', ['btop'], [])).toBe('allow');
		});
	});

	describe('blacklist matching', () => {
		it('denies when a blacklist prefix matches', () => {
			expect(checkCommandPolicy('rm -rf foo', DEFAULT_BLACKLIST, ['rm '])).toBe('deny');
		});

		it('denies when the base command exactly equals a blacklist pattern', () => {
			expect(checkCommandPolicy('mkfs', [], DEFAULT_BLACKLIST)).toBe('deny');
		});

		it('denies sudo rm via the multi-token prefix', () => {
			expect(checkCommandPolicy('sudo rm -rf /', [], DEFAULT_BLACKLIST)).toBe('deny');
		});

		it('does not deny `rmdir` because the default blacklist uses `rm ` (with trailing space)', () => {
			expect(checkCommandPolicy('rmdir foo', [], DEFAULT_BLACKLIST)).toBe('ask');
		});

		it('does not deny commands that merely contain a blacklisted token elsewhere', () => {
			expect(checkCommandPolicy('echo "do not rm anything"', [], DEFAULT_BLACKLIST)).toBe('ask');
		});
	});

	describe('precedence', () => {
		it('blacklist wins when the same command appears in both lists', () => {
			expect(checkCommandPolicy('rm -rf foo', ['rm '], ['rm '])).toBe('deny');
		});

		it('blacklist wins when whitelist matches the base but blacklist matches the prefix', () => {
			expect(checkCommandPolicy('sudo rm -rf /', ['sudo'], ['sudo rm'])).toBe('deny');
		});
	});

	describe('tokenization', () => {
		it('splits the base command on any whitespace (not just space)', () => {
			expect(checkCommandPolicy('btop\t-t', ['btop'], [])).toBe('allow');
		});

		it('uses the first token as the base, even with collapsed whitespace', () => {
			expect(checkCommandPolicy('npm   run    dev', ['npm'], [])).toBe('allow');
		});
	});
});
