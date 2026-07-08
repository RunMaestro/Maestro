import { EventEmitter } from 'events';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { Readable, Writable } from 'stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	appState: {
		userData: '',
		temp: '',
		isPackaged: false,
	},
	execAsync: vi.fn(),
	exec: vi.fn(),
	httpsGet: vi.fn(),
	createWriteStream: vi.fn(),
	pipeState: {
		count: 0,
	},
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

mocks.exec[Symbol.for('nodejs.util.promisify.custom')] = mocks.execAsync;

vi.mock('electron', () => ({
	app: {
		getPath: vi.fn((name: string) =>
			name === 'temp' ? mocks.appState.temp : mocks.appState.userData
		),
		get isPackaged() {
			return mocks.appState.isPackaged;
		},
		set isPackaged(value: boolean) {
			mocks.appState.isPackaged = value;
		},
	},
}));

vi.mock('child_process', () => ({
	exec: mocks.exec,
	default: {
		exec: mocks.exec,
	},
}));

vi.mock('node:child_process', () => ({
	exec: mocks.exec,
	default: {
		exec: mocks.exec,
	},
}));

vi.mock('https', () => ({
	default: {
		get: mocks.httpsGet,
	},
	get: mocks.httpsGet,
}));

vi.mock('node:https', () => ({
	default: {
		get: mocks.httpsGet,
	},
	get: mocks.httpsGet,
}));

vi.mock('fs', async (importOriginal) => {
	const actual = await importOriginal<typeof import('fs')>();
	return {
		...actual,
		createWriteStream: mocks.createWriteStream,
		default: {
			...actual,
			createWriteStream: mocks.createWriteStream,
		},
	};
});

vi.mock('node:fs', async (importOriginal) => {
	const actual = await importOriginal<typeof import('fs')>();
	return {
		...actual,
		createWriteStream: mocks.createWriteStream,
		default: {
			...actual,
			createWriteStream: mocks.createWriteStream,
		},
	};
});

vi.mock('../../main/utils/logger', () => ({
	logger: mocks.logger,
}));

import {
	getSpeckitCommand,
	getSpeckitCommandBySlash,
	getSpeckitMetadata,
	getSpeckitPrompts,
	refreshSpeckitPrompts,
	resetSpeckitPrompt,
	saveSpeckitPrompt,
	type SpecKitMetadata,
} from '../../main/speckit-manager';

const tempRoots: string[] = [];

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
	return path.join(mocks.appState.userData, 'speckit-customizations.json');
}

function promptsPath(...parts: string[]): string {
	return path.join(mocks.appState.userData, 'speckit-prompts', ...parts);
}

function metadata(version = 'v2.0.0'): SpecKitMetadata {
	return {
		lastRefreshed: '2026-05-26T10:00:00.000Z',
		commitSha: version,
		sourceVersion: version.replace(/^v/, ''),
		sourceUrl: 'https://github.com/github/spec-kit',
	};
}

