import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as net from 'node:net';
import type { AgentRun } from '../../../shared/agent-run';
import type { DesktopSessionsSnapshot } from '../../../shared/desktopTabs';

const host = vi.hoisted(() => ({
	directory: '',
	sessions: [] as Array<{
		id: string;
		name: string;
		cwd: string;
		toolType: string;
		activeTabId: string;
		aiTabs: Array<{ id: string; createdAt: number; logs: unknown[] }>;
	}>,
	readSessions: vi.fn(),
}));
vi.mock('electron', () => ({
	app: { getPath: () => host.directory },
	BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../../../main/stores', () => ({
	getSessionsStore: () => ({ get: host.readSessions }),
	getSettingsStore: () => ({ get: () => ({ pianola: true }) }),
}));
vi.mock('../../../main/web-server/handlers/bridgeHandlers', () => ({
	broadcastBridgeEvent: vi.fn(),
}));
vi.mock('../../../main/utils/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
	initPermissionRelay,
	resolvePermissionResponse,
} from '../../../main/permission-relay/integration';
import { permissionRelayServer } from '../../../main/permission-relay/PermissionRelayServer';
import * as registry from '../../../main/permission-relay/registry';
import {
	registerSpawn,
	getPendingQuestion,
	answerPendingQuestion,
} from '../../../main/permission-relay/registry';
import { nativeCurrentTurns } from '../../../main/pianola/current-turn';
import * as store from '../../../main/pianola/pianola-store-main';
import * as json from '../../../shared/canonicalJson';
import { registerSessionCallbacks } from '../../../main/web-server/callbacks/sessionCallbacks';

