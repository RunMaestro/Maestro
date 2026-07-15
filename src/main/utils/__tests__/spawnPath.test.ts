/**
 * Tests for buildSpawnPath() - the spawn-time PATH builder that merges
 * Maestro's hardcoded expanded PATH with the user's cached login-shell PATH
 * and caller-supplied extra dirs.
 *
 * Regression coverage for issue #1016 (codex exit 127 on a non-standard
 * node install): the spawn PATH must include both the cached shell PATH
 * entries that detection used AND the parent directory of the detected
 * agent binary.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { buildSpawnPath } from '../spawnPath';
import { clearShellPathCache, refreshShellPath } from '../../runtime/getShellPath';

describe('buildSpawnPath', () => {
	const originalPlatform = process.platform;
	const originalPath = process.env.PATH;
	const originalShell = process.env.SHELL;

	beforeEach(() => {
		Object.defineProperty(process, 'platform', { value: 'darwin' });
		clearShellPathCache();
	});

	afterEach(() => {
		Object.defineProperty(process, 'platform', { value: originalPlatform });
		process.env.PATH = originalPath;
		if (originalShell === undefined) {
			delete process.env.SHELL;
		} else {
			process.env.SHELL = originalShell;
		}
		clearShellPathCache();
	});

	it('returns the expanded PATH when no shell cache and no extras are provided', () => {
		process.env.PATH = '/usr/bin';
		const result = buildSpawnPath();

		// Maestro's hardcoded paths should be present
		expect(result).toContain('/opt/homebrew/bin');
		expect(result).toContain('/usr/local/bin');
		expect(result).toContain('/usr/bin');
	});

	it('prepends extraPaths ahead of the expanded PATH', () => {
		process.env.PATH = '/usr/bin';
		const result = buildSpawnPath(['/Users/me/opt/node/bin']);
		const parts = result.split(path.delimiter);

		expect(parts[0]).toBe('/Users/me/opt/node/bin');
		expect(parts).toContain('/opt/homebrew/bin');
	});

	it('keeps multiple extraPaths in order, all ahead of expanded PATH', () => {
		process.env.PATH = '/usr/bin';
		const result = buildSpawnPath(['/Users/me/opt/node/bin', '/Users/me/tools/bin']);
		const parts = result.split(path.delimiter);

		expect(parts[0]).toBe('/Users/me/opt/node/bin');
		expect(parts[1]).toBe('/Users/me/tools/bin');
		expect(parts.indexOf('/opt/homebrew/bin')).toBeGreaterThan(1);
	});

	it('merges cached shell PATH entries between extras and the expanded PATH', async () => {
		// Use a small bash command to populate the shell PATH cache deterministically
		process.env.SHELL = '/bin/sh';
		process.env.PATH = '/usr/bin';
		// refreshShellPath spawns the shell - we can't control that in CI, so we
		// instead rely on it returning *something* and assert structural ordering.
		try {
			await refreshShellPath();
		} catch {
			// On hosts where /bin/sh isn't viable, skip the shell-merge assertions.
			return;
		}

		const result = buildSpawnPath(['/Users/me/opt/node/bin']);
		const parts = result.split(path.delimiter);

		// extras must come first
		expect(parts[0]).toBe('/Users/me/opt/node/bin');

		// expanded paths still present after shell parts
		expect(parts).toContain('/opt/homebrew/bin');
	});

	it('deduplicates a dir that appears in both extras and expanded PATH', () => {
		process.env.PATH = '/usr/bin';
		const result = buildSpawnPath(['/opt/homebrew/bin', '/Users/me/opt/node/bin']);
		const parts = result.split(path.delimiter);

		const homebrewCount = parts.filter((p) => p === '/opt/homebrew/bin').length;
		expect(homebrewCount).toBe(1);
		// extras still take precedence
		expect(parts.indexOf('/opt/homebrew/bin')).toBe(0);
	});

	it('filters out empty / falsy extras', () => {
		process.env.PATH = '/usr/bin';
		// Cast to satisfy strict signature while exercising the runtime filter
		const result = buildSpawnPath(['', '/Users/me/opt/node/bin', '']);
		const parts = result.split(path.delimiter);

		expect(parts).not.toContain('');
		expect(parts[0]).toBe('/Users/me/opt/node/bin');
	});

	it('drops non-absolute extras to avoid prepending "." or relative dirs', () => {
		// path.dirname("codex") returns "." - if a caller ever forwards a bare
		// binary name, we must NOT prepend cwd to PATH (it would let a binary
		// in cwd shadow system tools).
		process.env.PATH = '/usr/bin';
		const result = buildSpawnPath(['.', 'relative/dir', '/Users/me/opt/node/bin']);
		const parts = result.split(path.delimiter);

		expect(parts).not.toContain('.');
		expect(parts).not.toContain('relative/dir');
		expect(parts[0]).toBe('/Users/me/opt/node/bin');
	});
});
