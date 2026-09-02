/**
 * @file image.test.ts
 * @description Tests for the `image list` / `image save` CLI commands.
 *
 * Covers:
 * - Newest-first ordering, with staged (unsent) images ahead of sent ones
 * - Target resolution by index, by content handle, and by default ("latest")
 * - Output resolution: generated name in the cwd, explicit file, directory
 * - The extension following the bytes rather than the requested name
 * - Collision handling (`-2` suffix for generated names, `--force` for explicit)
 * - `--all` treating `--output` as a folder even for a single image
 */

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { SessionInfo } from '../../../shared/types';

vi.mock('../../../cli/services/file-tree-refresh', () => ({
	nudgeFileTreeForPaths: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../../cli/services/storage', () => ({
	resolveAgentId: vi.fn((id: string) => id),
	readSessions: vi.fn().mockReturnValue([]),
	getConfigDir: vi.fn(),
}));

import { imageList, imageSave } from '../../../cli/commands/image';
import { readSessions, getConfigDir, resolveAgentId } from '../../../cli/services/storage';
import { nudgeFileTreeForPaths } from '../../../cli/services/file-tree-refresh';

const PNG_SHA = 'a'.repeat(64);
const JPEG_SHA = 'b'.repeat(64);
const STAGED_SHA = 'c'.repeat(64);
const PNG_REF = `maestro-image://store/${PNG_SHA}.png`;
const JPEG_REF = `maestro-image://store/${JPEG_SHA}.jpeg`;
const STAGED_REF = `maestro-image://store/${STAGED_SHA}.png`;

