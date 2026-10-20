/**
 * @file real-path-containment.test.ts
 * @description Real-path containment in main (src/main/utils/real-path-containment.ts): the lexical
 * `isPathWithin`, case folding, and `resolvePathInRealRoot` against a real temp folder with real symlinks
 * (inside, outside, dangling, looping, and a symlinked root).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	foldPathCase,
	isPathWithin,
	realpathThroughAncestor,
	resolvePathInRealRoot,
} from '../../../main/utils/real-path-containment';

describe('isPathWithin', () => {
	const root = path.resolve('/srv/vault');

	it('accepts the root itself and anything under it', () => {
		expect(isPathWithin(root, root)).toBe(true);
		expect(isPathWithin(path.join(root, 'a.md'), root)).toBe(true);
		expect(isPathWithin(path.join(root, 'x', 'y', 'z.md'), root)).toBe(true);
		// A name that merely starts with two dots is still inside.
		expect(isPathWithin(path.join(root, '..notes.md'), root)).toBe(true);
	});

	it('refuses the parent, a sibling sharing a prefix, and anything elsewhere', () => {
		expect(isPathWithin(path.dirname(root), root)).toBe(false);
		expect(isPathWithin(`${root}2`, root)).toBe(false);
		expect(isPathWithin(path.join(`${root}2`, 'a.md'), root)).toBe(false);
		expect(isPathWithin(path.resolve('/etc/passwd'), root)).toBe(false);
	});
});

describe('foldPathCase', () => {
	it('folds on macOS and Windows only', () => {
		expect(foldPathCase('/Users/Me', 'darwin')).toBe('/users/me');
		expect(foldPathCase('C:\\Users\\Me', 'win32')).toBe('c:\\users\\me');
		expect(foldPathCase('/home/Me', 'linux')).toBe('/home/Me');
	});
});

// Symlinks need a privilege Windows runners may lack; the zip-archive and server-secrets tests skip the same way.
describe.skipIf(process.platform === 'win32')('resolvePathInRealRoot', () => {
	let base: string;
	let root: string;
	let outside: string;

	beforeAll(() => {
		base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'real-path-containment-')));
		root = path.join(base, 'vault');
		outside = path.join(base, 'outside');
		fs.mkdirSync(path.join(root, 'notes'), { recursive: true });
		fs.mkdirSync(outside);
		fs.writeFileSync(path.join(root, 'notes', 'a.md'), 'inside');
		fs.writeFileSync(path.join(outside, 'secret.md'), 'secret');
		// A link inside the root to a file inside it, and links that leave the root.
		fs.symlinkSync(path.join(root, 'notes', 'a.md'), path.join(root, 'alias.md'));
		fs.symlinkSync(path.join(outside, 'secret.md'), path.join(root, 'escape.md'));
		fs.symlinkSync(outside, path.join(root, 'escape-dir'));
		fs.symlinkSync(path.join(root, 'gone.md'), path.join(root, 'dangling.md'));
		fs.symlinkSync(path.join(root, 'loop-b'), path.join(root, 'loop-a'));
		fs.symlinkSync(path.join(root, 'loop-a'), path.join(root, 'loop-b'));
		// The root itself reached through a symlink.
		fs.symlinkSync(root, path.join(base, 'vault-link'));
	});

	afterAll(() => {
		fs.rmSync(base, { recursive: true, force: true });
	});

	it('resolves a plain file inside the root', async () => {
		await expect(resolvePathInRealRoot(root, 'notes/a.md')).resolves.toEqual({
			kind: 'inside',
			realPath: path.join(root, 'notes', 'a.md'),
			realRelativePath: 'notes/a.md',
		});
	});

	it('follows a symlink that stays inside, and hands back the target to read', async () => {
		await expect(resolvePathInRealRoot(root, 'alias.md')).resolves.toEqual({
			kind: 'inside',
			realPath: path.join(root, 'notes', 'a.md'),
			// Where the link landed, not the name it was asked by, so callers can apply their rules to it.
			realRelativePath: 'notes/a.md',
		});
	});

	it('refuses a symlinked file or folder that leads out of the root', async () => {
		await expect(resolvePathInRealRoot(root, 'escape.md')).resolves.toEqual({
			kind: 'outside',
			realPath: path.join(outside, 'secret.md'),
		});
		await expect(resolvePathInRealRoot(root, 'escape-dir/secret.md')).resolves.toMatchObject({
			kind: 'outside',
		});
	});

	it('reads a missing file, a dangling link, and a link loop as missing', async () => {
		await expect(resolvePathInRealRoot(root, 'nope.md')).resolves.toEqual({ kind: 'missing' });
		await expect(resolvePathInRealRoot(root, 'notes/a.md/below')).resolves.toEqual({
			kind: 'missing',
		});
		await expect(resolvePathInRealRoot(root, 'dangling.md')).resolves.toEqual({ kind: 'missing' });
		await expect(resolvePathInRealRoot(root, 'loop-a')).resolves.toEqual({ kind: 'missing' });
	});

	it('works when the root itself is reached through a symlink', async () => {
		const linkedRoot = path.join(base, 'vault-link');
		await expect(resolvePathInRealRoot(linkedRoot, 'notes/a.md')).resolves.toEqual({
			kind: 'inside',
			realPath: path.join(root, 'notes', 'a.md'),
			realRelativePath: 'notes/a.md',
		});
		await expect(resolvePathInRealRoot(linkedRoot, 'escape.md')).resolves.toMatchObject({
			kind: 'outside',
		});
	});

	it('throws when the root itself does not exist', async () => {
		await expect(resolvePathInRealRoot(path.join(base, 'no-root'), 'a.md')).rejects.toThrow();
	});

	it('realpathThroughAncestor resolves a file that does not exist yet under a symlinked folder', () => {
		expect(realpathThroughAncestor(path.join(base, 'vault-link', 'new.md'))).toBe(
			path.join(root, 'new.md')
		);
	});
});
