import { describe, it, expect, vi } from 'vitest';
import {
	buildFileTreeIndices,
	findFirstExistingPath,
	parseEmbedAltSize,
	resolveEmbedCandidates,
	resolveNoteRelativePath,
} from '../../../../renderer/utils/fileLinks';
import type { FileNode } from '../../../../renderer/types/fileTree';

function file(name: string): FileNode {
	return { name, type: 'file' } as FileNode;
}
function folder(name: string, children: FileNode[]): FileNode {
	return { name, type: 'folder', children } as FileNode;
}

// /vault
//   Body/note.md
//   Body/_attachments/Tendon Exercises/hang.jpg
//   Media/clip.mp4
const vaultTree = [
	folder('Body', [
		file('note.md'),
		folder('_attachments', [folder('Tendon Exercises', [file('hang.jpg')])]),
	]),
	folder('Media', [file('clip.mp4')]),
];

describe('resolveNoteRelativePath', () => {
	it('returns data and http(s) sources unchanged', () => {
		expect(resolveNoteRelativePath('data:image/png;base64,abc', '/docs/readme.md')).toBe(
			'data:image/png;base64,abc'
		);
		expect(resolveNoteRelativePath('https://example.com/img.png', '/docs/readme.md')).toBe(
			'https://example.com/img.png'
		);
	});

	it('returns absolute paths unchanged', () => {
		expect(resolveNoteRelativePath('/absolute/path.png', '/docs/readme.md')).toBe(
			'/absolute/path.png'
		);
	});

	it('resolves relative paths from the note folder', () => {
		expect(resolveNoteRelativePath('images/photo.png', '/project/docs/readme.md')).toBe(
			'/project/docs/images/photo.png'
		);
		expect(resolveNoteRelativePath('./images/photo.png', '/project/docs/readme.md')).toBe(
			'/project/docs/images/photo.png'
		);
	});

	it('collapses .. segments', () => {
		expect(resolveNoteRelativePath('../assets/img.png', '/project/docs/readme.md')).toBe(
			'/project/assets/img.png'
		);
		expect(resolveNoteRelativePath('../../img.png', '/a/b/c/readme.md')).toBe('/a/img.png');
	});

	it('keeps Windows separators and drive letters', () => {
		expect(resolveNoteRelativePath('..\\img\\a.png', 'C:\\vault\\Body\\note.md')).toBe(
			'C:\\vault\\img\\a.png'
		);
	});
});

describe('resolveEmbedCandidates', () => {
	const indices = buildFileTreeIndices(vaultTree);
	const note = '/vault/Body/note.md';

	it('puts the tree-confirmed vault-root reading first', () => {
		const candidates = resolveEmbedCandidates('Body/_attachments/Tendon Exercises/hang.jpg', {
			markdownFilePath: note,
			projectRoot: '/vault',
			indices,
		});
		expect(candidates[0]).toBe('/vault/Body/_attachments/Tendon Exercises/hang.jpg');
		expect(candidates).toContain('/vault/Body/Body/_attachments/Tendon Exercises/hang.jpg');
	});

	it('still offers the vault-root reading without a file tree', () => {
		expect(
			resolveEmbedCandidates('Body/_attachments/a.jpg', {
				markdownFilePath: note,
				projectRoot: '/vault',
			})
		).toEqual(['/vault/Body/Body/_attachments/a.jpg', '/vault/Body/_attachments/a.jpg']);
	});

	it('finds a bare file name anywhere in the tree (Obsidian shortest path)', () => {
		const candidates = resolveEmbedCandidates('hang.jpg', {
			markdownFilePath: note,
			projectRoot: '/vault',
			indices,
		});
		expect(candidates[0]).toBe('/vault/Body/_attachments/Tendon Exercises/hang.jpg');
	});

	it('finds media the same way', () => {
		const candidates = resolveEmbedCandidates('clip.mp4', {
			markdownFilePath: note,
			projectRoot: '/vault',
			indices,
		});
		expect(candidates[0]).toBe('/vault/Media/clip.mp4');
	});

	it('tries attachment folders for a bare name the tree does not know', () => {
		const candidates = resolveEmbedCandidates('orphan.png', {
			markdownFilePath: note,
			projectRoot: '/vault',
		});
		expect(candidates[0]).toBe('/vault/Body/orphan.png');
		expect(candidates).toContain('/vault/Body/_attachments/orphan.png');
		expect(candidates).toContain('/vault/_attachments/orphan.png');
		expect(candidates).toContain('/vault/assets/orphan.png');
	});

	it('gives explicit ./ and ../ references no vault-root reading', () => {
		const candidates = resolveEmbedCandidates('../x/a.png', {
			markdownFilePath: note,
			projectRoot: '/vault',
		});
		expect(candidates).toEqual(['/vault/x/a.png']);
	});

	it('expands ~/ and strips file://', () => {
		expect(
			resolveEmbedCandidates('~/Pictures/a.png', { markdownFilePath: note, homeDir: '/Users/me' })
		).toEqual(['/Users/me/Pictures/a.png']);
		expect(resolveEmbedCandidates('file:///tmp/a.png', { markdownFilePath: note })).toEqual([
			'/tmp/a.png',
		]);
	});

	it('returns nothing for ~/ without a home folder', () => {
		expect(resolveEmbedCandidates('~/a.png', { markdownFilePath: note })).toEqual([]);
	});

	it('returns self-contained sources as-is', () => {
		expect(resolveEmbedCandidates('https://x.io/a.png', { markdownFilePath: note })).toEqual([
			'https://x.io/a.png',
		]);
	});

	it('never returns duplicates', () => {
		const candidates = resolveEmbedCandidates('a.png', {
			markdownFilePath: '/vault/note.md',
			projectRoot: '/vault',
		});
		expect(new Set(candidates).size).toBe(candidates.length);
	});
});

describe('findFirstExistingPath', () => {
	it('returns the first candidate the probe accepts', async () => {
		const probe = vi.fn(async (path: string) => (path === '/b' ? 'data:b' : null));
		await expect(findFirstExistingPath(['/a', '/b', '/c'], probe)).resolves.toEqual({
			path: '/b',
			value: 'data:b',
		});
		expect(probe).toHaveBeenCalledTimes(2);
	});

	it('moves past a candidate that throws', async () => {
		const probe = async (path: string) => {
			if (path === '/a') throw new Error('ENOENT');
			return 'ok';
		};
		await expect(findFirstExistingPath(['/a', '/b'], probe)).resolves.toEqual({
			path: '/b',
			value: 'ok',
		});
	});

	it('returns null when nothing exists, and rethrows when every miss threw', async () => {
		await expect(findFirstExistingPath(['/a'], async () => null)).resolves.toBeNull();
		await expect(
			findFirstExistingPath(['/a'], async () => {
				throw new Error('ENOENT');
			})
		).rejects.toThrow('ENOENT');
	});
});

describe('parseEmbedAltSize', () => {
	it('splits an Obsidian width off the caption', () => {
		expect(parseEmbedAltSize('How to dead hang (2:30)|220')).toEqual({
			alt: 'How to dead hang (2:30)',
			width: 220,
			height: undefined,
		});
	});

	it('reads width x height', () => {
		expect(parseEmbedAltSize('pic|200x100')).toEqual({ alt: 'pic', width: 200, height: 100 });
	});

	it('leaves a plain caption alone', () => {
		expect(parseEmbedAltSize('a | b')).toEqual({ alt: 'a | b' });
		expect(parseEmbedAltSize(undefined)).toEqual({ alt: '' });
	});
});
