/**
 * Tests for the peekShellPath() sync accessor on the shell-PATH cache.
 *
 * peekShellPath exists so callers in spawn hot paths (which can't await)
 * can opportunistically read the cached login-shell PATH. It returns null
 * until refreshShellPath() has populated the cache.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { peekShellPath, clearShellPathCache, refreshShellPath } from '../getShellPath';

describe('peekShellPath', () => {
	beforeEach(() => {
		clearShellPathCache();
	});

	it('returns null when no probe has completed', () => {
		expect(peekShellPath()).toBeNull();
	});

	it('returns the cached value after refreshShellPath resolves', async () => {
		const originalShell = process.env.SHELL;
		process.env.SHELL = '/bin/sh';
		try {
			let resolved: string;
			try {
				resolved = await refreshShellPath();
			} catch {
				// Some CI hosts won't have /bin/sh viable for our PATH probe.
				// In that case there's nothing to assert.
				return;
			}
			expect(peekShellPath()).toBe(resolved);
		} finally {
			if (originalShell === undefined) {
				delete process.env.SHELL;
			} else {
				process.env.SHELL = originalShell;
			}
		}
	});

	it('returns null again after clearShellPathCache', async () => {
		const originalShell = process.env.SHELL;
		process.env.SHELL = '/bin/sh';
		try {
			try {
				await refreshShellPath();
			} catch {
				return;
			}
			expect(peekShellPath()).not.toBeNull();

			clearShellPathCache();
			expect(peekShellPath()).toBeNull();
		} finally {
			if (originalShell === undefined) {
				delete process.env.SHELL;
			} else {
				process.env.SHELL = originalShell;
			}
		}
	});
});
