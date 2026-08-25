import { describe, it, expect } from 'vitest';
import {
	collectAutoRunDocsInFolder,
	relativeAutoRunFolderPath,
} from '../../../renderer/utils/autoRunStaging';

describe('relativeAutoRunFolderPath', () => {
	const root = '/project/.maestro/playbooks';

	it('returns the empty string for the Auto Run folder itself', () => {
		expect(relativeAutoRunFolderPath(root, root)).toBe('');
	});

	it('returns the path relative to the Auto Run folder for a descendant', () => {
		expect(relativeAutoRunFolderPath(`${root}/RET/nested`, root)).toBe('RET/nested');
	});

	it('returns null for a folder outside the Auto Run folder', () => {
		expect(relativeAutoRunFolderPath('/project/docs', root)).toBeNull();
	});

	it('does not treat a sibling with a shared prefix as inside', () => {
		expect(relativeAutoRunFolderPath(`${root}-archive/RET`, root)).toBeNull();
	});

	it('ignores trailing slashes on either side', () => {
		expect(relativeAutoRunFolderPath(`${root}/RET/`, `${root}/`)).toBe('RET');
	});

	it('matches across Windows separators', () => {
		expect(
			relativeAutoRunFolderPath(
				'C:\\project\\.maestro\\playbooks\\RET',
				'C:/project/.maestro/playbooks'
			)
		).toBe('RET');
	});

	it('returns null when either path is missing', () => {
		expect(relativeAutoRunFolderPath(undefined, root)).toBeNull();
		expect(relativeAutoRunFolderPath(root, undefined)).toBeNull();
		expect(relativeAutoRunFolderPath(root, '')).toBeNull();
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
