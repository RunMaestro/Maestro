import { describe, it, expect } from 'vitest';
import {
	resolveAutoRunDocumentName,
	resolveAutoRunDocumentNames,
} from '../../shared/autoRunDocumentPaths';

const FOLDER = '/repo/.maestro/playbooks';

describe('resolveAutoRunDocumentName', () => {
	it('strips the folder and .md from an absolute path under the folder', () => {
		expect(resolveAutoRunDocumentName(`${FOLDER}/batch/DOC-01.md`, FOLDER)).toEqual({
			name: 'batch/DOC-01',
		});
	});

	it('tolerates a trailing slash on the folder', () => {
		expect(resolveAutoRunDocumentName(`${FOLDER}/a.md`, `${FOLDER}/`)).toEqual({ name: 'a' });
	});

	it('matches Windows paths case-insensitively and normalizes separators', () => {
		expect(
			resolveAutoRunDocumentName('c:\\Users\\Me\\Docs\\sub\\Task.MD', 'C:\\Users\\me\\Docs')
		).toEqual({ name: 'sub/Task' });
	});

	it('keeps a name that is already folder-relative', () => {
		expect(resolveAutoRunDocumentName('sub/phase-1', FOLDER)).toEqual({ name: 'sub/phase-1' });
		expect(resolveAutoRunDocumentName('./phase-1.md', FOLDER)).toEqual({ name: 'phase-1' });
	});

	it('refuses an absolute path outside the folder by name', () => {
		expect(resolveAutoRunDocumentName('/elsewhere/x.md', FOLDER)).toEqual({
			error: `Document is outside the Auto Run folder (${FOLDER}): /elsewhere/x.md`,
		});
	});

	it('refuses a sibling folder that shares the prefix', () => {
		expect('error' in resolveAutoRunDocumentName(`${FOLDER}-old/x.md`, FOLDER)).toBe(true);
	});

	it('refuses names that climb out of the folder', () => {
		expect('error' in resolveAutoRunDocumentName('../x.md', FOLDER)).toBe(true);
		expect('error' in resolveAutoRunDocumentName(`${FOLDER}/a/../../x.md`, FOLDER)).toBe(true);
	});

	it('refuses the folder itself and an empty path', () => {
		expect('error' in resolveAutoRunDocumentName(FOLDER, FOLDER)).toBe(true);
		expect('error' in resolveAutoRunDocumentName('  ', FOLDER)).toBe(true);
	});
});

describe('resolveAutoRunDocumentNames', () => {
	it('converts every entry and keeps its other fields', () => {
		expect(
			resolveAutoRunDocumentNames(
				[{ filename: `${FOLDER}/a.md`, resetOnCompletion: true }, { filename: 'b' }],
				FOLDER
			)
		).toEqual({ documents: [{ filename: 'a', resetOnCompletion: true }, { filename: 'b' }] });
	});

	it('returns the first refusal', () => {
		expect(
			resolveAutoRunDocumentNames([{ filename: 'a' }, { filename: '/x/y.md' }], FOLDER)
		).toEqual({ error: `Document is outside the Auto Run folder (${FOLDER}): /x/y.md` });
	});
});
