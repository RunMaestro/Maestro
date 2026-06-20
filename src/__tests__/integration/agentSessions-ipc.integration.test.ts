import fs from 'fs/promises';
import path from 'path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSessionOriginsData } from '../../main/ipc/handlers/agentSessions';
import type { SshRemoteConfig } from '../../shared/types';

type IpcHandler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
type StoreLike<T extends Record<string, unknown>> = {
	data: T;
	get: ReturnType<typeof vi.fn>;
	set: ReturnType<typeof vi.fn>;
};

const handlers = new Map<string, IpcHandler>();

let tempRoot: string;
let homeDir: string;
let userDataDir: string;
let webContentsSend: ReturnType<typeof vi.fn>;
let getSessionStorage: ReturnType<typeof vi.fn>;
let hasSessionStorage: ReturnType<typeof vi.fn>;
let getAllSessionStorages: ReturnType<typeof vi.fn>;
let getSshRemoteById: ReturnType<typeof vi.fn>;

function createStore<T extends Record<string, unknown>>(initialData: T): StoreLike<T> {
	const store: StoreLike<T> = {
		data: initialData,
		get: vi.fn((key: string, defaultValue?: unknown) => store.data[key] ?? defaultValue),
		set: vi.fn((key: string, value: unknown) => {
			store.data[key as keyof T] = value as T[keyof T];
		}),
	};
	return store;
}

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
	const handler = handlers.get(channel);
	expect(handler, `Expected ${channel} to be registered`).toBeDefined();
	return (await handler!({}, ...args)) as T;
}

async function registerAgentSessions(deps: Record<string, unknown> = {}) {
	const { registerAgentSessionsHandlers } = await import('../../main/ipc/handlers/agentSessions');
	registerAgentSessionsHandlers(deps as never);
}

