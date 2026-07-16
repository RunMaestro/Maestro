import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';

vi.mock('electron', () => ({
	app: {
		getPath: vi.fn().mockReturnValue('/profile'),
		isPackaged: false,
	},
}));

vi.mock('fs/promises', () => ({
	default: {
		readFile: vi.fn(),
		writeFile: vi.fn(),
		mkdir: vi.fn(),
		rm: vi.fn(),
	},
}));

vi.mock('../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn() },
}));

import {
	createSpecCommandManager,
	type SpecCommandManagerConfig,
	type SpecMetadata,
} from '../../main/spec-command-manager';

function enoent(): NodeJS.ErrnoException {
	const error = new Error('ENOENT') as NodeJS.ErrnoException;
	error.code = 'ENOENT';
	return error;
}

const metadata: SpecMetadata = {
	lastRefreshed: '2026-01-01T00:00:00.000Z',
	commitSha: 'old',
	sourceVersion: '1.0.0',
	sourceUrl: 'https://example.test/source',
};

function createConfig(overrides: Partial<SpecCommandManagerConfig> = {}): SpecCommandManagerConfig {
	return {
		logContext: '[Test]',
		filePrefix: 'spec',
		bundledDirName: 'spec',
		customizationsFileName: 'spec-customizations.json',
		userPromptsDirName: 'spec-prompts',
		commands: [{ id: 'refresh', description: 'Refresh', isCustom: false }],
		defaultMetadata: metadata,
		...overrides,
	};
}

describe('spec-command-manager refresh storage', () => {
	let files: Map<string, Buffer>;
	let failNextCustomizationWrite: boolean;

	beforeEach(() => {
		files = new Map();
		failNextCustomizationWrite = false;
		vi.clearAllMocks();
		vi.mocked(fs.readFile).mockImplementation(async (pathname, options?: unknown) => {
			const content = files.get(pathname.toString());
			if (!content) throw enoent();
			return options === 'utf-8' ? content.toString('utf-8') : Buffer.from(content);
		});
		vi.mocked(fs.writeFile).mockImplementation(async (pathname, content) => {
			const filename = pathname.toString();
			if (failNextCustomizationWrite && filename.endsWith('spec-customizations.json')) {
				failNextCustomizationWrite = false;
				throw new Error('customization write failed');
			}
			files.set(filename, Buffer.isBuffer(content) ? Buffer.from(content) : Buffer.from(content));
		});
		vi.mocked(fs.mkdir).mockResolvedValue(undefined);
		vi.mocked(fs.rm).mockImplementation(async (pathname) => {
			files.delete(pathname.toString());
		});
	});

	it('preserves a user customization while replacing refreshed source content', async () => {
		files.set(
			path.join('/profile', 'spec-customizations.json'),
			Buffer.from(
				JSON.stringify({
					metadata,
					prompts: { refresh: { content: 'user prompt', isModified: true } },
				})
			)
		);
		const manager = createSpecCommandManager(createConfig());
		const refreshedMetadata = { ...metadata, commitSha: 'new', sourceVersion: '1.1.0' };

		await manager.commitRefresh(
			[{ id: 'refresh', content: 'new source prompt' }],
			refreshedMetadata
		);

		expect(files.get(path.join('/profile', 'spec-prompts', 'spec.refresh.md'))?.toString()).toBe(
			'new source prompt'
		);
		expect(
			JSON.parse(files.get(path.join('/profile', 'spec-customizations.json'))!.toString())
		).toEqual({
			metadata: refreshedMetadata,
			prompts: { refresh: { content: 'user prompt', isModified: true } },
		});
		expect((await manager.getPrompts())[0]?.prompt).toBe('user prompt');
	});

	it('restores the exact prior bytes if refresh cannot persist customization metadata', async () => {
		const originalPrompt = Buffer.from([0, 255, 16]);
		const originalMetadata = Buffer.from('{"old":true}\n');
		const originalCustomizations = Buffer.from('{"custom":true}\n');
		files.set(path.join('/profile', 'spec-prompts', 'spec.refresh.md'), originalPrompt);
		files.set(path.join('/profile', 'spec-prompts', 'metadata.json'), originalMetadata);
		files.set(path.join('/profile', 'spec-customizations.json'), originalCustomizations);
		failNextCustomizationWrite = true;
		const manager = createSpecCommandManager(createConfig());

		await expect(
			manager.commitRefresh([{ id: 'refresh', content: 'new source prompt' }], {
				...metadata,
				commitSha: 'new',
			})
		).rejects.toThrow('customization write failed');

		expect(files.get(path.join('/profile', 'spec-prompts', 'spec.refresh.md'))).toEqual(
			originalPrompt
		);
		expect(files.get(path.join('/profile', 'spec-prompts', 'metadata.json'))).toEqual(
			originalMetadata
		);
		expect(files.get(path.join('/profile', 'spec-customizations.json'))).toEqual(
			originalCustomizations
		);
	});

	it('keeps domain command and source policies in explicit hooks', async () => {
		const manager = createSpecCommandManager(
			createConfig({
				filePrefix: 'bmad',
				commandForDefinition: () => '/bmad-custom',
				loadPrompt: async () => 'bmad source',
				loadMetadata: async () => ({ ...metadata, sourceVersion: '6.2.0' }),
			})
		);

		expect(await manager.getPrompts()).toEqual([
			expect.objectContaining({ command: '/bmad-custom', prompt: 'bmad source' }),
		]);
		expect(await manager.getMetadata()).toEqual(
			expect.objectContaining({ sourceVersion: '6.2.0' })
		);
	});
});
