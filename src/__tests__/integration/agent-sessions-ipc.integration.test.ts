import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerAgentSessionsHandlers } from '../../main/ipc/handlers/agentSessions';

const ipcHandlers = vi.hoisted(() => new Map<string, (...args: any[]) => Promise<any>>());
const agentState = vi.hoisted(() => ({
	storages: new Map<string, any>(),
	allStorages: [] as any[],
}));
const cacheState = vi.hoisted(() => ({
	loadResult: null as any,
	saveGlobalStatsCache: vi.fn(),
}));
const sshRemoteState = vi.hoisted(() => ({
	remotes: [] as any[],
}));
const fsState = vi.hoisted(() => ({
	entries: new Map<
		string,
		{
			children?: string[];
			content?: string;
			dir?: boolean;
			mtimeMs?: number;
			readError?: Error;
			size?: number;
		}
	>(),
	homeDir: '/tmp/maestro-agent-sessions-home',
}));

vi.mock('electron', () => ({
	ipcMain: {
		handle: vi.fn((channel: string, handler: (...args: any[]) => Promise<any>) => {
			ipcHandlers.set(channel, handler);
		}),
	},
	BrowserWindow: class MockBrowserWindow {},
}));

vi.mock('../../main/agents', () => ({
	getAllSessionStorages: vi.fn(() => agentState.allStorages),
	getSessionStorage: vi.fn((agentId: string) => agentState.storages.get(agentId)),
	hasSessionStorage: vi.fn((agentId: string) => agentState.storages.has(agentId)),
}));

vi.mock('../../main/stores', () => ({
	getSshRemoteById: vi.fn((sshRemoteId: string) =>
		sshRemoteState.remotes.find((remote) => remote.id === sshRemoteId)
	),
}));

vi.mock('os', async (importOriginal) => {
	const actual = await importOriginal<typeof import('os')>();
	return {
		...actual,
		default: {
			...actual,
			homedir: () => fsState.homeDir,
		},
		homedir: () => fsState.homeDir,
	};
});

vi.mock('fs/promises', () => {
	const getEntry = (targetPath: string) => {
		const entry = fsState.entries.get(targetPath);
		if (!entry) {
			throw Object.assign(new Error(`ENOENT: ${targetPath}`), { code: 'ENOENT' });
		}
		return entry;
	};
	const mockedFs = {
		access: vi.fn(async (targetPath: string) => {
			getEntry(targetPath);
		}),
		readFile: vi.fn(async (targetPath: string) => {
			const entry = getEntry(targetPath);
			if (entry.readError) throw entry.readError;
			return entry.content ?? '';
		}),
		readdir: vi.fn(async (targetPath: string) => getEntry(targetPath).children ?? []),
		stat: vi.fn(async (targetPath: string) => {
			const entry = getEntry(targetPath);
			return {
				isDirectory: () => !!entry.dir,
				mtimeMs: entry.mtimeMs ?? 1,
				size: entry.size ?? entry.content?.length ?? 0,
			};
		}),
	};
	return {
		...mockedFs,
		default: mockedFs,
	};
});

vi.mock('../../main/utils/statsCache', () => ({
	GLOBAL_STATS_CACHE_VERSION: 1,
	loadGlobalStatsCache: vi.fn(async () => cacheState.loadResult),
	saveGlobalStatsCache: (...args: unknown[]) => cacheState.saveGlobalStatsCache(...args),
}));

vi.mock('../../main/utils/safe-send', () => ({
	isWebContentsAvailable: vi.fn((win: { webContents?: unknown } | null) => !!win?.webContents),
}));

vi.mock('../../main/utils/logger', () => ({
	logger: {
		debug: vi.fn(),
		error: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
	},
}));

function handler<T = any>(channel: string) {
	const found = ipcHandlers.get(channel);
	if (!found) {
		throw new Error(`Missing handler ${channel}`);
	}
	return found as (_event: unknown, ...args: any[]) => Promise<T>;
}

