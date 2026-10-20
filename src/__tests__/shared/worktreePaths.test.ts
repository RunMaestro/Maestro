import { describe, it, expect } from 'vitest';
import { isPathAtOrUnderRoot, normalizeWorktreePath } from '../../shared/worktreePaths';

describe('isPathAtOrUnderRoot', () => {
	it('matches the root itself and paths under it', () => {
		expect(isPathAtOrUnderRoot('/a/b', '/a/b')).toBe(true);
		expect(isPathAtOrUnderRoot('/a/b/c', '/a/b')).toBe(true);
	});

	it('does not match a similarly named sibling', () => {
		expect(isPathAtOrUnderRoot('/a/bc', '/a/b')).toBe(false);
	});

	it('treats / as the parent of everything', () => {
		expect(isPathAtOrUnderRoot('/a', '/')).toBe(true);
	});

	it('treats a normalized Windows drive root as the parent of the drive', () => {
		const root = normalizeWorktreePath('C:\\');
		expect(root).toBe('C:/');
		expect(isPathAtOrUnderRoot(normalizeWorktreePath('C:\\vault\\notes'), root)).toBe(true);
		expect(isPathAtOrUnderRoot(normalizeWorktreePath('D:\\vault'), root)).toBe(false);
	});
});