describe('agentSessions IPC integration', () => {
	beforeEach(async () => {
		vi.resetModules();
		handlers.clear();
		getSessionStorage = vi.fn();
		hasSessionStorage = vi.fn();
		getAllSessionStorages = vi.fn();
		getSshRemoteById = vi.fn();
		webContentsSend = vi.fn();
		tempRoot = await fs.mkdtemp(path.join(tmpdir(), 'maestro-agent-sessions-ipc-'));
		homeDir = path.join(tempRoot, 'home');
		userDataDir = path.join(tempRoot, 'user-data');
		await fs.mkdir(homeDir, { recursive: true });
		await fs.mkdir(userDataDir, { recursive: true });

		vi.doMock('os', () => ({
			default: { homedir: () => homeDir },
			homedir: () => homeDir,
		}));
		vi.doMock('electron', () => ({
			app: {
				getPath: vi.fn((name: string) => {
					expect(name).toBe('userData');
					return userDataDir;
				}),
			},
			ipcMain: {
				handle: vi.fn((channel: string, handler: IpcHandler) => {
					handlers.set(channel, handler);
				}),
				removeHandler: vi.fn((channel: string) => {
					handlers.delete(channel);
				}),
			},
			BrowserWindow: vi.fn(),
		}));
		vi.doMock('../../main/agents', () => ({
			getSessionStorage,
			hasSessionStorage,
			getAllSessionStorages,
		}));
		vi.doMock('../../main/stores', () => ({
			getSshRemoteById,
		}));
		vi.doMock('../../main/utils/logger', () => ({
			logger: {
				debug: vi.fn(),
				error: vi.fn(),
				info: vi.fn(),
				warn: vi.fn(),
			},
		}));
	});

	afterEach(async () => {
		handlers.clear();
		vi.doUnmock('os');
		vi.doUnmock('electron');
		vi.doUnmock('../../main/agents');
		vi.doUnmock('../../main/stores');
		vi.doUnmock('../../main/utils/logger');
		vi.resetModules();
		await fs.rm(tempRoot, { recursive: true, force: true });
	});

	it('routes provider session operations through registered IPC handlers with SSH settings', async () => {
		const sshRemote: SshRemoteConfig = {
			id: 'remote-1',
			name: 'Remote 1',
			host: 'remote.test',
			port: 22,
			username: 'tester',
			privateKeyPath: '/tmp/no-key',
			enabled: true,
		};
		const storage = {
			agentId: 'codex',
			listSessions: vi
				.fn()
				.mockResolvedValue([
					{ sessionId: 'session-1', projectPath: '/repo', firstMessage: 'Hello' },
				]),
			listSessionsPaginated: vi.fn().mockResolvedValue({
				sessions: [{ sessionId: 'session-1' }],
				hasMore: false,
				totalCount: 1,
				nextCursor: null,
			}),
			readSessionMessages: vi.fn().mockResolvedValue({
				messages: [{ uuid: 'message-1', role: 'user', content: 'Hello' }],
				total: 1,
				hasMore: false,
			}),
			searchSessions: vi
				.fn()
				.mockResolvedValue([{ sessionId: 'session-1', matchType: 'user', matchCount: 1 }]),
			getSessionPath: vi.fn().mockReturnValue('/repo/session-1.jsonl'),
			deleteMessagePair: vi.fn().mockResolvedValue({ success: true, linesRemoved: 2 }),
			getAllNamedSessions: vi.fn().mockResolvedValue([
				{
					agentSessionId: 'session-1',
					projectPath: '/repo',
					sessionName: 'Named session',
					starred: true,
					lastActivityAt: 123,
				},
			]),
		};
		const failingNamedStorage = {
			agentId: 'opencode',
			getAllNamedSessions: vi.fn().mockRejectedValue(new Error('storage unavailable')),
		};
		getSessionStorage.mockImplementation((agentId: string) =>
			agentId === 'codex' ? storage : null
		);
		hasSessionStorage.mockImplementation((agentId: string) => agentId === 'codex');
		getAllSessionStorages.mockReturnValue([storage, failingNamedStorage, { agentId: 'noop' }]);
		getSshRemoteById.mockImplementation((sshRemoteId: string) =>
			sshRemoteId === 'remote-1' ? sshRemote : undefined
		);
		await registerAgentSessions();

		await expect(invoke('agentSessions:list', 'codex', '/repo', 'remote-1')).resolves.toEqual([
			{ sessionId: 'session-1', projectPath: '/repo', firstMessage: 'Hello' },
		]);
		expect(storage.listSessions).toHaveBeenCalledWith('/repo', sshRemote);

		await expect(
			invoke('agentSessions:listPaginated', 'codex', '/repo', { limit: 10 }, 'remote-1')
		).resolves.toMatchObject({ totalCount: 1, hasMore: false });
		expect(storage.listSessionsPaginated).toHaveBeenCalledWith('/repo', { limit: 10 }, sshRemote);

		await expect(
			invoke('agentSessions:read', 'codex', '/repo', 'session-1', { limit: 5 }, 'remote-1')
		).resolves.toMatchObject({ total: 1, hasMore: false });
		expect(storage.readSessionMessages).toHaveBeenCalledWith(
			'/repo',
			'session-1',
			{ limit: 5 },
			sshRemote
		);

		await expect(
			invoke('agentSessions:search', 'codex', '/repo', 'hello', 'all', 'remote-1')
		).resolves.toEqual([{ sessionId: 'session-1', matchType: 'user', matchCount: 1 }]);
		expect(storage.searchSessions).toHaveBeenCalledWith('/repo', 'hello', 'all', sshRemote);

		await expect(invoke('agentSessions:getPath', 'codex', '/repo', 'session-1')).resolves.toBe(
			'/repo/session-1.jsonl'
		);
		await expect(
			invoke('agentSessions:deleteMessagePair', 'codex', '/repo', 'session-1', 'message-1', 'Hello')
		).resolves.toEqual({ success: true, linesRemoved: 2 });
		await expect(invoke('agentSessions:hasStorage', 'codex')).resolves.toBe(true);
		await expect(invoke('agentSessions:hasStorage', 'missing')).resolves.toBe(false);
		await expect(invoke('agentSessions:getAvailableStorages')).resolves.toEqual([
			'codex',
			'opencode',
			'noop',
		]);
		await expect(invoke('agentSessions:getAllNamedSessions')).resolves.toEqual([
			{
				agentId: 'codex',
				agentSessionId: 'session-1',
				projectPath: '/repo',
				sessionName: 'Named session',
				starred: true,
				lastActivityAt: 123,
			},
		]);

		await expect(invoke('agentSessions:list', 'missing', '/repo')).resolves.toEqual([]);
		await expect(
			invoke('agentSessions:deleteMessagePair', 'missing', '/repo', 'session-1', 'message-1')
		).resolves.toEqual({
			success: false,
			error: 'No session storage available for agent: missing',
		});
	});

	it('persists generic session names and stars through the origins store', async () => {
		const originsStore = createStore<AgentSessionOriginsData>({
			origins: {
				codex: {
					'/repo': {
						'session-1': { origin: 'auto', sessionName: 'Old name' },
						'session-2': { starred: true },
					},
				},
			},
		});
		await registerAgentSessions({ agentSessionOriginsStore: originsStore });

		await expect(invoke('agentSessions:getOrigins', 'codex', '/repo')).resolves.toEqual({
			'session-1': { origin: 'auto', sessionName: 'Old name' },
			'session-2': { starred: true },
		});
		await invoke('agentSessions:setSessionName', 'codex', '/repo', 'session-1', 'New name');
		expect(originsStore.data.origins.codex['/repo']['session-1']).toEqual({
			origin: 'auto',
			sessionName: 'New name',
		});
		await invoke('agentSessions:setSessionName', 'codex', '/repo', 'session-1', null);
		expect(originsStore.data.origins.codex['/repo']['session-1']).toEqual({ origin: 'auto' });

		await invoke('agentSessions:setSessionStarred', 'codex', '/repo', 'session-2', false);
		expect(originsStore.data.origins.codex['/repo']['session-2']).toBeUndefined();

		await invoke('agentSessions:setSessionStarred', 'opencode', '/other', 'session-3', true);
		expect(originsStore.data.origins.opencode['/other']['session-3']).toEqual({
			starred: true,
		});
	});

	it('builds global stats from real Claude and Codex session files', async () => {
		const claudeDir = path.join(homeDir, '.claude', 'projects', 'repo-project');
		const codexDir = path.join(homeDir, '.codex', 'sessions', '2026', '05', '25');
		await fs.mkdir(claudeDir, { recursive: true });
		await fs.mkdir(codexDir, { recursive: true });
		await fs.writeFile(
			path.join(claudeDir, 'claude-session.jsonl'),
			[
				JSON.stringify({ type: 'user', message: { role: 'user', content: 'Hello Claude' } }),
				JSON.stringify({
					type: 'assistant',
					message: {
						role: 'assistant',
						content: 'Hello user',
						usage: {
							input_tokens: 11,
							output_tokens: 13,
							cache_read_input_tokens: 17,
							cache_creation_input_tokens: 19,
						},
					},
				}),
			].join('\n'),
			'utf-8'
		);
		await fs.writeFile(path.join(claudeDir, 'empty.jsonl'), '', 'utf-8');
		await fs.writeFile(path.join(claudeDir, 'notes.txt'), 'ignored', 'utf-8');
		await fs.writeFile(
			path.join(codexDir, 'codex-session.jsonl'),
			[
				JSON.stringify({
					type: 'response_item',
					payload: { type: 'message', role: 'user', content: 'Hello Codex' },
				}),
				JSON.stringify({
					type: 'response_item',
					payload: { type: 'message', role: 'assistant', content: 'Hello back' },
				}),
				JSON.stringify({
					type: 'event_msg',
					payload: {
						type: 'token_count',
						info: {
							total_token_usage: {
								input_tokens: 7,
								output_tokens: 9,
								reasoning_output_tokens: 3,
								cached_input_tokens: 5,
							},
						},
					},
				}),
				'not json',
			].join('\n'),
			'utf-8'
		);
		await registerAgentSessions({
			getMainWindow: () =>
				({
					isDestroyed: () => false,
					webContents: {
						isDestroyed: () => false,
						send: webContentsSend,
					},
				}) as never,
		});

		const stats = await invoke<{
			totalSessions: number;
			totalMessages: number;
			totalInputTokens: number;
			totalOutputTokens: number;
			totalCacheReadTokens: number;
			totalCacheCreationTokens: number;
			byProvider: Record<string, { sessions: number; messages: number }>;
			isComplete: boolean;
		}>('agentSessions:getGlobalStats');

		expect(stats).toMatchObject({
			totalSessions: 2,
			totalMessages: 4,
			totalInputTokens: 18,
			totalOutputTokens: 25,
			totalCacheReadTokens: 22,
			totalCacheCreationTokens: 19,
			isComplete: true,
			byProvider: {
				'claude-code': { sessions: 1, messages: 2 },
				codex: { sessions: 1, messages: 2 },
			},
		});
		expect(webContentsSend).toHaveBeenCalledWith(
			'agentSessions:globalStatsUpdate',
			expect.objectContaining({ isComplete: true, totalSessions: 2 })
		);
		await expect(
			fs.readFile(path.join(userDataDir, 'stats-cache', 'global-stats.json'), 'utf-8')
		).resolves.toContain('claude-code');
	});
});