function createStorage(agentId = 'codex') {
	return {
		agentId,
		deleteMessagePair: vi.fn(async () => ({ success: true, linesRemoved: 2 })),
		getAllNamedSessions: vi.fn(async () => [
			{
				agentSessionId: 'named-1',
				lastActivityAt: 100,
				projectPath: '/repo',
				sessionName: 'Named session',
				starred: true,
			},
		]),
		getSessionPath: vi.fn(async () => '/sessions/session-1.jsonl'),
		listSessions: vi.fn(async () => [{ id: 'session-1', title: 'Session 1' }]),
		listSessionsPaginated: vi.fn(async () => ({
			hasMore: false,
			nextCursor: null,
			sessions: [{ id: 'session-1', title: 'Session 1' }],
			totalCount: 1,
		})),
		readSessionMessages: vi.fn(async () => ({
			hasMore: false,
			messages: [{ role: 'user', content: 'hello' }],
			total: 1,
		})),
		searchSessions: vi.fn(async () => [{ sessionId: 'session-1', matches: [] }]),
	};
}

function createOriginsStore(initialOrigins: Record<string, any> = {}) {
	let origins = initialOrigins;
	return {
		get: vi.fn((_key: string, fallback: Record<string, any>) => origins ?? fallback),
		set: vi.fn((_key: string, value: Record<string, any>) => {
			origins = value;
		}),
		read: () => origins,
	};
}

function putDir(targetPath: string, children: string[] = []) {
	fsState.entries.set(targetPath, { children, dir: true });
}

function putFile(targetPath: string, content: string, mtimeMs = 1) {
	fsState.entries.set(targetPath, {
		content,
		mtimeMs,
		size: Buffer.byteLength(content),
	});
}

function cachedStats(overrides: Record<string, unknown> = {}) {
	return {
		cacheCreationTokens: 0,
		cacheReadTokens: 0,
		cachedInputTokens: 0,
		fileMtimeMs: 1,
		inputTokens: 1,
		messages: 1,
		outputTokens: 1,
		sizeBytes: 10,
		...overrides,
	};
}

