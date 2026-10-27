import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough, Writable } from 'stream';
import { RpcServerSpawner } from '../../../main/process-manager/spawners/RpcServerSpawner';
import { DataBufferManager } from '../../../main/process-manager/handlers/DataBufferManager';
import type { ManagedProcess, ProcessConfig } from '../../../main/process-manager/types';
import type { SteeringResultFrame } from '../../../shared/chatSteering';
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
const mockStopProcess = vi.fn(() => ({ stage: () => undefined, dispose: () => {} }));
vi.mock('../../../shared/maestro-lib/control/termination', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('../../../shared/maestro-lib/control/termination')>();
	return { ...actual, stopProcess: (...args: unknown[]) => mockStopProcess(...(args as [])) };
});

type RpcRecord = Record<string, unknown>;

class FakeRpcAgent extends EventEmitter {
	pid = 4242;
	exitCode: number | null = null;
	signalCode: NodeJS.Signals | null = null;
	stdout = new PassThrough();
	stderr = new PassThrough();
	stdin: Writable;
	written: RpcRecord[] = [];
	stdinEnded = false;
	failPrompt = false;

	constructor(
		private readonly dialog = false,
		private readonly waitForSteer = false
	) {
		super();
		let pending = '';
		this.stdin = new Writable({
			write: (chunk, _encoding, callback) => {
				pending += chunk.toString();
				let index = pending.indexOf('\n');
				while (index !== -1) {
					const line = pending.slice(0, index);
					pending = pending.slice(index + 1);
					if (line.trim()) this.handle(JSON.parse(line));
					index = pending.indexOf('\n');
				}
				callback();
			},
			final: (callback) => {
				this.stdinEnded = true;
				callback();
				this.exit(0);
			},
		});
	}

	send(record: RpcRecord): void {
		this.stdout.write(JSON.stringify(record) + '\n');
	}

	exit(code: number): void {
		if (this.exitCode !== null) return;
		this.exitCode = code;
		this.stdout.end();
		this.stderr.end();
		setImmediate(() => this.emit('close', code, null));
	}

	private respond(request: RpcRecord, data: unknown): void {
		this.send({ id: request.id, type: 'response', command: request.type, success: true, data });
	}

	private handle(request: RpcRecord): void {
		this.written.push(request);
		switch (request.type) {
			case 'get_state':
				this.respond(request, { sessionId: 'omp-session', isStreaming: false });
				return;
			case 'prompt':
				this.respond(request, { disposition: 'started' });
				if (this.failPrompt) {
					this.send({ type: 'prompt_result', status: 'failed', error: 'boom' });
					return;
				}
				if (this.dialog) {
					this.send({
						type: 'extension_ui_request',
						id: 'dialog-1',
						method: 'confirm',
						title: 'Allow dangerous command?',
					});
				} else if (!this.waitForSteer) {
					this.send({ type: 'session_settled' });
				}
				return;
			case 'steer':
				this.respond(request, { disposition: 'queued' });
				this.send({
					type: 'message_start',
					message: { role: 'user', content: [{ type: 'text', text: request.message }] },
				});
				this.send({ type: 'session_settled' });
				return;
			case 'abort':
				this.respond(request, {});
				this.send({ type: 'session_settled', aborted: true });
				return;
			case 'extension_ui_response':
				this.send({ type: 'session_settled' });
		}
	}
}

function harness(agent: FakeRpcAgent) {
	mockSpawn.mockReturnValue(agent);
	const processes = new Map<string, ManagedProcess>();
	const emitter = new EventEmitter();
	const spawner = new RpcServerSpawner(
		processes,
		emitter,
		new DataBufferManager(processes, emitter),
		vi.fn(() => ({ pid: 999, success: true }))
	);
	const data: string[] = [];
	const verdicts: SteeringResultFrame[] = [];
	emitter.on('data', (_sessionId, line) => data.push(line));
	emitter.on('steering-verdict', (_sessionId, frame) => verdicts.push(frame));
	const { promise: exited, resolve: resolveExit } = Promise.withResolvers<number>();
	emitter.on('exit', (_sessionId, code) => resolveExit(code));
	const config: ProcessConfig = {
		sessionId: 'maestro-omp',
		toolType: 'omp',
		cwd: '/tmp/project',
		command: 'omp',
		args: [],
		nativeRpcArgs: ['--mode', 'rpc-ui'],
		nativeRpcProtocol: 'omp-rpc',
		permissionMode: 'standard',
		prompt: 'Run tests',
		tabId: 'tab-a',
	};
	return { spawner, config, processes, data, verdicts, exited };
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
							if (channel !== HARNESS_INTERACTION_REQUEST_CHANNEL) return;
							const request = payload as HarnessInteractionRequest;
							requests.push(request);
							harnessInteractionBroker.resolve({
								requestId: request.requestId,
								outcome: 'selected',
								optionId: 'confirm',
							});
						},
					},
				}) as never,
		},
		null
	);
	return requests;
}

describe('RpcServerSpawner', () => {
	beforeEach(() => {
		mockSpawn.mockReset();
		mockStopProcess.mockClear();
		harnessInteractionBroker.closeAll();
	});

	it('reports delivered then absorbed for a native steer', async () => {
		const agent = new FakeRpcAgent(false, true);
		const h = harness(agent);
		h.spawner.spawn(h.config);
		const managed = h.processes.get('maestro-omp')!;
		await vi.waitFor(() =>
			expect(agent.written.some((record) => record.type === 'prompt')).toBe(true)
		);
		const verdict = await managed.harnessControl!.steer({
			id: 'steer-1',
			text: 'Use the safer implementation',
		});

		expect(verdict.verdict).toBe('delivered');
		await expect(h.exited).resolves.toBe(0);
		expect(h.verdicts).toEqual([expect.objectContaining({ id: 'steer-1', verdict: 'absorbed' })]);
		expect(agent.written.some((record) => record.type === 'steer')).toBe(true);
	});

	it('answers an extension confirmation and resumes the turn', async () => {
		const agent = new FakeRpcAgent(true);
		const h = harness(agent);
		const requests = answerWindow();
		h.spawner.spawn(h.config);

		await expect(h.exited).resolves.toBe(0);
		expect(requests[0]).toMatchObject({ provider: 'omp', kind: 'permission' });
		expect(
			agent.written.some(
				(record) => record.type === 'extension_ui_response' && record.confirmed === true
			)
		).toBe(true);
	});

	it('closes stdin when the provider rejects a prompt', async () => {
		const agent = new FakeRpcAgent();
		agent.failPrompt = true;
		const h = harness(agent);
		h.spawner.spawn(h.config);
		await vi.waitFor(() => expect(agent.stdinEnded).toBe(true));
	});
});
