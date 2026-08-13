/**
 * Compile-time + runtime smoke for the shared search contract. These tests
 * exist so a future rename of `SearchHit` / `FilePreviewSearchAdapter` causes
 * a CI failure rather than a silent drift in tier code.
 */

import { describe, it, expect } from 'vitest';
import type {
	SearchHit,
	FilePreviewSearchAdapter,
} from '../../../../../renderer/components/FilePreview/search/types';

describe('shared search contract', () => {
	it('SearchHit has all required fields', () => {
		const hit: SearchHit = {
			sourceOffset: 10,
			length: 3,
			blockIndex: 0,
			offsetWithinBlock: 4,
		};
		expect(hit.sourceOffset).toBe(10);
		expect(hit.length).toBe(3);
		expect(hit.blockIndex).toBe(0);
		expect(hit.offsetWithinBlock).toBe(4);
	});

	it('FilePreviewSearchAdapter satisfies the agreed shape', () => {
		const adapter: FilePreviewSearchAdapter = {
			findHits: () => [],
			scrollToMatch: () => {},
		};
		expect(adapter.findHits('foo')).toEqual([]);
		// scrollToMatch returns void - call with a valid hit, ensure no throw.
		expect(() =>
			adapter.scrollToMatch({
				sourceOffset: 0,
				length: 1,
				blockIndex: 0,
				offsetWithinBlock: 0,
			})
		).not.toThrow();
	});
});
