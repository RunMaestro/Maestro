import { describe, expect, it } from 'vitest';
import { hasInformativeEntries } from '../../../../../../renderer/components/Wizard/screens/ConversationScreen/utils/projectFiles';
import type { DirectoryEntry } from '../../../../../../shared/types';

function entry(name: string, isDirectory = false): DirectoryEntry {
	return { name, isDirectory, isFile: !isDirectory, path: `/project/${name}` };
}

describe('hasInformativeEntries', () => {
	it('is false for an empty folder', () => {
		expect(hasInformativeEntries([])).toBe(false);
	});

	it('is false for a folder holding only housekeeping entries', () => {
		expect(hasInformativeEntries([entry('.git', true), entry('.DS_Store')])).toBe(false);
	});

	it('is true as soon as one real file is present', () => {
		expect(hasInformativeEntries([entry('.git', true), entry('README.md')])).toBe(true);
	});
});