describe('speckit manager integration', () => {
	beforeEach(async () => {
		vi.clearAllMocks();
		vi.unstubAllGlobals();
		mocks.appState.userData = await makeRoot('speckit-user-data');
		mocks.appState.temp = await makeRoot('speckit-temp');
		mocks.appState.isPackaged = false;
		mocks.pipeState.count = 0;
		mocks.execAsync.mockResolvedValue({ stdout: '', stderr: '' });
		mocks.exec.mockImplementation(
			(command: string, callback?: (error: Error | null, result?: unknown) => void) => {
				mocks.execAsync(command).then(
					(result) => callback?.(null, result),
					(error) => callback?.(error)
				);
				return { on: vi.fn() };
			}
		);
	});

	afterEach(async () => {
		vi.unstubAllGlobals();
		mocks.appState.isPackaged = false;
		for (const dir of tempRoots.splice(0)) {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it('loads bundled prompts, downloaded upstream prompts, and user customizations from disk', async () => {
		const downloadedMetadata = metadata('v3.1.4');
		const customMetadata = metadata('v4.0.0');
		await fs.mkdir(path.dirname(promptsPath('speckit.specify.md')), { recursive: true });
		await fs.writeFile(promptsPath('speckit.specify.md'), '# Downloaded Specify', 'utf8');
		await fs.writeFile(promptsPath('speckit.help.md'), '# Ignored Downloaded Help', 'utf8');
		await writeJson(promptsPath('metadata.json'), downloadedMetadata);

		await expect(getSpeckitMetadata()).resolves.toEqual(downloadedMetadata);

		await writeJson(customizationsPath(), {
			metadata: customMetadata,
			prompts: {
				plan: {
					content: '# Custom Plan',
					isModified: true,
					modifiedAt: '2026-05-26T11:00:00.000Z',
				},
				tasks: {
					content: '# Stale Tasks',
					isModified: false,
				},
			},
		});

		await expect(getSpeckitMetadata()).resolves.toEqual(customMetadata);
		const commands = await getSpeckitPrompts();

		expect(commands).toHaveLength(10);
		expect(commands.map((command) => command.command)).toContain('/speckit.constitution');
		expect(commands.find((command) => command.id === 'specify')).toMatchObject({
			prompt: '# Downloaded Specify',
			isModified: false,
			isCustom: false,
		});
		expect(commands.find((command) => command.id === 'plan')).toMatchObject({
			prompt: '# Custom Plan',
			isModified: true,
		});
		expect(commands.find((command) => command.id === 'tasks')?.prompt).not.toBe('# Stale Tasks');
		expect(commands.find((command) => command.id === 'help')?.prompt).not.toBe(
			'# Ignored Downloaded Help'
		);

		await expect(getSpeckitCommand('plan')).resolves.toMatchObject({
			id: 'plan',
			prompt: '# Custom Plan',
		});
		await expect(getSpeckitCommandBySlash('/speckit.specify')).resolves.toMatchObject({
			id: 'specify',
			prompt: '# Downloaded Specify',
		});
		await expect(getSpeckitCommand('missing')).resolves.toBeNull();
		await expect(getSpeckitCommandBySlash('/speckit.missing')).resolves.toBeNull();
	});

	it('persists prompt customizations and resets them back to bundled defaults', async () => {
		await saveSpeckitPrompt('specify', '# Custom Specify');

		const saved = await readJson<{
			prompts: Record<string, { content: string; isModified: boolean; modifiedAt?: string }>;
		}>(customizationsPath());
		expect(saved.prompts.specify).toMatchObject({
			content: '# Custom Specify',
			isModified: true,
		});
		expect(saved.prompts.specify.modifiedAt).toEqual(expect.any(String));

		const defaultPrompt = await resetSpeckitPrompt('specify');
		const afterReset = await readJson<{ prompts: Record<string, unknown> }>(customizationsPath());

		expect(defaultPrompt).toContain('Create or update the feature specification');
		expect(defaultPrompt).not.toBe('# Custom Specify');
		expect(afterReset.prompts.specify).toBeUndefined();

		await expect(resetSpeckitPrompt('not-real')).rejects.toThrow(
			'Unknown speckit command: not-real'
		);
	});

	it('uses packaged resource paths and placeholder fallbacks when bundled files are missing', async () => {
		const originalResourcesPath = process.resourcesPath;
		const resourcesRoot = await makeRoot('speckit-resources');
		process.resourcesPath = resourcesRoot;
		mocks.appState.isPackaged = true;

		await expect(getSpeckitMetadata()).resolves.toEqual({
			lastRefreshed: '2024-01-01T00:00:00Z',
			commitSha: 'bundled',
			sourceVersion: '0.0.90',
			sourceUrl: 'https://github.com/github/spec-kit',
		});

		const commands = await getSpeckitPrompts();

		expect(commands.find((command) => command.id === 'help')?.prompt).toBe(
			'# help\n\nPrompt not available.'
		);
		expect(commands.find((command) => command.id === 'constitution')?.prompt).toBe(
			'# constitution\n\nPrompt not available.'
		);
		expect(mocks.logger.warn).toHaveBeenCalledWith(
			expect.stringContaining('Failed to load bundled prompt for help:'),
			'[SpecKit]'
		);

		process.resourcesPath = originalResourcesPath;
	});

	it('refreshes upstream prompts through mocked GitHub raw-template fetches', async () => {
		const fetchMock = vi.fn(async (url: string) => {
			if (url === 'https://api.github.com/repos/github/spec-kit/releases/latest') {
				return {
					ok: true,
					json: vi.fn().mockResolvedValue({
						tag_name: 'v9.8.7',
					}),
				};
			}

			const command = url.split('/').pop()?.replace('.md', '') ?? 'unknown';
			return {
				ok: true,
				text: vi.fn().mockResolvedValue(`# ${command}`),
			};
		});
		vi.stubGlobal('fetch', fetchMock);

		const refreshed = await withMockBoundaryTimeout(refreshSpeckitPrompts(), 'refresh success');

		expect(refreshed).toEqual(
			expect.objectContaining({
				commitSha: 'v9.8.7',
				sourceVersion: '9.8.7',
				sourceUrl: 'https://github.com/github/spec-kit',
			})
		);
		await expect(fs.readFile(promptsPath('speckit.constitution.md'), 'utf8')).resolves.toBe(
			'# constitution'
		);
		await expect(fs.readFile(promptsPath('speckit.specify.md'), 'utf8')).resolves.toBe('# specify');
		await expect(fs.readFile(promptsPath('speckit.tasks.md'), 'utf8')).resolves.toBe('# tasks');
		await expect(fs.readFile(promptsPath('speckit.taskstoissues.md'), 'utf8')).resolves.toBe(
			'# taskstoissues'
		);
		await expect(fs.stat(promptsPath('speckit.implement.md'))).rejects.toThrow();
		await expect(readJson<SpecKitMetadata>(promptsPath('metadata.json'))).resolves.toMatchObject({
			commitSha: 'v9.8.7',
			sourceVersion: '9.8.7',
		});
		await expect(readJson<{ metadata: SpecKitMetadata }>(customizationsPath())).resolves.toEqual(
			expect.objectContaining({
				metadata: expect.objectContaining({ commitSha: 'v9.8.7' }),
			})
		);
		await expect(
			fs.stat(path.join(mocks.appState.temp, 'maestro-speckit-refresh'))
		).rejects.toThrow();
		expect(fetchMock).toHaveBeenCalledWith(
			'https://raw.githubusercontent.com/github/spec-kit/v9.8.7/templates/commands/constitution.md',
			expect.objectContaining({
				headers: expect.objectContaining({ 'User-Agent': expect.any(String) }),
			})
		);
	});

	it('surfaces refresh failures and still cleans temporary download state', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValueOnce({
				ok: false,
				statusText: 'Service Unavailable',
			})
		);
		await expect(
			withMockBoundaryTimeout(refreshSpeckitPrompts(), 'release failure')
		).rejects.toThrow('Failed to fetch release info: Service Unavailable');

		vi.stubGlobal(
			'fetch',
			vi
				.fn()
				.mockResolvedValueOnce({
					ok: true,
					json: vi.fn().mockResolvedValue({ tag_name: 'v1.0.0' }),
				})
				.mockResolvedValueOnce({
					ok: false,
					status: 500,
				})
		);

		await expect(
			withMockBoundaryTimeout(refreshSpeckitPrompts(), 'raw fetch failure')
		).rejects.toThrow('HTTP 500');
		await expect(
			fs.stat(path.join(mocks.appState.temp, 'maestro-speckit-refresh'))
		).rejects.toThrow();
	});
});

async function withMockBoundaryTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
	let timeout: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timeout = setTimeout(() => {
					reject(
						new Error(
							`${label} stalled after hitting https=${mocks.httpsGet.mock.calls.length}, exec=${mocks.execAsync.mock.calls.length}, ` +
								`execCb=${mocks.exec.mock.calls.length}, createWriteStream=${mocks.createWriteStream.mock.calls.length}, pipe=${mocks.pipeState.count}`
						)
					);
				}, 2000);
			}),
		]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

