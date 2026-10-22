import { describe, expect, it } from 'vitest';
import { isPathInsideRoot, normalizeRootRelativePath } from '../../shared/pathContainment';

describe('normalizeRootRelativePath', () => {
	it.each([
		['People/Ada.md', 'People/Ada.md'],
		['./People/Ada.md', 'People/Ada.md'],
		['People//Ada.md', 'People/Ada.md'],
		['People/./Ada.md', 'People/Ada.md'],
		['People/Ada.md/', 'People/Ada.md'],
		['People\\Ada.md', 'People/Ada.md'],
		['Views/../People/Ada.md', 'People/Ada.md'],
		['a/b/../../c.md', 'c.md'],
		['a/b/c/../../../d.md', 'd.md'],
		['...md', '...md'],
		['notes.../x.md', 'notes.../x.md'],
		['a b/c .md', 'a b/c .md'],
		['~/notes.md', '~/notes.md'],
		['file:/x.md', 'file:/x.md'],
	])('normalizes %j to %j', (input, expected) => {
		expect(normalizeRootRelativePath(input)).toBe(expected);
	});

	it.each(['', '.', './', './/.', 'a/..', 'a/b/../..'])('reads %j as the root itself', (input) => {
		expect(normalizeRootRelativePath(input)).toBe('');
	});

	it.each([
		'..',
		'../a.md',
		'a/../../b.md',
		'./../a.md',
		'..\\a.md',
		'a\\..\\..\\b.md',
		'a/..\\../b.md',
	])('refuses %j, which climbs out of the root', (input) => {
		expect(normalizeRootRelativePath(input)).toBeNull();
	});

	it.each([
		'/etc/passwd',
		'/',
		'\\Windows\\win.ini',
		'//server/share/x.md',
		'\\\\server\\share\\x.md',
		'\\\\?\\C:\\Windows\\win.ini',
		'C:\\Windows\\win.ini',
		'C:/Windows/win.ini',
		'c:x.md',
		'Z:',
	])('refuses %j, which is absolute or drive-qualified', (input) => {
		expect(normalizeRootRelativePath(input)).toBeNull();
	});

	it.each(['.. /a.md', 'a/.../b.md', 'a/. ./b.md', '. ', '...'])(
		'refuses %j, a segment Windows could trim into a dot segment',
		(input) => {
			expect(normalizeRootRelativePath(input)).toBeNull();
		}
	);

	it('refuses a NUL byte', () => {
		expect(normalizeRootRelativePath('a.md\0.png')).toBeNull();
	});
});

describe('isPathInsideRoot', () => {
	it('is true for a path that stays inside, the root itself included', () => {
		expect(isPathInsideRoot('People/Ada.md')).toBe(true);
		expect(isPathInsideRoot('a/../b.md')).toBe(true);
		expect(isPathInsideRoot('')).toBe(true);
	});

	it('is false for traversal, absolute, and drive paths', () => {
		expect(isPathInsideRoot('../a.md')).toBe(false);
		expect(isPathInsideRoot('/etc/passwd')).toBe(false);
		expect(isPathInsideRoot('C:\\Windows')).toBe(false);
	});
});
