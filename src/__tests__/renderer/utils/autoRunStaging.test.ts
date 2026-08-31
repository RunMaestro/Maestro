import { describe, it, expect } from 'vitest';
import {
	autoRunDocIdForFile,
	collectAutoRunDocsInFolder,
	relativeToAutoRunFolder,
} from '../../../renderer/utils/autoRunStaging';

describe('relativeToAutoRunFolder', () => {
	const root = '/project/.maestro/playbooks';

	it('returns the empty string for the Auto Run folder itself', () => {
		expect(relativeToAutoRunFolder(root, root)).toBe('');
	});

	it('returns the path relative to the Auto Run folder for a descendant', () => {
		expect(relativeToAutoRunFolder(`${root}/RET/nested`, root)).toBe('RET/nested');
	});

	it('returns null for a folder outside the Auto Run folder', () => {
		expect(relativeToAutoRunFolder('/project/docs', root)).toBeNull();
	});

	it('does not treat a sibling with a shared prefix as inside', () => {
		expect(relativeToAutoRunFolder(`${root}-archive/RET`, root)).toBeNull();
	});

	it('ignores trailing slashes on either side', () => {
		expect(relativeToAutoRunFolder(`${root}/RET/`, `${root}/`)).toBe('RET');
	});

	it('matches across Windows separators', () => {
		expect(
			relativeToAutoRunFolder(
				'C:\\project\\.maestro\\playbooks\\RET',
				'C:/project/.maestro/playbooks'
			)
		).toBe('RET');
	});

	it('returns null when either path is missing', () => {
		expect(relativeToAutoRunFolder(undefined, root)).toBeNull();
		expect(relativeToAutoRunFolder(root, undefined)).toBeNull();
		expect(relativeToAutoRunFolder(root, '')).toBeNull();
	});
});

describe('collectAutoRunDocsInFolder', () => {
	const docs = ['RET/RET-01', 'RET/nested/RET-02', 'RETRO/R-01', 'SPEC'];

	it('returns every document when the folder is the Auto Run folder itself', () => {
		expect(collectAutoRunDocsInFolder('', docs)).toEqual(docs);
	});

	it('includes documents in nested subfolders', () => {
		expect(collectAutoRunDocsInFolder('RET', docs)).toEqual(['RET/RET-01', 'RET/nested/RET-02']);
	});

	it('does not match a sibling folder that shares a name prefix', () => {
		expect(collectAutoRunDocsInFolder('RET', docs)).not.toContain('RETRO/R-01');
	});

	it('returns an empty list when the folder holds no documents', () => {
		expect(collectAutoRunDocsInFolder('Working', docs)).toEqual([]);
	});
});

describe('autoRunDocIdForFile', () => {
	const root = '/project/.maestro/playbooks';

	it('drops the .md extension to form the document id', () => {
		expect(autoRunDocIdForFile(`${root}/RET/RET-01.md`, root)).toBe('RET/RET-01');
	});

	it('handles an uppercase extension', () => {
		expect(autoRunDocIdForFile(`${root}/SPEC.MD`, root)).toBe('SPEC');
	});

	it('returns null for a non-markdown file inside the Auto Run folder', () => {
		expect(autoRunDocIdForFile(`${root}/notes.txt`, root)).toBeNull();
	});

	it('returns null for a markdown file outside the Auto Run folder', () => {
		expect(autoRunDocIdForFile('/project/docs/README.md', root)).toBeNull();
	});

	it('returns null for the Auto Run folder itself', () => {
		expect(autoRunDocIdForFile(root, root)).toBeNull();
	});
});