function mockHttpsDownload(statusCode: number, redirectLocation?: string): void {
	let callCount = 0;
	const downloadStream = new Writable({
		write(_chunk, _encoding, callback) {
			callback();
		},
	}) as Writable & { close: ReturnType<typeof vi.fn> };
	downloadStream.close = vi.fn();
	mocks.createWriteStream.mockReturnValue(downloadStream as never);

	mocks.httpsGet.mockImplementation(
		(_url: string, _options: unknown, callback: (response: EventEmitter & any) => void) => {
			callCount += 1;
			const requestNumber = callCount;
			const request = new EventEmitter() as EventEmitter & { on: ReturnType<typeof vi.fn> };
			request.on = vi.fn((event: string, listener: (...args: unknown[]) => void) => {
				EventEmitter.prototype.on.call(request, event, listener);
				return request;
			}) as never;

			queueMicrotask(() => {
				const responseStatus = redirectLocation && requestNumber === 1 ? 302 : statusCode;
				const response = Object.assign(Readable.from(responseStatus === 200 ? ['zip'] : []), {
					statusCode: responseStatus,
					headers: redirectLocation && requestNumber === 1 ? { location: redirectLocation } : {},
					pipe(dest: NodeJS.WritableStream) {
						mocks.pipeState.count += 1;
						return Readable.prototype.pipe.call(this, dest);
					},
				});
				callback(response);
			});

			return request;
		}
	);
}