describe('agentSessions IPC integration', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		ipcHandlers.clear();
		agentState.storages = new Map();
		agentState.allStorages = [];
		cacheState.loadResult = null;
		cacheState.saveGlobalStatsCache.mockReset();
		sshRemoteState.remotes = [];
		fsState.entries = new Map();
	});

	it('returns safe fallbacks when storage and origins stores are unavailable', async () => {
		registerAgentSessionsHandlers({ getMainWindow: () => null });

		await expect(handler('agentSessions:list')({}, 'missing', '/repo')).resolves.toEqual([]);
		await expect(handler('agentSessions:listPaginated')({}, 'missing', '/repo')).resolves.toEqual({
			hasMore: false,
			nextCursor: null,
			sessions: [],
			totalCount: 0,
		});
		await expect(
			handler('agentSessions:read')({}, 'missing', '/repo', 'session-1')
		).resolves.toEqual({
			hasMore: false,
			messages: [],
			total: 0,
		});
		await expect(
			handler('agentSessions:search')({}, 'missing', '/repo', 'query', 'content')
		).resolves.toEqual([]);
		await expect(
			handler('agentSessions:getPath')({}, 'missing', '/repo', 'session-1')
		).resolves.toBeNull();
		await expect(
			handler('agentSessions:deleteMessagePair')({}, 'missing', '/repo', 'session-1', 'message-1')
		).resolves.toMatchObject({
			success: false,
			error: 'No session storage available for agent: missing',
		});

		await expect(handler('agentSessions:getOrigins')({}, 'codex', '/repo')).resolves.toEqual({});
		await expect(
			handler('agentSessions:setSessionName')({}, 'codex', '/repo', 'session-1', 'Name')
		).resolves.toBeUndefined();
		await expect(
			handler('agentSessions:setSessionStarred')({}, 'codex', '/repo', 'session-1', true)
		).resolves.toBeUndefined();
	});

	it('delegates storage operations with SSH config lookup and named-session aggregation', async () => {
		const storage = createStorage('codex');
		agentState.storages.set('codex', storage);
		agentState.allStorages = [
			storage,
			{ agentId: 'plain' },
			{
				agentId: 'thrower',
				getAllNamedSessions: vi.fn(async () => {
					throw new Error('named sessions failed');
				}),
			},
		];
		sshRemoteState.remotes = [
			{ enabled: true, host: 'example.com', id: 'remote-1', name: 'Remote 1' },
			{ enabled: false, host: 'disabled.example.com', id: 'disabled', name: 'Disabled' },
		];
		registerAgentSessionsHandlers({ getMainWindow: () => null });

		await expect(handler('agentSessions:list')({}, 'codex', '/repo', 'remote-1')).resolves.toEqual([
			{ id: 'session-1', title: 'Session 1' },
		]);
		expect(storage.listSessions).toHaveBeenCalledWith(
			'/repo',
			expect.objectContaining({ id: 'remote-1' })
		);
		await handler('agentSessions:list')({}, 'codex', '/repo');
		expect(storage.listSessions).toHaveBeenLastCalledWith('/repo', undefined);

		await handler('agentSessions:listPaginated')({}, 'codex', '/repo', { limit: 5 });
		expect(storage.listSessionsPaginated).toHaveBeenCalledWith('/repo', { limit: 5 }, undefined);
		await handler('agentSessions:listPaginated')({}, 'codex', '/repo', { limit: 1 }, 'remote-1');
		expect(storage.listSessionsPaginated).toHaveBeenLastCalledWith(
			'/repo',
			{ limit: 1 },
			expect.objectContaining({ id: 'remote-1' })
		);

		await handler('agentSessions:read')({}, 'codex', '/repo', 'session-1', { limit: 20 });
		expect(storage.readSessionMessages).toHaveBeenCalledWith(
			'/repo',
			'session-1',
			{ limit: 20 },
			undefined
		);
		await handler('agentSessions:read')({}, 'codex', '/repo', 'session-1', undefined, 'remote-1');
		expect(storage.readSessionMessages).toHaveBeenLastCalledWith(
			'/repo',
			'session-1',
			undefined,
			expect.objectContaining({ id: 'remote-1' })
		);

		await handler('agentSessions:search')({}, 'codex', '/repo', 'hello', 'content');
		expect(storage.searchSessions).toHaveBeenCalledWith('/repo', 'hello', 'content', undefined);
		await handler('agentSessions:search')({}, 'codex', '/repo', 'hello', 'content', 'remote-1');
		expect(storage.searchSessions).toHaveBeenLastCalledWith(
			'/repo',
			'hello',
			'content',
			expect.objectContaining({ id: 'remote-1' })
		);

		await expect(handler('agentSessions:getPath')({}, 'codex', '/repo', 'session-1')).resolves.toBe(
			'/sessions/session-1.jsonl'
		);
		await expect(
			handler('agentSessions:deleteMessagePair')({}, 'codex', '/repo', 'session-1', 'message-1')
		).resolves.toEqual({ success: true, linesRemoved: 2 });
		await expect(handler('agentSessions:hasStorage')({}, 'codex')).resolves.toBe(true);
		await expect(handler('agentSessions:getAvailableStorages')({})).resolves.toEqual([
			'codex',
			'plain',
			'thrower',
		]);
		await expect(handler('agentSessions:getAllNamedSessions')({})).resolves.toEqual([
			expect.objectContaining({
				agentId: 'codex',
				agentSessionId: 'named-1',
				sessionName: 'Named session',
			}),
		]);

		await handler('agentSessions:list')({}, 'codex', '/repo', 'disabled');
		expect(storage.listSessions).toHaveBeenLastCalledWith('/repo', undefined);

		sshRemoteState.remotes = [];
		ipcHandlers.clear();
		registerAgentSessionsHandlers({ getMainWindow: () => null });
		await handler('agentSessions:list')({}, 'codex', '/repo', 'remote-1');
		expect(storage.listSessions).toHaveBeenLastCalledWith('/repo', undefined);
	});

	it('updates and cleans generic origins metadata', async () => {
		const originsStore = createOriginsStore();
		registerAgentSessionsHandlers({
			agentSessionOriginsStore: originsStore as any,
			getMainWindow: () => null,
		});

		await expect(handler('agentSessions:getOrigins')({}, 'codex', '/repo')).resolves.toEqual({});

		await handler('agentSessions:setSessionName')({}, 'codex', '/repo', 'session-1', 'Named');
		expect(originsStore.read()).toEqual({
			codex: {
				'/repo': {
					'session-1': { sessionName: 'Named' },
				},
			},
		});

		await handler('agentSessions:setSessionStarred')({}, 'codex', '/repo', 'session-1', true);
		expect(originsStore.read().codex['/repo']['session-1']).toEqual({
			sessionName: 'Named',
			starred: true,
		});

		await handler('agentSessions:setSessionName')({}, 'codex', '/repo', 'session-1', null);
		expect(originsStore.read().codex['/repo']['session-1']).toEqual({ starred: true });

		await handler('agentSessions:setSessionName')({}, 'codex', '/repo', 'name-only', 'Temporary');
		await handler('agentSessions:setSessionName')({}, 'codex', '/repo', 'name-only', null);
		expect(originsStore.read().codex['/repo']['name-only']).toBeUndefined();
		await handler('agentSessions:setSessionName')({}, 'codex', '/repo', 'missing-name', null);

		await handler('agentSessions:setSessionStarred')({}, 'codex', '/repo', 'session-1', false);
		expect(originsStore.read().codex['/repo']['session-1']).toBeUndefined();
		await handler('agentSessions:setSessionName')({}, 'codex', '/repo', 'named-kept', 'Keep');
		await handler('agentSessions:setSessionStarred')({}, 'codex', '/repo', 'named-kept', false);
		expect(originsStore.read().codex['/repo']['named-kept']).toEqual({ sessionName: 'Keep' });
		await handler('agentSessions:setSessionStarred')({}, 'codex', '/repo', 'missing-star', false);

		await handler('agentSessions:setSessionStarred')({}, 'opencode', '/other', 'star-only', true);
		expect(originsStore.read().opencode['/other']['star-only']).toEqual({ starred: true });
	});

	it('builds global stats from cached and discovered Claude/Codex sessions', async () => {
		cacheState.loadResult = {
			lastUpdated: 1,
			providers: {
				'claude-code': {
					sessions: {
						'deleted-claude': cachedStats({ archived: false, messages: 2 }),
						'proj-one/fresh': cachedStats({ archived: false, fileMtimeMs: 5 }),
						'proj-one/valid': cachedStats({ archived: true, fileMtimeMs: 1 }),
					},
				},
				codex: {
					sessions: {
						'2026/05/27/deleted-codex': cachedStats({ archived: false, messages: 3 }),
						'2026/05/27/fresh': cachedStats({ archived: false, fileMtimeMs: 5 }),
						'2026/05/27/valid': cachedStats({ archived: true, fileMtimeMs: 1 }),
					},
				},
			},
			version: 1,
		};

		const claudeProjects = `${fsState.homeDir}/.claude/projects`;
		putDir(claudeProjects, ['not-dir', 'proj-one']);
		putFile(`${claudeProjects}/not-dir`, '');
		putDir(`${claudeProjects}/proj-one`, [
			'skip.txt',
			'empty.jsonl',
			'fresh.jsonl',
			'valid.jsonl',
			'bad.jsonl',
		]);
		putFile(`${claudeProjects}/proj-one/empty.jsonl`, '', 2);
		putFile(`${claudeProjects}/proj-one/fresh.jsonl`, '{"type":"user"}', 5);
		putFile(
			`${claudeProjects}/proj-one/valid.jsonl`,
			'{"type":"user","input_tokens":10,"output_tokens":2}\n{"type":"assistant","cache_read_input_tokens":3,"cache_creation_input_tokens":4}',
			5
		);
		fsState.entries.set(`${claudeProjects}/proj-one/bad.jsonl`, {
			mtimeMs: 6,
			readError: new Error('bad claude file'),
			size: 12,
		});

		const codexSessions = `${fsState.homeDir}/.codex/sessions`;
		putDir(codexSessions, ['bad-year', '2024', '2025', '2026']);
		putFile(`${codexSessions}/2025`, '');
		putDir(`${codexSessions}/2026`, ['bad-month', '03', '04', '05']);
		putFile(`${codexSessions}/2026/04`, '');
		putDir(`${codexSessions}/2026/05`, ['bad-day', '25', '26', '27']);
		putFile(`${codexSessions}/2026/05/26`, '');
		putDir(`${codexSessions}/2026/05/27`, [
			'skip.txt',
			'empty.jsonl',
			'fresh.jsonl',
			'valid.jsonl',
			'bad.jsonl',
			'missing.jsonl',
		]);
		putFile(`${codexSessions}/2026/05/27/empty.jsonl`, '', 2);
		putFile(
			`${codexSessions}/2026/05/27/fresh.jsonl`,
			'{"type":"response_item","payload":{"type":"message","role":"user"}}',
			5
		);
		putFile(
			`${codexSessions}/2026/05/27/valid.jsonl`,
			[
				'{"type":"response_item","payload":{"type":"message","role":"user"}}',
				'{"type":"response_item","payload":{"type":"message","role":"assistant"}}',
				'{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":7,"output_tokens":8,"reasoning_output_tokens":9,"cached_input_tokens":10}}}}',
				'not json',
			].join('\n'),
			5
		);
		fsState.entries.set(`${codexSessions}/2026/05/27/bad.jsonl`, {
			mtimeMs: 6,
			readError: new Error('bad codex file'),
			size: 12,
		});

		const send = vi.fn();
		registerAgentSessionsHandlers({
			getMainWindow: () => ({ webContents: { send } }) as any,
		});

		const result = await handler('agentSessions:getGlobalStats')({});

		expect(result.totalSessions).toBeGreaterThanOrEqual(4);
		expect(result.byProvider['claude-code']).toMatchObject({
			hasCostData: true,
			sessions: expect.any(Number),
		});
		expect(result.byProvider.codex).toMatchObject({
			hasCostData: false,
			sessions: expect.any(Number),
		});
		expect(cacheState.saveGlobalStatsCache).toHaveBeenCalledWith(
			expect.objectContaining({
				providers: expect.objectContaining({
					'claude-code': expect.any(Object),
					codex: expect.any(Object),
				}),
			})
		);
		expect(send).toHaveBeenCalledWith(
			'agentSessions:globalStatsUpdate',
			expect.objectContaining({ isComplete: true })
		);
	});

	it('parses global stats files with default token and no-message branches', async () => {
		cacheState.loadResult = null;

		const claudeProjects = `${fsState.homeDir}/.claude/projects`;
		putDir(claudeProjects, ['proj-two']);
		putDir(`${claudeProjects}/proj-two`, ['default.jsonl']);
		putFile(`${claudeProjects}/proj-two/default.jsonl`, '{"type":"system"}', 2);

		const codexSessions = `${fsState.homeDir}/.codex/sessions`;
		putDir(codexSessions, ['2026']);
		putDir(`${codexSessions}/2026`, ['05']);
		putDir(`${codexSessions}/2026/05`, ['27']);
		putDir(`${codexSessions}/2026/05/27`, ['default.jsonl']);
		putFile(
			`${codexSessions}/2026/05/27/default.jsonl`,
			[
				'{"type":"response_item","payload":{"type":"message","role":"system"}}',
				'{"type":"event_msg","payload":{"type":"token_count","info":{}}}',
				'{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{}}}}',
			].join('\n'),
			2
		);

		const send = vi.fn();
		registerAgentSessionsHandlers({
			getMainWindow: () => ({ webContents: { send } }) as any,
		});

		const result = await handler('agentSessions:getGlobalStats')({});

		expect(result.totalSessions).toBe(2);
		expect(result.totalMessages).toBe(0);
		expect(send).toHaveBeenCalledWith(
			'agentSessions:globalStatsUpdate',
			expect.objectContaining({ isComplete: true })
		);
	});

	it('returns empty complete global stats when no cache or session roots exist', async () => {
		cacheState.loadResult = null;
		fsState.entries = new Map();
		registerAgentSessionsHandlers({ getMainWindow: () => null });

		const result = await handler('agentSessions:getGlobalStats')({});

		expect(result).toMatchObject({
			byProvider: {},
			isComplete: true,
			totalMessages: 0,
			totalSessions: 0,
		});
		expect(cacheState.saveGlobalStatsCache).toHaveBeenCalledWith(
			expect.objectContaining({
				providers: {
					'claude-code': { sessions: {} },
					codex: { sessions: {} },
				},
			})
		);
	});
});
