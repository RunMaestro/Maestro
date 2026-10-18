import { describe, it, expect } from 'vitest';
import path from 'path';
import { ignoreDotfilesUnder } from '../../../main/utils/watcher-ignore';

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
