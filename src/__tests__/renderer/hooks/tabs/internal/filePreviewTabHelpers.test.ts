import { describe, expect, it } from 'vitest';
import {
	buildFileTabDisplayNames,
	buildReplacementNavigationHistory,
	draftWrittenElsewhere,
	getFileNameParts,
	nextEditContentPath,
} from '../../../../../renderer/hooks/tabs/internal/filePreviewTabHelpers';
import { createMockFileTab } from './testUtils';

describe('filePreviewTabHelpers', () => {
	describe('nextEditContentPath', () => {
		it('names the tab file on the first edit of a draft', () => {
			const tab = createMockFileTab({ path: '/repo/a.ts', editContent: undefined });

			expect(nextEditContentPath(tab, 'first edit')).toBe('/repo/a.ts');
		});

		it('keeps that name on later edits, even after the tab path has moved', () => {
			// The tab shows b.ts now, but the draft was typed for a.ts.
			const tab = createMockFileTab({
				path: '/repo/b.ts',
				editContent: 'draft',
				editContentPath: '/repo/a.ts',
			});

			expect(nextEditContentPath(tab, 'draft, more')).toBe('/repo/a.ts');
		});

		it('names the tab file for a draft that predates the stamp', () => {
			const tab = createMockFileTab({ path: '/repo/a.ts', editContent: 'old draft' });

			expect(nextEditContentPath(tab, 'old draft, more')).toBe('/repo/a.ts');
		});

		it('names nothing once the draft is cleared', () => {
			const tab = createMockFileTab({
				path: '/repo/a.ts',
				editContent: 'draft',
				editContentPath: '/repo/a.ts',
			});

			expect(nextEditContentPath(tab, undefined)).toBeUndefined();
		});

		it('starts a new draft on a new file after the old one was cleared', () => {
			// A stale name left behind by a cleared draft must not outlive it.
			const tab = createMockFileTab({
				path: '/repo/b.ts',
				editContent: undefined,
				editContentPath: '/repo/a.ts',
			});

			expect(nextEditContentPath(tab, 'fresh')).toBe('/repo/b.ts');
		});

		it('names an untitled tab by its empty path', () => {
			const tab = createMockFileTab({ path: '', editContent: '' });

			expect(nextEditContentPath(tab, 'hello')).toBe('');
		});
	});

	describe('draftWrittenElsewhere', () => {
		it('names the file a draft was typed for when a save would write another', () => {
			const tab = createMockFileTab({ editContent: 'draft', editContentPath: '/repo/a.ts' });

			expect(draftWrittenElsewhere(tab, '/repo/b.ts')).toBe('/repo/a.ts');
		});

		it('allows a save over the file the draft was typed for', () => {
			const tab = createMockFileTab({ editContent: 'draft', editContentPath: '/repo/a.ts' });

			expect(draftWrittenElsewhere(tab, '/repo/a.ts')).toBeUndefined();
		});

		it('allows a save when the tab holds no draft, whatever name is left behind', () => {
			const tab = createMockFileTab({ editContent: undefined, editContentPath: '/repo/a.ts' });

			expect(draftWrittenElsewhere(tab, '/repo/b.ts')).toBeUndefined();
		});

		it('trusts a draft that predates the stamp', () => {
			const tab = createMockFileTab({ editContent: 'old draft', editContentPath: undefined });

			expect(draftWrittenElsewhere(tab, '/repo/b.ts')).toBeUndefined();
		});

		it('allows a save when the tab cannot be found', () => {
			expect(draftWrittenElsewhere(undefined, '/repo/b.ts')).toBeUndefined();
		});

		it('treats an untitled draft as written for no file on disk', () => {
			const tab = createMockFileTab({ editContent: 'draft', editContentPath: '' });

			expect(draftWrittenElsewhere(tab, '')).toBeUndefined();
			expect(draftWrittenElsewhere(tab, '/repo/b.ts')).toBe('');
		});
	});

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
