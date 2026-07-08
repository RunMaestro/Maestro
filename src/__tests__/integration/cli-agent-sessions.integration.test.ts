import fs from 'fs/promises';
import * as realOs from 'node:os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	homeDir: '',
	platform: vi.fn(() => 'darwin'),
	readFileSyncOverride: undefined as
		undefined | ((filePath: unknown, options?: unknown) => unknown),
}));

vi.mock('fs', async () => {
	const actual = await import('node:fs');
	const readFileSync = vi.fn(
		(filePath: Parameters<typeof actual.readFileSync>[0], options?: unknown) => {
			if (mocks.readFileSyncOverride) {
				return mocks.readFileSyncOverride(filePath, options);
			}
			return actual.readFileSync(filePath, options as Parameters<typeof actual.readFileSync>[1]);
		}
	);
	return {
		...actual,
		existsSync: actual.existsSync,
		readdirSync: actual.readdirSync,
		readFileSync,
		statSync: actual.statSync,
		default: {
			...actual,
			existsSync: actual.existsSync,
			readdirSync: actual.readdirSync,
			readFileSync,
			statSync: actual.statSync,
		},
	};
});

vi.mock('os', async (importOriginal) => {
	const actual = await importOriginal<typeof import('os')>();
	const mockedOs = {
		...actual,
		homedir: vi.fn(() => mocks.homeDir),
		platform: mocks.platform,
	};
	return {
		...mockedOs,
		default: mockedOs,
	};
});

import { listClaudeSessions } from '../../cli/services/agent-sessions';
import { encodeClaudeProjectPath } from '../../shared/pathUtils';

let originalEnv: NodeJS.ProcessEnv;
let tempRoot: string;

