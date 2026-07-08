/**
 * @file claude-session-ipc.integration.test.ts
 * @description Integration coverage for Claude session IPC handlers backed by a real temp filesystem.
 */

import fs from 'fs/promises';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerClaudeHandlers } from '../../main/ipc/handlers/claude';
import { encodeClaudeProjectPath } from '../../main/utils/statsCache';

type IpcHandler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

const testState = vi.hoisted(() => ({
	homeDir: '',
	userDataDir: '',
	handlers: new Map<string, IpcHandler>(),
}));

vi.mock('electron', () => ({
	ipcMain: {
		handle: vi.fn((channel: string, handler: IpcHandler) => {
			testState.handlers.set(channel, handler);
		}),
		removeHandler: vi.fn((channel: string) => {
			testState.handlers.delete(channel);
		}),
	},
	app: {
		getPath: vi.fn(() => testState.userDataDir),
	},
	BrowserWindow: vi.fn(),
}));

vi.mock('os', async () => {
	const actual = await vi.importActual<typeof import('os')>('os');
	const mockedHomedir = vi.fn(() => testState.homeDir);
	return {
		...actual,
		default: {
			...actual,
			homedir: mockedHomedir,
		},
		homedir: mockedHomedir,
	};
});

vi.mock('../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

interface OriginsData {
	origins: Record<string, Record<string, unknown>>;
}

function createOriginsStore(initialOrigins: OriginsData['origins'] = {}) {
	const data: OriginsData = { origins: initialOrigins };
	return {
		get: vi.fn((key: keyof OriginsData, fallback: unknown) => data[key] ?? fallback),
		set: vi.fn((key: keyof OriginsData, value: OriginsData[typeof key]) => {
			data[key] = value;
		}),
		data,
	};
}

function sessionJsonl(lines: Array<Record<string, unknown> | string>) {
	return lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n');
}

function userMessage(uuid: string, text: string, timestamp: string, extraContent: unknown[] = []) {
	return {
		type: 'user',
		uuid,
		timestamp,
		message: {
			role: 'user',
			content: [{ type: 'text', text }, ...extraContent],
		},
	};
}

function assistantMessage(
	uuid: string,
	text: string,
	timestamp: string,
	usage = {
		input_tokens: 100,
		output_tokens: 50,
		cache_read_input_tokens: 10,
		cache_creation_input_tokens: 5,
	},
	extraContent: unknown[] = []
) {
	return {
		type: 'assistant',
		uuid,
		timestamp,
		message: {
			role: 'assistant',
			content: [{ type: 'text', text }, ...extraContent],
			usage,
		},
	};
}

async function writeSession(
	projectDir: string,
	sessionId: string,
	lines: Array<Record<string, unknown> | string>,
	mtime: Date
) {
	const sessionPath = path.join(projectDir, `${sessionId}.jsonl`);
	await fs.writeFile(sessionPath, `${sessionJsonl(lines)}\n`, 'utf-8');
	await fs.utimes(sessionPath, mtime, mtime);
	return sessionPath;
}

describe('Claude session IPC integration', () => {
	let tempRoot: string;
	let projectPath: string;
	let projectDir: string;
	let originsStore: ReturnType<typeof createOriginsStore>;
	let webContentsSend: ReturnType<typeof vi.fn>;

	async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
		const handler = testState.handlers.get(channel);
		expect(handler, `Expected ${channel} to be registered`).toBeDefined();
		return (await handler!({}, ...args)) as T;
	}

	async function createProjectFixture() {
		projectPath = path.join(tempRoot, 'workspace', 'maestro-app');
		projectDir = path.join(
			testState.homeDir,
			'.claude',
			'projects',
			encodeClaudeProjectPath(projectPath)
		);
		await fs.mkdir(projectDir, { recursive: true });
		await fs.mkdir(path.join(projectPath, '.claude', 'commands'), { recursive: true });
		await fs.mkdir(path.join(projectPath, '.claude', 'skills', 'project-skill'), {
			recursive: true,
		});

		await writeSession(
			projectDir,
			'alpha',
			[
				userMessage('u-alpha', 'Plan coverage improvements', '2026-05-25T10:00:00.000Z', [
					{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } },
				]),
				assistantMessage('a-alpha', 'Coverage runner ready', '2026-05-25T10:00:05.000Z'),
				'not-json',
			],
			new Date('2026-05-25T10:00:05.000Z')
		);

		await writeSession(
			projectDir,
			'beta',
			[
				userMessage('u-beta', 'Review websocket integration', '2026-05-25T09:00:00.000Z'),
				assistantMessage('a-beta', 'Remote control bridge verified', '2026-05-25T09:00:03.000Z', {
					input_tokens: 20,
					output_tokens: 30,
					cache_read_input_tokens: 0,
					cache_creation_input_tokens: 0,
				}),
			],
			new Date('2026-05-25T09:00:03.000Z')
		);

		await fs.writeFile(path.join(projectDir, 'empty.jsonl'), '', 'utf-8');
	}

	beforeEach(async () => {
		vi.clearAllMocks();
		testState.handlers.clear();
		tempRoot = await fs.mkdtemp(path.join(process.env.TMPDIR || '/tmp', 'maestro-claude-ipc-'));
		testState.homeDir = path.join(tempRoot, 'home');
		testState.userDataDir = path.join(tempRoot, 'user-data');
		await fs.mkdir(testState.homeDir, { recursive: true });
		await fs.mkdir(testState.userDataDir, { recursive: true });
		await createProjectFixture();

		originsStore = createOriginsStore({
			[projectPath]: {
				alpha: { origin: 'auto', sessionName: 'Integration Campaign', starred: true },
			},
		});
		webContentsSend = vi.fn();

		registerClaudeHandlers({
			claudeSessionOriginsStore: originsStore as any,
			getMainWindow: () =>
				({
					isDestroyed: () => false,
					webContents: {
						isDestroyed: () => false,
						send: webContentsSend,
					},
				}) as any,
		});
	});

	afterEach(async () => {
		testState.handlers.clear();
		await fs.rm(tempRoot, { recursive: true, force: true });
	});

	it('lists, paginates, reads, and searches real Claude JSONL sessions', async () => {
		const sessions = await invoke<any[]>('claude:listSessions', projectPath);

		expect(sessions).toHaveLength(2);
		expect(sessions[0]).toMatchObject({
			sessionId: 'alpha',
			projectPath,
			firstMessage: 'Plan coverage improvements',
			messageCount: 2,
			inputTokens: 100,
			outputTokens: 50,
			cacheReadTokens: 10,
			cacheCreationTokens: 5,
			durationSeconds: 5,
			origin: 'auto',
			sessionName: 'Integration Campaign',
		});
		expect(sessions.map((session) => session.sessionId)).toEqual(['alpha', 'beta']);

		const page = await invoke<{
			sessions: Array<{ sessionId: string }>;
			hasMore: boolean;
			totalCount: number;
			nextCursor: string | null;
		}>('claude:listSessionsPaginated', projectPath, { limit: 1 });
		expect(page).toMatchObject({
			hasMore: true,
			totalCount: 2,
			nextCursor: 'alpha',
		});
		expect(page.sessions).toEqual([expect.objectContaining({ sessionId: 'alpha' })]);

		const messages = await invoke<{
			messages: Array<{ uuid: string; content: string }>;
			total: number;
			hasMore: boolean;
		}>('claude:readSessionMessages', projectPath, 'alpha', { limit: 10 });
		expect(messages.total).toBe(2);
		expect(messages.hasMore).toBe(false);
		expect(messages.messages.map((message) => [message.uuid, message.content])).toEqual([
			['u-alpha', 'Plan coverage improvements'],
			['a-alpha', 'Coverage runner ready'],
		]);

		const titleMatches = await invoke<
			Array<{ sessionId: string; matchType: string; matchCount: number }>
		>('claude:searchSessions', projectPath, 'coverage', 'all');
		expect(titleMatches).toEqual([
			expect.objectContaining({ sessionId: 'alpha', matchType: 'title', matchCount: 2 }),
		]);

		const assistantMatches = await invoke<
			Array<{ sessionId: string; matchType: string; matchPreview: string }>
		>('claude:searchSessions', projectPath, 'bridge', 'assistant');
		expect(assistantMatches).toEqual([
			expect.objectContaining({
				sessionId: 'beta',
				matchType: 'assistant',
				matchPreview: 'Remote control bridge verified',
			}),
		]);
	});

	it('builds project/global stats caches and preserves deleted project sessions as archived', async () => {
		const projectStats = await invoke<Record<string, unknown>>(
			'claude:getProjectStats',
			projectPath
		);

		expect(projectStats).toMatchObject({
			totalSessions: 2,
			totalMessages: 4,
			totalSizeBytes: expect.any(Number),
			totalTokens: 200,
			oldestTimestamp: '2026-05-25T09:00:00.000Z',
			isComplete: true,
		});
		expect(webContentsSend).toHaveBeenCalledWith(
			'claude:projectStatsUpdate',
			expect.objectContaining({ projectPath, totalSessions: 2, isComplete: true })
		);

		const timestamps = await invoke<Array<{ sessionId: string; timestamp: string }>>(
			'claude:getSessionTimestamps',
			projectPath
		);
		expect(timestamps).toEqual(
			expect.arrayContaining([
				{ sessionId: 'alpha', timestamp: '2026-05-25T10:00:00.000Z' },
				{ sessionId: 'beta', timestamp: '2026-05-25T09:00:00.000Z' },
			])
		);

		await fs.rm(path.join(projectDir, 'beta.jsonl'));
		const archivedStats = await invoke<Record<string, unknown>>(
			'claude:getProjectStats',
			projectPath
		);
		expect(archivedStats).toMatchObject({
			totalSessions: 2,
			totalMessages: 4,
			isComplete: true,
		});

		const globalStats = await invoke<Record<string, unknown>>('claude:getGlobalStats');
		expect(globalStats).toMatchObject({
			totalSessions: 1,
			totalMessages: 2,
			totalInputTokens: 100,
			totalOutputTokens: 50,
			totalCacheReadTokens: 10,
			totalCacheCreationTokens: 5,
			isComplete: true,
		});
		expect(webContentsSend).toHaveBeenCalledWith(
			'claude:globalStatsUpdate',
			expect.objectContaining({ totalSessions: 1, isComplete: true })
		);
	});

	it('deletes a message pair and removes orphaned tool results from the session file', async () => {
		await writeSession(
			projectDir,
			'tools',
			[
				userMessage('u-tools', 'Run the tool', '2026-05-25T11:00:00.000Z'),
				assistantMessage(
					'a-tools',
					'I will call a tool',
					'2026-05-25T11:00:01.000Z',
					{
						input_tokens: 1,
						output_tokens: 1,
						cache_read_input_tokens: 0,
						cache_creation_input_tokens: 0,
					},
					[{ type: 'tool_use', id: 'tool-1', name: 'Read', input: {} }]
				),
				userMessage('u-result', 'Next request', '2026-05-25T11:00:02.000Z', [
					{ type: 'tool_result', tool_use_id: 'tool-1', content: 'orphan result' },
				]),
				assistantMessage('a-result', 'Next answer', '2026-05-25T11:00:03.000Z'),
			],
			new Date('2026-05-25T11:00:03.000Z')
		);

		const result = await invoke<Record<string, unknown>>(
			'claude:deleteMessagePair',
			projectPath,
			'tools',
			'u-tools'
		);

		expect(result).toEqual({ success: true, linesRemoved: 2 });
		const updated = await fs.readFile(path.join(projectDir, 'tools.jsonl'), 'utf-8');
		expect(updated).not.toContain('u-tools');
		expect(updated).not.toContain('tool-1');
		expect(updated).toContain('u-result');
		expect(updated).toContain('Next request');
	});

	it('discovers commands and skills from user, project, and enabled plugin directories', async () => {
		const userCommandsDir = path.join(testState.homeDir, '.claude', 'commands');
		const pluginDir = path.join(tempRoot, 'plugin-pack');
		await fs.mkdir(userCommandsDir, { recursive: true });
		await fs.mkdir(path.join(pluginDir, 'commands'), { recursive: true });
		await fs.mkdir(path.join(testState.homeDir, '.claude', 'plugins'), { recursive: true });
		await fs.mkdir(path.join(testState.homeDir, '.claude', 'skills', 'user-skill'), {
			recursive: true,
		});

		await fs.writeFile(
			path.join(userCommandsDir, 'audit.md'),
			'---\nname: audit\n---\n# Audit now'
		);
		await fs.writeFile(
			path.join(projectPath, '.claude', 'commands', 'ship.md'),
			'---\ndescription: ignored\n---\nShip checklist'
		);
		await fs.writeFile(path.join(pluginDir, 'commands', 'sync.md'), 'Sync plugin data');
		await fs.writeFile(
			path.join(testState.homeDir, '.claude', 'settings.json'),
			JSON.stringify({ enabledPlugins: { 'maestro@example': true } })
		);
		await fs.writeFile(
			path.join(testState.homeDir, '.claude', 'plugins', 'installed_plugins.json'),
			JSON.stringify({
				plugins: {
					'maestro@example': { installPath: pluginDir },
				},
			})
		);

		await fs.writeFile(
			path.join(projectPath, '.claude', 'skills', 'project-skill', 'skill.md'),
			'---\nname: project-skill\ndescription: Project skill\n---\nUse project context.'
		);
		await fs.writeFile(
			path.join(testState.homeDir, '.claude', 'skills', 'user-skill', 'skill.md'),
			'---\nname: user-skill\ndescription: User skill\n---\nUse user context.'
		);

		const commands = await invoke<Array<{ command: string; description: string }>>(
			'claude:getCommands',
			projectPath
		);
		expect(commands).toEqual(
			expect.arrayContaining([
				{ command: '/audit', description: 'Audit now' },
				{ command: '/ship', description: 'Ship checklist' },
				{ command: '/maestro:sync', description: 'Sync plugin data' },
			])
		);

		const skills = await invoke<Array<{ name: string; description: string; source: string }>>(
			'claude:getSkills',
			projectPath
		);
		expect(skills).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name: 'project-skill',
					description: 'Project skill',
					source: 'project',
				}),
				expect.objectContaining({
					name: 'user-skill',
					description: 'User skill',
					source: 'user',
				}),
			])
		);
	});

	it('persists session origin metadata through the registered IPC handlers', async () => {
		await invoke('claude:registerSessionOrigin', projectPath, 'gamma', 'user', 'Manual Review');
		await invoke('claude:updateSessionStarred', projectPath, 'gamma', true);
		await invoke('claude:updateSessionContextUsage', projectPath, 'gamma', 71);
		await invoke('claude:updateSessionName', projectPath, 'beta', 'Beta Session');

		const origins = await invoke<Record<string, unknown>>('claude:getSessionOrigins', projectPath);
		expect(origins).toMatchObject({
			alpha: { origin: 'auto', sessionName: 'Integration Campaign', starred: true },
			gamma: { origin: 'user', sessionName: 'Manual Review', starred: true, contextUsage: 71 },
			beta: { origin: 'user', sessionName: 'Beta Session' },
		});

		const named = await invoke<
			Array<{ agentSessionId: string; sessionName: string; starred?: boolean }>
		>('claude:getAllNamedSessions');
		expect(named).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					agentSessionId: 'alpha',
					sessionName: 'Integration Campaign',
					starred: true,
				}),
				expect.objectContaining({
					agentSessionId: 'gamma',
					sessionName: 'Manual Review',
					starred: true,
				}),
				expect.objectContaining({
					agentSessionId: 'beta',
					sessionName: 'Beta Session',
				}),
			])
		);
	});
});
