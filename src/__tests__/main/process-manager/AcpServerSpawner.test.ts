import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough, Writable } from 'stream';
import { AcpServerSpawner } from '../../../main/process-manager/spawners/AcpServerSpawner';
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
const mockStopProcess = vi.fn(() => ({ stage: () => undefined, dispose: () => {} }));
vi.mock('../../../shared/maestro-lib/control/termination', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('../../../shared/maestro-lib/control/termination')>();
	return { ...actual, stopProcess: (...args: unknown[]) => mockStopProcess(...(args as [])) };
});

type ClientMessage = {
	id?: number | string;
	method?: string;
	params?: Record<string, unknown>;
	result?: unknown;
	error?: unknown;
};

class FakeAcpAgent extends EventEmitter {
	pid = 4242;
	exitCode: number | null = null;
	signalCode: NodeJS.Signals | null = null;
	stdout = new PassThrough();
	stderr = new PassThrough();
	stdin: Writable;
	written: ClientMessage[] = [];

	constructor(
		private readonly permission = true,
		private readonly loadSession = true
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
				callback();
				this.exit(0);
			},
		});
	}

	send(msg: ClientMessage): void {
		this.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
	}

	responseTo(id: string | number): ClientMessage | undefined {
		return this.written.find((msg) => msg.id === id && msg.method === undefined);
	}

	exit(code: number): void {
		if (this.exitCode !== null) return;
		this.exitCode = code;
		this.stdout.end();
		this.stderr.end();
		setImmediate(() => this.emit('close', code, null));
	}

	private handle(msg: ClientMessage): void {
		this.written.push(msg);
		if (msg.method === 'initialize') {
			this.send({
				id: msg.id,
				result: {
					protocolVersion: 1,
					agentCapabilities: { loadSession: this.loadSession, promptCapabilities: { image: true } },
					agentInfo: { name: 'fixture-acp', version: '1.0.0' },
					authMethods: [],
				},
			});
			return;
		}
		if (msg.method === 'session/new' || msg.method === 'session/load') {
			if (!Array.isArray(msg.params?.mcpServers)) {
				throw new Error('mcpServers is required');
			}
			this.send({ id: msg.id, result: { sessionId: 'acp-session' } });
			return;
		}
		if (msg.method === 'session/prompt') {
			this.send({
				method: 'session/update',
				params: {
					sessionId: 'acp-session',
					update: {
						sessionUpdate: 'agent_message_chunk',
						content: { type: 'text', text: 'NATIVE_OK' },
					},
				},
			});
			if (this.permission) {
				this.send({
					id: 'permission-1',
					method: 'session/request_permission',
					params: {
						sessionId: 'acp-session',
						toolCall: {
							toolCallId: 'call-1',
							title: 'Run tests?',
							name: 'Bash',
							status: 'pending',
						},
						options: [
							{ optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
							{ optionId: 'deny', name: 'Deny', kind: 'reject_once' },
						],
					},
				});
			} else {
				this.send({ id: msg.id, result: { stopReason: 'end_turn' } });
			}
			return;
		}
		if (msg.id === 'permission-1' && msg.method === undefined) {
			this.send({
				method: 'session/update',
				params: {
					sessionId: 'acp-session',
					update: { sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'completed' },
				},
			});
			const prompt = this.written.find((item) => item.method === 'session/prompt');
			this.send({ id: prompt?.id, result: { stopReason: 'end_turn' } });
		}
	}
}

