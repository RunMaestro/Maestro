import { describe, expect, it } from 'vitest';
import {
	buildReplacementNavigationHistory,
	getFileNameParts,
} from '../../../../../renderer/hooks/tabs/internal/filePreviewTabHelpers';
import { createMockFileTab } from './testUtils';

describe('filePreviewTabHelpers', () => {
	describe('getFileNameParts', () => {
		it('splits a normal filename into name and extension', () => {
			expect(getFileNameParts('index.test.ts')).toEqual({
				nameWithoutExtension: 'index.test',
				extension: '.ts',
			});
		});

		it('keeps extension empty when no dot exists', () => {
			expect(getFileNameParts('README')).toEqual({
				nameWithoutExtension: 'README',
				extension: '',
			});
		});

		it('preserves the legacy hidden-file behavior', () => {
			expect(getFileNameParts('.env')).toEqual({
				nameWithoutExtension: '',
				extension: '.env',
			});
		});
	});

	describe('buildReplacementNavigationHistory', () => {
		it('adds current file and replacement file when history is empty', () => {
			const tab = createMockFileTab({ path: '/old.ts', name: 'old', scrollTop: 42 });

			expect(
				buildReplacementNavigationHistory(
					tab,
					tab,
					{ path: '/new.ts', name: 'new.ts', content: 'new' },
					'new'
				)
			).toEqual([
				{ path: '/old.ts', name: 'old', scrollTop: 42 },
				{ path: '/new.ts', name: 'new', scrollTop: 0 },
			]);
		});

		it('truncates forward history before adding the replacement file', () => {
			const tab = createMockFileTab({
				path: '/b.ts',
				name: 'b',
				scrollTop: 10,
				navigationHistory: [
					{ path: '/a.ts', name: 'a', scrollTop: 1 },
					{ path: '/b.ts', name: 'b', scrollTop: 2 },
					{ path: '/c.ts', name: 'c', scrollTop: 3 },
				],
				navigationIndex: 1,
			});

			expect(
				buildReplacementNavigationHistory(
					tab,
					tab,
					{ path: '/d.ts', name: 'd.ts', content: 'd' },
					'd'
				)
			).toEqual([
				{ path: '/a.ts', name: 'a', scrollTop: 1 },
				{ path: '/b.ts', name: 'b', scrollTop: 2 },
				{ path: '/d.ts', name: 'd', scrollTop: 0 },
			]);
		});
	});
});
