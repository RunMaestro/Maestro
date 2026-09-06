/**
 * @file FileSearchModal.test.ts
 * @description Tests for FileSearchModal's flattenPreviewableFiles helper
 *
 * The search spans the whole tree - there is no expanded-folder scope any
 * more, so these cover:
 * - Every previewable file in the tree is returned, at any depth
 * - Non-previewable files are excluded
 * - Playable media is included (it opens in the floating player, not a tab)
 * - Depth is stamped from the tree, not the path
 */

import { describe, it, expect } from 'vitest';
import { flattenPreviewableFiles } from '../../../renderer/components/FileSearchModal';
import type { FileNode } from '../../../renderer/types/fileTree';

// Reusable test tree:
// src/
//   components/
//     App.tsx
//     Modal.tsx
//   utils/
//     helpers.ts
//   index.ts
// docs/
//   README.md
// package.json
// image.png
// binary.exe  (not previewable)
const testTree: FileNode[] = [
	{
		name: 'src',
		type: 'folder',
		children: [
			{
				name: 'components',
				type: 'folder',
				children: [
					{ name: 'App.tsx', type: 'file' },
					{ name: 'Modal.tsx', type: 'file' },
				],
			},
			{
				name: 'utils',
				type: 'folder',
				children: [{ name: 'helpers.ts', type: 'file' }],
			},
			{ name: 'index.ts', type: 'file' },
		],
	},
	{
		name: 'docs',
		type: 'folder',
		children: [{ name: 'README.md', type: 'file' }],
	},
	{ name: 'package.json', type: 'file' },
	{ name: 'image.png', type: 'file' },
	{ name: 'binary.exe', type: 'file' },
];

describe('flattenPreviewableFiles', () => {
	it('returns every previewable file in the tree regardless of depth', () => {
		const result = flattenPreviewableFiles(testTree);
		const paths = result.map((f) => f.fullPath);

		expect(paths).toContain('src/components/App.tsx');
		expect(paths).toContain('src/components/Modal.tsx');
		expect(paths).toContain('src/utils/helpers.ts');
		expect(paths).toContain('src/index.ts');
		expect(paths).toContain('docs/README.md');
		expect(paths).toContain('package.json');
		expect(paths).toContain('image.png');
		// binary.exe is not previewable
		expect(paths).not.toContain('binary.exe');
		expect(result).toHaveLength(7);
	});

	it('excludes non-previewable files', () => {
		const tree: FileNode[] = [
			{ name: 'readme.md', type: 'file' },
			{ name: 'program.exe', type: 'file' },
			{ name: 'data.bin', type: 'file' },
			{ name: 'archive.tar.gz', type: 'file' },
		];
		const result = flattenPreviewableFiles(tree);
		expect(result).toHaveLength(1);
		expect(result[0].fullPath).toBe('readme.md');
	});

	it('includes playable audio and video', () => {
		const tree: FileNode[] = [
			{ name: 'theme.mp3', type: 'file' },
			{ name: 'demo.mp4', type: 'file' },
			// Chromium cannot demux mkv, so it is deliberately not listed
			{ name: 'raw.mkv', type: 'file' },
		];
		const paths = flattenPreviewableFiles(tree).map((f) => f.fullPath);
		expect(paths).toEqual(['theme.mp3', 'demo.mp4']);
	});

	it('sets correct depth values', () => {
		const result = flattenPreviewableFiles(testTree);
		const appFile = result.find((f) => f.fullPath === 'src/components/App.tsx');
		const indexFile = result.find((f) => f.fullPath === 'src/index.ts');
		const rootFile = result.find((f) => f.fullPath === 'package.json');

		expect(rootFile?.depth).toBe(0);
		expect(indexFile?.depth).toBe(1);
		expect(appFile?.depth).toBe(2);
	});
});
