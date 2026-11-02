import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough, Writable } from 'stream';
import { HermesApiSpawner } from '../../../main/process-manager/spawners/HermesApiSpawner';
import { DataBufferManager } from '../../../main/process-manager/handlers/DataBufferManager';
import type { ManagedProcess, ProcessConfig } from '../../../main/process-manager/types';
import {
	HARNESS_INTERACTION_REQUEST_CHANNEL,
	harnessInteractionBroker,
	initHarnessControl,
} from '../../../main/harness-control/integration';
import type { HarnessInteractionRequest } from '../../../shared/harness-control/types';

const mockSpawn = vi.fn();
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
const mockStopProcess = vi.fn(() => ({ stage: () => undefined, dispose: () => {} }));
vi.mock('../../../shared/maestro-lib/control/termination', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('../../../shared/maestro-lib/control/termination')>();
	return { ...actual, stopProcess: (...args: unknown[]) => mockStopProcess(...(args as [])) };
});

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
