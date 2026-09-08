/**
 * @file sshOptions.test.ts
 * @description Tests for the shared `ssh -o` option resolver.
 */

import { describe, it, expect } from 'vitest';
import {
	DEFAULT_SSH_OPTIONS,
	RESERVED_SSH_OPTION_KEYS,
	buildSshOptionArgs,
	isReservedSshOptionKey,
	normalizeSshOptions,
	parseSshOptionAssignments,
	resolveSshOptions,
	sshOptionArgs,
	validateSshOption,
} from '../../shared/sshOptions';

describe('resolveSshOptions', () => {
	it('returns the non-interactive defaults when there are no overrides', () => {
		expect(resolveSshOptions(undefined)).toEqual({ ...DEFAULT_SSH_OPTIONS });
	});

	it('lets a remote raise ConnectTimeout, which is unreachable via ~/.ssh/config', () => {
		// A command-line -o outranks the config file, so before overrides existed
		// there was no way for a slow tunnel to get more than 10 seconds.
		const resolved = resolveSshOptions({ ConnectTimeout: '45' });
		expect(resolved.ConnectTimeout).toBe('45');
		expect(resolved.BatchMode).toBe('yes');
	});

	it('adds an unknown option such as ProxyCommand alongside the defaults', () => {
		const resolved = resolveSshOptions({ ProxyCommand: '/opt/homebrew/bin/tailcat tcABC 22' });
		expect(resolved.ProxyCommand).toBe('/opt/homebrew/bin/tailcat tcABC 22');
		expect(resolved.StrictHostKeyChecking).toBe('accept-new');
	});

	it('matches an override to a default case-insensitively', () => {
		// OpenSSH keywords are case-insensitive but -o flags are FIRST-WINS, so
		// emitting both spellings would silently keep the default and make the
		// user's override a no-op.
		const resolved = resolveSshOptions({ connecttimeout: '30' });
		expect(resolved.ConnectTimeout).toBe('30');
		expect(resolved).not.toHaveProperty('connecttimeout');
	});

	it('never emits the same keyword twice', () => {
		const args = buildSshOptionArgs({ CONNECTTIMEOUT: '30', ProxyJump: 'bastion' });
		const keywords = args.filter((_, i) => i % 2 === 1).map((pair) => pair.split('=')[0]);
		expect(new Set(keywords).size).toBe(keywords.length);
	});

	it('ignores an attempt to override RequestTTY', () => {
		// RequestTTY is derived per command from whether the agent speaks
		// stream-json; a forced TTY corrupts that stream.
		const resolved = resolveSshOptions({ RequestTTY: 'force' });
		expect(resolved.RequestTTY).toBe('no');
	});

	it('sets RequestTTY=force when the caller forces a TTY', () => {
		expect(resolveSshOptions(undefined, { forceTty: true }).RequestTTY).toBe('force');
	});

	describe('interactive context', () => {
		it('drops BatchMode, RequestTTY and LogLevel', () => {
			const resolved = resolveSshOptions(undefined, { context: 'interactive' });
			// The user is at the keyboard: they can answer a passphrase prompt, the
			// caller passes -t, and SSH's own warnings are the diagnostics.
			expect(resolved).not.toHaveProperty('BatchMode');
			expect(resolved).not.toHaveProperty('RequestTTY');
			expect(resolved).not.toHaveProperty('LogLevel');
			expect(resolved.ConnectTimeout).toBe('10');
			expect(resolved.ClearAllForwardings).toBe('yes');
		});

		it('does not let an override reinstate a dropped option', () => {
			const resolved = resolveSshOptions({ BatchMode: 'yes' }, { context: 'interactive' });
			expect(resolved).not.toHaveProperty('BatchMode');
		});

		it('still accepts an unrelated override', () => {
			const resolved = resolveSshOptions(
				{ ProxyCommand: 'tailcat tcABC 22' },
				{ context: 'interactive' }
			);
			expect(resolved.ProxyCommand).toBe('tailcat tcABC 22');
		});
	});
});

describe('sshOptionArgs', () => {
	it('flattens into -o KEY=VALUE pairs', () => {
		expect(sshOptionArgs({ ConnectTimeout: '10', ProxyJump: 'bastion' })).toEqual([
			'-o',
			'ConnectTimeout=10',
			'-o',
			'ProxyJump=bastion',
		]);
	});

	it('keeps a value containing spaces and equals signs as one argument', () => {
		const args = sshOptionArgs({ ProxyCommand: 'tailcat --key=default tcABC 22' });
		expect(args).toEqual(['-o', 'ProxyCommand=tailcat --key=default tcABC 22']);
	});
});

describe('normalizeSshOptions', () => {
	it('returns undefined for an empty or absent record', () => {
		expect(normalizeSshOptions(undefined)).toBeUndefined();
		expect(normalizeSshOptions({})).toBeUndefined();
	});

	it('drops blank and reserved keys', () => {
		expect(normalizeSshOptions({ '  ': 'x', RequestTTY: 'force', ProxyJump: 'bastion' })).toEqual({
			ProxyJump: 'bastion',
		});
	});
});

describe('validateSshOption', () => {
	it('accepts a normal option', () => {
		expect(validateSshOption('ProxyCommand', 'tailcat tcABC 22')).toBeNull();
	});

	it('rejects an empty name', () => {
		expect(validateSshOption('   ', 'x')).toMatch(/cannot be empty/);
	});

	it('rejects a non-alphanumeric name', () => {
		expect(validateSshOption('Proxy Command', 'x')).toMatch(/Invalid SSH option name/);
	});

	it('rejects a reserved name whatever its case', () => {
		expect(validateSshOption('requesttty', 'force')).toMatch(/cannot be overridden/);
	});

	it('rejects a value containing a line break', () => {
		expect(validateSshOption('ProxyCommand', 'a\nb')).toMatch(/line break/);
	});
});

describe('isReservedSshOptionKey', () => {
	it('is case-insensitive over every reserved key', () => {
		for (const key of RESERVED_SSH_OPTION_KEYS) {
			expect(isReservedSshOptionKey(key.toUpperCase())).toBe(true);
		}
		expect(isReservedSshOptionKey('ProxyCommand')).toBe(false);
	});
});

describe('parseSshOptionAssignments', () => {
	it('returns nothing for no entries', () => {
		expect(parseSshOptionAssignments(undefined)).toEqual({});
		expect(parseSshOptionAssignments([])).toEqual({});
	});

	it('splits on the first equals only', () => {
		// A ProxyCommand value routinely contains its own '='.
		expect(parseSshOptionAssignments(['ProxyCommand=tailcat --key=default tcABC 22'])).toEqual({
			options: { ProxyCommand: 'tailcat --key=default tcABC 22' },
		});
	});

	it('reports an entry with no equals', () => {
		expect(parseSshOptionAssignments(['ProxyCommand']).error).toMatch(/Expected KEY=VALUE/);
	});

	it('reports a reserved key rather than silently dropping it', () => {
		expect(parseSshOptionAssignments(['RequestTTY=force']).error).toMatch(/cannot be overridden/);
	});
});