describe('CLI agent sessions integration', () => {
	const projectPath = '/Users/tester/projects/maestro';

	beforeEach(async () => {
		vi.clearAllMocks();
		originalEnv = { ...process.env };
		tempRoot = await fs.mkdtemp(path.join(realOs.tmpdir(), 'maestro-cli-sessions-'));
		mocks.homeDir = path.join(tempRoot, 'home');
		mocks.platform.mockReturnValue('darwin');
		mocks.readFileSyncOverride = undefined;
		await fs.mkdir(mocks.homeDir, { recursive: true });
		process.env = { ...originalEnv };
		delete process.env.XDG_CONFIG_HOME;
		delete process.env.APPDATA;
	});

	afterEach(async () => {
		process.env = originalEnv;
		await fs.rm(tempRoot, { recursive: true, force: true });
	});

	it('returns an empty result when the encoded Claude project directory does not exist', () => {
		expect(listClaudeSessions(projectPath)).toEqual({
			sessions: [],
			totalCount: 0,
			filteredCount: 0,
		});
	});

	it('parses, sorts, searches, paginates, and decorates real Claude JSONL sessions', async () => {
		const projectDir = await makeProjectDir(projectPath);
		await writeDarwinOrigins({
			[projectPath]: {
				'session-new': {
					origin: 'wizard',
					sessionName: 'Named Feature Session',
					starred: true,
				},
				'session-old': 'manual',
			},
		});
		await writeSession(
			projectDir,
			'session-new',
			[
				'not json',
				{
					type: 'user',
					timestamp: '2026-05-26T10:00:00.000Z',
					message: {
						role: 'user',
						content: [
							{ type: 'text', text: 'Build the integration coverage report' },
							{ type: 'tool_use', name: 'ignored' },
						],
					},
				},
				{
					type: 'assistant',
					timestamp: '2026-05-26T10:01:00.000Z',
					message: {
						role: 'assistant',
						content: [{ type: 'text', text: 'Implemented the report workflow' }],
					},
				},
				{
					type: 'result',
					timestamp: '2026-05-26T10:03:30.000Z',
					usage: {
						input_tokens: 1000,
						output_tokens: 200,
						cache_read_input_tokens: 300,
						cache_creation_input_tokens: 400,
					},
				},
			],
			'2026-05-26T10:04:00.000Z'
		);
		await writeSession(
			projectDir,
			'session-old',
			[
				{
					type: 'user',
					timestamp: '2026-05-25T09:00:00.000Z',
					message: { role: 'user', content: 'Investigate old logs' },
				},
				'{bad json',
				{
					type: 'result',
					timestamp: '2026-05-25T09:05:00.000Z',
					usage: { input_tokens: 50, output_tokens: 25 },
				},
			],
			'2026-05-25T09:06:00.000Z'
		);
		await fs.writeFile(path.join(projectDir, 'empty.jsonl'), '', 'utf8');
		await fs.mkdir(path.join(projectDir, 'unreadable.jsonl'));
		await fs.writeFile(path.join(projectDir, 'notes.txt'), 'ignored', 'utf8');

		const result = listClaudeSessions(projectPath, { limit: 10 });

		expect(result.totalCount).toBe(2);
		expect(result.filteredCount).toBe(2);
		expect(result.sessions.map((session) => session.sessionId)).toEqual([
			'session-new',
			'session-old',
		]);
		expect(result.sessions[0]).toMatchObject({
			sessionName: 'Named Feature Session',
			origin: 'wizard',
			starred: true,
			firstMessage: 'Implemented the report workflow',
			messageCount: 2,
			inputTokens: 1000,
			outputTokens: 200,
			cacheReadTokens: 300,
			cacheCreationTokens: 400,
			durationSeconds: 210,
		});
		expect(result.sessions[0].costUsd).toBeGreaterThan(0);
		expect(result.sessions[1]).toMatchObject({
			origin: 'manual',
			firstMessage: 'Investigate old logs',
			messageCount: 1,
		});

		expect(listClaudeSessions(projectPath, { search: 'named', limit: 10 }).sessions).toHaveLength(
			1
		);
		expect(
			listClaudeSessions(projectPath, { search: 'investigate', limit: 10 }).sessions[0].sessionId
		).toBe('session-old');
		expect(listClaudeSessions(projectPath, { search: 'absent', limit: 10 })).toMatchObject({
			sessions: [],
			totalCount: 2,
			filteredCount: 0,
		});
		expect(listClaudeSessions(projectPath, { skip: 1, limit: 1 }).sessions[0].sessionId).toBe(
			'session-old'
		);
	});

	it('reads origin stores from Linux and Windows config locations and tolerates corrupt stores', async () => {
		const projectDir = await makeProjectDir(projectPath);
		await writeSession(
			projectDir,
			'session-platform',
			[
				{
					type: 'user',
					timestamp: '2026-05-26T12:00:00.000Z',
					message: { role: 'user', content: { unexpected: true } },
				},
			],
			'2026-05-26T12:00:00.000Z'
		);

		mocks.platform.mockReturnValue('linux');
		process.env.XDG_CONFIG_HOME = path.join(tempRoot, 'xdg-config');
		await writeOrigins(path.join(process.env.XDG_CONFIG_HOME, 'Maestro'), {
			[projectPath]: {
				'session-platform': {
					origin: 'linux-origin',
					sessionName: 'Linux Session',
					starred: false,
				},
			},
		});
		expect(listClaudeSessions(projectPath).sessions[0]).toMatchObject({
			origin: 'linux-origin',
			sessionName: 'Linux Session',
			starred: false,
			firstMessage: '',
		});

		await writeOrigins(path.join(process.env.XDG_CONFIG_HOME, 'Maestro'), {
			[projectPath]: {},
		});
		expect(listClaudeSessions(projectPath).sessions[0]).toMatchObject({
			origin: undefined,
			sessionName: undefined,
			starred: undefined,
		});

		await fs.writeFile(
			path.join(process.env.XDG_CONFIG_HOME, 'Maestro', 'claude-session-origins.json'),
			'{bad json',
			'utf8'
		);
		expect(listClaudeSessions(projectPath).sessions[0]).toMatchObject({
			origin: undefined,
			sessionName: undefined,
			starred: undefined,
		});

		mocks.platform.mockReturnValue('win32');
		process.env.APPDATA = path.join(tempRoot, 'AppData', 'Roaming');
		await writeOrigins(path.join(process.env.APPDATA, 'Maestro'), {
			[projectPath]: {
				'session-platform': {
					origin: 'windows-origin',
					sessionName: 'Windows Session',
					starred: true,
				},
			},
		});
		expect(listClaudeSessions(projectPath).sessions[0]).toMatchObject({
			origin: 'windows-origin',
			sessionName: 'Windows Session',
			starred: true,
		});
	});

	it('skips sessions that fail defensive content parsing after a successful file read', async () => {
		const projectDir = await makeProjectDir(projectPath);
		const badSessionPath = await writeSession(
			projectDir,
			'session-bad-content',
			[
				{
					type: 'user',
					timestamp: '2026-05-26T12:00:00.000Z',
					message: { role: 'user', content: 'Will be replaced by bad read data' },
				},
			],
			'2026-05-26T12:00:00.000Z'
		);
		mocks.readFileSyncOverride = (filePath) => {
			if (String(filePath) === badSessionPath) {
				return undefined as unknown as string;
			}
			throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
		};

		expect(listClaudeSessions(projectPath)).toEqual({
			sessions: [],
			totalCount: 0,
			filteredCount: 0,
		});
	});
});

async function makeProjectDir(projectPath: string): Promise<string> {
	const projectDir = path.join(
		mocks.homeDir,
		'.claude',
		'projects',
		encodeClaudeProjectPath(projectPath)
	);
	await fs.mkdir(projectDir, { recursive: true });
	return projectDir;
}

async function writeDarwinOrigins(origins: Record<string, Record<string, unknown>>): Promise<void> {
	await writeOrigins(
		path.join(mocks.homeDir, 'Library', 'Application Support', 'Maestro'),
		origins
	);
}

async function writeOrigins(
	configDir: string,
	origins: Record<string, Record<string, unknown>>
): Promise<void> {
	await fs.mkdir(configDir, { recursive: true });
	await fs.writeFile(
		path.join(configDir, 'claude-session-origins.json'),
		JSON.stringify({ origins }, null, 2),
		'utf8'
	);
}

async function writeSession(
	projectDir: string,
	sessionId: string,
	entries: Array<Record<string, unknown> | string>,
	modifiedAt: string
): Promise<string> {
	const filePath = path.join(projectDir, `${sessionId}.jsonl`);
	await fs.writeFile(
		filePath,
		entries.map((entry) => (typeof entry === 'string' ? entry : JSON.stringify(entry))).join('\n'),
		'utf8'
	);
	const modifiedTime = new Date(modifiedAt);
	await fs.utimes(filePath, modifiedTime, modifiedTime);
	return filePath;
}
