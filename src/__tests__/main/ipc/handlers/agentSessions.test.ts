/**
 * Tests for the agentSessions IPC handlers
 *
 * These tests verify the generic agent session management API that works
 * with any agent supporting the AgentSessionStorage interface.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { ipcMain } from 'electron';
import {
	registerAgentSessionsHandlers,
	isExpectedSessionReadError,
	type AgentSessionOriginsData,
	type AgentSessionsHandlerDependencies,
} from '../../../../main/ipc/handlers/agentSessions';
import * as agentSessionStorage from '../../../../main/agents';
import {
	GLOBAL_STATS_CACHE_MIN_UPGRADABLE_VERSION,
	GLOBAL_STATS_CACHE_VERSION,
	loadGlobalStatsCache,
	qualifiedGlobalStatsSessionKey,
	saveGlobalStatsCache,
	type GlobalStatsCache,
} from '../../../../main/utils/statsCache';
import { GrokSessionStorage } from '../../../../main/storage/grok-session-storage';
import os from 'os';
import path from 'path';
import { promises as realFs } from 'fs';
import { getLiveSessions, getSshRemoteById } from '../../../../main/stores';
import * as mirrors from '../../../../main/storage/starred-transcript-mirror';
import { createMockSession } from '../../../helpers/mockSession';
import { getHistoryManager } from '../../../../main/history-manager';
import { logger } from '../../../../main/utils/logger';
import { observePathRemote } from '../../../../main/utils/remote-fs';
import { nativeAccountRef } from '../../../../shared/agentAccountDir';
import { grokInstallationId } from '../../../../shared/maestro-lib/grok/host-seams';
import type { SshRemoteEndpointIdentity } from '../../../../shared/maestro-lib/launch/ssh-remote-resolver';
import type { NativeSessionBinding } from '../../../../shared/maestro-lib/agents/providerSwap';

const accountStores = vi.hoisted(() => ({
	provider: {} as Record<string, string>,
	global: {} as Record<string, string>,
}));

// Inert observer identity; no endpoint connection or provider account is opened.
const endpoint: SshRemoteEndpointIdentity = {
	contractVersion: '1',
	installationId: 'remote-installation',
	runtimeId: 'runtime',
	processEpoch: 'epoch',
	tenantId: 'fixture',
	orgId: 'fixture',
	authorityId: 'fixture',
	policyRevision: 1,
	authority: 'registered',
	routes: [],
};

// Mock electron's ipcMain
vi.mock('electron', () => ({
	ipcMain: {
		handle: vi.fn(),
		removeHandler: vi.fn(),
	},
}));

// Mock the agents module (session storage exports)
vi.mock('../../../../main/agents', () => ({
	getSessionStorage: vi.fn(),
	hasSessionStorage: vi.fn(),
	getAllSessionStorages: vi.fn(),
}));

// Keep account resolution real, with only its stores replaced by inert inputs.
vi.mock('../../../../main/stores', () => ({
	getSshRemoteById: vi.fn().mockReturnValue(undefined),
	getLiveSessions: vi.fn().mockReturnValue([]),
	getProductionDataPath: () => path.resolve('tmp/grok-history-ipc/data'),
	getAgentConfigsStore: () => ({
		get: () => ({ grok: { customEnvVars: accountStores.provider } }),
	}),
	getSettingsStore: () => ({ get: () => accountStores.global }),
}));
vi.mock('../../../../main/utils/remote-fs', () => ({ observePathRemote: vi.fn() }));
vi.mock('../../../../main/stores/instances', () => ({ isInitialized: () => true }));
vi.mock('../../../../main/stores/getters', () => ({
	// Grok account discovery reads stored agents; none are configured here.
	getSessionsStore: () => ({ get: () => [] }),
	getAgentConfigsStore: () => ({
		get: () => ({ grok: { customEnvVars: accountStores.provider } }),
	}),
	getSettingsStore: () => ({ get: () => accountStores.global }),
}));
vi.mock('../../../../main/storage/starred-transcript-mirror', () => ({
	restoreStarredTranscript: vi.fn().mockResolvedValue(false),
	snapshotStarredTranscript: vi.fn(),
	releaseTranscriptMirror: vi.fn(),
	releaseSnoozedTranscriptMirror: vi.fn(),
	listMirroredStarredSessions: vi.fn().mockResolvedValue([]),
}));

// The global stats scan reads and writes a cache under userData; start cold
// and discard writes so a test only ever sees the transcripts it created.
vi.mock('../../../../main/utils/statsCache', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../../main/utils/statsCache')>()),
	loadGlobalStatsCache: vi.fn().mockResolvedValue(null),
	saveGlobalStatsCache: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../../main/history-manager', () => ({ getHistoryManager: vi.fn() }));

// Mock the logger
vi.mock('../../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

describe('agentSessions IPC handlers', () => {
	let handlers: Map<string, (...args: any[]) => any>;

	beforeEach(() => {
		// Clear mocks
		vi.clearAllMocks();
		vi.mocked(getLiveSessions).mockReset().mockReturnValue([]);
		vi.mocked(getSshRemoteById).mockReset().mockReturnValue(undefined);
		vi.mocked(observePathRemote).mockReset();
		accountStores.provider = {};
		accountStores.global = {};

		// Capture all registered handlers
		handlers = new Map();
		vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => {
			handlers.set(channel, handler);
		});

		// Register handlers
		registerAgentSessionsHandlers();
	});

	afterEach(() => {
		handlers.clear();
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	describe('registration', () => {
		it('should register all agentSessions handlers', () => {
			const expectedChannels = [
				'agentSessions:list',
				'agentSessions:listPaginated',
				'agentSessions:read',
				'agentSessions:search',
				'agentSessions:getPath',
				'agentSessions:deleteMessagePair',
				'agentSessions:hasStorage',
				'agentSessions:getAvailableStorages',
			];

			for (const channel of expectedChannels) {
				expect(handlers.has(channel)).toBe(true);
			}
		});
	});

	describe('Grok native title and unscoped label boundaries', () => {
		const project = path.resolve('tmp/grok-history-ipc/project');
		let persisted: string;
		let store: { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> };
		let deps: AgentSessionsHandlerDependencies;

		beforeEach(() => {
			persisted = JSON.stringify({
				grok: {
					[project]: { collision: { sessionName: 'Legacy name', starred: true, origin: 'user' } },
				},
				codex: {
					[project]: { collision: { sessionName: 'Codex label', starred: true, origin: 'auto' } },
				},
			});
			store = {
				get: vi.fn(() => JSON.parse(persisted) as AgentSessionOriginsData['origins']),
				set: vi.fn((_key: string, value: AgentSessionOriginsData['origins']) => {
					persisted = JSON.stringify(value);
				}),
			};
			deps = {
				getMainWindow: () => null,
				agentSessionOriginsStore:
					store as unknown as AgentSessionsHandlerDependencies['agentSessionOriginsStore'],
			};
			registerAgentSessionsHandlers(deps);
		});

		it.each([
			{ ssh: false, state: 'idle' as const },
			{ ssh: false, state: 'busy' as const },
			{ ssh: true, state: 'idle' as const },
			{ ssh: true, state: 'busy' as const },
		])(
			'refuses rename/reset across colliding accounts (SSH=$ssh, state=$state)',
			async ({ ssh, state }) => {
				const owners = ['a', 'b'].map((suffix) =>
					createMockSession({
						id: `owner-${suffix}`,
						toolType: 'grok',
						state,
						cwd: project,
						customEnvVars: { GROK_HOME: ssh ? `~/account-${suffix}` : path.join(project, suffix) },
						sessionSshRemoteConfig: ssh
							? { enabled: true, remoteId: `remote-${suffix}` }
							: undefined,
						agentSessionId: 'collision',
					})
				);
				vi.mocked(getLiveSessions).mockReturnValue(owners);
				const before = persisted;
				for (const name of ['Renamed', null, '']) {
					await expect(
						handlers.get('agentSessions:setSessionName')!({}, 'grok', project, 'collision', name)
					).rejects.toThrow(
						/unsupported.*account\/host.*native title.*Rename the Maestro tab.*Grok CLI.*refresh history/
					);
				}
				expect(persisted).toBe(before);
				expect(store.get).not.toHaveBeenCalled();
				expect(store.set).not.toHaveBeenCalled();
				expect(agentSessionStorage.getSessionStorage).not.toHaveBeenCalled();
				expect(getSshRemoteById).not.toHaveBeenCalled();
				expect(observePathRemote).not.toHaveBeenCalled();
				for (const mirror of Object.values(mirrors)) expect(mirror).not.toHaveBeenCalled();
				expect(logger.info).not.toHaveBeenCalledWith(
					expect.stringContaining('Set session name'),
					expect.anything()
				);
			}
		);

		it.each(['Renamed', null])('rejects %s even when the origins store is absent', async (name) => {
			registerAgentSessionsHandlers();
			await expect(
				handlers.get('agentSessions:setSessionName')!({}, 'grok', project, 'collision', name)
			).rejects.toThrow(/Grok history rename is unsupported/);
			expect(store.set).not.toHaveBeenCalled();
			expect(logger.warn).not.toHaveBeenCalledWith(
				'Origins store not available',
				expect.anything()
			);
		});

		it('suppresses ambiguous names after reload without erasing stars, origins or saved bytes', async () => {
			const before = persisted;
			for (let reload = 0; reload < 2; reload++) {
				registerAgentSessionsHandlers(deps);
				expect(await handlers.get('agentSessions:getOrigins')!({}, 'grok', project)).toEqual({
					collision: { starred: true, origin: 'user' },
				});
				expect(await handlers.get('agentSessions:getOrigins')!({}, 'codex', project)).toEqual({
					collision: { sessionName: 'Codex label', starred: true, origin: 'auto' },
				});
			}
			expect(persisted).toBe(before);
			expect(store.set).not.toHaveBeenCalled();
		});

		it.each(['claude-code', 'codex'])(
			'persists and resets a %s Maestro label across handler reload',
			async (provider) => {
				await handlers.get('agentSessions:setSessionName')!(
					{},
					provider,
					project,
					'collision',
					'Local label'
				);
				registerAgentSessionsHandlers(deps);
				expect(
					(await handlers.get('agentSessions:getOrigins')!({}, provider, project)).collision
						.sessionName
				).toBe('Local label');
				await handlers.get('agentSessions:setSessionName')!(
					{},
					provider,
					project,
					'collision',
					null
				);
				registerAgentSessionsHandlers(deps);
				const origins = await handlers.get('agentSessions:getOrigins')!({}, provider, project);
				expect(origins.collision?.sessionName).toBeUndefined();
				if (provider === 'codex')
					expect(origins.collision).toEqual({ starred: true, origin: 'auto' });
				expect(store.set).toHaveBeenCalledTimes(2);
			}
		);

		it('rejects a failed label write without logging successful native or metadata rename', async () => {
			const before = persisted;
			const error = new Error('Origins write failed');
			store.set.mockImplementationOnce(() => {
				throw error;
			});
			await expect(
				handlers.get('agentSessions:setSessionName')!(
					{},
					'codex',
					project,
					'collision',
					'Lost label'
				)
			).rejects.toBe(error);
			expect(persisted).toBe(before);
			expect(logger.info).not.toHaveBeenCalledWith(
				expect.stringContaining('Set session name'),
				expect.anything()
			);
			expect(logger.error).toHaveBeenCalledWith(
				'setSessionName error',
				expect.anything(),
				expect.objectContaining({ message: error.message })
			);
		});

		it('excludes Grok from origins, default-account History and mirror label fallbacks', async () => {
			const grokPath = vi.fn().mockReturnValue(path.join(project, 'grok-native'));
			const codexPath = vi.fn().mockReturnValue(path.join(project, 'codex-native'));
			const storages = [
				{ agentId: 'grok', getSessionPath: grokPath },
				{ agentId: 'codex', getSessionPath: codexPath },
			];
			vi.mocked(agentSessionStorage.getAllSessionStorages)
				.mockReturnValueOnce(storages as unknown as agentSessionStorage.AgentSessionStorage[])
				.mockReturnValueOnce(storages as unknown as agentSessionStorage.AgentSessionStorage[]);
			vi.mocked(agentSessionStorage.getSessionStorage).mockReturnValueOnce(
				storages[1] as unknown as agentSessionStorage.AgentSessionStorage
			);
			vi.spyOn(realFs, 'stat').mockResolvedValue({ mtime: new Date(1000) } as Awaited<
				ReturnType<typeof realFs.stat>
			>);
			const binding: NativeSessionBinding = {
				version: 1,
				state: 'bound',
				provider: 'grok',
				nativeSessionId: 'bound-collision',
				cwd: project,
				accountRef: nativeAccountRef('grok', path.join(project, 'account-a')),
				host: { kind: 'local', identity: 'fixture-installation' },
			};
			const entries = [
				{
					agentSessionId: 'bound-collision',
					projectPath: project,
					sessionName: 'Retained Grok name',
					nativeSessionBinding: binding,
				},
				{ agentSessionId: 'unbound', projectPath: project, sessionName: 'Legacy history name' },
			];
			vi.mocked(getHistoryManager).mockReturnValueOnce({
				getAllEntriesPaginated: vi.fn().mockResolvedValue({ entries }),
			} as unknown as ReturnType<typeof getHistoryManager>);
			vi.mocked(mirrors.listMirroredStarredSessions).mockResolvedValueOnce([
				{
					agentId: 'grok',
					sessionId: 'mirror-collision',
					projectPath: project,
					sessionName: 'Grok mirror',
					mirroredAtMs: 1000,
					sourceMtimeMs: 1000,
				},
				{
					agentId: 'codex',
					sessionId: 'mirror-collision',
					projectPath: project,
					sessionName: 'Codex mirror',
					mirroredAtMs: 1000,
					sourceMtimeMs: 1000,
				},
			]);
			const before = persisted;
			expect(await handlers.get('agentSessions:getAllNamedSessions')!({})).toEqual([
				{
					agentId: 'codex',
					agentSessionId: 'collision',
					projectPath: project,
					sessionName: 'Codex label',
					starred: true,
				},
				{
					agentId: 'codex',
					agentSessionId: 'unbound',
					projectPath: project,
					sessionName: 'Legacy history name',
					lastActivityAt: 1000,
				},
				{
					agentId: 'codex',
					agentSessionId: 'mirror-collision',
					projectPath: project,
					sessionName: 'Codex mirror',
					starred: true,
					lastActivityAt: 1000,
				},
			]);
			expect(grokPath).not.toHaveBeenCalled();
			expect(codexPath).not.toHaveBeenCalledWith(project, 'bound-collision');
			expect(agentSessionStorage.getSessionStorage).not.toHaveBeenCalledWith('grok');
			expect(persisted).toBe(before);
			expect(store.set).not.toHaveBeenCalled();
		});
	});

	describe('agentSessions:list', () => {
		it('should return sessions from storage', async () => {
			const mockSessions = [
				{ sessionId: 'session-1', projectPath: '/test', firstMessage: 'Hello' },
				{ sessionId: 'session-2', projectPath: '/test', firstMessage: 'Hi' },
			];

			const mockStorage = {
				agentId: 'claude-code',
				listSessions: vi.fn().mockResolvedValue(mockSessions),
			};

			vi.mocked(agentSessionStorage.getSessionStorage).mockReturnValue(
				mockStorage as unknown as agentSessionStorage.AgentSessionStorage
			);

			const handler = handlers.get('agentSessions:list');
			const result = await handler!({} as any, 'claude-code', '/test');

			expect(mockStorage.listSessions).toHaveBeenCalledWith('/test', undefined);
			expect(result).toEqual(mockSessions);
		});

		it('should return empty array when no storage available', async () => {
			vi.mocked(agentSessionStorage.getSessionStorage).mockReturnValue(null);

			const handler = handlers.get('agentSessions:list');
			const result = await handler!({} as any, 'unknown-agent', '/test');

			expect(result).toEqual([]);
		});

		it('refuses a missing SSH remote instead of reading local history', async () => {
			const mockSessions = [{ sessionId: 'session-1', projectPath: '/test' }];

			const mockStorage = {
				agentId: 'claude-code',
				listSessions: vi.fn().mockResolvedValue(mockSessions),
			};

			vi.mocked(agentSessionStorage.getSessionStorage).mockReturnValue(
				mockStorage as unknown as agentSessionStorage.AgentSessionStorage
			);

			const handler = handlers.get('agentSessions:list');
			await expect(handler!({} as any, 'claude-code', '/test', 'ssh-remote-1')).rejects.toThrow(
				/History SSH target unavailable/
			);
			expect(mockStorage.listSessions).not.toHaveBeenCalled();
			expect(mirrors.restoreStarredTranscript).not.toHaveBeenCalled();
		});
	});

	describe('agentSessions:listPaginated', () => {
		it('should return paginated sessions from storage', async () => {
			const mockResult = {
				sessions: [{ sessionId: 'session-1' }],
				hasMore: true,
				totalCount: 50,
				nextCursor: 'session-1',
			};

			const mockStorage = {
				agentId: 'claude-code',
				listSessionsPaginated: vi.fn().mockResolvedValue(mockResult),
			};

			vi.mocked(agentSessionStorage.getSessionStorage).mockReturnValue(
				mockStorage as unknown as agentSessionStorage.AgentSessionStorage
			);

			const handler = handlers.get('agentSessions:listPaginated');
			const result = await handler!({} as any, 'claude-code', '/test', { limit: 10 });

			expect(mockStorage.listSessionsPaginated).toHaveBeenCalledWith(
				'/test',
				{ limit: 10 },
				undefined
			);
			expect(result).toEqual(mockResult);
		});

		it('should return empty result when no storage available', async () => {
			vi.mocked(agentSessionStorage.getSessionStorage).mockReturnValue(null);

			const handler = handlers.get('agentSessions:listPaginated');
			const result = await handler!({} as any, 'unknown-agent', '/test', {});

			expect(result).toEqual({
				sessions: [],
				hasMore: false,
				totalCount: 0,
				nextCursor: null,
			});
		});

		it('refuses a missing SSH remote instead of reading local history', async () => {
			const mockResult = {
				sessions: [{ sessionId: 'session-1' }],
				hasMore: false,
				totalCount: 1,
				nextCursor: null,
			};

			const mockStorage = {
				agentId: 'claude-code',
				listSessionsPaginated: vi.fn().mockResolvedValue(mockResult),
			};

			vi.mocked(agentSessionStorage.getSessionStorage).mockReturnValue(
				mockStorage as unknown as agentSessionStorage.AgentSessionStorage
			);

			const handler = handlers.get('agentSessions:listPaginated');
			await expect(
				handler!({} as any, 'claude-code', '/test', { limit: 10 }, 'ssh-remote-1')
			).rejects.toThrow(/History SSH target unavailable/);
			expect(mockStorage.listSessionsPaginated).not.toHaveBeenCalled();
			expect(mirrors.restoreStarredTranscript).not.toHaveBeenCalled();
		});
	});

	describe('agentSessions:read', () => {
		it('should return session messages from storage', async () => {
			const mockResult = {
				messages: [{ type: 'user', content: 'Hello' }],
				total: 10,
				hasMore: true,
			};

			const mockStorage = {
				agentId: 'claude-code',
				readSessionMessages: vi.fn().mockResolvedValue(mockResult),
			};

			vi.mocked(agentSessionStorage.getSessionStorage).mockReturnValue(
				mockStorage as unknown as agentSessionStorage.AgentSessionStorage
			);

			const handler = handlers.get('agentSessions:read');
			const result = await handler!({} as any, 'claude-code', '/test', 'session-1', {
				offset: 0,
				limit: 20,
			});

			expect(mockStorage.readSessionMessages).toHaveBeenCalledWith(
				'/test',
				'session-1',
				{
					offset: 0,
					limit: 20,
				},
				undefined
			);
			expect(mirrors.restoreStarredTranscript).toHaveBeenCalledExactlyOnceWith({
				agentId: 'claude-code',
				projectPath: '/test',
				sessionId: 'session-1',
			});
			expect(result).toEqual(mockResult);
		});

		it('drops native ingestion options supplied by a renderer', async () => {
			const mockStorage = {
				agentId: 'claude-code',
				readSessionMessages: vi.fn().mockResolvedValue({ messages: [], total: 0, hasMore: false }),
			};
			vi.mocked(agentSessionStorage.getSessionStorage).mockReturnValue(
				mockStorage as unknown as agentSessionStorage.AgentSessionStorage
			);
			await handlers.get('agentSessions:read')!({}, 'claude-code', '/test', 'session-1', {
				offset: 4,
				limit: 8,
				filePath: '/untrusted.jsonl',
				content: 'untrusted',
			});
			expect(mockStorage.readSessionMessages).toHaveBeenCalledWith(
				'/test',
				'session-1',
				{ offset: 4, limit: 8 },
				undefined
			);
		});

		it('should return empty result when no storage available', async () => {
			vi.mocked(agentSessionStorage.getSessionStorage).mockReturnValue(null);

			const handler = handlers.get('agentSessions:read');
			const result = await handler!({} as any, 'unknown-agent', '/test', 'session-1', {});

			expect(result).toEqual({ messages: [], total: 0, hasMore: false });
		});

		it('refuses a missing SSH remote instead of reading local history', async () => {
			const mockResult = {
				messages: [{ type: 'user', content: 'Hello' }],
				total: 1,
				hasMore: false,
			};

			const mockStorage = {
				agentId: 'claude-code',
				readSessionMessages: vi.fn().mockResolvedValue(mockResult),
			};

			vi.mocked(agentSessionStorage.getSessionStorage).mockReturnValue(
				mockStorage as unknown as agentSessionStorage.AgentSessionStorage
			);

			const handler = handlers.get('agentSessions:read');
			await expect(
				handler!(
					{} as any,
					'claude-code',
					'/test',
					'session-1',
					{ offset: 0, limit: 20 },
					'ssh-remote-1'
				)
			).rejects.toThrow(/History SSH target unavailable/);
			expect(mockStorage.readSessionMessages).not.toHaveBeenCalled();
			expect(mirrors.restoreStarredTranscript).not.toHaveBeenCalled();
		});
	});

	describe('agentSessions:search', () => {
		it('should return search results from storage', async () => {
			const mockResults = [
				{
					sessionId: 'session-1',
					matchType: 'title' as const,
					matchPreview: 'Hello...',
					matchCount: 1,
				},
			];

			const mockStorage = {
				agentId: 'claude-code',
				searchSessions: vi.fn().mockResolvedValue(mockResults),
			};

			vi.mocked(agentSessionStorage.getSessionStorage).mockReturnValue(
				mockStorage as unknown as agentSessionStorage.AgentSessionStorage
			);

			const handler = handlers.get('agentSessions:search');
			const result = await handler!({} as any, 'claude-code', '/test', 'hello', 'all');

			expect(mockStorage.searchSessions).toHaveBeenCalledWith('/test', 'hello', 'all', undefined);
			expect(result).toEqual(mockResults);
		});

		it('should return empty array when no storage available', async () => {
			vi.mocked(agentSessionStorage.getSessionStorage).mockReturnValue(null);

			const handler = handlers.get('agentSessions:search');
			const result = await handler!({} as any, 'unknown-agent', '/test', 'hello', 'all');

			expect(result).toEqual([]);
		});

		it('refuses a missing SSH remote instead of reading local history', async () => {
			const mockResults = [
				{
					sessionId: 'session-1',
					matchType: 'title' as const,
					matchPreview: 'Hello...',
					matchCount: 1,
				},
			];

			const mockStorage = {
				agentId: 'claude-code',
				searchSessions: vi.fn().mockResolvedValue(mockResults),
			};

			vi.mocked(agentSessionStorage.getSessionStorage).mockReturnValue(
				mockStorage as unknown as agentSessionStorage.AgentSessionStorage
			);

			const handler = handlers.get('agentSessions:search');
			await expect(
				handler!({} as any, 'claude-code', '/test', 'hello', 'all', 'ssh-remote-1')
			).rejects.toThrow(/History SSH target unavailable/);
			expect(mockStorage.searchSessions).not.toHaveBeenCalled();
			expect(mirrors.restoreStarredTranscript).not.toHaveBeenCalled();
		});
	});

	describe('agentSessions:getPath', () => {
		it('should return session path from storage', async () => {
			const mockStorage = {
				agentId: 'claude-code',
				getSessionPath: vi.fn().mockReturnValue('/path/to/session.jsonl'),
			};

			vi.mocked(agentSessionStorage.getSessionStorage).mockReturnValue(
				mockStorage as unknown as agentSessionStorage.AgentSessionStorage
			);

			const handler = handlers.get('agentSessions:getPath');
			const result = await handler!({} as any, 'claude-code', '/test', 'session-1');

			expect(mockStorage.getSessionPath).toHaveBeenCalledWith('/test', 'session-1');
			expect(result).toBe('/path/to/session.jsonl');
		});

		it('should return null when no storage available', async () => {
			vi.mocked(agentSessionStorage.getSessionStorage).mockReturnValue(null);

			const handler = handlers.get('agentSessions:getPath');
			const result = await handler!({} as any, 'unknown-agent', '/test', 'session-1');

			expect(result).toBe(null);
		});
	});

	describe.each([
		{ api: 'list', method: 'listSessions', args: [], options: undefined },
		{
			api: 'listPaginated',
			method: 'listSessionsPaginated',
			args: [],
			options: { cursor: 'previous', limit: 2 },
		},
		{
			api: 'read',
			method: 'readSessionMessages',
			args: ['native-collision'],
			options: { offset: 1, limit: 2, includeNativeRecords: true },
		},
		{ api: 'search', method: 'searchSessions', args: ['needle', 'all'], options: undefined },
		{ api: 'getPath', method: 'getSessionPath', args: ['native-collision'], options: undefined },
	] as const)('Grok history scope: $api', ({ api, method, args, options }) => {
		const home = path.resolve('tmp/grok-history-ipc/home');
		const remote = {
			id: 'remote-a',
			name: 'A',
			host: 'a.invalid',
			port: 22,
			username: 'fixture',
			privateKeyPath: '',
			enabled: true,
		};
		let owner: ReturnType<typeof getLiveSessions>[number];
		let storage: Record<string, ReturnType<typeof vi.fn>>;
		const invoke = (ownerAgentId: unknown = 'owner', sshRemoteId?: unknown) =>
			handlers.get(`agentSessions:${api}`)!(
				{},
				'grok',
				'/project',
				...args,
				...(options ? [{ ...options, ownerAgentId }, sshRemoteId] : [sshRemoteId, ownerAgentId])
			);

		const expectedOptions = (configDir?: string, ssh = false) => ({
			...options,
			configDir:
				api === 'read' && ssh ? (configDir ?? '~/.grok').replace('~', '/fixture-home') : configDir,
			...(api === 'read'
				? { nativeSessionBinding: expect.objectContaining({ state: 'bound' }) }
				: {}),
		});
		const expectScope = (configDir?: string, target?: ReturnType<typeof getSshRemoteById>) => {
			// No host here qualifies a remote endpoint, so a scoped SSH read stays unbound.
			if (api === 'read' && target) {
				expect(storage[method]).not.toHaveBeenCalled();
				return;
			}
			expect(storage[method]).toHaveBeenCalledExactlyOnceWith(
				'/project',
				...args,
				...(options ? [expectedOptions(configDir, !!target), target] : [target, configDir])
			);
		};

		beforeEach(() => {
			vi.spyOn(os, 'homedir').mockReturnValue(home);
			vi.stubEnv('GROK_HOME', path.join(home, 'process-account'));
			owner = { ...createMockSession({ id: 'owner', toolType: 'grok' }) };
			if (api === 'read') {
				owner.projectRoot = '/project';
				vi.spyOn(realFs, 'realpath').mockImplementation(async (value) => String(value));
				vi.mocked(observePathRemote).mockImplementation(async (value) => ({
					success: true,
					data: {
						canonicalPath: value.replace('~', '/fixture-home'),
						device: '1',
						inode: value,
						kind: 'directory',
					},
				}));
				registerAgentSessionsHandlers({ getMainWindow: () => null });
			}
			vi.mocked(getLiveSessions).mockImplementation(() => [owner]);
			vi.mocked(getSshRemoteById).mockImplementation((id) =>
				id === remote.id ? remote : undefined
			);
			storage = {
				listSessions: vi.fn().mockResolvedValue([]),
				listSessionsPaginated: vi
					.fn()
					.mockResolvedValue({ sessions: [], totalCount: 0, hasMore: false, nextCursor: null }),
				readSessionMessages: vi.fn().mockResolvedValue({ messages: [], total: 0, hasMore: false }),
				searchSessions: vi.fn().mockResolvedValue([]),
				getSessionPath: vi.fn().mockReturnValue(null),
			};
			vi.mocked(agentSessionStorage.getSessionStorage).mockReturnValue(
				storage as unknown as agentSessionStorage.AgentSessionStorage
			);
		});

		afterEach(() => {
			for (const mirror of Object.values(mirrors)) expect(mirror).not.toHaveBeenCalled();
		});

		it.each([false, true])(
			'keeps colliding native IDs in their selected accounts/hosts (SSH=%s)',
			async (ssh) => {
				const owners = ['a', 'b'].map((suffix) => ({
					...owner,
					id: `owner-${suffix}`,
					customEnvVars: { GROK_HOME: ssh ? `~/Grok ${suffix}/账户` : path.join(home, suffix) },
					sessionSshRemoteConfig: ssh ? { enabled: true, remoteId: `remote-${suffix}` } : undefined,
				}));
				vi.mocked(getLiveSessions).mockReturnValue(owners);
				vi.mocked(getSshRemoteById).mockImplementation((id) => ({
					...remote,
					id,
					host: `${id}.invalid`,
				}));
				for (const selected of owners) {
					const configDir = selected.customEnvVars.GROK_HOME;
					const id = selected.sessionSshRemoteConfig?.remoteId;
					const target = id ? { ...remote, id, host: `${id}.invalid` } : undefined;
					const row = { sessionId: 'native-collision', firstMessage: selected.id };
					const result =
						api === 'listPaginated'
							? { sessions: [row], totalCount: 2, hasMore: true, nextCursor: 'next' }
							: api === 'read'
								? {
										messages: [{ type: 'user', content: selected.id }],
										total: 3,
										hasMore: true,
										source: { provider: 'grok', status: 'partial', reason: 'inconsistent' },
									}
								: api === 'getPath'
									? `${configDir}/native-collision`
									: [row];
					storage[method].mockReturnValueOnce(result);
					if (api === 'read' && target) {
						expect(await invoke(selected.id, target.id)).toMatchObject({
							messages: [],
							nativeSessionBinding: { state: 'unknown' },
							source: { status: 'unavailable', reason: 'history-remote-endpoint-unqualified' },
						});
						storage[method].mockReset();
						continue;
					}
					expect(await invoke(selected.id, target?.id)).toEqual(
						api === 'read'
							? {
									...(result as object),
									nativeSessionBinding: { version: 1, state: 'unknown', reason: 'unobserved' },
								}
							: result
					);
					expect(storage[method]).toHaveBeenLastCalledWith(
						'/project',
						...args,
						...(options ? [expectedOptions(configDir, !!target), target] : [target, configDir])
					);
				}
				expect(storage[method]).toHaveBeenCalledTimes(api === 'read' && ssh ? 0 : 2);
			}
		);

		it.each([
			['agent wins', { GROK_HOME: '~/agent' }, '~/provider', '~/global', 'agent'],
			['provider beats global/process', undefined, '~/provider', '~/global', 'provider'],
			[
				'session map replaces provider',
				{ UNRELATED: 'fixture' },
				'~/provider',
				'~/global',
				'global',
			],
			['global beats process', undefined, undefined, '~/global', 'global'],
			['process fallback', undefined, undefined, undefined, 'process-account'],
			['agent blank unsets lower layers', { GROK_HOME: ' \t' }, '~/provider', '~/global', '.grok'],
			['provider blank unsets lower layers', undefined, '', '~/global', '.grok'],
			['global blank unsets process', undefined, undefined, '\t', '.grok'],
		] as const)('%s', async (_label, custom, provider, global, expected) => {
			owner.customEnvVars = custom;
			if (provider !== undefined) accountStores.provider.GROK_HOME = provider;
			if (global !== undefined) accountStores.global.GROK_HOME = global;
			await invoke();
			const configDir = path.join(home, expected);
			expectScope(configDir);
		});

		it.each([undefined, ' \t', '~/custom remote'])(
			'keeps remote home %j independent of local env',
			async (custom) => {
				owner.customEnvVars = custom === undefined ? {} : { GROK_HOME: custom };
				owner.sessionSshRemoteConfig = { enabled: true, remoteId: remote.id };
				accountStores.global.GROK_HOME = '~/local-global';
				const result = await invoke();
				const configDir = custom?.trim() || undefined;
				if (api === 'read')
					expect(result).toMatchObject({
						source: {
							status: 'unavailable',
							reason: configDir
								? 'history-remote-endpoint-unqualified'
								: 'history-remote-account-environment-unresolved',
						},
					});
				expectScope(configDir, remote);
			}
		);

		it('does not retry another account when the selected root has no history', async () => {
			const configDir = path.join(home, 'absent-account');
			owner.customEnvVars = { GROK_HOME: configDir };
			const result = await invoke();
			expect(result).toEqual(
				api === 'getPath'
					? null
					: api === 'read'
						? {
								messages: [],
								total: 0,
								hasMore: false,
								nativeSessionBinding: { version: 1, state: 'unknown', reason: 'unobserved' },
							}
						: api === 'listPaginated'
							? { sessions: [], totalCount: 0, hasMore: false, nextCursor: null }
							: []
			);
			expectScope(configDir);
		});

		it.each([
			['missing owner', { id: 'other-owner' }, undefined, /owner is unavailable/],
			['wrong provider', { toolType: 'codex' }, undefined, /different provider/],
			['missing', { enabled: true, remoteId: 'missing' }, undefined, /remote-not-found/],
			['disabled', { enabled: true, remoteId: 'remote-a' }, undefined, /remote-disabled/],
			['unselected', { enabled: true }, undefined, /no-remote-selected/],
			['conflicting', { enabled: true, remoteId: 'remote-a' }, 'other', /does not match/],
			['remote for local owner', {}, 'remote-a', /does not match/],
		] as const)(
			'refuses %s scope before storage or mirrors',
			async (label, patch, requested, error) => {
				if ('enabled' in patch) owner.sessionSshRemoteConfig = patch;
				else Object.assign(owner, patch);
				if (label === 'disabled')
					vi.mocked(getSshRemoteById).mockReturnValue({ ...remote, enabled: false });
				await expect(invoke('owner', requested)).rejects.toThrow(error);
				for (const call of Object.values(storage)) expect(call).not.toHaveBeenCalled();
			}
		);

		it.each([false, 0, '', [], {}, { enabled: 'true' }, { enabled: 0 }])(
			'refuses malformed saved SSH config %j',
			async (config) => {
				Object.assign(owner, { sessionSshRemoteConfig: config, sshRemoteId: 'remote-a' });
				await expect(invoke()).rejects.toThrow(/invalid SSH configuration/);
				for (const call of Object.values(storage)) expect(call).not.toHaveBeenCalled();
			}
		);

		it.each([false, 0, '', ' ', 42])(
			'refuses malformed/unselected saved remote ID %j',
			async (remoteId) => {
				Object.assign(owner, { sessionSshRemoteConfig: { enabled: true, remoteId } });
				await expect(invoke()).rejects.toThrow(/History SSH target unavailable/);
				for (const call of Object.values(storage)) expect(call).not.toHaveBeenCalled();
			}
		);

		it.each([null, false, 0, '', ' \t', 'bad\0id'])(
			'refuses malformed requested owner/remote %j',
			async (id) => {
				await expect(invoke(id)).rejects.toThrow(/Invalid history ownerAgentId/);
				await expect(invoke('owner', id)).rejects.toThrow(/Invalid history sshRemoteId/);
				for (const call of Object.values(storage)) expect(call).not.toHaveBeenCalled();
			}
		);

		it.each(['legacy', 'configured', 'disabled'] as const)(
			'resolves %s SSH selection ahead of the observed ID',
			async (mode) => {
				owner.sshRemoteId = mode === 'legacy' ? 'remote-a' : 'stale-remote';
				owner.sessionSshRemoteConfig =
					mode === 'legacy' ? undefined : { enabled: mode === 'configured', remoteId: 'remote-a' };
				await invoke();
				const target = mode === 'disabled' ? undefined : remote;
				const configDir = target ? undefined : path.join(home, 'process-account');
				expectScope(configDir, target);
			}
		);
	});

	describe('Grok read provenance and explicit scope', () => {
		it.each([undefined, '', ' ', '/selected-account'])(
			'forwards explicit configDir %j and unavailable evidence without restoration',
			async (configDir) => {
				const result: agentSessionStorage.SessionMessagesResult = {
					messages: [],
					total: 0,
					hasMore: false,
					source: { provider: 'grok', status: 'unavailable', reason: 'missing' },
				};
				const storage = { readSessionMessages: vi.fn().mockResolvedValue(result) };
				vi.mocked(agentSessionStorage.getSessionStorage).mockReturnValue(
					storage as unknown as agentSessionStorage.AgentSessionStorage
				);
				const options = { offset: 0, limit: 7, includeNativeRecords: true, configDir };
				expect(
					await handlers.get('agentSessions:read')!({}, 'grok', '/project', 'native', options)
				).toEqual({
					...result,
					nativeSessionBinding: { version: 1, state: 'unknown', reason: 'legacy' },
				});
				expect(storage.readSessionMessages).toHaveBeenCalledExactlyOnceWith(
					'/project',
					'native',
					options,
					undefined
				);
				expect(mirrors.restoreStarredTranscript).not.toHaveBeenCalled();
			}
		);

		it.each([
			['owner', '/override', /cannot override/],
			['owner', '', /cannot override/],
			['owner', ' ', /cannot override/],
			[undefined, null, /Invalid history account directory/],
			[undefined, false, /Invalid history account directory/],
			[undefined, 0, /Invalid history account directory/],
			[undefined, 'bad\0path', /Invalid history account directory/],
		] as const)('rejects owner %j with account %j', async (ownerAgentId, configDir, error) => {
			vi.mocked(getLiveSessions).mockReturnValue([
				{ ...createMockSession({ id: 'owner', toolType: 'grok' }) },
			]);
			const storage = { readSessionMessages: vi.fn() };
			vi.mocked(agentSessionStorage.getSessionStorage).mockReturnValue(
				storage as unknown as agentSessionStorage.AgentSessionStorage
			);
			await expect(
				handlers.get('agentSessions:read')!({}, 'grok', '/project', 'native', {
					ownerAgentId,
					configDir,
				})
			).rejects.toThrow(error);
			expect(storage.readSessionMessages).not.toHaveBeenCalled();
			expect(mirrors.restoreStarredTranscript).not.toHaveBeenCalled();
		});
	});

	// Local only: an SSH receipt needs an enterprise endpoint qualifier the port does not have
	// (the unbound SSH read is covered in 'Grok history scope').
	describe.each([false])('Grok observed history receipt (SSH=%s)', (ssh) => {
		const root = path.resolve('tmp/grok-history-ipc');
		const cwd = ssh ? '/physical/work 账户' : path.join(root, 'physical-work');
		const account = ssh ? '/physical/account 账户' : path.join(root, 'physical-account');
		const selected = ssh ? "~/account's 账户" : path.join(root, 'account-alias');
		const project = ssh ? '~/work alias' : path.join(root, 'work-alias');
		const remote = {
			id: 'remote-a',
			name: 'A',
			host: 'a.invalid',
			port: 22,
			username: 'fixture',
			privateKeyPath: '',
			enabled: true,
		};
		let owner: ReturnType<typeof getLiveSessions>[number];
		let binding: Extract<NativeSessionBinding, { state: 'bound' }>;
		let result: agentSessionStorage.SessionMessagesResult;
		let read: ReturnType<typeof vi.fn>;
		const invoke = (nativeSessionBinding?: unknown) =>
			handlers.get('agentSessions:read')!({}, 'grok', project, 'native-collision', {
				ownerAgentId: 'owner',
				offset: 2,
				limit: 3,
				includeNativeRecords: true,
				nativeSessionBinding,
			});

		beforeEach(() => {
			vi.spyOn(os, 'homedir').mockReturnValue(root);
			vi.spyOn(os, 'hostname').mockReturnValue('fixture-host');
			vi.stubEnv('GROK_HOME', path.join(root, 'unselected-process-account'));
			owner = {
				...createMockSession({
					id: 'owner',
					toolType: 'grok',
					cwd: project,
					projectRoot: project,
					customEnvVars: { GROK_HOME: selected },
				}),
				sessionSshRemoteConfig: ssh ? { enabled: true, remoteId: remote.id } : undefined,
			};
			vi.mocked(getLiveSessions).mockImplementation(() => [owner]);
			vi.mocked(getSshRemoteById).mockReturnValue(remote);
			vi.spyOn(realFs, 'realpath').mockImplementation(async (value) => {
				if (ssh) throw new Error('Remote history touched local filesystem');
				if (value === selected) return account;
				if (value === project) return cwd;
				throw new Error('Unexpected local path');
			});
			vi.mocked(observePathRemote).mockImplementation(async (value) => ({
				success: true,
				data: {
					canonicalPath: value === selected ? account : cwd,
					device: '1',
					inode: value === selected ? '2' : '3',
					kind: 'directory',
				},
			}));
			registerAgentSessionsHandlers({ getMainWindow: () => null });
			binding = {
				version: 1,
				state: 'bound',
				provider: 'grok',
				nativeSessionId: 'native-collision',
				cwd,
				accountRef: nativeAccountRef('grok', account),
				host: {
					kind: ssh ? 'ssh' : 'local',
					identity: ssh
						? 'remote-installation'
						: grokInstallationId({
								hostname: 'fixture-host',
								productionDataDir: path.join(root, 'data'),
							}),
				},
			};
			result = {
				messages: [
					{ type: 'user', content: 'fixture', uuid: '1', timestamp: '2026-10-31T00:00:00Z' },
				],
				total: 6,
				hasMore: true,
				source: { provider: 'grok', status: 'available' },
				nativeSessionBinding: structuredClone(binding),
			};
			read = vi.fn().mockImplementation(async () => result);
			vi.mocked(agentSessionStorage.getSessionStorage).mockReturnValue({
				readSessionMessages: read,
			} as unknown as agentSessionStorage.AgentSessionStorage);
		});

		afterEach(() => {
			for (const mirror of Object.values(mirrors)) expect(mirror).not.toHaveBeenCalled();
			if (ssh) expect(realFs.realpath).not.toHaveBeenCalled();
			else {
				expect(observePathRemote).not.toHaveBeenCalled();
			}
		});

		it.each([false, true])(
			'returns independently confirmed canonical scope (retained=%s)',
			async (retained) => {
				expect(await invoke(retained ? binding : undefined)).toEqual(result);
				expect(read).toHaveBeenCalledExactlyOnceWith(
					cwd,
					'native-collision',
					{
						offset: 2,
						limit: 3,
						includeNativeRecords: true,
						configDir: account,
						nativeSessionBinding: binding,
					},
					ssh ? remote : undefined
				);
				expect(read.mock.calls[0][2].nativeSessionBinding).not.toBe(binding);
			}
		);

		it.each([
			'provider',
			'nativeSessionId',
			'accountRef',
			'cwd',
			'host identity',
			'host kind',
			'missing account',
			'extra field',
		])(
			'rejects colliding %s in retained scope before storage and in adapter receipts after storage',
			async (field) => {
				const mismatch = {
					...binding,
					...(field === 'host identity'
						? { host: { ...binding.host, identity: 'other-installation' } }
						: field === 'host kind'
							? { host: { ...binding.host, kind: ssh ? 'local' : 'ssh' } }
							: field === 'missing account'
								? { accountRef: undefined }
								: { [field]: 'other' }),
				} as NativeSessionBinding;
				await expect(invoke(mismatch)).rejects.toThrow(/ownership/);
				expect(read).not.toHaveBeenCalled();
				result.nativeSessionBinding = mismatch;
				await expect(invoke(binding)).rejects.toThrow(/native transcript does not match/);
				expect(read).toHaveBeenCalledTimes(1);
			}
		);

		it.each([
			null,
			{},
			false,
			{ version: 2, state: 'bound' },
			{ version: 1, state: 'unknown', reason: 'legacy' },
		])('refuses malformed/unknown retained ownership %j before observation', async (retained) => {
			await expect(invoke(retained)).rejects.toThrow(/ownership is unknown/);
			expect(read).not.toHaveBeenCalled();
			expect(realFs.realpath).not.toHaveBeenCalled();
			expect(observePathRemote).not.toHaveBeenCalled();
		});

		it.each(['available', 'partial', 'unavailable'] as const)(
			'preserves %s provenance independently of receipt presence',
			async (status) => {
				result.source = {
					provider: 'grok',
					status,
					...(status === 'available' ? {} : { reason: 'fixture-source-loss' }),
				};
				for (const receipt of [
					binding,
					undefined,
					{ version: 1, state: 'unknown', reason: 'legacy' } as const,
				]) {
					result.nativeSessionBinding = receipt;
					expect(await invoke(binding)).toEqual({
						...result,
						nativeSessionBinding:
							receipt === binding
								? binding
								: { version: 1, state: 'unknown', reason: 'unobserved' },
					});
				}
			}
		);

		it.each([
			'owner removed',
			'provider',
			'cwd',
			'environment',
			'provider account',
			'global account',
			'path replacement',
			'installation',
		])('rejects %s changes while adapter read is pending', async (change) => {
			read.mockImplementationOnce(async () => {
				if (change === 'owner removed') vi.mocked(getLiveSessions).mockReturnValue([]);
				if (change === 'provider') owner.toolType = 'codex';
				if (change === 'cwd') owner.cwd = `${project}-other`;
				if (change === 'environment') owner.customEnvVars = { GROK_HOME: `${selected}-other` };
				if (change === 'provider account' || change === 'global account') {
					owner.customEnvVars = undefined;
					accountStores[change === 'provider account' ? 'provider' : 'global'].GROK_HOME =
						`${selected}-other`;
				}
				if (change === 'path replacement') {
					if (ssh)
						vi.mocked(observePathRemote).mockImplementation(async (value) => ({
							success: true,
							data: {
								canonicalPath: value === selected ? account : cwd,
								device: '1',
								inode: 'replacement',
								kind: 'directory',
							},
						}));
					else vi.mocked(realFs.realpath).mockResolvedValue(`${cwd}-replacement`);
				}
				if (change === 'installation') vi.mocked(os.hostname).mockReturnValue('replacement');
				return result;
			});
			await expect(invoke(binding)).rejects.toThrow(/owner|changed/);
			expect(read).toHaveBeenCalledTimes(1);
		});

		it('rechecks owner selection after path observation before content I/O', async () => {
			if (ssh)
				vi.mocked(observePathRemote).mockImplementationOnce(async () => {
					owner.customArgs = '--changed';
					return {
						success: true,
						data: { canonicalPath: cwd, device: '1', inode: '3', kind: 'directory' },
					};
				});
			else
				vi.mocked(realFs.realpath).mockImplementationOnce(async () => {
					owner.customArgs = '--changed';
					return cwd;
				});
			await expect(invoke(binding)).rejects.toThrow(/settings changed/);
			expect(read).not.toHaveBeenCalled();
		});

		it('does not let an adapter mutate the captured binding to authorize another account', async () => {
			read.mockImplementationOnce(async (_cwd, _id, options) => {
				options.nativeSessionBinding.accountRef = 'other-account';
				return { ...result, nativeSessionBinding: options.nativeSessionBinding };
			});
			await expect(invoke(binding)).rejects.toThrow(/native transcript does not match/);
			expect(binding.accountRef).not.toBe('other-account');
		});

		it('returns unavailable ownership when physical roots cannot be observed', async () => {
			if (ssh)
				vi.mocked(observePathRemote).mockResolvedValue({
					success: false,
					errorCode: 'identity-unavailable',
					error: 'missing',
				});
			else
				vi.mocked(realFs.realpath).mockRejectedValue(
					Object.assign(new Error('missing'), { code: 'ENOENT' })
				);
			expect(await invoke(binding)).toMatchObject({
				messages: [],
				total: 0,
				hasMore: false,
				nativeSessionBinding: { state: 'unknown' },
				source: { status: 'unavailable' },
			});
			expect(read).not.toHaveBeenCalled();
		});

		it.each(
			ssh
				? ([
						['global', 'HOME'],
						['provider', 'HOME'],
						['remote', 'HOME'],
						['global', 'GROK_HOME'],
						['provider', 'GROK_HOME'],
						['remote', 'GROK_HOME'],
					] as const)
				: ([
						['global', 'GROK_HOME'],
						['provider', 'GROK_HOME'],
					] as const)
		)('rejects %s %s changes without changing the owner', async (layer, key) => {
			owner.customEnvVars = undefined;
			const remoteEnv: Record<string, string> = {};
			vi.mocked(getSshRemoteById).mockReturnValue({ ...remote, remoteEnv });
			const vars = layer === 'remote' ? remoteEnv : accountStores[layer];
			if (key === 'HOME') accountStores.provider.GROK_HOME = selected;
			else if (!ssh || layer === 'provider') vars.GROK_HOME = selected;
			else {
				// Global/SSH roots are not resolved by the selected-account resolver.
				// Start from a provable login default, then introduce the override.
				const observe = vi.mocked(observePathRemote).getMockImplementation()!;
				vi.mocked(observePathRemote).mockImplementation((value, config) =>
					observe(value === '~/.grok' ? selected : value, config)
				);
			}
			const originalOwner = structuredClone(owner);
			read.mockImplementationOnce(async () => {
				vars[key] = ssh ? '/changed-account-or-home' : path.join(root, 'changed-account');
				return result;
			});
			await expect(invoke(binding)).rejects.toThrow(/settings changed/);
			expect(read).toHaveBeenCalledTimes(1);
			expect(read.mock.calls[0][2].configDir).toBe(account);
			expect(owner).toEqual(originalOwner);
		});

		it.each([{}, { GROK_HOME: 'selected' }])(
			'keeps replaced provider environment inert with session map %j',
			async (sessionEnv) => {
				owner.customEnvVars = sessionEnv.GROK_HOME ? { GROK_HOME: selected } : {};
				accountStores.provider = { GROK_HOME: 'unselected-provider', HOME: '/unselected-home' };
				accountStores.global.GROK_HOME = selected;
				if (ssh && !sessionEnv.GROK_HOME) {
					accountStores.global = {};
					const observe = vi.mocked(observePathRemote).getMockImplementation()!;
					vi.mocked(observePathRemote).mockImplementation((value, config) =>
						observe(value === '~/.grok' ? selected : value, config)
					);
				}
				const originalOwner = structuredClone(owner);
				read.mockImplementationOnce(async () => {
					accountStores.provider = { GROK_HOME: 'another-provider', HOME: '/another-home' };
					return result;
				});
				expect(await invoke(binding)).toEqual(result);
				expect(read).toHaveBeenCalledTimes(1);
				expect(read.mock.calls[0][2].configDir).toBe(account);
				expect(owner).toEqual(originalOwner);
			}
		);

		it('downgrades an unowned adapter receipt and refuses ownerless retained scope', async () => {
			const options = { configDir: selected, offset: 2, limit: 3 };
			expect(
				await handlers.get('agentSessions:read')!(
					{},
					'grok',
					project,
					'native-collision',
					options,
					ssh ? remote.id : undefined
				)
			).toEqual({
				...result,
				nativeSessionBinding: { version: 1, state: 'unknown', reason: 'legacy' },
			});
			expect(result.nativeSessionBinding).toEqual(binding);
			expect(read).toHaveBeenCalledExactlyOnceWith(
				project,
				'native-collision',
				options,
				ssh ? remote : undefined
			);
			read.mockClear();
			await expect(
				handlers.get('agentSessions:read')!(
					{},
					'grok',
					project,
					'native-collision',
					{ ...options, nativeSessionBinding: binding },
					ssh ? remote.id : undefined
				)
			).rejects.toThrow(/ownership is unknown/);
			expect(read).not.toHaveBeenCalled();
			expect(realFs.realpath).not.toHaveBeenCalled();
			expect(observePathRemote).not.toHaveBeenCalled();
		});

		it.each(['owner', 'global environment'])(
			'rejects %s changes during the final path observation with identical physical roots',
			async (change) => {
				if (change === 'global environment') {
					owner.customEnvVars = undefined;
					accountStores[ssh ? 'provider' : 'global'].GROK_HOME = selected;
				}
				const originalOwner = structuredClone(owner);
				read.mockImplementationOnce(async () => {
					const mutate = () => {
						if (change === 'owner') owner.customArgs = '--changed-during-final-observation';
						else accountStores.global[ssh ? 'HOME' : 'GROK_HOME'] = '/changed';
					};
					if (ssh) {
						const observe = vi.mocked(observePathRemote).getMockImplementation()!;
						vi.mocked(observePathRemote).mockImplementationOnce(async (value, config) => {
							mutate();
							return observe(value, config);
						});
					} else {
						vi.mocked(realFs.realpath).mockImplementationOnce(async () => {
							mutate();
							return cwd;
						});
					}
					return result;
				});
				await expect(invoke(binding)).rejects.toThrow(/settings changed/);
				expect(read).toHaveBeenCalledTimes(1);
				expect(ssh ? observePathRemote : realFs.realpath).toHaveBeenCalledTimes(6);
				if (change === 'global environment') expect(owner).toEqual(originalOwner);
			}
		);

		if (!ssh) {
			it.each(['global', 'provider'] as const)(
				'keeps an explicit local account stable across %s HOME changes',
				async (layer) => {
					owner.customEnvVars = undefined;
					accountStores.provider.GROK_HOME = selected;
					accountStores[layer].HOME = path.join(root, 'initial-home');
					const originalOwner = structuredClone(owner);
					read.mockImplementationOnce(async () => {
						accountStores[layer].HOME = path.join(root, 'changed-home');
						return result;
					});
					expect(await invoke(binding)).toEqual(result);
					expect(read).toHaveBeenCalledTimes(1);
					expect(owner).toEqual(originalOwner);
				}
			);

			it.each(['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR', 'EISDIR', 'EBUSY', 'EMFILE', 'EIO'])(
				'classifies local observer failure %s before native reads',
				async (code) => {
					const error = Object.assign(new Error(`observer failed: ${code}`), { code });
					vi.mocked(realFs.realpath).mockRejectedValue(error);
					if (code === 'EMFILE' || code === 'EIO') await expect(invoke()).rejects.toThrow(error);
					else
						expect(await invoke()).toEqual({
							messages: [],
							total: 0,
							hasMore: false,
							nativeSessionBinding: { version: 1, state: 'unknown', reason: 'unobserved' },
							source: {
								provider: 'grok',
								status: 'unavailable',
								reason: 'history-scope-unobserved',
							},
						});
					expect(read).not.toHaveBeenCalled();
				}
			);
		}
	});

	describe('agentSessions:deleteMessagePair', () => {
		it.each([
			{ ssh: false, state: 'idle' as const },
			{ ssh: false, state: 'busy' as const },
			{ ssh: true, state: 'idle' as const },
			{ ssh: true, state: 'busy' as const },
		])(
			'refuses unscoped Grok deletion before any adapter (SSH=$ssh, state=$state)',
			async ({ ssh, state }) => {
				const project = path.resolve('tmp/grok-history-ipc/project');
				const owners = ['a', 'b'].map((suffix) =>
					createMockSession({
						id: `owner-${suffix}`,
						toolType: 'grok',
						state,
						cwd: project,
						agentSessionId: 'collision',
						customEnvVars: { GROK_HOME: ssh ? `~/account-${suffix}` : path.join(project, suffix) },
						sessionSshRemoteConfig: ssh
							? { enabled: true, remoteId: `remote-${suffix}` }
							: undefined,
					})
				);
				vi.mocked(getLiveSessions).mockReturnValue(owners);
				const deleteMessagePair = vi.fn().mockRejectedValue(new Error('Native writer failed'));
				vi.mocked(agentSessionStorage.getSessionStorage).mockReturnValue({
					agentId: 'claude-code',
					deleteMessagePair,
				} as unknown as agentSessionStorage.AgentSessionStorage);
				const before = JSON.stringify(owners);
				const result = await handlers.get('agentSessions:deleteMessagePair')!(
					{},
					'grok',
					project,
					'collision',
					'message-1',
					'matching text in both accounts'
				);
				expect(result).toEqual({
					success: false,
					error: expect.stringMatching(
						/not supported.*account\/host.*verified transport.*History is unchanged/
					),
				});
				expect(JSON.stringify(owners)).toBe(before);
				expect(agentSessionStorage.getSessionStorage).not.toHaveBeenCalled();
				expect(deleteMessagePair).not.toHaveBeenCalled();
				expect(getLiveSessions).not.toHaveBeenCalled();
				expect(getSshRemoteById).not.toHaveBeenCalled();
				expect(observePathRemote).not.toHaveBeenCalled();
				for (const mirror of Object.values(mirrors)) expect(mirror).not.toHaveBeenCalled();
			}
		);

		it.each(['', '../other-account', '/absolute', 'id/child', 'bad\u0000id', '%2e%2e'])(
			'refuses empty or path-like Grok identity %j without a storage fallback',
			async (id) => {
				vi.mocked(agentSessionStorage.getSessionStorage).mockReturnValue(null);
				const result = await handlers.get('agentSessions:deleteMessagePair')!(
					{},
					'grok',
					'../outside',
					id,
					id,
					'fallback content'
				);
				expect(result).toEqual({
					success: false,
					error: expect.stringContaining('History is unchanged'),
				});
				expect(agentSessionStorage.getSessionStorage).not.toHaveBeenCalled();
				expect(logger.warn).not.toHaveBeenCalled();
			}
		);

		it('retains refusal across concurrent scope replacement and handler reload', async () => {
			accountStores.provider = { GROK_HOME: '/fixture/account-a' };
			const args = [{}, 'grok', '/fixture/project', 'collision', 'message-1'];
			const pending = handlers.get('agentSessions:deleteMessagePair')!(...args);
			// Replace the current owner under another account/host while the caller
			// awaits the result. Current state cannot authorize the old unscoped ID.
			accountStores.provider = { GROK_HOME: '/fixture/account-b' };
			vi.mocked(getLiveSessions).mockReturnValue([
				createMockSession({
					id: 'successor',
					toolType: 'grok',
					state: 'busy',
					agentSessionId: 'collision',
					sessionSshRemoteConfig: { enabled: true, remoteId: 'replacement-host' },
				}),
			]);
			registerAgentSessionsHandlers();
			const results = await Promise.all([
				pending,
				handlers.get('agentSessions:deleteMessagePair')!(...args),
			]);
			for (const result of results) {
				expect(result).toEqual({
					success: false,
					error: expect.stringContaining('History is unchanged'),
				});
			}
			expect(agentSessionStorage.getSessionStorage).not.toHaveBeenCalled();
			expect(getLiveSessions).not.toHaveBeenCalled();
			expect(getSshRemoteById).not.toHaveBeenCalled();
			expect(observePathRemote).not.toHaveBeenCalled();
		});

		it('should delete message pair from storage', async () => {
			const mockStorage = {
				agentId: 'claude-code',
				deleteMessagePair: vi.fn().mockResolvedValue({ success: true, linesRemoved: 3 }),
			};

			vi.mocked(agentSessionStorage.getSessionStorage).mockReturnValue(
				mockStorage as unknown as agentSessionStorage.AgentSessionStorage
			);

			const handler = handlers.get('agentSessions:deleteMessagePair');
			const result = await handler!(
				{} as any,
				'claude-code',
				'/test',
				'session-1',
				'uuid-123',
				'fallback content'
			);

			expect(mockStorage.deleteMessagePair).toHaveBeenCalledWith(
				'/test',
				'session-1',
				'uuid-123',
				'fallback content',
				undefined
			);
			expect(result).toEqual({ success: true, linesRemoved: 3 });
		});

		it('passes the resolved SSH remote through for a remote agent', async () => {
			const remote = { id: 'remote-1', enabled: true, host: 'pedbook' };
			vi.mocked(getSshRemoteById).mockReturnValueOnce(remote as any);
			const mockStorage = {
				agentId: 'claude-code',
				deleteMessagePair: vi.fn().mockResolvedValue({ success: true, linesRemoved: 2 }),
			};
			vi.mocked(agentSessionStorage.getSessionStorage).mockReturnValue(
				mockStorage as unknown as agentSessionStorage.AgentSessionStorage
			);

			const handler = handlers.get('agentSessions:deleteMessagePair');
			await handler!(
				{} as any,
				'claude-code',
				'/remote',
				'session-1',
				'uuid-1',
				'text',
				'remote-1'
			);

			expect(getSshRemoteById).toHaveBeenCalledWith('remote-1');
			expect(mockStorage.deleteMessagePair).toHaveBeenCalledWith(
				'/remote',
				'session-1',
				'uuid-1',
				'text',
				remote
			);
		});

		it("edits the owning agent's own account transcript (its CODEX_HOME)", async () => {
			vi.mocked(getLiveSessions).mockReturnValue([
				createMockSession({
					id: 'bench-lab',
					toolType: 'codex',
					cwd: '/project',
					projectRoot: '/project',
					customEnvVars: { CODEX_HOME: '/accounts/codex-gmail' },
				}),
			]);
			const mockStorage = {
				agentId: 'codex',
				deleteMessagePair: vi
					.fn()
					.mockResolvedValue({ success: true, linesRemoved: 0, notInTranscript: true }),
			};
			vi.mocked(agentSessionStorage.getSessionStorage).mockReturnValue(
				mockStorage as unknown as agentSessionStorage.AgentSessionStorage
			);

			const result = await handlers.get('agentSessions:deleteMessagePair')!(
				{} as any,
				'codex',
				'/project',
				'session-1',
				'log-1',
				'text',
				undefined,
				'bench-lab'
			);

			expect(mockStorage.deleteMessagePair).toHaveBeenCalledWith(
				'/project',
				'session-1',
				'log-1',
				'text',
				undefined,
				path.resolve('/accounts/codex-gmail')
			);
			expect(result).toEqual({ success: true, linesRemoved: 0, notInTranscript: true });
		});

		it('refuses an owned delete whose owner is gone or runs another provider', async () => {
			vi.mocked(getLiveSessions).mockReturnValue([
				createMockSession({ id: 'bench-lab', toolType: 'claude-code' }),
			]);
			const mockStorage = { agentId: 'codex', deleteMessagePair: vi.fn() };
			vi.mocked(agentSessionStorage.getSessionStorage).mockReturnValue(
				mockStorage as unknown as agentSessionStorage.AgentSessionStorage
			);

			await expect(
				handlers.get('agentSessions:deleteMessagePair')!(
					{} as any,
					'codex',
					'/project',
					'session-1',
					'log-1',
					'text',
					undefined,
					'bench-lab'
				)
			).rejects.toThrow(/History owner is unavailable/);
			expect(mockStorage.deleteMessagePair).not.toHaveBeenCalled();
		});

		it('refuses rather than editing a local file when the remote cannot be resolved', async () => {
			vi.mocked(getSshRemoteById).mockReturnValueOnce(undefined);
			const mockStorage = { agentId: 'claude-code', deleteMessagePair: vi.fn() };
			vi.mocked(agentSessionStorage.getSessionStorage).mockReturnValue(
				mockStorage as unknown as agentSessionStorage.AgentSessionStorage
			);

			const handler = handlers.get('agentSessions:deleteMessagePair');
			const result = await handler!(
				{} as any,
				'claude-code',
				'/remote',
				'session-1',
				'uuid-1',
				'text',
				'gone-remote'
			);

			expect(result).toEqual({
				success: false,
				error: 'SSH remote not found or disabled: gone-remote',
			});
			expect(mockStorage.deleteMessagePair).not.toHaveBeenCalled();
		});

		it('should return error when no storage available', async () => {
			vi.mocked(agentSessionStorage.getSessionStorage).mockReturnValue(null);

			const handler = handlers.get('agentSessions:deleteMessagePair');
			const result = await handler!({} as any, 'unknown-agent', '/test', 'session-1', 'uuid-123');

			expect(result).toEqual({
				success: false,
				error: 'No session storage available for agent: unknown-agent',
			});
		});
	});

	describe('agentSessions:hasStorage', () => {
		it('should return true when storage exists', async () => {
			vi.mocked(agentSessionStorage.hasSessionStorage).mockReturnValue(true);

			const handler = handlers.get('agentSessions:hasStorage');
			const result = await handler!({} as any, 'claude-code');

			expect(agentSessionStorage.hasSessionStorage).toHaveBeenCalledWith('claude-code');
			expect(result).toBe(true);
		});

		it('should return false when storage does not exist', async () => {
			vi.mocked(agentSessionStorage.hasSessionStorage).mockReturnValue(false);

			const handler = handlers.get('agentSessions:hasStorage');
			const result = await handler!({} as any, 'unknown-agent');

			expect(result).toBe(false);
		});
	});

	describe('agentSessions:getAvailableStorages', () => {
		it('should return list of available storage agent IDs', async () => {
			const mockStorages = [{ agentId: 'claude-code' }, { agentId: 'opencode' }];

			vi.mocked(agentSessionStorage.getAllSessionStorages).mockReturnValue(
				mockStorages as unknown as agentSessionStorage.AgentSessionStorage[]
			);

			const handler = handlers.get('agentSessions:getAvailableStorages');
			const result = await handler!({} as any);

			expect(result).toEqual(['claude-code', 'opencode']);
		});
	});
});

describe('isExpectedSessionReadError', () => {
	// The global-stats loops read provider transcripts that belong to the agent
	// CLI, not to us. Failures rooted in the user's filesystem must not reach
	// Sentry (MAESTRO-W9); a genuine parse fault still must.
	it('treats an unreadable transcript as expected (MAESTRO-W9)', () => {
		const error = Object.assign(
			new Error("EACCES: permission denied, open '/Users/x/.claude/projects/a/b.jsonl'"),
			{ code: 'EACCES' }
		);
		expect(isExpectedSessionReadError(error)).toBe(true);
	});

	it('treats a transcript deleted mid-scan as expected', () => {
		const error = Object.assign(new Error('ENOENT: no such file or directory'), {
			code: 'ENOENT',
		});
		expect(isExpectedSessionReadError(error)).toBe(true);
	});

	it.each(['EPERM', 'ENOTDIR', 'EISDIR', 'EBUSY'])('treats %s as expected', (code) => {
		expect(isExpectedSessionReadError(Object.assign(new Error(code), { code }))).toBe(true);
	});

	it('still reports errors that are not filesystem conditions', () => {
		expect(isExpectedSessionReadError(new Error('Unexpected token in JSON'))).toBe(false);
		expect(isExpectedSessionReadError(new RangeError('Invalid string length'))).toBe(false);
		expect(isExpectedSessionReadError(Object.assign(new Error('boom'), { code: 'EMFILE' }))).toBe(
			false
		);
	});

	it('handles non-Error throwables', () => {
		expect(isExpectedSessionReadError(undefined)).toBe(false);
		expect(isExpectedSessionReadError('EACCES')).toBe(false);
	});
});

describe('agentSessions:getGlobalStats discovery', () => {
	let home: string;
	let getGlobalStats: () => Promise<{
		totalSessions: number;
		totalMessages: number;
		totalSizeBytes: number;
		byProvider: Record<string, { sessions: number }>;
	}>;

	beforeEach(async () => {
		home = await realFs.mkdtemp(path.join(os.tmpdir(), 'maestro-global-stats-'));
		vi.spyOn(os, 'homedir').mockReturnValue(home);
		const handlers = new Map<string, (...args: any[]) => any>();
		vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => {
			handlers.set(channel, handler);
		});
		registerAgentSessionsHandlers();
		const handler = handlers.get('agentSessions:getGlobalStats')!;
		getGlobalStats = () => handler({});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await realFs.rm(home, { recursive: true, force: true });
	});

	it('counts every non-empty transcript across more files than the concurrency cap', async () => {
		const claudeTranscript = '{"type":"user"}\n{"type":"assistant"}\n';
		const projects = path.join(home, '.claude', 'projects');
		// 40 transcripts across two projects: more than either pool's cap, so
		// workers must pull past their first item for the count to come out right.
		for (const project of ['-Users-a', '-Users-b']) {
			await realFs.mkdir(path.join(projects, project), { recursive: true });
			for (let i = 0; i < 20; i++) {
				await realFs.writeFile(path.join(projects, project, `s${i}.jsonl`), claudeTranscript);
			}
		}
		// Skipped: an abandoned 0-byte session, a non-transcript, and a stray file
		// where a project directory is expected.
		await realFs.writeFile(path.join(projects, '-Users-a', 'empty.jsonl'), '');
		await realFs.writeFile(path.join(projects, '-Users-a', 'notes.txt'), 'x');
		await realFs.writeFile(path.join(projects, 'stray.jsonl'), claudeTranscript);

		const codexDay = path.join(home, '.codex', 'sessions', '2026', '10', '11');
		await realFs.mkdir(codexDay, { recursive: true });
		await realFs.writeFile(
			path.join(codexDay, 'rollout.jsonl'),
			'{"type":"response_item","payload":{"type":"message","role":"user"}}\n'
		);

		const stats = await getGlobalStats();

		expect(stats.byProvider['claude-code'].sessions).toBe(40);
		expect(stats.byProvider['codex'].sessions).toBe(1);
		expect(stats.totalSessions).toBe(41);
		expect(stats.totalMessages).toBe(81);
		expect(stats.totalSizeBytes).toBe(
			40 * claudeTranscript.length +
				'{"type":"response_item","payload":{"type":"message","role":"user"}}\n'.length
		);
	});

	it('upgrades a cache from an older Claude parser: re-parses live sessions, rescales archived ones', async () => {
		const projects = path.join(home, '.claude', 'projects', '-Users-a');
		await realFs.mkdir(projects, { recursive: true });
		// One API response written as two lines (one per content block), each
		// repeating the usage: 1M Sonnet input = $3 once deduplicated.
		const line = JSON.stringify({
			type: 'assistant',
			requestId: 'req_1',
			message: { id: 'msg_1', model: 'claude-sonnet-4-6', usage: { input_tokens: 1_000_000 } },
		});
		await realFs.writeFile(path.join(projects, 'live.jsonl'), `${line}\n${line}\n`);

		const cachedEntry = (inputTokens: number, costUsd: number, archived = false) => ({
			messages: 2,
			inputTokens,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheCreationTokens: 0,
			cachedInputTokens: 0,
			sizeBytes: 1,
			costUsd,
			// Newer than the file, so only the version can force the re-parse.
			fileMtimeMs: Date.now() + 60_000,
			archived,
		});
		vi.mocked(loadGlobalStatsCache).mockResolvedValueOnce({
			version: GLOBAL_STATS_CACHE_MIN_UPGRADABLE_VERSION,
			lastUpdated: 0,
			providers: {
				'claude-code': {
					sessions: {
						'-Users-a/live': cachedEntry(2_000_000, 6),
						'-Users-a/gone': cachedEntry(4_000_000, 12, true),
					},
				},
				codex: { sessions: {} },
			},
		});

		const stats = (await getGlobalStats()) as unknown as {
			totalCostUsd: number;
			totalInputTokens: number;
		};

		// Live re-parsed to $3; the fix halved it, so the archived $12 becomes $6.
		expect(stats.totalCostUsd).toBeCloseTo(9, 10);
		expect(stats.totalInputTokens).toBe(3_000_000);
		const saved = vi.mocked(saveGlobalStatsCache).mock.calls.at(-1)![0];
		expect(saved.version).toBe(GLOBAL_STATS_CACHE_VERSION);
	});

	it("prices a Claude session's subagent transcripts into the totals without counting them as sessions", async () => {
		const project = path.join(home, '.claude', 'projects', '-Users-a');
		const line = (id: string) =>
			JSON.stringify({
				type: 'assistant',
				requestId: `req_${id}`,
				message: { id, model: 'claude-sonnet-4-6', usage: { input_tokens: 1_000_000 } },
			});
		await realFs.mkdir(path.join(project, 's1', 'subagents'), { recursive: true });
		await realFs.writeFile(path.join(project, 's1.jsonl'), `${line('parent')}\n`);
		await realFs.writeFile(
			path.join(project, 's1', 'subagents', 'agent-x.jsonl'),
			`${line('child')}\n`
		);

		const stats = (await getGlobalStats()) as unknown as {
			totalSessions: number;
			totalInputTokens: number;
			totalCostUsd: number;
		};

		expect(stats.totalSessions).toBe(1);
		expect(stats.totalInputTokens).toBe(2_000_000);
		expect(stats.totalCostUsd).toBeCloseTo(6, 10);
	});

	it('resumes a part-done upgrade: skips upgraded entries and rescales archived ones once', async () => {
		const projects = path.join(home, '.claude', 'projects', '-Users-a');
		await realFs.mkdir(projects, { recursive: true });
		const line = JSON.stringify({
			type: 'assistant',
			requestId: 'req_1',
			message: { id: 'msg_1', model: 'claude-sonnet-4-6', usage: { input_tokens: 1_000_000 } },
		});
		await realFs.writeFile(path.join(projects, 'live.jsonl'), `${line}\n`);
		// Already upgraded by the killed run. Its content would parse to $3, so a
		// re-parse would show up in the total.
		await realFs.writeFile(path.join(projects, 'done.jsonl'), `${line}\n`);

		const cachedEntry = (inputTokens: number, costUsd: number, extra = {}) => ({
			messages: 1,
			inputTokens,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheCreationTokens: 0,
			cachedInputTokens: 0,
			sizeBytes: 1,
			costUsd,
			fileMtimeMs: Date.now() + 60_000,
			...extra,
		});
		vi.mocked(loadGlobalStatsCache).mockResolvedValueOnce({
			version: GLOBAL_STATS_CACHE_MIN_UPGRADABLE_VERSION,
			lastUpdated: 0,
			upgrade: {
				toVersion: GLOBAL_STATS_CACHE_VERSION,
				baseline: {
					costUsd: { oldSum: 4, newSum: 2 },
					inputTokens: { oldSum: 2_000_000, newSum: 1_000_000 },
				},
			},
			providers: {
				'claude-code': {
					sessions: {
						'-Users-a/live': cachedEntry(2_000_000, 6),
						'-Users-a/done': cachedEntry(5_000_000, 15, {
							derivedVersion: GLOBAL_STATS_CACHE_VERSION,
						}),
						'-Users-a/gone': cachedEntry(4_000_000, 12, { archived: true }),
					},
				},
				codex: { sessions: {} },
			},
		});

		const stats = (await getGlobalStats()) as unknown as {
			totalCostUsd: number;
			totalInputTokens: number;
		};

		// live $6 -> $3 (re-parsed), done $15 (kept), gone $12 scaled by both
		// runs' sums ($10 -> $5) to $6.
		expect(stats.totalCostUsd).toBeCloseTo(24, 10);
		expect(stats.totalInputTokens).toBe(8_000_000);
		const saved = vi.mocked(saveGlobalStatsCache).mock.calls.at(-1)![0];
		expect(saved.version).toBe(GLOBAL_STATS_CACHE_VERSION);
		expect(saved.upgrade).toBeUndefined();
		expect(saved.providers['claude-code'].sessions['-Users-a/gone'].derivedVersion).toBe(
			GLOBAL_STATS_CACHE_VERSION
		);
	});

	it('shares one scan between concurrent requests', async () => {
		vi.mocked(loadGlobalStatsCache).mockClear();
		const [first, second] = await Promise.all([getGlobalStats(), getGlobalStats()]);
		expect(vi.mocked(loadGlobalStatsCache)).toHaveBeenCalledTimes(1);
		expect(second).toEqual(first);
	});

	it('reports zero when neither provider has a transcript directory', async () => {
		const stats = await getGlobalStats();
		expect(stats.totalSessions).toBe(0);
	});
});

// Grok stored history through the registered getGlobalStats path,
// read by the real Grok storage over isolated temp account pools. GROK_HOME is
// blanked so discovery never reaches a production ~/.grok.
describe('agentSessions:getGlobalStats Grok history', () => {
	const CWD = '/work/alpha';
	const USD = 10_000_000_000; // costUsdTicks per dollar
	let home: string;
	let listSpy: MockInstance<GrokSessionStorage['listSessions']>;
	let getGlobalStats: () => Promise<any>;

	const transcript = [
		{ type: 'system', content: 'fixture system prompt' },
		{ type: 'user', content: [{ type: 'text', text: '<user_query>\nhello\n</user_query>' }] },
		{ type: 'assistant', content: 'hi' },
	]
		.map((record) => JSON.stringify(record))
		.join('\n');

	const usage = (session: Record<string, unknown>) =>
		// Ticks are written unquoted, as Grok does; the storage keeps them exact.
		JSON.stringify({ session }).replace(/"costUsdTicks":"(\d+)"/g, '"costUsdTicks":$1');

	const sessionDir = (account: string, id: string, cwd = CWD) =>
		path.join(home, account, 'sessions', encodeURIComponent(cwd), id);

	const writeSession = async (
		account: string,
		id: string,
		files: { usage?: string; transcript?: string; summary?: Record<string, unknown> } = {},
		cwd = CWD
	) => {
		const dir = sessionDir(account, id, cwd);
		await realFs.mkdir(dir, { recursive: true });
		await realFs.writeFile(
			path.join(dir, 'summary.json'),
			JSON.stringify({
				info: { id, cwd },
				created_at: '2026-10-01T00:00:00.000Z',
				updated_at: '2026-10-01T00:01:00.000Z',
				...files.summary,
			})
		);
		await realFs.writeFile(path.join(dir, 'chat_history.jsonl'), files.transcript ?? transcript);
		if (files.usage !== undefined)
			await realFs.writeFile(path.join(dir, 'usage.json'), files.usage);
	};

	const keyFor = async (account: string, id: string, cwd = CWD) =>
		qualifiedGlobalStatsSessionKey({
			accountScope: await realFs.realpath(path.join(home, account, 'sessions')),
			projectPath: cwd,
			nativeSessionId: id,
		});

	const lastSaved = (): GlobalStatsCache =>
		structuredClone(vi.mocked(saveGlobalStatsCache).mock.calls.at(-1)![0]);

	beforeEach(async () => {
		home = await realFs.mkdtemp(path.join(os.tmpdir(), 'maestro-grok-global-stats-'));
		vi.spyOn(os, 'homedir').mockReturnValue(home);
		vi.stubEnv('GROK_HOME', '');
		vi.mocked(saveGlobalStatsCache).mockClear();
		const storage = new GrokSessionStorage();
		listSpy = vi.spyOn(storage, 'listSessions');
		vi.mocked(agentSessionStorage.getSessionStorage).mockImplementation((id) =>
			id === 'grok' ? storage : null
		);
		const handlers = new Map<string, (...args: any[]) => any>();
		vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => {
			handlers.set(channel, handler);
		});
		registerAgentSessionsHandlers();
		const handler = handlers.get('agentSessions:getGlobalStats')!;
		getGlobalStats = () => handler({});
	});

	afterEach(async () => {
		vi.mocked(agentSessionStorage.getSessionStorage).mockReset();
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		await realFs.rm(home, { recursive: true, force: true });
	});

	it('keeps the same native ID in two account pools as two sessions under qualified keys', async () => {
		await writeSession('.grok', 'S1', {
			usage: usage({
				inputTokens: 100,
				outputTokens: 10,
				cachedReadTokens: 0,
				cacheCreationTokens: 0,
				costUsdTicks: String(2 * USD),
			}),
		});
		await writeSession('.grok-work', 'S1', {
			usage: usage({
				inputTokens: 40,
				outputTokens: 4,
				cachedReadTokens: 0,
				cacheCreationTokens: 0,
				costUsdTicks: String(USD / 2),
			}),
		});

		const stats = await getGlobalStats();

		expect(stats.byProvider.grok).toMatchObject({
			sessions: 2,
			messages: 4,
			inputTokens: 140,
			outputTokens: 14,
			hasCostData: true,
			// The storage cannot bind usage.json to the transcript: a floor, never complete.
			costCoverage: 'partial',
			costUsdTicks: String(2.5 * USD),
		});
		expect(stats.byProvider.grok.costUsd).toBeCloseTo(2.5, 10);
		expect(stats.totalCostUsd).toBeCloseTo(2.5, 10);
		expect(stats.costCoverage).toBe('partial');
		const saved = lastSaved().providers.grok.sessions;
		const keys = [await keyFor('.grok', 'S1'), await keyFor('.grok-work', 'S1')];
		expect(Object.keys(saved).sort()).toEqual([...keys].sort());
		expect(keys[0]).not.toBe(keys[1]);
		expect(saved[keys[1]]).toMatchObject({
			inputTokens: 40,
			usageSource: 'runtime-stream',
			identity: { projectPath: CWD, nativeSessionId: 'S1' },
		});
		// One read per account pool, through the registered storage with that account.
		expect(listSpy.mock.calls.map(([cwd, ssh, account]) => [cwd, ssh, account]).sort()).toEqual(
			[
				[CWD, undefined, path.join(home, '.grok')],
				[CWD, undefined, path.join(home, '.grok-work')],
			].sort()
		);
	});

	it('reports a missing ledger as unknown cost, never a measured or free zero', async () => {
		await writeSession('.grok', 'NOLEDGER');

		const stats = await getGlobalStats();

		expect(stats.byProvider.grok).toMatchObject({
			sessions: 1,
			inputTokens: 0,
			costUsd: 0,
			hasCostData: false,
			costCoverage: 'unknown',
		});
		expect(stats.byProvider.grok.costUsdTicks).toBeUndefined();
		expect(stats.hasCostData).toBe(false);
		expect(stats.costCoverage).toBe('unknown');
		const [entry] = Object.values(lastSaved().providers.grok.sessions);
		expect(entry.cost).toMatchObject({ status: 'unknown' });
		expect(entry.cost).not.toHaveProperty('costUsdTicks');
		expect(entry.costUsd).toBeUndefined();
		expect(entry.usageSource).toBe('none');
	});

	it('keeps an explicit zero cost as evidence, partial beside an unknown one', async () => {
		await writeSession('.grok', 'ZERO', {
			usage: usage({
				inputTokens: 5,
				outputTokens: 1,
				cachedReadTokens: 0,
				cacheCreationTokens: 0,
				costUsdTicks: '0',
			}),
		});
		await writeSession('.grok', 'UNKNOWN', {
			usage: usage({
				inputTokens: 7,
				outputTokens: 2,
				cachedReadTokens: 0,
				cacheCreationTokens: 0,
			}),
		});

		const stats = await getGlobalStats();

		expect(stats.byProvider.grok).toMatchObject({
			sessions: 2,
			inputTokens: 12,
			costUsd: 0,
			hasCostData: true,
			costCoverage: 'partial',
			costUsdTicks: '0',
		});
		const saved = lastSaved().providers.grok.sessions;
		expect(saved[await keyFor('.grok', 'ZERO')].cost).toMatchObject({
			status: 'partial',
			costUsdTicks: '0',
		});
		expect(saved[await keyFor('.grok', 'UNKNOWN')].cost).toMatchObject({ status: 'unknown' });
	});

	it('skips empty or absent transcripts and keeps malformed or partial ledgers honest', async () => {
		// A 0-byte transcript sits alone in its folder: discovery must never hand it to the storage.
		await writeSession('.grok', 'EMPTY', { transcript: '' }, '/work/empty');
		await realFs.mkdir(sessionDir('.grok', 'NOTRANSCRIPT'), { recursive: true });
		await realFs.writeFile(path.join(sessionDir('.grok', 'NOTRANSCRIPT'), 'usage.json'), '{}');
		await writeSession('.grok', 'UNPROMPTED', {
			transcript: JSON.stringify({ type: 'system', content: 'fixture system prompt' }),
		});
		await writeSession('.grok', 'MALFORMED', { usage: '{"session":' });
		await writeSession('.grok', 'PARTIAL', { usage: usage({ inputTokens: 9, outputTokens: 2 }) });

		const stats = await getGlobalStats();

		expect(stats.byProvider.grok).toMatchObject({
			sessions: 2,
			messages: 4,
			hasCostData: false,
			costCoverage: 'unknown',
		});
		const saved = lastSaved().providers.grok.sessions;
		expect(Object.keys(saved).sort()).toEqual(
			[await keyFor('.grok', 'MALFORMED'), await keyFor('.grok', 'PARTIAL')].sort()
		);
		expect(saved[await keyFor('.grok', 'MALFORMED')]).toMatchObject({
			inputTokens: 0,
			cost: { status: 'unknown' },
			usageSource: 'none',
		});
		expect(saved[await keyFor('.grok', 'PARTIAL')]).toMatchObject({
			outputTokens: 2,
			usageCompleteness: 'partial',
			cost: { status: 'unknown' },
		});
		expect(listSpy.mock.calls.map(([cwd]) => cwd)).toEqual([CWD]);
	});

	it('reuses unchanged sessions from the reloaded cache and replaces a resumed cumulative ledger', async () => {
		const ledger = (input: number, ticks: number) =>
			usage({
				inputTokens: input,
				outputTokens: 10,
				cachedReadTokens: 0,
				cacheCreationTokens: 0,
				costUsdTicks: String(ticks),
			});
		await writeSession('.grok', 'RESUMED', { usage: ledger(100, USD) });
		await writeSession('.grok', 'STEADY', { usage: ledger(50, USD) });

		const first = await getGlobalStats();
		expect(first.byProvider.grok.inputTokens).toBe(150);

		// Reload, nothing changed: no storage read, the same totals.
		listSpy.mockClear();
		vi.mocked(loadGlobalStatsCache).mockResolvedValueOnce(lastSaved());
		const unchanged = await getGlobalStats();
		expect(listSpy).not.toHaveBeenCalled();
		expect(unchanged.byProvider.grok).toEqual(first.byProvider.grok);

		// A resume rewrites the same session's lifetime snapshot (250 includes the
		// first 100): the entry is replaced, never added to, and only its folder is read.
		const dir = sessionDir('.grok', 'RESUMED');
		await realFs.writeFile(path.join(dir, 'usage.json'), ledger(250, 3 * USD));
		const later = new Date(Date.now() + 120_000);
		await realFs.utimes(path.join(dir, 'usage.json'), later, later);
		vi.mocked(loadGlobalStatsCache).mockResolvedValueOnce(lastSaved());
		const resumed = await getGlobalStats();

		expect(listSpy).toHaveBeenCalledTimes(1);
		expect(resumed.byProvider.grok).toMatchObject({
			sessions: 2,
			inputTokens: 300,
			outputTokens: 20,
			costUsdTicks: String(4 * USD),
		});
		expect(resumed.byProvider.grok.costUsd).toBeCloseTo(4, 10);
	});

	it('archives a deleted session from the reloaded cache and still counts its lifetime usage', async () => {
		const ledger = usage({
			inputTokens: 30,
			outputTokens: 3,
			cachedReadTokens: 0,
			cacheCreationTokens: 0,
			costUsdTicks: String(USD),
		});
		await writeSession('.grok', 'KEPT', { usage: ledger });
		await writeSession('.grok-work', 'GONE', { usage: ledger });
		await getGlobalStats();

		await realFs.rm(sessionDir('.grok-work', 'GONE'), { recursive: true, force: true });
		listSpy.mockClear();
		vi.mocked(loadGlobalStatsCache).mockResolvedValueOnce(lastSaved());
		const stats = await getGlobalStats();

		expect(listSpy).not.toHaveBeenCalled();
		expect(stats.byProvider.grok).toMatchObject({ sessions: 2, inputTokens: 60 });
		expect(stats.byProvider.grok.costUsd).toBeCloseTo(2, 10);
		const saved = lastSaved().providers.grok.sessions;
		expect(saved[await keyFor('.grok-work', 'GONE')].archived).toBe(true);
		expect(saved[await keyFor('.grok', 'KEPT')].archived).toBe(false);
	});
});

describe('agentSessions:setSessionPins', () => {
	type Data = { origins: Record<string, unknown> };
	/** A tiny in-memory stand-in for electron-store's get/set. */
	function fakeStore(initial: Data) {
		let state: Data = initial;
		return {
			get: (key: keyof Data, fallback: unknown) => state[key] ?? fallback,
			set: (key: keyof Data, value: Data['origins']) => {
				state = { ...state, [key]: value };
			},
			read: () => state,
		};
	}

	const pin = {
		id: 'pin-1',
		logId: 'log-1',
		source: 'stdout',
		timestamp: 100,
		title: 'A reply',
		excerpt: 'A reply',
		pinnedAt: 200,
	};

	let handlers: Map<string, Function>;
	let claudeStore: ReturnType<typeof fakeStore>;
	let genericStore: ReturnType<typeof fakeStore>;

	beforeEach(() => {
		vi.clearAllMocks();
		handlers = new Map();
		vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => {
			handlers.set(channel, handler);
		});
		claudeStore = fakeStore({ origins: { '/p': { 's-1': 'user' } } });
		genericStore = fakeStore({
			origins: { opencode: { '/p': { 's-2': { sessionName: 'Named' } } } },
		});
		registerAgentSessionsHandlers({
			getMainWindow: () => null,
			agentSessionOriginsStore: genericStore as never,
			claudeSessionOriginsStore: claudeStore as never,
		});
	});

	it('writes Claude Code and Codex pins to the Claude origins store, where resume reads them', async () => {
		await handlers.get('agentSessions:setSessionPins')!({}, 'codex', '/p', 's-1', [pin]);
		expect(claudeStore.read().origins).toEqual({
			'/p': { 's-1': { origin: 'user', pinnedMessages: [pin] } },
		});
	});

	it('writes other providers to the generic store and keeps the record fields it does not own', async () => {
		await handlers.get('agentSessions:setSessionPins')!({}, 'opencode', '/p', 's-2', [pin]);
		expect(genericStore.read().origins).toEqual({
			opencode: { '/p': { 's-2': { sessionName: 'Named', pinnedMessages: [pin] } } },
		});
	});

	it('drops malformed pins and clears the field when no pins are left', async () => {
		const handler = handlers.get('agentSessions:setSessionPins')!;
		await handler({}, 'opencode', '/p', 's-2', [pin, { id: 'broken' }]);
		expect(genericStore.read().origins).toEqual({
			opencode: { '/p': { 's-2': { sessionName: 'Named', pinnedMessages: [pin] } } },
		});

		await handler({}, 'opencode', '/p', 's-2', []);
		expect(genericStore.read().origins).toEqual({
			opencode: { '/p': { 's-2': { sessionName: 'Named' } } },
		});

		// A Claude record that only held pins falls back to its compact form.
		await handler({}, 'claude-code', '/p', 's-1', [pin]);
		await handler({}, 'claude-code', '/p', 's-1', []);
		expect(claudeStore.read().origins).toEqual({ '/p': { 's-1': 'user' } });
	});
});
