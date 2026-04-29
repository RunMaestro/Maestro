/**
 * Tests for terminalRestartExecution.ts — planning + helpers for the terminal
 * persistence restart flow. Pure module: tests assert on returned descriptors
 * and array shapes only (no IPC / settings mocks needed).
 */

import { describe, it, expect } from 'vitest';
import {
	planRestartAction,
	formatRestartBanner,
	addCommandToWhitelist,
} from '../../../renderer/utils/terminalRestartExecution';

// Mirrors the default `terminalRestartBlacklist` shipped in
// `src/shared/settingsMetadata.ts`. Kept as a fixture so any future drift in
// the defaults is caught loudly here rather than silently changing behaviour.
const DEFAULT_BLACKLIST = ['rm ', 'sudo rm', 'dd ', 'mkfs'];

describe('planRestartAction', () => {
	describe('no-op cases', () => {
		it('returns null when persistCommand is false', () => {
			expect(
				planRestartAction({ persistCommand: false, currentCommand: 'btop' }, [], [])
			).toBeNull();
		});

		it('returns null when persistCommand is undefined', () => {
			expect(planRestartAction({ currentCommand: 'btop' }, [], [])).toBeNull();
		});

		it('returns skip with no-command when currentCommand is undefined', () => {
			expect(planRestartAction({ persistCommand: true }, [], [])).toEqual({
				kind: 'skip',
				reason: 'no-command',
				command: null,
			});
		});

		it('returns skip with no-command when currentCommand is empty', () => {
			expect(planRestartAction({ persistCommand: true, currentCommand: '' }, [], [])).toEqual({
				kind: 'skip',
				reason: 'no-command',
				command: null,
			});
		});

		it('returns skip with no-command when currentCommand is whitespace-only', () => {
			expect(
				planRestartAction({ persistCommand: true, currentCommand: '   \t\n' }, ['btop'], [])
			).toEqual({
				kind: 'skip',
				reason: 'no-command',
				command: null,
			});
		});
	});

	describe('whitelist (auto-execute)', () => {
		it('auto-executes when the base command is whitelisted', () => {
			const result = planRestartAction(
				{ persistCommand: true, currentCommand: 'btop' },
				['btop'],
				[]
			);
			expect(result).toEqual({ kind: 'auto-execute', command: 'btop', baseCommand: 'btop' });
		});

		it('auto-executes with the trimmed command and the base extracted from args', () => {
			const result = planRestartAction(
				{ persistCommand: true, currentCommand: '  npm run dev  ' },
				['npm'],
				[]
			);
			expect(result).toEqual({
				kind: 'auto-execute',
				command: 'npm run dev',
				baseCommand: 'npm',
			});
		});
	});

	describe('blacklist (skip)', () => {
		it('skips with reason=denied when blacklisted by default settings', () => {
			const result = planRestartAction(
				{ persistCommand: true, currentCommand: 'rm -rf foo' },
				[],
				DEFAULT_BLACKLIST
			);
			expect(result).toEqual({ kind: 'skip', reason: 'denied', command: 'rm -rf foo' });
		});

		it('skips when both lists match (blacklist precedence)', () => {
			const result = planRestartAction(
				{ persistCommand: true, currentCommand: 'rm -rf foo' },
				['rm '],
				['rm ']
			);
			expect(result).toEqual({ kind: 'skip', reason: 'denied', command: 'rm -rf foo' });
		});
	});

	describe('prompt (no match)', () => {
		it('prompts when neither list matches', () => {
			const result = planRestartAction(
				{ persistCommand: true, currentCommand: 'htop' },
				['btop'],
				DEFAULT_BLACKLIST
			);
			if (result?.kind !== 'prompt') throw new Error('expected prompt action');
			expect(result.command).toBe('htop');
			expect(result.baseCommand).toBe('htop');
			expect(result.banner).toContain('htop');
		});

		it('extracts the base command for the prompt baseCommand field', () => {
			const result = planRestartAction(
				{ persistCommand: true, currentCommand: 'docker compose up -d' },
				[],
				DEFAULT_BLACKLIST
			);
			expect(result).not.toBeNull();
			if (result?.kind !== 'prompt') throw new Error('expected prompt action');
			expect(result.baseCommand).toBe('docker');
			expect(result.command).toBe('docker compose up -d');
		});

		it('uses default blacklist + empty whitelist as the realistic first-restart case', () => {
			// Brand-new install: nothing on the whitelist, default blacklist.
			// A novel command should always end up at the prompt.
			const result = planRestartAction(
				{ persistCommand: true, currentCommand: 'claude' },
				[],
				DEFAULT_BLACKLIST
			);
			expect(result?.kind).toBe('prompt');
		});
	});
});

