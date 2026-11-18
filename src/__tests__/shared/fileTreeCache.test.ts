import { describe, it, expect } from 'vitest';
import {
	holdsFileTreeCache,
	unloadedFileTreeState,
	withoutFileTreeCache,
} from '../../shared/fileTreeCache';

describe('fileTreeCache', () => {
	it('reports no cache for an unscanned agent or one in the stored shape', () => {
		expect(holdsFileTreeCache({ id: 'a' })).toBe(false);
		expect(holdsFileTreeCache({ id: 'a', ...unloadedFileTreeState() })).toBe(false);
	});

	it('reports a cache for a scanned tree or a scan marker left beside an empty one', () => {
		expect(holdsFileTreeCache({ fileTree: [{ name: 'src' }] })).toBe(true);
		expect(holdsFileTreeCache({ fileTree: [], fileTreeLoadedCap: 250000 })).toBe(true);
		expect(holdsFileTreeCache({ fileTree: [], fileTreeStats: { fileCount: 0 } })).toBe(true);
		expect(holdsFileTreeCache({ fileTreeLoading: true })).toBe(true);
	});

	it('returns the same object when there is nothing to drop', () => {
		const agent = { id: 'a', name: 'Agent' };
		expect(withoutFileTreeCache(agent)).toBe(agent);
	});

	it('resets every scan field and keeps the rest of the agent', () => {
		const stripped = withoutFileTreeCache({
			id: 'a',
			name: 'Agent',
			fileTree: [{ name: 'src', children: [] }],
			fileTreeStats: { fileCount: 1, folderCount: 1, totalSize: 10 },
			fileTreeLoadedCap: 250000,
			fileTreeTruncated: false,
			fileTreeLastScanTime: 123,
		});
		expect(stripped).toEqual({ id: 'a', name: 'Agent', ...unloadedFileTreeState() });
		expect(JSON.parse(JSON.stringify(stripped))).toEqual({
			id: 'a',
			name: 'Agent',
			fileTree: [],
			fileTreeLoading: false,
		});
	});
});
