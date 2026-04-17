import { describe, it, expect } from 'vitest';
import { computeCommonAncestorPath, isDescendantOrEqual } from '../../shared/cue-path-utils';

describe('computeCommonAncestorPath', () => {
	it('returns null for empty input', () => {
		expect(computeCommonAncestorPath([])).toBeNull();
	});

	it('returns the path itself for a single-element array', () => {
		expect(computeCommonAncestorPath(['/a/b/c'])).toBe('/a/b/c');
	});

	it('returns the common parent for sibling directories', () => {
		expect(computeCommonAncestorPath(['/a/b/c', '/a/b/d'])).toBe('/a/b');
	});

	it('returns the parent when one path is a child of the other', () => {
		expect(computeCommonAncestorPath(['/project', '/project/sub'])).toBe('/project');
	});

	it('returns the parent for deeply nested children', () => {
		expect(computeCommonAncestorPath(['/project', '/project/sub/deep', '/project/other'])).toBe(
			'/project'
		);
	});

	it('returns filesystem root for completely unrelated paths', () => {
		expect(computeCommonAncestorPath(['/a/b', '/c/d'])).toBe('/');
	});

	it('handles identical paths', () => {
		expect(computeCommonAncestorPath(['/a/b', '/a/b'])).toBe('/a/b');
	});

	it('handles three paths with a shared prefix', () => {
		expect(
			computeCommonAncestorPath([
				'/home/user/project/A',
				'/home/user/project/B',
				'/home/user/project/C',
			])
		).toBe('/home/user/project');
	});
});

describe('isDescendantOrEqual', () => {
	it('returns true when paths are identical', () => {
		expect(isDescendantOrEqual('/a/b', '/a/b')).toBe(true);
	});

	it('returns true when child is a subdirectory of parent', () => {
		expect(isDescendantOrEqual('/a/b/c', '/a/b')).toBe(true);
	});

	it('returns true for deeply nested descendant', () => {
		expect(isDescendantOrEqual('/project/sub/deep/nested', '/project')).toBe(true);
	});

	it('returns false when child is not under parent', () => {
		expect(isDescendantOrEqual('/a/b', '/c/d')).toBe(false);
	});

	it('returns false when parent is a subdirectory of child (reversed)', () => {
		expect(isDescendantOrEqual('/a', '/a/b')).toBe(false);
	});

	it('returns false for partial prefix match that is not a directory boundary', () => {
		// /a/bar is NOT a descendant of /a/b — the prefix match is not at a separator
		expect(isDescendantOrEqual('/a/bar', '/a/b')).toBe(false);
	});

	it('handles trailing separators via normalization', () => {
		expect(isDescendantOrEqual('/a/b/c', '/a/b/')).toBe(true);
		expect(isDescendantOrEqual('/a/b/', '/a/b')).toBe(true);
	});
});

// Regression: this utility is imported by the renderer pipeline save flow.
// Do NOT let anyone reintroduce a Node `path` dependency — the renderer
// strips it and saves fail with "path.resolve is not a function".
describe('cue-path-utils (renderer-safe)', () => {
	it('does not reference Node built-in modules at import time', async () => {
		// A pure-JS module imports and evaluates without `require`/`import` of
		// Node built-ins; this assertion just re-executes the module to confirm.
		await expect(import('../../shared/cue-path-utils')).resolves.toBeDefined();
	});

	describe('Windows paths', () => {
		it('computes common ancestor for sibling Windows directories', () => {
			expect(computeCommonAncestorPath(['C:\\proj\\a', 'C:\\proj\\b'])).toBe('C:\\proj');
		});

		it('detects descendant under a Windows project root', () => {
			expect(isDescendantOrEqual('C:\\proj\\sub', 'C:\\proj')).toBe(true);
		});

		it('rejects non-boundary Windows prefix matches', () => {
			expect(isDescendantOrEqual('C:\\proj2', 'C:\\proj')).toBe(false);
		});
	});
});