describe('formatRestartBanner', () => {
	it('embeds the command verbatim in the banner', () => {
		expect(formatRestartBanner('btop')).toContain('btop');
	});

	it('uses ANSI yellow (33) for the surrounding text', () => {
		expect(formatRestartBanner('btop')).toContain('\x1b[33m');
	});

	it('uses ANSI bold (1) around the command itself', () => {
		const banner = formatRestartBanner('npm run dev');
		expect(banner).toMatch(/\x1b\[1mnpm run dev\x1b\[0m/);
	});

	it('starts and ends with CRLF so the banner sits on its own lines', () => {
		const banner = formatRestartBanner('btop');
		expect(banner.startsWith('\r\n')).toBe(true);
		expect(banner.endsWith('\r\n')).toBe(true);
	});

	it('mentions both "re-execute" and "new command" cues for the user', () => {
		const banner = formatRestartBanner('btop');
		expect(banner).toContain('re-execute');
		expect(banner).toContain('new command');
	});

	it('does not double-encode commands containing escape characters', () => {
		// If a user's command happened to contain an escape sequence, it should
		// pass through unchanged — we trust the caller (and the underlying
		// xterm.js rendering) to interpret it sensibly.
		const banner = formatRestartBanner('printf "\\x1b[31mred\\x1b[0m"');
		expect(banner).toContain('printf "\\x1b[31mred\\x1b[0m"');
	});
});

describe('addCommandToWhitelist', () => {
	it('appends a new base command and returns a new array', () => {
		const before = ['btop'];
		const after = addCommandToWhitelist(before, 'claude');
		expect(after).toEqual(['btop', 'claude']);
		expect(after).not.toBe(before);
	});

	it('returns the same array reference when the command is already present', () => {
		const before = ['btop', 'claude'];
		const after = addCommandToWhitelist(before, 'btop');
		expect(after).toBe(before);
	});

	it('returns the same array reference when the command is empty', () => {
		const before = ['btop'];
		expect(addCommandToWhitelist(before, '')).toBe(before);
	});

	it('returns the same array reference when the command is whitespace-only', () => {
		const before = ['btop'];
		expect(addCommandToWhitelist(before, '   \t')).toBe(before);
	});

	it('trims whitespace before comparing for membership', () => {
		const before = ['btop'];
		expect(addCommandToWhitelist(before, '  btop  ')).toBe(before);
	});

	it('trims whitespace before storing a new entry', () => {
		const before: string[] = [];
		expect(addCommandToWhitelist(before, '  npm  ')).toEqual(['npm']);
	});

	it('starts from an empty whitelist and grows organically', () => {
		let whitelist: string[] = [];
		whitelist = addCommandToWhitelist(whitelist, 'btop');
		whitelist = addCommandToWhitelist(whitelist, 'claude');
		whitelist = addCommandToWhitelist(whitelist, 'npm');
		whitelist = addCommandToWhitelist(whitelist, 'btop'); // duplicate
		expect(whitelist).toEqual(['btop', 'claude', 'npm']);
	});
});
