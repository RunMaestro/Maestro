import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { logger } from '../../../renderer/utils/logger';
import {
	shouldOpenExternally,
	loadFileTree as loadFileTreeRaw,
	getAllFolderPaths,
	flattenTree,
	compareFileTrees,
	buildTreeFromPaths,
	spliceMaestroIntoTree,
	loadFileTreeRemoteBatched,
	FileTreeNode,
} from '../../../renderer/utils/fileExplorer';
import { matchGlobPattern, shouldIgnore } from '../../../shared/globUtils';

/**
 * Test helper: calls loadFileTree and unwraps the `.tree` field so existing
 * assertions that treat the result as a FileTreeNode[] continue to work.
 * Truncation behavior is covered by dedicated tests that use `loadFileTreeRaw`.
 */
const loadFileTree = async (...args: Parameters<typeof loadFileTreeRaw>): Promise<FileTreeNode[]> =>
	(await loadFileTreeRaw(...args)).tree;

describe('fileExplorer utils', () => {
	// ============================================================================
	// shouldOpenExternally
	// ============================================================================
	describe('shouldOpenExternally', () => {
		describe('document files', () => {
			it('returns true for PDF files', () => {
				expect(shouldOpenExternally('report.pdf')).toBe(true);
				expect(shouldOpenExternally('document.PDF')).toBe(true);
			});

			it('returns true for Word documents', () => {
				expect(shouldOpenExternally('document.doc')).toBe(true);
				expect(shouldOpenExternally('document.docx')).toBe(true);
			});

			it('returns true for Excel spreadsheets', () => {
				expect(shouldOpenExternally('data.xls')).toBe(true);
				expect(shouldOpenExternally('data.xlsx')).toBe(true);
			});

			it('returns true for PowerPoint presentations', () => {
				expect(shouldOpenExternally('slides.ppt')).toBe(true);
				expect(shouldOpenExternally('slides.pptx')).toBe(true);
			});
		});

		describe('archive files', () => {
			it('returns true for zip files', () => {
				expect(shouldOpenExternally('archive.zip')).toBe(true);
			});

			it('returns true for tar files', () => {
				expect(shouldOpenExternally('archive.tar')).toBe(true);
			});

			it('returns true for gz files', () => {
				expect(shouldOpenExternally('archive.gz')).toBe(true);
			});

			it('returns true for rar files', () => {
				expect(shouldOpenExternally('archive.rar')).toBe(true);
			});

			it('returns true for 7z files', () => {
				expect(shouldOpenExternally('archive.7z')).toBe(true);
			});
		});

		describe('executable/installer files', () => {
			it('returns true for exe files', () => {
				expect(shouldOpenExternally('installer.exe')).toBe(true);
			});

			it('returns true for dmg files', () => {
				expect(shouldOpenExternally('installer.dmg')).toBe(true);
			});

			it('returns true for app files', () => {
				expect(shouldOpenExternally('MyApp.app')).toBe(true);
			});

			it('returns true for deb files', () => {
				expect(shouldOpenExternally('package.deb')).toBe(true);
			});

			it('returns true for rpm files', () => {
				expect(shouldOpenExternally('package.rpm')).toBe(true);
			});
		});

		describe('media files', () => {
			it('returns true for video files', () => {
				expect(shouldOpenExternally('video.mp4')).toBe(true);
				expect(shouldOpenExternally('video.avi')).toBe(true);
				expect(shouldOpenExternally('video.mov')).toBe(true);
				expect(shouldOpenExternally('video.mkv')).toBe(true);
			});

			it('returns true for audio files', () => {
				expect(shouldOpenExternally('audio.mp3')).toBe(true);
				expect(shouldOpenExternally('audio.wav')).toBe(true);
				expect(shouldOpenExternally('audio.flac')).toBe(true);
			});
		});

		describe('image files (previewable inline)', () => {
			it('returns false for PNG files (previewable)', () => {
				expect(shouldOpenExternally('image.png')).toBe(false);
				expect(shouldOpenExternally('screenshot.PNG')).toBe(false);
			});

			it('returns false for SVG files (previewable)', () => {
				expect(shouldOpenExternally('icon.svg')).toBe(false);
				expect(shouldOpenExternally('logo.SVG')).toBe(false);
			});

			it('returns false for JPEG files (previewable)', () => {
				expect(shouldOpenExternally('photo.jpg')).toBe(false);
				expect(shouldOpenExternally('photo.jpeg')).toBe(false);
				expect(shouldOpenExternally('photo.JPEG')).toBe(false);
			});

			it('returns false for other previewable image formats', () => {
				expect(shouldOpenExternally('image.gif')).toBe(false);
				expect(shouldOpenExternally('image.webp')).toBe(false);
				expect(shouldOpenExternally('image.bmp')).toBe(false);
				expect(shouldOpenExternally('favicon.ico')).toBe(false);
			});

			it('returns true for non-previewable image formats', () => {
				expect(shouldOpenExternally('photo.tiff')).toBe(true);
				expect(shouldOpenExternally('photo.tif')).toBe(true);
				expect(shouldOpenExternally('photo.heic')).toBe(true);
				expect(shouldOpenExternally('photo.heif')).toBe(true);
			});
		});

		describe('code and text files', () => {
			it('returns false for TypeScript files', () => {
				expect(shouldOpenExternally('app.ts')).toBe(false);
				expect(shouldOpenExternally('app.tsx')).toBe(false);
			});

			it('returns false for JavaScript files', () => {
				expect(shouldOpenExternally('app.js')).toBe(false);
				expect(shouldOpenExternally('app.jsx')).toBe(false);
			});

			it('returns false for markdown files', () => {
				expect(shouldOpenExternally('README.md')).toBe(false);
			});

			it('returns false for text files', () => {
				expect(shouldOpenExternally('notes.txt')).toBe(false);
			});

			it('returns false for JSON files', () => {
				expect(shouldOpenExternally('package.json')).toBe(false);
			});

			it('returns false for CSS files', () => {
				expect(shouldOpenExternally('styles.css')).toBe(false);
			});

			it('returns false for HTML files', () => {
				expect(shouldOpenExternally('index.html')).toBe(false);
			});
		});

		describe('edge cases', () => {
			it('returns false for files without extension', () => {
				expect(shouldOpenExternally('Makefile')).toBe(false);
				expect(shouldOpenExternally('Dockerfile')).toBe(false);
			});

			it('handles uppercase extensions', () => {
				expect(shouldOpenExternally('video.MP4')).toBe(true);
				expect(shouldOpenExternally('archive.ZIP')).toBe(true);
				expect(shouldOpenExternally('code.TS')).toBe(false);
			});

			it('handles filenames with multiple dots', () => {
				expect(shouldOpenExternally('archive.backup.zip')).toBe(true);
				expect(shouldOpenExternally('file.test.ts')).toBe(false);
				expect(shouldOpenExternally('report.2024.pdf')).toBe(true);
			});

			it('returns false for empty filename', () => {
				expect(shouldOpenExternally('')).toBe(false);
			});
		});
	});

	// ============================================================================
	// loadFileTree
	// ============================================================================
	describe('loadFileTree', () => {
		beforeEach(() => {
			vi.clearAllMocks();
		});

		it('returns empty array when maxDepth is reached', async () => {
			const result = await loadFileTree('/some/path', 5, 5);
			expect(result).toEqual([]);
			// Should not call readDir when depth is reached
			expect(window.maestro.fs.readDir).not.toHaveBeenCalled();
		});

		it('loads files and folders from directory', async () => {
			// First call returns the directory contents, second call for src folder returns empty
			vi.mocked(window.maestro.fs.readDir)
				.mockResolvedValueOnce([
					{ name: 'src', isFile: false, isDirectory: true },
					{ name: 'README.md', isFile: true, isDirectory: false },
					{ name: 'package.json', isFile: true, isDirectory: false },
				])
				.mockResolvedValue([]); // Empty children for src folder

			const result = await loadFileTree('/project');

			// Should pass undefined for sshRemoteId when no SSH context is provided
			expect(window.maestro.fs.readDir).toHaveBeenCalledWith('/project', undefined);
			expect(result).toHaveLength(3);
			expect(result[0]).toEqual({
				name: 'src',
				type: 'folder',
				children: [],
			});
			expect(result[1]).toEqual({ name: 'package.json', type: 'file' });
			expect(result[2]).toEqual({ name: 'README.md', type: 'file' });
		});

		it('includes hidden files and directories (starting with .)', async () => {
			vi.mocked(window.maestro.fs.readDir)
				.mockResolvedValueOnce([
					{ name: '.git', isFile: false, isDirectory: true },
					{ name: '.gitignore', isFile: true, isDirectory: false },
					{ name: '.env', isFile: true, isDirectory: false },
					{ name: 'src', isFile: false, isDirectory: true },
					{ name: 'README.md', isFile: true, isDirectory: false },
				])
				.mockResolvedValue([]); // Empty for recursive folder calls

			const result = await loadFileTree('/project');

			expect(result).toHaveLength(5);
			expect(result.find((n) => n.name === '.git')).toBeDefined();
			expect(result.find((n) => n.name === '.gitignore')).toBeDefined();
			expect(result.find((n) => n.name === '.env')).toBeDefined();
			expect(result.find((n) => n.name === 'src')).toBeDefined();
			expect(result.find((n) => n.name === 'README.md')).toBeDefined();
		});

		it('skips node_modules directory', async () => {
			vi.mocked(window.maestro.fs.readDir)
				.mockResolvedValueOnce([
					{ name: 'node_modules', isFile: false, isDirectory: true },
					{ name: 'src', isFile: false, isDirectory: true },
				])
				.mockResolvedValue([]); // Empty for src folder recursion

			const result = await loadFileTree('/project');

			expect(result).toHaveLength(1);
			expect(result[0].name).toBe('src');
		});

		it('skips __pycache__ directory', async () => {
			vi.mocked(window.maestro.fs.readDir).mockResolvedValueOnce([
				{ name: '__pycache__', isFile: false, isDirectory: true },
				{ name: 'main.py', isFile: true, isDirectory: false },
			]);
			// No further calls needed - __pycache__ is skipped and main.py is a file

			const result = await loadFileTree('/project');

			expect(result).toHaveLength(1);
			expect(result[0].name).toBe('main.py');
		});

		it('always shows .maestro folder even when it matches ignore patterns', async () => {
			vi.mocked(window.maestro.fs.readDir)
				.mockResolvedValueOnce([
					{ name: '.maestro', isFile: false, isDirectory: true },
					{ name: 'node_modules', isFile: false, isDirectory: true },
					{ name: 'src', isFile: false, isDirectory: true },
				])
				.mockResolvedValue([]); // Empty for folder recursion

			// Use ignore patterns that would match .maestro (e.g., dotfile glob)
			const result = await loadFileTree('/project', 10, 0, undefined, undefined, {
				ignorePatterns: ['node_modules', '.*'],
			});

			// .maestro should be present, node_modules should be filtered
			expect(result.find((n) => n.name === '.maestro')).toBeDefined();
			expect(result.find((n) => n.name === 'node_modules')).toBeUndefined();
			expect(result.find((n) => n.name === 'src')).toBeDefined();
		});

		it('sorts folders before files', async () => {
			vi.mocked(window.maestro.fs.readDir)
				.mockResolvedValueOnce([
					{ name: 'zebra.txt', isFile: true, isDirectory: false },
					{ name: 'alpha', isFile: false, isDirectory: true },
					{ name: 'apple.js', isFile: true, isDirectory: false },
					{ name: 'beta', isFile: false, isDirectory: true },
				])
				.mockResolvedValue([]); // Empty for folder recursion

			const result = await loadFileTree('/project');

			expect(result[0].name).toBe('alpha');
			expect(result[0].type).toBe('folder');
			expect(result[1].name).toBe('beta');
			expect(result[1].type).toBe('folder');
			expect(result[2].name).toBe('apple.js');
			expect(result[2].type).toBe('file');
			expect(result[3].name).toBe('zebra.txt');
			expect(result[3].type).toBe('file');
		});

		it('sorts alphabetically within same type', async () => {
			vi.mocked(window.maestro.fs.readDir).mockResolvedValueOnce([
				{ name: 'zebra.txt', isFile: true, isDirectory: false },
				{ name: 'apple.js', isFile: true, isDirectory: false },
				{ name: 'banana.ts', isFile: true, isDirectory: false },
			]);
			// No further calls - all files, no recursion

			const result = await loadFileTree('/project');

			expect(result[0].name).toBe('apple.js');
			expect(result[1].name).toBe('banana.ts');
			expect(result[2].name).toBe('zebra.txt');
		});

		it('recursively loads children of folders', async () => {
			vi.mocked(window.maestro.fs.readDir)
				.mockResolvedValueOnce([{ name: 'src', isFile: false, isDirectory: true }])
				.mockResolvedValueOnce([
					{ name: 'index.ts', isFile: true, isDirectory: false },
					{ name: 'components', isFile: false, isDirectory: true },
				])
				.mockResolvedValueOnce([{ name: 'App.tsx', isFile: true, isDirectory: false }]);

			const result = await loadFileTree('/project');

			expect(window.maestro.fs.readDir).toHaveBeenCalledTimes(3);
			expect(result[0].name).toBe('src');
			expect(result[0].children).toHaveLength(2);
			expect(result[0].children![0].name).toBe('components');
			expect(result[0].children![0].children).toHaveLength(1);
			expect(result[0].children![0].children![0].name).toBe('App.tsx');
		});

		it('propagates errors from readDir', async () => {
			const error = new Error('Permission denied');
			vi.mocked(window.maestro.fs.readDir).mockRejectedValue(error);

			const consoleSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
			await expect(loadFileTree('/restricted')).rejects.toThrow('Permission denied');
			consoleSpy.mockRestore();
		});

		it('respects default maxDepth of 5', async () => {
			// Setup recursive structure
			const setupMocks = () => {
				vi.mocked(window.maestro.fs.readDir).mockResolvedValue([
					{ name: 'deep', isFile: false, isDirectory: true },
				]);
			};
			setupMocks();

			await loadFileTree('/project');

			// Should be called maxDepth times (5) for each level, then stop
			expect(window.maestro.fs.readDir).toHaveBeenCalledTimes(5);
		});

		it('handles entries that are neither file nor directory', async () => {
			vi.mocked(window.maestro.fs.readDir).mockResolvedValueOnce([
				{ name: 'regular.txt', isFile: true, isDirectory: false },
				{ name: 'symlink', isFile: false, isDirectory: false }, // Neither file nor directory
			]);
			// No further calls - regular.txt is a file, symlink is skipped

			const result = await loadFileTree('/project');

			expect(result).toHaveLength(1);
			expect(result[0].name).toBe('regular.txt');
		});

		it('passes SSH context to readDir for remote file operations', async () => {
			vi.mocked(window.maestro.fs.readDir)
				.mockResolvedValueOnce([
					{ name: 'src', isFile: false, isDirectory: true },
					{ name: 'README.md', isFile: true, isDirectory: false },
				])
				.mockResolvedValue([]); // Empty children for src folder

			const sshContext = { sshRemoteId: 'remote-1', remoteCwd: '/home/user' };
			const result = await loadFileTree('/project', 10, 0, sshContext);

			// Verify SSH remote ID is passed to all readDir calls
			expect(window.maestro.fs.readDir).toHaveBeenCalledWith('/project', 'remote-1');
			expect(window.maestro.fs.readDir).toHaveBeenCalledWith('/project/src', 'remote-1');
			expect(result).toHaveLength(2);
		});

		it('passes undefined to readDir when no SSH context is provided', async () => {
			vi.mocked(window.maestro.fs.readDir).mockResolvedValueOnce([
				{ name: 'file.txt', isFile: true, isDirectory: false },
			]);

			await loadFileTree('/project');

			expect(window.maestro.fs.readDir).toHaveBeenCalledWith('/project', undefined);
		});

		it('uses localIgnorePatterns when provided for local scans', async () => {
			vi.mocked(window.maestro.fs.readDir)
				.mockResolvedValueOnce([
					{ name: '.git', isFile: false, isDirectory: true },
					{ name: 'node_modules', isFile: false, isDirectory: true },
					{ name: 'src', isFile: false, isDirectory: true },
					{ name: 'README.md', isFile: true, isDirectory: false },
				])
				.mockResolvedValue([]);

			// Pass localIgnorePatterns that includes .git and node_modules
			const result = await loadFileTree('/project', 10, 0, undefined, undefined, {
				ignorePatterns: ['.git', 'node_modules'],
			});

			expect(result).toHaveLength(2);
			expect(result.find((n) => n.name === '.git')).toBeUndefined();
			expect(result.find((n) => n.name === 'node_modules')).toBeUndefined();
			expect(result.find((n) => n.name === 'src')).toBeDefined();
			expect(result.find((n) => n.name === 'README.md')).toBeDefined();
		});

		it('falls back to default ignore patterns when localOptions is undefined', async () => {
			vi.mocked(window.maestro.fs.readDir)
				.mockResolvedValueOnce([
					{ name: '.git', isFile: false, isDirectory: true },
					{ name: 'node_modules', isFile: false, isDirectory: true },
					{ name: '__pycache__', isFile: false, isDirectory: true },
					{ name: 'src', isFile: false, isDirectory: true },
				])
				.mockResolvedValue([]);

			// No localOptions — should use defaults (node_modules, __pycache__)
			const result = await loadFileTree('/project');

			// .git should be included (not in defaults), node_modules and __pycache__ excluded
			expect(result).toHaveLength(2);
			expect(result.find((n) => n.name === '.git')).toBeDefined();
			expect(result.find((n) => n.name === 'src')).toBeDefined();
			expect(result.find((n) => n.name === 'node_modules')).toBeUndefined();
			expect(result.find((n) => n.name === '__pycache__')).toBeUndefined();
		});

		it('does not apply localOptions to SSH contexts', async () => {
			vi.mocked(window.maestro.fs.readDir)
				.mockResolvedValueOnce([
					{ name: '.git', isFile: false, isDirectory: true },
					{ name: 'src', isFile: false, isDirectory: true },
				])
				.mockResolvedValue([]);

			// SSH context with its own ignore patterns
			const sshContext = {
				sshRemoteId: 'remote-1',
				ignorePatterns: ['build'],
			};
			const result = await loadFileTree('/project', 10, 0, sshContext, undefined, {
				ignorePatterns: ['.git'],
			});

			// .git should NOT be ignored — SSH uses its own ignorePatterns, not localOptions
			expect(result).toHaveLength(2);
			expect(result.find((n) => n.name === '.git')).toBeDefined();
			expect(result.find((n) => n.name === 'src')).toBeDefined();
		});

		it('always shows .maestro even when it matches ignore patterns', async () => {
			vi.mocked(window.maestro.fs.readDir).mockResolvedValueOnce([
				{ name: '.maestro', isFile: false, isDirectory: true },
				{ name: '.env', isFile: true, isDirectory: false },
				{ name: 'src', isFile: false, isDirectory: true },
			]);
			vi.mocked(window.maestro.fs.readDir).mockResolvedValue([]);

			// Use ignore patterns that would match dotfiles
			const result = await loadFileTree('/project', 10, 0, undefined, undefined, {
				ignorePatterns: ['.*'],
			});

			// .maestro should survive despite matching .*
			expect(result.find((n) => n.name === '.maestro')).toBeDefined();
			// .env should be filtered out (matches .* and is not in ALWAYS_VISIBLE)
			expect(result.find((n) => n.name === '.env')).toBeUndefined();
			expect(result.find((n) => n.name === 'src')).toBeDefined();
		});

		it('deduplicates entries returned by readDir', async () => {
			vi.mocked(window.maestro.fs.readDir).mockResolvedValueOnce([
				{ name: 'src', isFile: false, isDirectory: true, path: '/project/src' },
				{ name: 'README.md', isFile: true, isDirectory: false, path: '/project/README.md' },
				{ name: 'src', isFile: false, isDirectory: true, path: '/project/src' }, // duplicate
				{ name: 'README.md', isFile: true, isDirectory: false, path: '/project/README.md' }, // duplicate
			]);
			vi.mocked(window.maestro.fs.readDir).mockResolvedValue([]); // Empty children

			const consoleSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
			const result = await loadFileTree('/project');

			expect(consoleSpy).toHaveBeenCalled();
			consoleSpy.mockRestore();

			expect(result).toHaveLength(2);
			expect(result[0].name).toBe('src');
			expect(result[1].name).toBe('README.md');
		});

		it('deduplicates entries in nested directories', async () => {
			vi.mocked(window.maestro.fs.readDir)
				.mockResolvedValueOnce([
					{ name: 'docs', isFile: false, isDirectory: true, path: '/project/docs' },
				])
				.mockResolvedValueOnce([
					{ name: 'guide.md', isFile: true, isDirectory: false, path: '/project/docs/guide.md' },
					{ name: 'guide.md', isFile: true, isDirectory: false, path: '/project/docs/guide.md' }, // duplicate child
				]);

			const consoleSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
			const result = await loadFileTree('/project');

			expect(consoleSpy).toHaveBeenCalled();
			consoleSpy.mockRestore();

			expect(result).toHaveLength(1);
			expect(result[0].children).toHaveLength(1);
			expect(result[0].children![0].name).toBe('guide.md');
		});

		it('deduplicates NFD/NFC normalized entries', async () => {
			const nfcName = 'caf\u00e9'.normalize('NFC');
			const nfdName = 'caf\u00e9'.normalize('NFD');

			vi.mocked(window.maestro.fs.readDir).mockResolvedValueOnce([
				{ name: nfcName, isFile: true, isDirectory: false },
				{ name: nfdName, isFile: true, isDirectory: false }, // same visual name, different Unicode form
			]);

			const consoleSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
			const result = await loadFileTree('/project');

			expect(consoleSpy).toHaveBeenCalled();
			consoleSpy.mockRestore();

			expect(result).toHaveLength(1);
			expect(result[0].name.normalize('NFC')).toBe(nfcName);
		});

		it('deduplicates NFD/NFC entries in nested directories', async () => {
			const nfcName = 'r\u00e9sum\u00e9.md'.normalize('NFC');
			const nfdName = 'r\u00e9sum\u00e9.md'.normalize('NFD');

			vi.mocked(window.maestro.fs.readDir)
				.mockResolvedValueOnce([{ name: 'docs', isFile: false, isDirectory: true }])
				.mockResolvedValueOnce([
					{ name: nfcName, isFile: true, isDirectory: false },
					{ name: nfdName, isFile: true, isDirectory: false }, // NFD duplicate in child
				]);

			const consoleSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
			const result = await loadFileTree('/project');

			expect(consoleSpy).toHaveBeenCalled();
			consoleSpy.mockRestore();

			expect(result).toHaveLength(1);
			expect(result[0].children).toHaveLength(1);
			expect(result[0].children![0].name.normalize('NFC')).toBe(nfcName);
		});

		// ============================================================================
		// maxEntries truncation
		// ============================================================================
		describe('maxEntries cap', () => {
			it('reports truncated=false when scan stays under cap', async () => {
				vi.mocked(window.maestro.fs.readDir).mockResolvedValueOnce([
					{ name: 'a.txt', isFile: true, isDirectory: false },
					{ name: 'b.txt', isFile: true, isDirectory: false },
				]);

				const result = await loadFileTreeRaw('/project', 5, 0, undefined, undefined, undefined, 10);
				expect(result.truncated).toBe(false);
				expect(result.filesFound).toBe(2);
				expect(result.tree).toHaveLength(2);
			});

			it('stops adding files and sets truncated=true when cap is hit', async () => {
				// 5 files at root, cap set to 3
				vi.mocked(window.maestro.fs.readDir).mockResolvedValueOnce([
					{ name: 'a.txt', isFile: true, isDirectory: false },
					{ name: 'b.txt', isFile: true, isDirectory: false },
					{ name: 'c.txt', isFile: true, isDirectory: false },
					{ name: 'd.txt', isFile: true, isDirectory: false },
					{ name: 'e.txt', isFile: true, isDirectory: false },
				]);

				const result = await loadFileTreeRaw('/project', 5, 0, undefined, undefined, undefined, 3);
				expect(result.truncated).toBe(true);
				expect(result.filesFound).toBe(3);
				expect(result.tree).toHaveLength(3);
			});

			it('skips recursion into sibling folders once cap is reached', async () => {
				// Root: folder "full" + folder "skipped". "full" fills the cap.
				vi.mocked(window.maestro.fs.readDir)
					.mockResolvedValueOnce([
						{ name: 'full', isFile: false, isDirectory: true },
						{ name: 'skipped', isFile: false, isDirectory: true },
					])
					.mockResolvedValueOnce([
						// "full" contents: 3 files, matches the cap
						{ name: 'a.txt', isFile: true, isDirectory: false },
						{ name: 'b.txt', isFile: true, isDirectory: false },
						{ name: 'c.txt', isFile: true, isDirectory: false },
					]);

				const result = await loadFileTreeRaw('/project', 5, 0, undefined, undefined, undefined, 3);
				expect(result.truncated).toBe(true);
				// "skipped" folder is still in the tree (as empty), but readDir was not called on it
				expect(window.maestro.fs.readDir).toHaveBeenCalledTimes(2);
				const skipped = result.tree.find((n) => n.name === 'skipped');
				expect(skipped).toBeDefined();
				expect(skipped?.children).toEqual([]);
			});

			it('treats Infinity (and omitted cap) as unlimited', async () => {
				vi.mocked(window.maestro.fs.readDir).mockResolvedValueOnce([
					{ name: 'a.txt', isFile: true, isDirectory: false },
					{ name: 'b.txt', isFile: true, isDirectory: false },
				]);

				const result = await loadFileTreeRaw('/project');
				expect(result.truncated).toBe(false);
				expect(result.tree).toHaveLength(2);
			});
		});

		// ============================================================================
		// .maestro prioritization (always-visible directories)
		// ============================================================================
		describe('always-visible directory prioritization', () => {
			it('walks .maestro before sibling directories', async () => {
				// Root listing returns sibling first to simulate readDir ordering
				vi.mocked(window.maestro.fs.readDir)
					.mockResolvedValueOnce([
						{ name: 'src', isFile: false, isDirectory: true },
						{ name: '.maestro', isFile: false, isDirectory: true },
					])
					.mockResolvedValue([]);

				await loadFileTreeRaw('/project');

				// .maestro should be readDir'd before src (call #2 vs #3)
				const calls = vi.mocked(window.maestro.fs.readDir).mock.calls;
				expect(calls[0][0]).toBe('/project');
				expect(calls[1][0]).toBe('/project/.maestro');
				expect(calls[2][0]).toBe('/project/src');
			});

			it('fully loads .maestro contents even when entry cap is exceeded', async () => {
				// Root: lots of bulk files + .maestro dir. Cap is small.
				vi.mocked(window.maestro.fs.readDir)
					.mockResolvedValueOnce([
						{ name: '.maestro', isFile: false, isDirectory: true },
						{ name: 'a.txt', isFile: true, isDirectory: false },
						{ name: 'b.txt', isFile: true, isDirectory: false },
						{ name: 'c.txt', isFile: true, isDirectory: false },
						{ name: 'd.txt', isFile: true, isDirectory: false },
						{ name: 'e.txt', isFile: true, isDirectory: false },
					])
					// .maestro contents — 4 files, more than the cap
					.mockResolvedValueOnce([
						{ name: 'cue.yaml', isFile: true, isDirectory: false },
						{ name: 'p1.md', isFile: true, isDirectory: false },
						{ name: 'p2.md', isFile: true, isDirectory: false },
						{ name: 'p3.md', isFile: true, isDirectory: false },
					]);

				const result = await loadFileTreeRaw(
					'/project',
					5,
					0,
					undefined,
					undefined,
					undefined,
					2 // cap of 2 files
				);

				// .maestro should be present with all 4 children
				const maestro = result.tree.find((n) => n.name === '.maestro');
				expect(maestro).toBeDefined();
				expect(maestro?.children).toHaveLength(4);

				// Bulk files should be capped at 2 with truncation flag
				const bulkFiles = result.tree.filter((n) => n.type === 'file');
				expect(bulkFiles).toHaveLength(2);
				expect(result.truncated).toBe(true);
			});

			it('does not let .maestro contents starve sibling directory budget', async () => {
				// Root has .maestro (with 5 files) + bulk dir + extra files. Cap is 3.
				// Without separate budget tracking, .maestro's 5 files would eat the cap.
				vi.mocked(window.maestro.fs.readDir)
					.mockResolvedValueOnce([
						{ name: '.maestro', isFile: false, isDirectory: true },
						{ name: 'src', isFile: false, isDirectory: true },
					])
					.mockResolvedValueOnce([
						// .maestro contents
						{ name: 'a.md', isFile: true, isDirectory: false },
						{ name: 'b.md', isFile: true, isDirectory: false },
						{ name: 'c.md', isFile: true, isDirectory: false },
						{ name: 'd.md', isFile: true, isDirectory: false },
						{ name: 'e.md', isFile: true, isDirectory: false },
					])
					.mockResolvedValueOnce([
						// src contents — should still be reachable
						{ name: 'index.ts', isFile: true, isDirectory: false },
						{ name: 'app.ts', isFile: true, isDirectory: false },
					]);

				const result = await loadFileTreeRaw('/project', 5, 0, undefined, undefined, undefined, 3);

				// src must be walked (readDir called), not folded as empty
				expect(window.maestro.fs.readDir).toHaveBeenCalledWith('/project/src', undefined);
				const src = result.tree.find((n) => n.name === 'src');
				expect(src?.children).toHaveLength(2);

				// .maestro fully loaded
				const maestro = result.tree.find((n) => n.name === '.maestro');
				expect(maestro?.children).toHaveLength(5);
			});

			it('propagates unlimited budget through nested .maestro descendants', async () => {
				vi.mocked(window.maestro.fs.readDir)
					.mockResolvedValueOnce([{ name: '.maestro', isFile: false, isDirectory: true }])
					.mockResolvedValueOnce([{ name: 'playbooks', isFile: false, isDirectory: true }])
					.mockResolvedValueOnce([
						{ name: 'one.md', isFile: true, isDirectory: false },
						{ name: 'two.md', isFile: true, isDirectory: false },
						{ name: 'three.md', isFile: true, isDirectory: false },
					]);

				// Cap of 1 — without propagation, only one playbook would survive
				const result = await loadFileTreeRaw('/project', 5, 0, undefined, undefined, undefined, 1);

				const maestro = result.tree.find((n) => n.name === '.maestro');
				const playbooks = maestro?.children?.find((n) => n.name === 'playbooks');
				expect(playbooks?.children).toHaveLength(3);
			});
		});
	});

	// ============================================================================
	// buildTreeFromPaths — pure tree builder used by the batched SSH loader
	// ============================================================================
	describe('buildTreeFromPaths', () => {
		it('builds a hierarchical tree from flat directory and file lists', () => {
			const dirs = ['src', 'src/components', 'docs'];
			const files = ['README.md', 'src/index.ts', 'src/components/Button.tsx'];

			const tree = buildTreeFromPaths(dirs, files);

			expect(tree).toEqual([
				{
					name: 'docs',
					type: 'folder',
					children: [],
				},
				{
					name: 'src',
					type: 'folder',
					children: [
						{
							name: 'components',
							type: 'folder',
							children: [{ name: 'Button.tsx', type: 'file' }],
						},
						{ name: 'index.ts', type: 'file' },
					],
				},
				{ name: 'README.md', type: 'file' },
			]);
		});

		it('sorts folders before files and alphabetizes at every depth', () => {
			const tree = buildTreeFromPaths(
				['z-folder', 'a-folder'],
				['z.txt', 'a.txt', 'a-folder/inner.ts']
			);
			expect(tree.map((n) => n.name)).toEqual(['a-folder', 'z-folder', 'a.txt', 'z.txt']);
		});

		it('handles depth-bounded entries whose parent is missing by attaching to root', () => {
			// Simulates an entry cap that dropped intermediate dirs but kept a deep file.
			const tree = buildTreeFromPaths([], ['a/b/c/orphan.txt']);
			expect(tree).toEqual([{ name: 'orphan.txt', type: 'file' }]);
		});

		it('returns an empty tree when no paths are provided', () => {
			expect(buildTreeFromPaths([], [])).toEqual([]);
		});
	});

	// ============================================================================
	// spliceMaestroIntoTree — merge .maestro subtree (loaded in its own phase)
	// into the rest-of-tree result.
	// ============================================================================
	describe('spliceMaestroIntoTree', () => {
		it('prepends .maestro folder when subtree is non-empty', () => {
			const restTree: FileTreeNode[] = [
				{ name: 'src', type: 'folder', children: [] },
				{ name: 'package.json', type: 'file' },
			];
			const maestro: FileTreeNode[] = [{ name: 'playbooks', type: 'folder', children: [] }];

			const merged = spliceMaestroIntoTree(restTree, maestro);

			const maestroNode = merged.find((n) => n.name === '.maestro');
			expect(maestroNode).toBeDefined();
			expect(maestroNode?.children).toEqual(maestro);
		});

		it('omits .maestro entirely when the subtree is empty or undefined', () => {
			const restTree: FileTreeNode[] = [{ name: 'src', type: 'folder', children: [] }];
			expect(spliceMaestroIntoTree(restTree, undefined)).toEqual(restTree);
			expect(spliceMaestroIntoTree(restTree, [])).toEqual(restTree);
		});

		it('replaces any pre-existing .maestro in the rest tree with the supplied subtree', () => {
			// Defensive: the rest phase prunes .maestro server-side, but if it
			// somehow leaked through, the splice still wins.
			const restTree: FileTreeNode[] = [
				{ name: '.maestro', type: 'folder', children: [{ name: 'stale.md', type: 'file' }] },
				{ name: 'src', type: 'folder', children: [] },
			];
			const maestro: FileTreeNode[] = [{ name: 'fresh.md', type: 'file' }];

			const merged = spliceMaestroIntoTree(restTree, maestro);
			const maestroNode = merged.find((n) => n.name === '.maestro');
			expect(maestroNode?.children).toEqual(maestro);
			// No duplicate .maestro entries
			expect(merged.filter((n) => n.name === '.maestro')).toHaveLength(1);
		});
	});

	// ============================================================================
	// loadFileTreeRemoteBatched — phased SSH loader
	// ============================================================================
	describe('loadFileTreeRemoteBatched', () => {
		beforeEach(() => {
			// The shared test setup mounts a real `window.maestro` mock; we just
			// need to attach a controllable `listTreeRemote` mock for these tests.
			window.maestro.fs.listTreeRemote = vi.fn();
		});

		it('issues separate find calls for .maestro (unlimited) and the rest of the tree (capped)', async () => {
			const listTreeMock = window.maestro.fs.listTreeRemote as ReturnType<typeof vi.fn>;
			// First call: .maestro phase. Second call: rest phase.
			listTreeMock
				.mockResolvedValueOnce({
					directories: ['playbooks'],
					files: ['playbooks/foo.md'],
					truncated: false,
				})
				.mockResolvedValueOnce({
					directories: ['src'],
					files: ['src/index.ts', 'README.md'],
					truncated: false,
				});

			const onPhase = vi.fn();
			const result = await loadFileTreeRemoteBatched('/project', {
				maxDepth: 5,
				maxEntries: 1000,
				ignorePatterns: ['node_modules'],
				honorGitignore: false,
				sshRemoteId: 'remote-1',
				onPhase,
			});

			// Phase 1: .maestro at the dedicated path, unlimited budget, no ignores.
			expect(listTreeMock).toHaveBeenNthCalledWith(1, '/project/.maestro', 'remote-1', {
				maxDepth: 5,
				ignorePatterns: [],
				maxFiles: undefined,
			});
			// Phase 2: rest of tree, with file cap and .maestro pruned.
			expect(listTreeMock).toHaveBeenNthCalledWith(2, '/project', 'remote-1', {
				maxDepth: 5,
				ignorePatterns: ['node_modules'],
				excludePaths: ['.maestro'],
				maxFiles: 1000,
			});

			// onPhase fires twice: once after .maestro lands, once after rest lands.
			expect(onPhase).toHaveBeenCalledTimes(2);
			expect(onPhase.mock.calls[0][0]).toBe('maestro');
			expect(onPhase.mock.calls[1][0]).toBe('rest');

			// Final tree contains .maestro spliced in alongside the rest.
			const maestroNode = result.tree.find((n) => n.name === '.maestro');
			expect(maestroNode).toBeDefined();
			expect(result.truncated).toBe(false);
			expect(result.filesFound).toBe(3);
		});

		it('continues without .maestro when its phase fails (directory missing)', async () => {
			const listTreeMock = window.maestro.fs.listTreeRemote as ReturnType<typeof vi.fn>;
			listTreeMock
				.mockRejectedValueOnce(new Error('Directory not found or not accessible'))
				.mockResolvedValueOnce({
					directories: ['src'],
					files: ['src/index.ts'],
					truncated: false,
				});

			const result = await loadFileTreeRemoteBatched('/project', {
				maxDepth: 5,
				maxEntries: 1000,
				ignorePatterns: [],
				honorGitignore: false,
				sshRemoteId: 'remote-1',
			});

			expect(result.tree.find((n) => n.name === '.maestro')).toBeUndefined();
			expect(result.tree.find((n) => n.name === 'src')).toBeDefined();
		});

		it('propagates the truncated flag from the rest phase', async () => {
			const listTreeMock = window.maestro.fs.listTreeRemote as ReturnType<typeof vi.fn>;
			listTreeMock
				.mockResolvedValueOnce({ directories: [], files: [], truncated: false })
				.mockResolvedValueOnce({
					directories: ['src'],
					files: ['src/a.ts', 'src/b.ts'],
					truncated: true,
				});

			const result = await loadFileTreeRemoteBatched('/project', {
				maxDepth: 5,
				maxEntries: 2,
				ignorePatterns: [],
				honorGitignore: false,
				sshRemoteId: 'remote-1',
			});

			expect(result.truncated).toBe(true);
		});
	});

	// ============================================================================
	// getAllFolderPaths
	// ============================================================================
	describe('getAllFolderPaths', () => {
		it('returns empty array for empty tree', () => {
			expect(getAllFolderPaths([])).toEqual([]);
		});

		it('returns empty array for tree with only files', () => {
			const tree: FileTreeNode[] = [
				{ name: 'file1.txt', type: 'file' },
				{ name: 'file2.js', type: 'file' },
			];

			expect(getAllFolderPaths(tree)).toEqual([]);
		});

		it('returns folder paths for flat structure', () => {
			const tree: FileTreeNode[] = [
				{ name: 'src', type: 'folder', children: [] },
				{ name: 'tests', type: 'folder', children: [] },
				{ name: 'README.md', type: 'file' },
			];

			expect(getAllFolderPaths(tree)).toEqual(['src', 'tests']);
		});

		it('returns nested folder paths', () => {
			const tree: FileTreeNode[] = [
				{
					name: 'src',
					type: 'folder',
					children: [
						{ name: 'components', type: 'folder', children: [] },
						{ name: 'utils', type: 'folder', children: [] },
					],
				},
			];

			const paths = getAllFolderPaths(tree);
			expect(paths).toContain('src');
			expect(paths).toContain('src/components');
			expect(paths).toContain('src/utils');
			expect(paths).toHaveLength(3);
		});

		it('handles multiple levels of nesting', () => {
			const tree: FileTreeNode[] = [
				{
					name: 'level1',
					type: 'folder',
					children: [
						{
							name: 'level2',
							type: 'folder',
							children: [
								{
									name: 'level3',
									type: 'folder',
									children: [],
								},
							],
						},
					],
				},
			];

			const paths = getAllFolderPaths(tree);
			expect(paths).toEqual(['level1', 'level1/level2', 'level1/level2/level3']);
		});

		it('excludes file entries at all levels', () => {
			const tree: FileTreeNode[] = [
				{
					name: 'src',
					type: 'folder',
					children: [
						{ name: 'index.ts', type: 'file' },
						{ name: 'components', type: 'folder', children: [] },
					],
				},
				{ name: 'package.json', type: 'file' },
			];

			const paths = getAllFolderPaths(tree);
			expect(paths).toEqual(['src', 'src/components']);
			expect(paths).not.toContain('src/index.ts');
		});

		it('uses provided currentPath prefix', () => {
			const tree: FileTreeNode[] = [{ name: 'subdir', type: 'folder', children: [] }];

			const paths = getAllFolderPaths(tree, 'root');
			expect(paths).toEqual(['root/subdir']);
		});
	});

	// ============================================================================
	// flattenTree
	// ============================================================================
	describe('flattenTree', () => {
		it('returns empty array for empty tree', () => {
			expect(flattenTree([], new Set())).toEqual([]);
		});

		it('flattens single file', () => {
			const tree: FileTreeNode[] = [{ name: 'file.txt', type: 'file' }];

			const result = flattenTree(tree, new Set());

			expect(result).toHaveLength(1);
			expect(result[0]).toEqual({
				name: 'file.txt',
				type: 'file',
				fullPath: 'file.txt',
				isFolder: false,
			});
		});

		it('flattens single folder (collapsed)', () => {
			const tree: FileTreeNode[] = [
				{
					name: 'src',
					type: 'folder',
					children: [{ name: 'index.ts', type: 'file' }],
				},
			];

			const result = flattenTree(tree, new Set());

			expect(result).toHaveLength(1);
			expect(result[0]).toEqual({
				name: 'src',
				type: 'folder',
				children: [{ name: 'index.ts', type: 'file' }],
				fullPath: 'src',
				isFolder: true,
			});
		});

		it('includes children when folder is expanded', () => {
			const tree: FileTreeNode[] = [
				{
					name: 'src',
					type: 'folder',
					children: [{ name: 'index.ts', type: 'file' }],
				},
			];

			const expanded = new Set(['src']);
			const result = flattenTree(tree, expanded);

			expect(result).toHaveLength(2);
			expect(result[0].fullPath).toBe('src');
			expect(result[1].fullPath).toBe('src/index.ts');
		});

		it('excludes children when folder is collapsed', () => {
			const tree: FileTreeNode[] = [
				{
					name: 'src',
					type: 'folder',
					children: [
						{ name: 'index.ts', type: 'file' },
						{ name: 'app.ts', type: 'file' },
					],
				},
			];

			const result = flattenTree(tree, new Set());

			expect(result).toHaveLength(1);
			expect(result[0].fullPath).toBe('src');
		});

		it('sets correct fullPath for nested items', () => {
			const tree: FileTreeNode[] = [
				{
					name: 'src',
					type: 'folder',
					children: [
						{
							name: 'components',
							type: 'folder',
							children: [{ name: 'App.tsx', type: 'file' }],
						},
					],
				},
			];

			const expanded = new Set(['src', 'src/components']);
			const result = flattenTree(tree, expanded);

			expect(result).toHaveLength(3);
			expect(result[0].fullPath).toBe('src');
			expect(result[1].fullPath).toBe('src/components');
			expect(result[2].fullPath).toBe('src/components/App.tsx');
		});

		it('sets isFolder correctly', () => {
			const tree: FileTreeNode[] = [
				{ name: 'src', type: 'folder', children: [] },
				{ name: 'file.txt', type: 'file' },
			];

			const result = flattenTree(tree, new Set());

			expect(result[0].isFolder).toBe(true);
			expect(result[1].isFolder).toBe(false);
		});

		it('handles deeply nested expanded folders', () => {
			const tree: FileTreeNode[] = [
				{
					name: 'a',
					type: 'folder',
					children: [
						{
							name: 'b',
							type: 'folder',
							children: [
								{
									name: 'c',
									type: 'folder',
									children: [{ name: 'file.txt', type: 'file' }],
								},
							],
						},
					],
				},
			];

			const expanded = new Set(['a', 'a/b', 'a/b/c']);
			const result = flattenTree(tree, expanded);

			expect(result).toHaveLength(4);
			expect(result.map((n) => n.fullPath)).toEqual(['a', 'a/b', 'a/b/c', 'a/b/c/file.txt']);
		});

		it('only expands folders in expanded set', () => {
			const tree: FileTreeNode[] = [
				{
					name: 'src',
					type: 'folder',
					children: [
						{
							name: 'components',
							type: 'folder',
							children: [{ name: 'App.tsx', type: 'file' }],
						},
						{
							name: 'utils',
							type: 'folder',
							children: [{ name: 'helper.ts', type: 'file' }],
						},
					],
				},
			];

			// Only expand src and components, not utils
			const expanded = new Set(['src', 'src/components']);
			const result = flattenTree(tree, expanded);

			expect(result).toHaveLength(4);
			const paths = result.map((n) => n.fullPath);
			expect(paths).toContain('src');
			expect(paths).toContain('src/components');
			expect(paths).toContain('src/components/App.tsx');
			expect(paths).toContain('src/utils');
			expect(paths).not.toContain('src/utils/helper.ts'); // Not expanded
		});

		it('uses provided currentPath prefix', () => {
			const tree: FileTreeNode[] = [{ name: 'file.txt', type: 'file' }];

			const result = flattenTree(tree, new Set(), 'prefix');

			expect(result[0].fullPath).toBe('prefix/file.txt');
		});

		it('handles folders without children array', () => {
			const tree: FileTreeNode[] = [
				{ name: 'empty', type: 'folder' }, // No children property
			];

			const expanded = new Set(['empty']);
			const result = flattenTree(tree, expanded);

			expect(result).toHaveLength(1);
			expect(result[0].fullPath).toBe('empty');
		});
	});

	// ============================================================================
	// compareFileTrees
	// ============================================================================
	describe('compareFileTrees', () => {
		it('returns all zeros for identical trees', () => {
			const tree: FileTreeNode[] = [
				{ name: 'src', type: 'folder', children: [] },
				{ name: 'file.txt', type: 'file' },
			];

			const result = compareFileTrees(tree, tree);

			expect(result).toEqual({
				totalChanges: 0,
				newFiles: 0,
				newFolders: 0,
				removedFiles: 0,
				removedFolders: 0,
			});
		});

		it('detects new files', () => {
			const oldTree: FileTreeNode[] = [{ name: 'file1.txt', type: 'file' }];

			const newTree: FileTreeNode[] = [
				{ name: 'file1.txt', type: 'file' },
				{ name: 'file2.txt', type: 'file' },
			];

			const result = compareFileTrees(oldTree, newTree);

			expect(result.newFiles).toBe(1);
			expect(result.removedFiles).toBe(0);
		});

		it('detects new folders', () => {
			const oldTree: FileTreeNode[] = [{ name: 'src', type: 'folder', children: [] }];

			const newTree: FileTreeNode[] = [
				{ name: 'src', type: 'folder', children: [] },
				{ name: 'tests', type: 'folder', children: [] },
			];

			const result = compareFileTrees(oldTree, newTree);

			expect(result.newFolders).toBe(1);
			expect(result.removedFolders).toBe(0);
		});

		it('detects removed files', () => {
			const oldTree: FileTreeNode[] = [
				{ name: 'file1.txt', type: 'file' },
				{ name: 'file2.txt', type: 'file' },
			];

			const newTree: FileTreeNode[] = [{ name: 'file1.txt', type: 'file' }];

			const result = compareFileTrees(oldTree, newTree);

			expect(result.removedFiles).toBe(1);
			expect(result.newFiles).toBe(0);
		});

		it('detects removed folders', () => {
			const oldTree: FileTreeNode[] = [
				{ name: 'src', type: 'folder', children: [] },
				{ name: 'tests', type: 'folder', children: [] },
			];

			const newTree: FileTreeNode[] = [{ name: 'src', type: 'folder', children: [] }];

			const result = compareFileTrees(oldTree, newTree);

			expect(result.removedFolders).toBe(1);
			expect(result.newFolders).toBe(0);
		});

		it('calculates totalChanges correctly', () => {
			const oldTree: FileTreeNode[] = [
				{ name: 'old.txt', type: 'file' },
				{ name: 'oldFolder', type: 'folder', children: [] },
			];

			const newTree: FileTreeNode[] = [
				{ name: 'new.txt', type: 'file' },
				{ name: 'newFolder', type: 'folder', children: [] },
			];

			const result = compareFileTrees(oldTree, newTree);

			expect(result.totalChanges).toBe(4); // 1 new file + 1 new folder + 1 removed file + 1 removed folder
			expect(result.newFiles).toBe(1);
			expect(result.newFolders).toBe(1);
			expect(result.removedFiles).toBe(1);
			expect(result.removedFolders).toBe(1);
		});

		it('handles empty old tree (all new)', () => {
			const newTree: FileTreeNode[] = [
				{ name: 'src', type: 'folder', children: [] },
				{ name: 'file.txt', type: 'file' },
			];

			const result = compareFileTrees([], newTree);

			expect(result.newFiles).toBe(1);
			expect(result.newFolders).toBe(1);
			expect(result.removedFiles).toBe(0);
			expect(result.removedFolders).toBe(0);
			expect(result.totalChanges).toBe(2);
		});

		it('handles empty new tree (all removed)', () => {
			const oldTree: FileTreeNode[] = [
				{ name: 'src', type: 'folder', children: [] },
				{ name: 'file.txt', type: 'file' },
			];

			const result = compareFileTrees(oldTree, []);

			expect(result.removedFiles).toBe(1);
			expect(result.removedFolders).toBe(1);
			expect(result.newFiles).toBe(0);
			expect(result.newFolders).toBe(0);
			expect(result.totalChanges).toBe(2);
		});

		it('handles both empty trees', () => {
			const result = compareFileTrees([], []);

			expect(result).toEqual({
				totalChanges: 0,
				newFiles: 0,
				newFolders: 0,
				removedFiles: 0,
				removedFolders: 0,
			});
		});

		it('detects changes in nested structures', () => {
			const oldTree: FileTreeNode[] = [
				{
					name: 'src',
					type: 'folder',
					children: [
						{ name: 'index.ts', type: 'file' },
						{
							name: 'components',
							type: 'folder',
							children: [{ name: 'App.tsx', type: 'file' }],
						},
					],
				},
			];

			const newTree: FileTreeNode[] = [
				{
					name: 'src',
					type: 'folder',
					children: [
						{ name: 'index.ts', type: 'file' },
						{ name: 'main.ts', type: 'file' }, // New file
						{
							name: 'utils',
							type: 'folder',
							children: [],
						}, // New folder (components removed)
					],
				},
			];

			const result = compareFileTrees(oldTree, newTree);

			expect(result.newFiles).toBe(1); // main.ts
			expect(result.newFolders).toBe(1); // utils
			expect(result.removedFiles).toBe(1); // App.tsx
			expect(result.removedFolders).toBe(1); // components
			expect(result.totalChanges).toBe(4);
		});

		it('correctly identifies files vs folders with same name', () => {
			const oldTree: FileTreeNode[] = [{ name: 'test', type: 'file' }];

			const newTree: FileTreeNode[] = [{ name: 'test', type: 'folder', children: [] }];

			const result = compareFileTrees(oldTree, newTree);

			expect(result.removedFiles).toBe(1);
			expect(result.newFolders).toBe(1);
			expect(result.totalChanges).toBe(2);
		});

		it('handles deeply nested additions', () => {
			const oldTree: FileTreeNode[] = [
				{
					name: 'a',
					type: 'folder',
					children: [],
				},
			];

			const newTree: FileTreeNode[] = [
				{
					name: 'a',
					type: 'folder',
					children: [
						{
							name: 'b',
							type: 'folder',
							children: [
								{
									name: 'c',
									type: 'folder',
									children: [{ name: 'deep.txt', type: 'file' }],
								},
							],
						},
					],
				},
			];

			const result = compareFileTrees(oldTree, newTree);

			expect(result.newFolders).toBe(2); // b and c
			expect(result.newFiles).toBe(1); // deep.txt
			expect(result.totalChanges).toBe(3);
		});
	});

	// ============================================================================
	// matchGlobPattern
	// ============================================================================
	describe('matchGlobPattern', () => {
		describe('exact matches', () => {
			it('matches exact string', () => {
				expect(matchGlobPattern('.git', '.git')).toBe(true);
				expect(matchGlobPattern('node_modules', 'node_modules')).toBe(true);
			});

			it('does not match different strings', () => {
				expect(matchGlobPattern('.git', '.gitignore')).toBe(false);
				expect(matchGlobPattern('node_modules', 'node')).toBe(false);
			});
		});

		describe('wildcard (*) patterns', () => {
			it('matches prefix wildcard', () => {
				expect(matchGlobPattern('*.log', 'error.log')).toBe(true);
				expect(matchGlobPattern('*.log', 'access.log')).toBe(true);
				expect(matchGlobPattern('*.log', 'debug.log')).toBe(true);
			});

			it('does not match wrong extension with prefix wildcard', () => {
				expect(matchGlobPattern('*.log', 'file.txt')).toBe(false);
				expect(matchGlobPattern('*.log', 'log.txt')).toBe(false);
			});

			it('matches suffix wildcard', () => {
				expect(matchGlobPattern('test_*', 'test_file')).toBe(true);
				expect(matchGlobPattern('test_*', 'test_data.txt')).toBe(true);
			});

			it('does not match wrong prefix with suffix wildcard', () => {
				expect(matchGlobPattern('test_*', 'my_test_file')).toBe(false);
				expect(matchGlobPattern('test_*', 'file_test')).toBe(false);
			});

			it('matches infix wildcard (contains pattern)', () => {
				expect(matchGlobPattern('*cache*', 'cache')).toBe(true);
				expect(matchGlobPattern('*cache*', '.cache')).toBe(true);
				expect(matchGlobPattern('*cache*', '__pycache__')).toBe(true);
				expect(matchGlobPattern('*cache*', 'node_cache_dir')).toBe(true);
			});

			it('does not match non-containing strings for infix wildcard', () => {
				expect(matchGlobPattern('*cache*', 'temporary')).toBe(false);
				expect(matchGlobPattern('*cache*', 'cach')).toBe(false);
			});

			it('matches multiple wildcards', () => {
				expect(matchGlobPattern('*test*.log', 'unit_test_results.log')).toBe(true);
				expect(matchGlobPattern('*test*.log', 'test.log')).toBe(true);
			});
		});

		describe('question mark (?) patterns', () => {
			it('matches single character', () => {
				expect(matchGlobPattern('file?.txt', 'file1.txt')).toBe(true);
				expect(matchGlobPattern('file?.txt', 'fileA.txt')).toBe(true);
			});

			it('does not match wrong number of characters', () => {
				expect(matchGlobPattern('file?.txt', 'file.txt')).toBe(false);
				expect(matchGlobPattern('file?.txt', 'file12.txt')).toBe(false);
			});

			it('matches multiple question marks', () => {
				expect(matchGlobPattern('???.txt', 'abc.txt')).toBe(true);
				expect(matchGlobPattern('???.txt', '123.txt')).toBe(true);
			});

			it('does not match with wrong character count', () => {
				expect(matchGlobPattern('???.txt', 'ab.txt')).toBe(false);
				expect(matchGlobPattern('???.txt', 'abcd.txt')).toBe(false);
			});
		});

		describe('combined patterns', () => {
			it('handles * and ? together', () => {
				expect(matchGlobPattern('*.?s', 'file.ts')).toBe(true);
				expect(matchGlobPattern('*.?s', 'app.js')).toBe(true);
				expect(matchGlobPattern('*.?s', 'main.cs')).toBe(true);
			});

			it('handles special regex characters in pattern', () => {
				expect(matchGlobPattern('.git', '.git')).toBe(true);
				expect(matchGlobPattern('file[1].txt', 'file[1].txt')).toBe(true);
				expect(matchGlobPattern('a+b.txt', 'a+b.txt')).toBe(true);
			});
		});

		describe('case sensitivity', () => {
			it('is case insensitive for user-friendliness', () => {
				expect(matchGlobPattern('*.LOG', 'file.log')).toBe(true);
				expect(matchGlobPattern('*.log', 'file.LOG')).toBe(true);
				expect(matchGlobPattern('.Git', '.git')).toBe(true);
				expect(matchGlobPattern('NODE_MODULES', 'node_modules')).toBe(true);
			});
		});
	});

	// ============================================================================
	// shouldIgnore
	// ============================================================================
	describe('shouldIgnore', () => {
		it('returns false for empty patterns array', () => {
			expect(shouldIgnore('anyfile', [])).toBe(false);
			expect(shouldIgnore('.git', [])).toBe(false);
		});

		it('returns true when name matches any pattern', () => {
			const patterns = ['.git', '*cache*', 'node_modules'];
			expect(shouldIgnore('.git', patterns)).toBe(true);
			expect(shouldIgnore('__pycache__', patterns)).toBe(true);
			expect(shouldIgnore('node_modules', patterns)).toBe(true);
		});

		it('returns false when name matches no patterns', () => {
			const patterns = ['.git', '*cache*', 'node_modules'];
			expect(shouldIgnore('src', patterns)).toBe(false);
			expect(shouldIgnore('README.md', patterns)).toBe(false);
			expect(shouldIgnore('package.json', patterns)).toBe(false);
		});

		it('handles default SSH ignore patterns', () => {
			const defaultPatterns = ['.git', '.*cache*'];
			expect(shouldIgnore('.git', defaultPatterns)).toBe(true);
			expect(shouldIgnore('.cache', defaultPatterns)).toBe(true);
			expect(shouldIgnore('.__pycache__', defaultPatterns)).toBe(true);
			expect(shouldIgnore('.pytest_cache', defaultPatterns)).toBe(true);
			expect(shouldIgnore('src', defaultPatterns)).toBe(false);
			// Does not match cache dirs without leading dot
			expect(shouldIgnore('__pycache__', defaultPatterns)).toBe(false);
		});

		it('handles multiple specific patterns', () => {
			const patterns = ['*.log', '*.tmp', 'temp_*'];
			expect(shouldIgnore('error.log', patterns)).toBe(true);
			expect(shouldIgnore('backup.tmp', patterns)).toBe(true);
			expect(shouldIgnore('temp_file', patterns)).toBe(true);
			expect(shouldIgnore('main.ts', patterns)).toBe(false);
		});

		it('returns true on first matching pattern', () => {
			const patterns = ['first', 'second', 'third'];
			expect(shouldIgnore('first', patterns)).toBe(true);
			expect(shouldIgnore('second', patterns)).toBe(true);
			expect(shouldIgnore('third', patterns)).toBe(true);
		});
	});
});
