import { describe, expect, it } from 'vitest';
import {
	foldPathSegment,
	hasGitMetadataSegment,
	isPathInsideRoot,
	normalizeRootRelativePath,
} from '../../shared/pathContainment';

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

describe('foldPathSegment', () => {
	it.each([
		['.git', '.git'],
		['.GIT', '.git'],
		['.Git', '.git'],
		['.git.', '.git'],
		['.git ', '.git'],
		['.git. .', '.git'],
		['.git::$INDEX_ALLOCATION', '.git'],
		['.git:stream', '.git'],
		['Prompts', 'prompts'],
		['prompts', 'prompts'],
		['notes.md', 'notes.md'],
		['a.b', 'a.b'],
		['', ''],
	])('folds %j to %j', (input, expected) => {
		expect(foldPathSegment(input)).toBe(expected);
	});

	// The special characters are built from code points so this file stays ASCII.
	it.each([
		['a zero-width non-joiner', `.g${String.fromCodePoint(0x200c)}it`, '.git'],
		['a left-to-right mark', `.${String.fromCodePoint(0x200e)}git`, '.git'],
		['a right-to-left override', `.git${String.fromCodePoint(0x202e)}`, '.git'],
		['a byte order mark', `${String.fromCodePoint(0xfeff)}.git`, '.git'],
		['a long s, which APFS folds to s', `.mae${String.fromCodePoint(0x17f)}tro`, '.maestro'],
	])('folds %s away', (_label, input, expected) => {
		expect(foldPathSegment(input)).toBe(expected);
	});
});

describe('hasGitMetadataSegment', () => {
	it.each([
		'.git',
		'.git/hooks/pre-commit',
		'workspaces/proj/.git/config',
		'sub/.GIT/config',
		'a/.Git/hooks/x',
		'a\\.git\\hooks\\x',
		'a/.git./config',
		'a/.git /config',
		'.git::$INDEX_ALLOCATION/hooks/x',
		'GIT~1/hooks/x',
		'a/git~1/config',
	])('finds git metadata in %j', (input) => {
		expect(hasGitMetadataSegment(input)).toBe(true);
	});

	it('finds a name with a zero-width character hidden in it', () => {
		expect(
			hasGitMetadataSegment(`workspaces/proj/.g${String.fromCodePoint(0x200d)}it/hooks/x`)
		).toBe(true);
	});

	it.each([
		'',
		'README.md',
		'.github/workflows/ci.yml',
		'.gitignore',
		'.gitattributes',
		'src/git.ts',
		'a/.git-hooks/x',
		'sub.git/x',
		'workspaces/proj/.maestro/prompts/tick.md',
	])('does not flag %j', (input) => {
		expect(hasGitMetadataSegment(input)).toBe(false);
	});
});
