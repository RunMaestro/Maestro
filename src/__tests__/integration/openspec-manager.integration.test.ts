import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	appState: {
		userData: '',
		isPackaged: false,
	},
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

vi.mock('electron', () => ({
	app: {
		getPath: vi.fn(() => mocks.appState.userData),
		get isPackaged() {
			return mocks.appState.isPackaged;
		},
		set isPackaged(value: boolean) {
			mocks.appState.isPackaged = value;
		},
	},
}));

vi.mock('../../main/utils/logger', () => ({
	logger: mocks.logger,
}));

import {
	getOpenSpecCommand,
	getOpenSpecCommandBySlash,
	getOpenSpecMetadata,
	getOpenSpecPrompts,
	refreshOpenSpecPrompts,
	resetOpenSpecPrompt,
	saveOpenSpecPrompt,
	type OpenSpecMetadata,
} from '../../main/openspec-manager';

const tempRoots: string[] = [];

type StoredPromptSnapshot = {
	content?: string;
	isModified?: boolean;
	modifiedAt?: string;
};

describe('openspec manager integration', () => {
	beforeEach(async () => {
		vi.clearAllMocks();
		vi.unstubAllGlobals();
		mocks.appState.userData = await makeRoot('openspec-user-data');
		mocks.appState.isPackaged = false;
		delete (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
	});

	afterEach(async () => {
		vi.unstubAllGlobals();
		mocks.appState.isPackaged = false;
		delete (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
		for (const dir of tempRoots.splice(0)) {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it('loads bundled prompts, downloaded prompts, and user customizations from disk', async () => {
		const downloadedMetadata = metadata('v3.1.4');
		const customMetadata = metadata('v4.0.0');
		await fs.mkdir(path.dirname(promptsPath('openspec.proposal.md')), { recursive: true });
		await fs.writeFile(promptsPath('openspec.proposal.md'), '# Downloaded Proposal', 'utf8');
		await writeJson(promptsPath('metadata.json'), downloadedMetadata);
		await writeJson(customizationsPath(), {
			metadata: customMetadata,
			prompts: {
				apply: {
					content: '# Custom Apply',
					isModified: true,
					modifiedAt: '2026-05-26T10:00:00.000Z',
				},
				archive: {
					content: '# Ignored Archive',
					isModified: false,
				},
			},
		});

		await expect(getOpenSpecMetadata()).resolves.toEqual(customMetadata);

		const commands = await getOpenSpecPrompts();
		expect(commands).toHaveLength(5);
		expect(commands.find((command) => command.id === 'help')).toMatchObject({
			command: '/openspec.help',
			isCustom: true,
			isModified: false,
		});
		expect(commands.find((command) => command.id === 'proposal')).toMatchObject({
			prompt: '# Downloaded Proposal',
			isCustom: false,
			isModified: false,
		});
		expect(commands.find((command) => command.id === 'apply')).toMatchObject({
			prompt: '# Custom Apply',
			isModified: true,
		});
		expect(commands.find((command) => command.id === 'archive')?.prompt).not.toBe(
			'# Ignored Archive'
		);

		await expect(getOpenSpecCommand('proposal')).resolves.toEqual(
			expect.objectContaining({ prompt: '# Downloaded Proposal' })
		);
		await expect(getOpenSpecCommandBySlash('/openspec.apply')).resolves.toEqual(
			expect.objectContaining({ prompt: '# Custom Apply' })
		);
		await expect(getOpenSpecCommand('missing')).resolves.toBeNull();
		await expect(getOpenSpecCommandBySlash('/openspec.missing')).resolves.toBeNull();

		await fs.rm(customizationsPath());
		await expect(getOpenSpecMetadata()).resolves.toEqual(downloadedMetadata);
	});

	it('persists prompt customizations and resets them back to bundled defaults', async () => {
		await saveOpenSpecPrompt('proposal', '# User Proposal');

		const saved = await readJson<{
			metadata: OpenSpecMetadata;
			prompts: Record<string, StoredPromptSnapshot>;
		}>(customizationsPath());
		expect(saved.metadata.sourceUrl).toBe('https://github.com/Fission-AI/OpenSpec');
		expect(saved.prompts.proposal).toEqual(
			expect.objectContaining({
				content: '# User Proposal',
				isModified: true,
				modifiedAt: expect.any(String),
			})
		);
		expect(mocks.logger.info).toHaveBeenCalledWith(
			'Saved customization for openspec.proposal',
			'[OpenSpec]'
		);
		await expect(getOpenSpecCommand('proposal')).resolves.toEqual(
			expect.objectContaining({ prompt: '# User Proposal', isModified: true })
		);

		const resetPrompt = await resetOpenSpecPrompt('proposal');
		expect(resetPrompt).not.toBe('# User Proposal');
		const afterReset = await readJson<{ prompts: Record<string, unknown> }>(customizationsPath());
		expect(afterReset.prompts.proposal).toBeUndefined();
		expect(mocks.logger.info).toHaveBeenCalledWith(
			'Reset openspec.proposal to bundled default',
			'[OpenSpec]'
		);

		await expect(resetOpenSpecPrompt('missing')).rejects.toThrow(
			'Unknown openspec command: missing'
		);
		await expect(resetOpenSpecPrompt('archive')).resolves.toEqual(expect.any(String));
	});

	it('uses packaged resource paths and placeholder fallbacks when bundled files are missing', async () => {
		const resourcesPath = await makeRoot('openspec-resources');
		(process as NodeJS.Process & { resourcesPath?: string }).resourcesPath = resourcesPath;
		mocks.appState.isPackaged = true;
		await fs.mkdir(path.join(resourcesPath, 'prompts', 'openspec'), { recursive: true });
		await fs.writeFile(
			path.join(resourcesPath, 'prompts', 'openspec', 'openspec.archive.md'),
			'# Packaged Archive',
			'utf8'
		);

		await expect(getOpenSpecMetadata()).resolves.toEqual({
			lastRefreshed: '2026-01-12T00:00:00Z',
			commitSha: 'v0.19.0',
			sourceVersion: '0.19.0',
			sourceUrl: 'https://github.com/Fission-AI/OpenSpec',
		});

		const commands = await getOpenSpecPrompts();
		expect(commands.find((command) => command.id === 'archive')?.prompt).toBe('# Packaged Archive');
		expect(commands.find((command) => command.id === 'help')?.prompt).toBe(
			'# help\n\nPrompt not available.'
		);
		expect(commands.find((command) => command.id === 'proposal')?.prompt).toBe(
			'# proposal\n\nPrompt not available.'
		);
		expect(mocks.logger.warn).toHaveBeenCalledWith(
			expect.stringContaining('Failed to load bundled prompt for help:'),
			'[OpenSpec]'
		);
		expect(mocks.logger.warn).toHaveBeenCalledWith(
			expect.stringContaining('Failed to load bundled prompt for proposal:'),
			'[OpenSpec]'
		);
	});

	it('refreshes upstream prompts from mocked release and workflow responses', async () => {
		await writeJson(customizationsPath(), {
			metadata: metadata('v1.0.0'),
			prompts: {
				help: {
					content: '# Custom Help',
					isModified: true,
				},
			},
		});
		const fetchMock = stubFetch(
			{
				ok: true,
				json: vi.fn().mockResolvedValue({ tag_name: 'v9.8.7' }),
			},
			{
				ok: true,
				text: vi.fn().mockResolvedValue(workflowSource('Write the proposal.')),
			},
			{
				ok: true,
				text: vi.fn().mockResolvedValue(workflowSource('Implement the approved tasks.')),
			},
			{
				ok: true,
				text: vi.fn().mockResolvedValue(workflowSource('Archive the completed change.')),
			}
		);

		const refreshed = await refreshOpenSpecPrompts();

		expect(fetchMock).toHaveBeenCalledWith(
			'https://api.github.com/repos/Fission-AI/OpenSpec/releases/latest',
			{
				headers: { 'User-Agent': 'Maestro-OpenSpec-Refresher' },
			}
		);
		for (const sourceFile of ['propose.ts', 'apply-change.ts', 'archive-change.ts']) {
			expect(fetchMock).toHaveBeenCalledWith(
				`https://raw.githubusercontent.com/Fission-AI/OpenSpec/v9.8.7/src/core/templates/workflows/${sourceFile}`,
				{
					headers: { 'User-Agent': 'Maestro-OpenSpec-Refresher' },
				}
			);
		}
		expect(refreshed).toEqual(
			expect.objectContaining({
				commitSha: 'v9.8.7',
				sourceVersion: '9.8.7',
				sourceUrl: 'https://github.com/Fission-AI/OpenSpec',
			})
		);
		await expect(fs.readFile(promptsPath('openspec.proposal.md'), 'utf8')).resolves.toContain(
			'Write the proposal.'
		);
		await expect(fs.readFile(promptsPath('openspec.apply.md'), 'utf8')).resolves.toContain(
			'Implement the approved tasks.'
		);
		await expect(fs.readFile(promptsPath('openspec.archive.md'), 'utf8')).resolves.toContain(
			'Archive the completed change.'
		);
		await expect(readJson<OpenSpecMetadata>(promptsPath('metadata.json'))).resolves.toMatchObject({
			commitSha: 'v9.8.7',
			sourceVersion: '9.8.7',
		});
		await expect(
			readJson<{ metadata: OpenSpecMetadata; prompts: Record<string, { content: string }> }>(
				customizationsPath()
			)
		).resolves.toEqual(
			expect.objectContaining({
				metadata: expect.objectContaining({ commitSha: 'v9.8.7' }),
				prompts: expect.objectContaining({
					help: expect.objectContaining({ content: '# Custom Help' }),
				}),
			})
		);
		expect(mocks.logger.info).toHaveBeenCalledWith(
			'Refreshed OpenSpec prompts to v9.8.7',
			'[OpenSpec]'
		);
	});

	it('surfaces refresh failures and warns when workflow instructions are missing', async () => {
		stubFetch(new Error('network down'), {
			ok: false,
			statusText: 'Not Found',
		});
		await expect(refreshOpenSpecPrompts()).rejects.toThrow('Failed to fetch propose.ts: Not Found');
		expect(mocks.logger.warn).toHaveBeenCalledWith(
			'Could not fetch release info, using main branch',
			'[OpenSpec]'
		);

		stubFetch(
			{ ok: false },
			{
				ok: true,
				text: vi.fn().mockResolvedValue(workflowSource('Only proposal.')),
			},
			{
				ok: true,
				text: vi.fn().mockResolvedValue('export const apply = {};'),
			},
			{
				ok: true,
				text: vi.fn().mockResolvedValue('export const archive = {};'),
			}
		);

		const refreshed = await refreshOpenSpecPrompts();

		expect(refreshed).toMatchObject({
			commitSha: 'main',
			sourceVersion: 'main',
		});
		await expect(fs.readFile(promptsPath('openspec.proposal.md'), 'utf8')).resolves.toContain(
			'Only proposal.'
		);
		await expect(fs.stat(promptsPath('openspec.apply.md'))).rejects.toThrow();
		expect(mocks.logger.warn).toHaveBeenCalledWith(
			'Could not extract instructions from apply-change.ts',
			'[OpenSpec]'
		);
		expect(mocks.logger.warn).toHaveBeenCalledWith(
			'Could not extract instructions from archive-change.ts',
			'[OpenSpec]'
		);
	});
});

async function makeRoot(name: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), `maestro-${name}-`));
	tempRoots.push(dir);
	return dir;
}

async function writeJson(filePath: string, data: unknown): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}

async function readJson<T>(filePath: string): Promise<T> {
	return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
}

function customizationsPath(): string {
	return path.join(mocks.appState.userData, 'openspec-customizations.json');
}

function promptsPath(...parts: string[]): string {
	return path.join(mocks.appState.userData, 'openspec-prompts', ...parts);
}

function metadata(version = 'v2.0.0'): OpenSpecMetadata {
	return {
		lastRefreshed: '2026-05-26T10:00:00.000Z',
		commitSha: version,
		sourceVersion: version.replace(/^v/, ''),
		sourceUrl: 'https://github.com/Fission-AI/OpenSpec',
	};
}

function workflowSource(instructions: string): string {
	return ['export const workflow = {', '\tinstructions: `', instructions, '`,', '};'].join('\n');
}

function stubFetch(...responses: unknown[]): ReturnType<typeof vi.fn> {
	const fetchMock = vi.fn();
	for (const response of responses) {
		if (response instanceof Error) {
			fetchMock.mockRejectedValueOnce(response);
		} else {
			fetchMock.mockResolvedValueOnce(response);
		}
	}
	vi.stubGlobal('fetch', fetchMock);
	return fetchMock;
}