function harness(agent: FakeAcpAgent) {
	mockSpawn.mockReturnValue(agent);
	const processes = new Map<string, ManagedProcess>();
	const emitter = new EventEmitter();
	const fallbackToCli = vi.fn(() => ({ pid: 999, success: true }));
	const spawner = new AcpServerSpawner(
		processes,
		emitter,
		new DataBufferManager(processes, emitter),
		fallbackToCli,
		{ clientVersion: 'test' }
	);
	const data: string[] = [];
	const errors: unknown[] = [];
	emitter.on('data', (_sessionId, line) => data.push(line));
	emitter.on('agent-error', (_sessionId, error) => errors.push(error));
	const { promise: exited, resolve: resolveExit } = Promise.withResolvers<number>();
	emitter.on('exit', (_sessionId, code) => resolveExit(code));
	const config = (overrides: Partial<ProcessConfig> = {}): ProcessConfig => ({
		sessionId: 'maestro-acp',
		toolType: 'qwen3-coder',
		cwd: '/tmp/project',
		command: 'qwen',
		args: [],
		nativeAcpArgs: ['--acp'],
		harnessControlMode: 'native',
		permissionMode: 'standard',
		prompt: 'Run tests',
		tabId: 'tab-a',
		...overrides,
	});
	return { spawner, config, processes, data, errors, exited, fallbackToCli };
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
								optionId: 'allow',
							});
						},
					},
				}) as never,
		},
		null
	);
	return requests;
}

describe('AcpServerSpawner', () => {
	beforeEach(() => {
		mockSpawn.mockReset();
		mockStopProcess.mockClear();
		harnessInteractionBroker.closeAll();
	});

	it('runs ACP v1 session updates and a permission round trip', async () => {
		const agent = new FakeAcpAgent();
		const h = harness(agent);
		const requests = answerWindow();
		const result = h.spawner.spawn(h.config());
		const managed = h.processes.get('maestro-acp');

		await expect(h.exited).resolves.toBe(0);
		expect(agent.responseTo('permission-1')?.result).toEqual({
			outcome: { outcome: 'selected', optionId: 'allow' },
		});
		expect(requests[0]).toMatchObject({ provider: 'qwen3-coder', toolCallId: 'call-1' });
		expect(h.data.join('')).toContain('NATIVE_OK');
		expect(managed?.harnessControl?.getCapabilities()).toMatchObject({
			protocol: 'acp',
			resume: true,
			imagePrompts: true,
		});
	});

	it('uses session/load for an advertised resume capability', async () => {
		const agent = new FakeAcpAgent(false);
		const h = harness(agent);
		answerWindow();
		h.spawner.spawn(h.config({ agentSessionId: 'acp-session' }));

		await expect(h.exited).resolves.toBe(0);
		expect(agent.written.some((msg) => msg.method === 'session/load')).toBe(true);
		expect(agent.written.some((msg) => msg.method === 'session/new')).toBe(false);
	});

	it('falls back instead of replacing a conversation when resume is unsupported', async () => {
		const agent = new FakeAcpAgent(true, false);
		const h = harness(agent);
		h.spawner.spawn(h.config({ agentSessionId: 'existing-session', permissionMode: 'full' }));
		await vi.waitFor(() => expect(h.fallbackToCli).toHaveBeenCalled());
		expect(agent.written.some((record) => record.method === 'session/new')).toBe(false);
	});

	it('falls back only before native setup succeeds', async () => {
		class FailingAgent extends FakeAcpAgent {
			override send(msg: ClientMessage): void {
				if (msg.id !== undefined && msg.method === undefined) {
					super.send({ id: msg.id, error: { code: -32603, message: 'boom' } });
					return;
				}
				super.send(msg);
			}
		}
		const agent = new FailingAgent(false);
		const h = harness(agent);
		const fallback = h.fallbackToCli;
		h.spawner.spawn(h.config({ permissionMode: 'full' }));

		await vi.waitFor(() => expect(fallback).toHaveBeenCalled());
	});

	it('does not fall back to prompt-less CLI for Standard setup failures', async () => {
		class FailingAgent extends FakeAcpAgent {
			override send(msg: ClientMessage): void {
				if (msg.id !== undefined && msg.method === undefined) {
					super.send({ id: msg.id, error: { code: -32603, message: 'boom' } });
					return;
				}
				super.send(msg);
			}
		}
		const agent = new FailingAgent(false);
		const h = harness(agent);
		h.spawner.spawn(h.config());

		await vi.waitFor(() => expect(h.errors).toHaveLength(1));
		expect(mockStopProcess).toHaveBeenCalled();
	});
});
