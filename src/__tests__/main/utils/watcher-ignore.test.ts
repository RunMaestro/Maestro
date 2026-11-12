import { describe, it, expect } from 'vitest';
import path from 'path';
import { ignoreDotfilesUnder, ignoreUnderRoot } from '../../../main/utils/watcher-ignore';

describe('ignoreDotfilesUnder', () => {
	// The default Auto Run folder sits inside a dot-directory; the bare dotfile
	// regex matched every path under it and the watcher reported nothing.
	const root = path.join(path.sep, 'repo', '.maestro', 'playbooks');
	const ignored = ignoreDotfilesUnder(root);

	it('does not ignore the root even when an ancestor is a dot-directory', () => {
		expect(ignored(root)).toBe(false);
	});

	it('does not ignore ordinary files and folders below the root', () => {
		expect(ignored(path.join(root, 'PLAN.md'))).toBe(false);
		expect(ignored(path.join(root, '2026-10-10-Local-Models', 'LOCAL-MODELS-10.md'))).toBe(false);
	});

	it('ignores dotfiles and dot-directories below the root', () => {
		expect(ignored(path.join(root, '.DS_Store'))).toBe(true);
		expect(ignored(path.join(root, '.hidden', 'doc.md'))).toBe(true);
		expect(ignored(path.join(root, 'sub', '.draft.md'))).toBe(true);
	});

	it('does not ignore paths outside the root', () => {
		expect(ignored(path.join(path.sep, 'repo', '.git', 'HEAD'))).toBe(false);
	});
});

describe('ignoreUnderRoot', () => {
	const root = path.join(path.sep, 'repo', '.maestro', 'playbooks');
	const file = { isFile: () => true };
	const dir = { isFile: () => false };
	const ignored = ignoreUnderRoot(root, {
		skipDirNames: ['node_modules', '__pycache__'],
		onlyFileExtensions: ['.md'],
	});

	it('skips the named trees at any depth, case-insensitively', () => {
		expect(ignored(path.join(root, 'node_modules'))).toBe(true);
		expect(ignored(path.join(root, 'app', 'Node_Modules', 'x', 'README.md'), file)).toBe(true);
		expect(ignored(path.join(root, 'tool', '__pycache__'))).toBe(true);
	});

	it('ignores files of other types but still walks directories', () => {
		expect(ignored(path.join(root, 'app', 'main.ts'), file)).toBe(true);
		expect(ignored(path.join(root, 'app', 'DOC.MD'), file)).toBe(false);
		expect(ignored(path.join(root, 'app'), dir)).toBe(false);
		// Before chokidar has stat'ed a path it cannot tell a file from a folder.
		expect(ignored(path.join(root, 'app', 'main.ts'))).toBe(false);
	});

	it('keeps the dotfile rule and never ignores the root or paths outside it', () => {
		expect(ignored(path.join(root, '.git', 'HEAD'), file)).toBe(true);
		expect(ignored(root, dir)).toBe(false);
		expect(ignored(path.join(path.sep, 'elsewhere', 'node_modules'))).toBe(false);
	});
});
