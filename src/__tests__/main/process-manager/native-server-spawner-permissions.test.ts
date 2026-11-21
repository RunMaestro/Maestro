// Source: src/__tests__/main/process-manager/HermesApiSpawner.test.ts
// Source: src/__tests__/main/process-manager/OpencodeServerSpawner.test.ts
import { beforeEach } from 'vitest';
import { describe } from 'vitest';
import { expect } from 'vitest';
import { it } from 'vitest';
import { vi } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { Writable } from 'stream';
import { HermesApiSpawner } from '../../../main/process-manager/spawners/HermesApiSpawner';
import { DataBufferManager } from '../../../main/process-manager/handlers/DataBufferManager';
import type { ManagedProcess } from '../../../main/process-manager/types';
import type { ProcessConfig } from '../../../main/process-manager/types';
import { HARNESS_INTERACTION_REQUEST_CHANNEL } from '../../../main/harness-control/integration';
import { harnessInteractionBroker } from '../../../main/harness-control/integration';
import { initHarnessControl } from '../../../main/harness-control/integration';
import type { HarnessInteractionRequest } from '../../../shared/harness-control/types';
import type { Event } from '@opencode-ai/sdk';
import type { OpencodeClient } from '@opencode-ai/sdk';
import type { Permission } from '@opencode-ai/sdk';
import { OpencodeServerSpawner } from '../../../main/process-manager/spawners/OpencodeServerSpawner';
import { opencodeServerManager } from '../../../main/opencode-server/OpencodeServerManager';
const mockSpawn = vi.hoisted(() => vi.fn());
const mockStopProcess = vi.hoisted(() =>
	vi.fn(() => ({ stage: () => undefined, dispose: () => {} }))
);
vi.mock('child_process', async (importOriginal) => {
	const actual = await importOriginal<typeof import('child_process')>();
	return {
		...actual,
		spawn: (...args: unknown[]) => mockSpawn(...args),
		default: { ...actual, spawn: (...args: unknown[]) => mockSpawn(...args) },
	};
});
vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../main/utils/sentry', () => ({ captureException: vi.fn() }));
vi.mock('fs', async (importOriginal) => {
	const actual = await importOriginal<typeof import('fs')>();
	return { ...actual, existsSync: () => true };
});
vi.mock('../../../shared/maestro-lib/control/termination', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('../../../shared/maestro-lib/control/termination')>();
	return { ...actual, stopProcess: (...args: unknown[]) => mockStopProcess(...(args as [])) };
});
vi.mock('../../../main/opencode-server/OpencodeServerManager', () => ({
	opencodeServerManager: { ensureServer: vi.fn() },
}));
describe('HermesApiSpawner', () => {
	class FakeHermesAgent extends EventEmitter {
		pid = 4242;
		exitCode: number | null = null;
		signalCode: NodeJS.Signals | null = null;
		stdout = new PassThrough();
		stderr = new PassThrough();
		stdin: Writable;
		clarifyAnswers: Record<string, unknown> | undefined;
		written: Array<Record<string, unknown>> = [];
		holdCreate = false;
		private heldCreate?: Record<string, unknown>;

		releaseCreate(): void {
			if (!this.heldCreate) return;
			const request = this.heldCreate;
			this.heldCreate = undefined;
			this.send({ jsonrpc: '2.0', id: request.id, result: { session_id: 'hermes-session' } });
		}

		constructor(
			private readonly clarify = false,
			private readonly failCreate = false
		) {
			super();
			this.stdin = new Writable({
				write: (chunk, _encoding, callback) => {
					for (const line of String(chunk).split('\n').filter(Boolean)) {
						this.handle(JSON.parse(line));
					}
					callback();
				},
				final: (callback) => {
					callback();
					this.exit(0);
				},
			});
		}

		send(record: Record<string, unknown>): void {
			this.stdout.write(JSON.stringify(record) + '\n');
		}

		exit(code: number): void {
			if (this.exitCode !== null) return;
			this.exitCode = code;
			this.stdout.end();
			this.stderr.end();
			setImmediate(() => this.emit('close', code, null));
		}

		private handle(record: Record<string, unknown>): void {
			this.written.push(record);
			if (record.method === 'session.create') {
				if (this.failCreate) {
					this.send({ jsonrpc: '2.0', id: record.id, error: { code: -32603, message: 'boom' } });
					return;
				}
				if (this.holdCreate) {
					this.heldCreate = record;
					return;
				}
				this.send({ jsonrpc: '2.0', id: record.id, result: { session_id: 'hermes-session' } });
				if (this.clarify) {
					this.send({
						jsonrpc: '2.0',
						id: 'clarify-1',
						method: 'clarify.request',
						params: {
							request_id: 'clarify-1',
							description: 'Choose and explain',
							questions: [
								{ id: 'choice', question: 'Continue?', options: ['Yes', 'No'] },
								{ id: 'details', question: 'Why?', options: [] },
							],
						},
					});
				}
				return;
			}
			if (record.id === 'clarify-1' && record.result) {
				const result = record.result as { answers?: Record<string, unknown> };
				this.clarifyAnswers = result.answers ?? (record.result as Record<string, unknown>);
				this.send({
					jsonrpc: '2.0',
					method: 'message.complete',
					params: { status: 'completed', output: 'DONE' },
				});
				return;
			}
			if (record.method === 'clarify.respond') {
				this.clarifyAnswers = record.params as Record<string, unknown>;
				this.send({
					jsonrpc: '2.0',
					method: 'message.complete',
					params: { status: 'completed', output: 'DONE' },
				});
				return;
			}
			if (record.method === 'session.resume') {
				this.send({ jsonrpc: '2.0', id: record.id, error: { code: 4007, message: 'not found' } });
				return;
			}
			if (record.method === 'prompt.submit') {
				this.send({ jsonrpc: '2.0', id: record.id, result: { disposition: 'started' } });
			}
		}
	}

	function harness(agent: FakeHermesAgent) {
		mockSpawn.mockReturnValue(agent);
		const processes = new Map<string, ManagedProcess>();
		const emitter = new EventEmitter();
		const fallbackToCli = vi.fn(() => ({ pid: 999, success: true }));
		const spawner = new HermesApiSpawner(
			processes,
			emitter,
			new DataBufferManager(processes, emitter),
			fallbackToCli
		);
		const { promise: exited, resolve: resolveExit } = Promise.withResolvers<number>();
		emitter.on('exit', (_sessionId, code) => resolveExit(code));
		const config: ProcessConfig = {
			sessionId: 'maestro-hermes',
			toolType: 'hermes',
			cwd: '/tmp/project',
			command: '/opt/hermes/bin/hermes',
			args: ['--yolo'],
			harnessControlMode: 'native',
			permissionMode: 'full',
			prompt: 'Run tests',
			tabId: 'tab-a',
		};
		return { spawner, config, processes, exited, fallbackToCli };
	}

	function answerWindow(): HarnessInteractionRequest[] {
		const requests: HarnessInteractionRequest[] = [];
		initHarnessControl(
			{
				getMainWindow: () =>
					({
						isDestroyed: () => false,
						webContents: {
							isDestroyed: () => false,
							send: (channel: string, payload: unknown) => {
								if (channel === HARNESS_INTERACTION_REQUEST_CHANNEL) {
									requests.push(payload as HarnessInteractionRequest);
								}
							},
						},
					}) as never,
			},
			null
		);
		return requests;
	}

	describe('HermesApiSpawner', () => {
		beforeEach(() => {
			mockSpawn.mockReset();
			mockStopProcess.mockClear();
			harnessInteractionBroker.closeAll();
		});

		it('falls back with the original Hermes command and arguments', async () => {
			const agent = new FakeHermesAgent(false, true);
			const h = harness(agent);
			h.spawner.spawn(h.config);

			await vi.waitFor(() => expect(h.fallbackToCli).toHaveBeenCalledOnce());
			expect(h.fallbackToCli).toHaveBeenCalledWith(
				expect.objectContaining({ command: '/opt/hermes/bin/hermes', args: ['--yolo'] })
			);
		});

		it('does not submit a prompt when session setup completes after Stop', async () => {
			const agent = new FakeHermesAgent();
			agent.holdCreate = true;
			const h = harness(agent);
			h.spawner.spawn(h.config);
			const managed = h.processes.get('maestro-hermes')!;
			await vi.waitFor(() =>
				expect(agent.written.some((record) => record.method === 'session.create')).toBe(true)
			);

			await managed.harnessControl!.interrupt();
			agent.releaseCreate();

			await expect(h.exited).resolves.toBe(0);
			expect(agent.written.some((record) => record.method === 'prompt.submit')).toBe(false);
			expect(h.fallbackToCli).not.toHaveBeenCalled();
		});

		it('does not restart a cancelled startup through the current transport', async () => {
			const agent = new FakeHermesAgent();
			const h = harness(agent);
			h.spawner.spawn(h.config);
			const managed = h.processes.get('maestro-hermes')!;
			await managed.harnessControl!.interrupt();
			agent.exit(1);

			await expect(h.exited).resolves.toBe(0);
			expect(h.fallbackToCli).not.toHaveBeenCalled();
		});

		it('returns every clarification answer, including free text', async () => {
			const agent = new FakeHermesAgent(true);
			const h = harness(agent);
			const requests = answerWindow();
			h.spawner.spawn(h.config);
			await vi.waitFor(() => expect(requests).toHaveLength(1));
			expect(requests[0].questions).toHaveLength(2);
			harnessInteractionBroker.resolve({
				requestId: requests[0].requestId,
				outcome: 'answers',
				answers: { choice: 'Yes', details: 'Native coverage' },
			});

			await vi.waitFor(() =>
				expect(agent.clarifyAnswers).toEqual({ choice: 'Yes', details: 'Native coverage' })
			);
			await expect(h.exited).resolves.toBe(0);
		});
	});
});
describe('OpencodeServerSpawner', () => {
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
		const errors: unknown[] = [];
		emitter.on('agent-error', (_sessionId, error) => errors.push(error));
		const fallbackToCli = vi.fn(() => ({ pid: 999, success: true }));
		const spawner = new OpencodeServerSpawner(
			processes,
			emitter,
			new DataBufferManager(processes, emitter),
			fallbackToCli
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
		return { spawner, config, processes, fallbackToCli, errors };
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

		it('refuses Standard instead of falling back to auto-approving CLI', async () => {
			const { client } = clientFixture([]);
			const { spawner, config, fallbackToCli, errors } = spawnHarness(client);
			vi.mocked(opencodeServerManager.ensureServer).mockRejectedValue(new Error('offline'));

			spawner.spawn({ ...config, permissionMode: 'standard' });

			await vi.waitFor(() => expect(errors).toHaveLength(1));
			expect(fallbackToCli).not.toHaveBeenCalled();
			expect(errors[0]).toMatchObject({
				message: expect.stringContaining('Standard requires the native approval channel'),
			});
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
});