describe('host-private question observation authority', () => {
	it.each(['unchanged', 'rules', 'targets', 'owner'] as const)(
		'amortizes real store reads per native census and freshly fences final answer: %s',
		async (mode) => {
			nativeCurrentTurns.setEnabled(true);
			host.directory = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-'));
			host.sessions = Array.from({ length: 8 }, (_, i) => ({
				id: `agent${i}`,
				name: `Agent ${i}`,
				cwd: host.directory,
				toolType: 'claude-code',
				activeTabId: 'tab',
				aiTabs: [{ id: 'tab', createdAt: 7, logs: [] }],
			}));
			host.readSessions.mockImplementation(() => host.sessions);
			let onRequest: (request: { requestId: string }) => void = () => {};
			initPermissionRelay(
				() =>
					({
						isDestroyed: () => false,
						webContents: {
							isDestroyed: () => false,
							send: (_channel: string, request: { requestId: string }) => onRequest(request),
						},
					}) as never,
				null
			);
			// init is idempotent; its window closure belongs to the first invocation.
			permissionRelayServer.setOnRequest((request) => onRequest(request));
			const cleanups: Array<() => void> = [];
			const sockets: net.Socket[] = [];
			const requestIds: string[] = [];
			const reads = vi.spyOn(store, 'readRules');
			const targets = vi.spyOn(store, 'readSupervisorTargets');
			const originalCanonical = json.canonicalJson;
			let authorityHashes = 0;
			const canonical = vi.spyOn(json, 'canonicalJson').mockImplementation((value) => {
				if (
					value &&
					typeof value === 'object' &&
					'rules' in value &&
					'targets' in value &&
					'owners' in value
				)
					authorityHashes++;
				return originalCanonical(value);
			});
			try {
				store.writeRules([]);
				store.writeSupervisorTargets([]);
				const socketPath = await permissionRelayServer.ensureStarted(host.directory);
				for (const session of host.sessions) {
					const userRow = { id: 'user', source: 'user', text: 'Inspect project', timestamp: 1 };
					nativeCurrentTurns.commit({
						sessionId: session.id,
						tabId: 'tab',
						field: 'logs',
						removedIds: [],
						orderIds: ['user'],
						upserts: [userRow],
						observation: {
							sourceGeneration: 'renderer',
							sequence: 1,
							createdAt: 7,
							provider: 'claude-code',
						},
					});
					const processId = `${session.id}-ai-tab`;
					nativeCurrentTurns.begin(
						{
							id: `run-${session.id}`,
							provider: 'claude-code',
							sessionId: processId,
							tabId: 'tab',
							metadata: { nativeTabSession: { agentId: session.id, tabId: 'tab', createdAt: 7 } },
						} as unknown as AgentRun,
						'user'
					);
					const spawn = registerSpawn({ sessionId: processId, tabId: 'tab' });
					cleanups.push(spawn.cleanup);
					const socket = net.createConnection(socketPath);
					sockets.push(socket);
					await new Promise<void>((resolve, reject) => {
						socket.once('connect', resolve);
						socket.once('error', reject);
					});
					const committed = new Promise<void>((resolve) => {
						onRequest = (request) => {
							requestIds.push(request.requestId);
							resolve();
						};
					});
					socket.write(
						JSON.stringify({
							type: 'permission-request',
							token: spawn.token,
							requestId: 'bridge',
							toolName: 'AskUserQuestion',
							input: {
								questions: [
									{
										question: 'Use count or total?',
										multiSelect: false,
										options: [{ label: 'count' }, { label: 'total' }],
									},
								],
							},
						}) + '\n'
					);
					await committed;
				}
				let census!: () => DesktopSessionsSnapshot;
				registerSessionCallbacks(
					new Proxy(
						{},
						{
							get: (_t, key) => (callback: unknown) => {
								if (key === 'setListDesktopSessionsCallback') census = callback as typeof census;
							},
						}
					) as never,
					{
						sessionsStore: { get: host.readSessions },
						groupsStore: { get: () => [] },
						settingsStore: { get: () => ({ pianola: true }) },
						getProcessManager: () => ({
							get: (id: string) => (id.endsWith('-ai-tab') ? { sessionId: id } : undefined),
						}),
					} as never
				);
				const resetCounts = () => {
					reads.mockClear();
					targets.mockClear();
					host.readSessions.mockClear();
					authorityHashes = 0;
				};
				// Previous consumer: one exact registry lookup for every tab.
				resetCounts();
				const beforeCpu = process.cpuUsage();
				const beforeStart = process.hrtime.bigint();
				const priorReader = vi
					.spyOn(registry, 'getPendingQuestionsSnapshot')
					.mockImplementation(() => {
						const questions = new Map();
						for (const session of host.sessions) {
							const turn = nativeCurrentTurns.readProcessTurn(`${session.id}-ai-tab`, 'tab')!;
							const question = getPendingQuestion(`${session.id}-ai-tab`, turn.cursor);
							if (question) questions.set(question.processId, question);
						}
						return questions;
					});
				const priorSnapshot = census();
				priorReader.mockRestore();
				expect(priorSnapshot.sessions.every((s) => !!s.supervision?.nativeQuestion)).toBe(true);
				const before = {
					rules: reads.mock.calls.length,
					targets: targets.mock.calls.length,
					owners: host.readSessions.mock.calls.length,
					hashes: authorityHashes,
					wallNs: Number(process.hrtime.bigint() - beforeStart),
					cpu: process.cpuUsage(beforeCpu),
				};
				expect(before).toMatchObject({ rules: 8, targets: 8, owners: 9, hashes: 8 });
				resetCounts();
				const afterCpu = process.cpuUsage();
				const afterStart = process.hrtime.bigint();
				const snapshot = census();
				const after = {
					rules: reads.mock.calls.length,
					targets: targets.mock.calls.length,
					owners: host.readSessions.mock.calls.length,
					hashes: authorityHashes,
					wallNs: Number(process.hrtime.bigint() - afterStart),
					cpu: process.cpuUsage(afterCpu),
				};
				expect(snapshot.sessions).toHaveLength(8);
				expect(snapshot.sessions.every((s) => !!s.supervision?.nativeQuestion)).toBe(true);
				expect(after).toMatchObject({ rules: 1, targets: 1, owners: 2, hashes: 1 });
				process.stdout.write(
					'R02_PASSIVE_COUNTS ' + JSON.stringify({ mode, questions: 8, before, after }) + '\n'
				);
				// A new synchronous census must reread; there is no TTL or cross-call cache.
				census();
				expect(reads).toHaveBeenCalledTimes(2);
				const observed = snapshot.sessions[0].supervision!.nativeQuestion!;
				if (mode === 'rules')
					store.writeRules([
						{
							id: 'rule',
							enabled: true,
							scope: 'global',
							match: { kinds: ['question'], maxRisk: 'low' },
							action: 'auto_answer',
							answer: 'count',
							priority: 1,
							createdAt: 1,
							updatedAt: 1,
						},
					]);
				if (mode === 'targets')
					store.writeSupervisorTargets([
						{
							id: '11111111-1111-4111-8111-111111111111',
							kind: 'watch-scope',
							enabled: true,
							managerAgentId: 'manager',
							createdAt: 1,
							selection: {
								mode: 'agents-and-groups',
								label: 'New policy',
								agentIds: ['agent0'],
								groupIds: [],
								excludedAgentIds: [],
							},
						},
					]);
				if (mode === 'owner') host.sessions[0].cwd += '/changed';
				resetCounts();
				expect(answerPendingQuestion(observed, 'count')).toBe(mode === 'unchanged');
				expect(reads).toHaveBeenCalledTimes(1);
				expect(targets).toHaveBeenCalledTimes(1);
				expect(host.readSessions).toHaveBeenCalledTimes(1);
				expect(authorityHashes).toBe(1);
				if (mode !== 'unchanged') {
					const response = new Promise<string>((resolve) =>
						sockets[0].once('data', (data) => resolve(data.toString()))
					);
					expect(
						resolvePermissionResponse(requestIds[0], { behavior: 'deny', message: 'Human answer' })
					).toBe(true);
					expect(JSON.parse(await response).decision.message).toBe('Human answer');
				}
			} finally {
				for (const cleanup of cleanups) cleanup();
				for (const socket of sockets) socket.destroy();
				permissionRelayServer.stop();
				nativeCurrentTurns.setEnabled(false);
				nativeCurrentTurns.setEnabled(true);
				vi.mocked(registry.getPendingQuestionsSnapshot).mockRestore?.();
				reads.mockRestore();
				targets.mockRestore();
				canonical.mockRestore();
				fs.rmSync(host.directory, { recursive: true, force: true });
			}
		}
	);
});
