import { describe, expect, it } from 'vitest';
import {
	buildFileTabDisplayNames,
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

	describe('buildFileTabDisplayNames', () => {
		const tab = (id: string, path: string) => {
			const { nameWithoutExtension, extension } = getFileNameParts(
				path.split(/[/\\]+/).pop() ?? ''
			);
			return { id, path, name: nameWithoutExtension, extension };
		};

		it('leaves uniquely-named tabs as the bare filename', () => {
			const result = buildFileTabDisplayNames([tab('1', '/a/ioc.go'), tab('2', '/b/service.go')]);
			expect(result.get('1')).toBe('ioc');
			expect(result.get('2')).toBe('service');
		});

		it('prefixes the immediate folder when two filenames collide', () => {
			const result = buildFileTabDisplayNames([
				tab('1', '/proj/ioc/service.go'),
				tab('2', '/proj/api/service.go'),
			]);
			expect(result.get('1')).toBe('ioc/service');
			expect(result.get('2')).toBe('api/service');
		});

		it('deepens the prefix until labels are unique', () => {
			const result = buildFileTabDisplayNames([
				tab('1', '/proj/a/shared/service.go'),
				tab('2', '/proj/b/shared/service.go'),
			]);
			// One folder (shared) collides, so walk up another level.
			expect(result.get('1')).toBe('a/shared/service');
			expect(result.get('2')).toBe('b/shared/service');
		});

		it('does not prefix tabs that share a name but differ in extension', () => {
			const result = buildFileTabDisplayNames([
				tab('1', '/proj/service.go'),
				tab('2', '/proj/service.ts'),
			]);
			expect(result.get('1')).toBe('service');
			expect(result.get('2')).toBe('service');
		});

		it('handles paths of unequal depth without collisions', () => {
			const result = buildFileTabDisplayNames([tab('1', '/service.go'), tab('2', '/x/service.go')]);
			expect(result.get('1')).toBe('service');
			expect(result.get('2')).toBe('x/service');
		});

		it('disambiguates three or more colliding files', () => {
			const result = buildFileTabDisplayNames([
				tab('1', '/proj/ioc/service.go'),
				tab('2', '/proj/api/service.go'),
				tab('3', '/proj/db/service.go'),
			]);
			expect(result.get('1')).toBe('ioc/service');
			expect(result.get('2')).toBe('api/service');
			expect(result.get('3')).toBe('db/service');
		});
	});
});