describe('image commands', () => {
	let consoleSpy: MockInstance;
	let configDir: string;
	let outDir: string;

	/** One agent with a tab holding a staged image and two sent ones. */
	const mockSessions = (): SessionInfo[] =>
		[
			{
				id: 'agent-1',
				name: 'Test Agent',
				toolType: 'claude-code',
				cwd: '/project',
				projectRoot: '/project',
				aiTabs: [
					{
						id: 'tab-1',
						name: 'Main',
						stagedImages: [STAGED_REF],
						logs: [
							{ timestamp: 1000, text: 'older message', images: [JPEG_REF] },
							{ timestamp: 2000, text: 'newer message\nsecond line', images: [PNG_REF] },
						],
					},
				],
			},
		] as unknown as SessionInfo[];

	beforeEach(() => {
		configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-image-test-'));
		outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-image-out-'));
		const imageDir = path.join(configDir, 'session-images');
		fs.mkdirSync(imageDir, { recursive: true });
		fs.writeFileSync(path.join(imageDir, `${PNG_SHA}.png`), Buffer.from('png-bytes'));
		fs.writeFileSync(path.join(imageDir, `${JPEG_SHA}.jpeg`), Buffer.from('jpeg-bytes'));
		fs.writeFileSync(path.join(imageDir, `${STAGED_SHA}.png`), Buffer.from('staged-bytes'));

		vi.mocked(getConfigDir).mockReturnValue(configDir);
		vi.mocked(resolveAgentId).mockImplementation((id: string) => id);
		vi.mocked(readSessions).mockReturnValue(mockSessions());
		vi.mocked(nudgeFileTreeForPaths).mockResolvedValue([]);

		consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
			throw new Error(`process.exit(${code})`);
		}) as never);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		fs.rmSync(configDir, { recursive: true, force: true });
		fs.rmSync(outDir, { recursive: true, force: true });
	});

	const jsonOutput = () => JSON.parse(consoleSpy.mock.calls[0][0] as string);

	describe('image list', () => {
		it('lists staged images first, then sent ones newest-first', () => {
			imageList({ json: true });

			const result = jsonOutput();
			expect(result.success).toBe(true);
			expect(result.total).toBe(3);
			expect(result.images.map((i: { ref: string }) => i.ref)).toEqual([
				STAGED_REF,
				PNG_REF,
				JPEG_REF,
			]);
			expect(result.images[0].staged).toBe(true);
			expect(result.images[0].timestamp).toBeNull();
			expect(result.images[1].message).toBe('newer message');
			expect(result.images[1].handle).toBe(PNG_SHA.slice(0, 8));
		});

		it('honors --limit while still reporting the true total', () => {
			imageList({ limit: '1', json: true });

			const result = jsonOutput();
			expect(result.images).toHaveLength(1);
			expect(result.total).toBe(3);
		});

		it('rejects a non-positive --limit', async () => {
			expect(() => imageList({ limit: '0', json: true })).toThrow('process.exit(2)');
			expect(jsonOutput().code).toBe('INVALID_USAGE');
		});

		it('says nothing was found rather than printing an empty table', () => {
			vi.mocked(readSessions).mockReturnValue([]);

			imageList({});

			expect(consoleSpy.mock.calls[0][0]).toContain('No pasted images found');
		});
	});

	describe('image save', () => {
		it('saves the newest image when no target is given', async () => {
			await imageSave(undefined, { output: outDir, json: true });

			const { saved } = jsonOutput();
			expect(saved).toHaveLength(1);
			expect(saved[0].ref).toBe(STAGED_REF);
			expect(path.dirname(saved[0].path)).toBe(path.resolve(outDir));
			expect(fs.readFileSync(saved[0].path, 'utf-8')).toBe('staged-bytes');
		});

		it('saves by 1-based index from the list', async () => {
			await imageSave('3', { output: outDir, json: true });

			expect(fs.readFileSync(jsonOutput().saved[0].path, 'utf-8')).toBe('jpeg-bytes');
		});

		it('nudges the Files panel for the paths it wrote', async () => {
			await imageSave(undefined, { output: outDir, json: true });

			const written = jsonOutput().saved[0].path;
			expect(nudgeFileTreeForPaths).toHaveBeenCalledWith([written]);
		});

		it('saves by content handle', async () => {
			await imageSave(PNG_SHA.slice(0, 8), { output: outDir, json: true });

			expect(fs.readFileSync(jsonOutput().saved[0].path, 'utf-8')).toBe('png-bytes');
		});

		it('rejects a handle that matches nothing', async () => {
			await expect(imageSave('deadbeef', { output: outDir, json: true })).rejects.toThrow(
				'process.exit(1)'
			);
			expect(jsonOutput().code).toBe('IMAGE_NOT_FOUND');
		});

		it('rejects an index past the end of the list', async () => {
			await expect(imageSave('99', { output: outDir, json: true })).rejects.toThrow(
				'process.exit(1)'
			);
			expect(jsonOutput().code).toBe('IMAGE_NOT_FOUND');
		});

		it('names the file after the bytes, not the requested extension', async () => {
			const requested = path.join(outDir, 'shot.png');

			await imageSave('3', { output: requested, json: true });

			const written = jsonOutput().saved[0].path;
			expect(path.basename(written)).toBe('shot.jpeg');
			expect(fs.existsSync(requested)).toBe(false);
		});

		it('refuses to overwrite an explicit path without --force', async () => {
			const requested = path.join(outDir, 'shot.png');
			fs.writeFileSync(requested, 'existing');

			await expect(imageSave('1', { output: requested, json: true })).rejects.toThrow(
				'process.exit(1)'
			);
			expect(jsonOutput().code).toBe('FILE_EXISTS');
			expect(fs.readFileSync(requested, 'utf-8')).toBe('existing');
		});

		it('overwrites an explicit path with --force', async () => {
			const requested = path.join(outDir, 'shot.png');
			fs.writeFileSync(requested, 'existing');

			await imageSave('1', { output: requested, force: true, json: true });

			expect(fs.readFileSync(requested, 'utf-8')).toBe('staged-bytes');
		});

		it('suffixes a generated name rather than clobbering a previous save', async () => {
			await imageSave('2', { output: outDir, json: true });
			const first = jsonOutput().saved[0].path;
			consoleSpy.mockClear();

			await imageSave('2', { output: outDir, json: true });
			const second = jsonOutput().saved[0].path;

			expect(second).not.toBe(first);
			expect(path.basename(second)).toMatch(/-2\.png$/);
			expect(fs.existsSync(first)).toBe(true);
		});

		it('treats --output as a folder with --all, even for one image', async () => {
			const target = path.join(outDir, 'batch');

			await imageSave(undefined, { all: true, tab: 'tab-1', output: target, json: true });

			const { saved } = jsonOutput();
			expect(saved).toHaveLength(3);
			expect(fs.statSync(target).isDirectory()).toBe(true);
			expect(fs.readdirSync(target)).toHaveLength(3);
		});

		it('rejects --all when --output names an existing file', async () => {
			const target = path.join(outDir, 'afile');
			fs.writeFileSync(target, 'x');

			await expect(imageSave(undefined, { all: true, output: target, json: true })).rejects.toThrow(
				'process.exit(2)'
			);
			expect(jsonOutput().code).toBe('INVALID_USAGE');
		});

		it('narrows to one tab and reports when that tab has no images', async () => {
			await expect(
				imageSave(undefined, { tab: 'tab-missing', output: outDir, json: true })
			).rejects.toThrow('process.exit(1)');
			expect(jsonOutput().code).toBe('NO_IMAGES');
		});

		it('fails loudly when the store is missing the bytes', async () => {
			fs.rmSync(path.join(configDir, 'session-images', `${STAGED_SHA}.png`));

			await expect(imageSave('1', { output: outDir, json: true })).rejects.toThrow(
				'process.exit(1)'
			);
			expect(jsonOutput().code).toBe('IMAGE_MISSING');
		});

		it('surfaces an unknown agent as AGENT_NOT_FOUND', async () => {
			vi.mocked(resolveAgentId).mockImplementation(() => {
				throw new Error('Agent not found: nope');
			});

			await expect(imageSave(undefined, { agent: 'nope', json: true })).rejects.toThrow(
				'process.exit(1)'
			);
			expect(jsonOutput().code).toBe('AGENT_NOT_FOUND');
		});
	});
});
