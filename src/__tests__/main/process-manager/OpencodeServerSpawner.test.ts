import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import type { Event, OpencodeClient, Permission } from '@opencode-ai/sdk';
import { OpencodeServerSpawner } from '../../../main/process-manager/spawners/OpencodeServerSpawner';
import { opencodeServerManager } from '../../../main/opencode-server/OpencodeServerManager';
import { DataBufferManager } from '../../../main/process-manager/handlers/DataBufferManager';
import type { ManagedProcess, ProcessConfig } from '../../../main/process-manager/types';
import {
	HARNESS_INTERACTION_REQUEST_CHANNEL,
	harnessInteractionBroker,
	initHarnessControl,
} from '../../../main/harness-control/integration';
import type { HarnessInteractionRequest } from '../../../shared/harness-control/types';

vi.mock('../../../main/opencode-server/OpencodeServerManager', () => ({
	opencodeServerManager: { ensureServer: vi.fn() },
}));
vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../main/utils/sentry', () => ({ captureException: vi.fn() }));

const permission: Permission = {
	id: 'permission-a',
	type: 'shell',
	pattern: 'bun test',
	sessionID: 'opencode-session',
	messageID: 'message-a',
	callID: 'call-a',
	title: 'Run tests?',
	metadata: {},
	time: { created: 1 },
};

function clientFixture(events: Event[]) {
	const postSessionIdPermissionsPermissionId = vi.fn().mockResolvedValue({ data: true });
	const client = {
		session: {
			create: vi.fn().mockResolvedValue({ data: { id: 'opencode-session' } }),
			promptAsync: vi.fn().mockResolvedValue({ data: undefined }),
			abort: vi.fn().mockResolvedValue({ data: true }),
		},
		event: {
			subscribe: vi.fn().mockResolvedValue({
				stream: (async function* () {
					for (const event of events) yield event;
				})(),
			}),
		},
		postSessionIdPermissionsPermissionId,
	} as unknown as OpencodeClient;
	return { client, postSessionIdPermissionsPermissionId };
}

function spawnHarness(client: OpencodeClient) {
	vi.mocked(opencodeServerManager.ensureServer).mockResolvedValue({
		client,
		url: 'http://opencode.test',
	} as never);
	const processes = new Map<string, ManagedProcess>();
	const emitter = new EventEmitter();
	const spawner = new OpencodeServerSpawner(
		processes,
		emitter,
		new DataBufferManager(processes, emitter),
		vi.fn(() => ({ pid: 999, success: true }))
	);
	const config: ProcessConfig = {
		sessionId: 'maestro-session',
		toolType: 'opencode',
		cwd: '/tmp/project',
		command: 'opencode',
		args: [],
		prompt: 'run tests',
		tabId: 'tab-a',
	};
	return { spawner, config, processes };
}

function answerWindow(onRequest: (request: HarnessInteractionRequest) => void) {
	initHarnessControl(
		{
			getMainWindow: () =>
				({
					isDestroyed: () => false,
					webContents: {
						isDestroyed: () => false,
						send: (channel: string, payload: unknown) => {
							if (channel === HARNESS_INTERACTION_REQUEST_CHANNEL) {
								onRequest(payload as HarnessInteractionRequest);
							}
						},
					},
				}) as never,
		},
		null
	);
}

describe('OpencodeServerSpawner permissions', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		harnessInteractionBroker.closeAll();
	});

	it('returns a broker selection to the native permission endpoint', async () => {
		const { client, postSessionIdPermissionsPermissionId } = clientFixture([
			{ type: 'permission.updated', properties: permission },
			{ type: 'session.idle', properties: { sessionID: 'opencode-session' } },
		] as Event[]);
		const { spawner, config } = spawnHarness(client);
		answerWindow((request) => {
			queueMicrotask(() => {
				harnessInteractionBroker.resolve({
					requestId: request.requestId,
					outcome: 'selected',
					optionId: 'once',
				});
			});
		});

		spawner.spawn(config);

		await vi.waitFor(() => expect(postSessionIdPermissionsPermissionId).toHaveBeenCalledOnce());
		expect(postSessionIdPermissionsPermissionId).toHaveBeenCalledWith({
			path: { id: 'opencode-session', permissionID: 'permission-a' },
			query: { directory: '/tmp/project' },
			body: { response: 'once' },
		});
	});

	it('uses the current permission.asked reply protocol', async () => {
		const { client, postSessionIdPermissionsPermissionId } = clientFixture([
			{
				type: 'permission.asked',
				properties: {
					id: 'permission-current',
					sessionID: 'opencode-session',
					permission: 'bash',
					patterns: ['bun test'],
					metadata: {},
					always: ['bun *'],
				},
			},
			{ type: 'session.idle', properties: { sessionID: 'opencode-session' } },
		] as Event[]);
		const { spawner, config } = spawnHarness(client);
		const fetchMock = vi.fn().mockResolvedValue({ ok: true });
		vi.stubGlobal('fetch', fetchMock);
		answerWindow((request) => {
			harnessInteractionBroker.resolve({
				requestId: request.requestId,
				outcome: 'selected',
				optionId: 'once',
			});
		});

		spawner.spawn(config);

		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
		expect(fetchMock.mock.calls[0][0]).toBe(
			'http://opencode.test/permission/permission-current/reply?directory=%2Ftmp%2Fproject'
		);
		expect(fetchMock.mock.calls[0][1]).toMatchObject({
			method: 'POST',
			body: JSON.stringify({ reply: 'once' }),
		});
		expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
		expect(postSessionIdPermissionsPermissionId).not.toHaveBeenCalled();
		vi.unstubAllGlobals();
	});

	it('does not answer again when another client replies first', async () => {
		const { client, postSessionIdPermissionsPermissionId } = clientFixture([
			{ type: 'permission.updated', properties: permission },
			{
				type: 'permission.replied',
				properties: {
					sessionID: 'opencode-session',
					permissionID: 'permission-a',
					response: 'once',
				},
			},
			{ type: 'session.idle', properties: { sessionID: 'opencode-session' } },
		] as Event[]);
		const { spawner, config } = spawnHarness(client);
		answerWindow(() => {});

		spawner.spawn(config);

		await vi.waitFor(() => expect(harnessInteractionBroker.pendingRequests()).toHaveLength(0));
		expect(postSessionIdPermissionsPermissionId).not.toHaveBeenCalled();
	});
});
