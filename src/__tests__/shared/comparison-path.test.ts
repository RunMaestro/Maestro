import { describe, expect, it } from 'vitest';
import {
	normalizeCopilotPathForComparison,
	normalizeWorktreePathForComparison,
} from '../../shared/comparison-path';

describe('comparison path normalization', () => {
	it.each([
		['POSIX separators and a trailing slash', '/worktrees/maestro/', '/worktrees/maestro'],
		[
			'Windows separators and duplicate separators',
			'C:\\worktrees\\\\maestro\\',
			'C:/worktrees/maestro',
		],
		['a POSIX root', '/', ''],
		[
			'dot segments without resolving them',
			'/worktrees/maestro/../other',
			'/worktrees/maestro/../other',
		],
		['a UNC path', '\\\\server\\share\\\\maestro\\', '/server/share/maestro'],
		['a drive-letter path without case folding', 'C:\\Repo\\Maestro', 'C:/Repo/Maestro'],
		[
			'a symlink-shaped path without resolving it',
			'/links/current/project',
			'/links/current/project',
		],
		['a remote POSIX path without resolving it', '~/projects/maestro/', '~/projects/maestro'],
	])('normalizes worktree paths with %s', (_scenario, input, expected) => {
		expect(normalizeWorktreePathForComparison(input)).toBe(expected);
	});

	it('keeps worktree comparison case-sensitive on every host platform', () => {
		expect(normalizeWorktreePathForComparison('/Projects/Maestro')).not.toBe(
			normalizeWorktreePathForComparison('/projects/maestro')
		);
	});

	it.each([
		['missing and empty values', undefined, null],
		['POSIX separators and a trailing slash', '/worktrees/maestro/', '/worktrees/maestro'],
		['Windows separators and a trailing slash', 'C:\\Repo\\Maestro\\', 'c:/repo/maestro'],
		['a POSIX root', '/', '/'],
		['dot segments without resolving them', 'C:\\Repo\\..\\Other', 'c:/repo/../other'],
		[
			'a UNC path without collapsing its leading authority marker',
			'\\\\server\\share\\maestro\\',
			'//server/share/maestro',
		],
		[
			'a symlink-shaped path without resolving it',
			'/links/current/project',
			'/links/current/project',
		],
		['a remote POSIX path without resolving it', '~/projects/maestro/', '~/projects/maestro'],
	])('normalizes Copilot comparison paths with %s', (_scenario, input, expected) => {
		expect(normalizeCopilotPathForComparison(input)).toBe(expected);
	});

	it('case-folds only drive-letter paths for Copilot comparison', () => {
		expect(normalizeCopilotPathForComparison('C:\\Repo\\Maestro')).toBe('c:/repo/maestro');
		expect(normalizeCopilotPathForComparison('/Projects/Maestro')).toBe('/Projects/Maestro');
	});
});
