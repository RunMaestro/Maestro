import { beforeAll, describe, expect, it, vi } from 'vitest';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { spawnNativeSdkAgent } from '../../../cli/services/native-sdk-agent';
import { initializeOutputParsers } from '../../../main/parsers';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }));
vi.mock('@github/copilot-sdk', () => ({
	CopilotClient: vi.fn(),
	RuntimeConnection: { forStdio: vi.fn() },
	approveAll: vi.fn(),
}));

const queryMock = vi.mocked(query);
const rpcRequestMock = vi.hoisted(() => vi.fn());
const rpcCloseMock = vi.hoisted(() => vi.fn());
const rpcNotification = vi.hoisted(() => ({
	current: (_record: Record<string, unknown>) => {},
}));
vi.mock('../../../shared/maestro-lib/harness/rpc/connection', () => ({
	NdJsonConnection: class {
		request = rpcRequestMock;
		close = rpcCloseMock;
		constructor(
			_child: unknown,
			options: { onNotification: (record: Record<string, unknown>) => void }
		) {
			rpcNotification.current = options.onNotification;
		}
	},
}));
vi.mock('../../../shared/maestro-lib/run/start-turn', () => ({
	startTurn: vi.fn(() => {
		let resolveDone!: (value: { exitCode: number }) => void;
		const done = new Promise<{ exitCode: number }>((resolve) => {
			resolveDone = resolve;
		});
		return {
			child: { stdin: { end: vi.fn(() => resolveDone({ exitCode: 0 })) } },
			done,
		};
	}),
}));
const readAgentConfigMock = vi.hoisted(() =>
	vi.fn(() => ({ model: 'saved-model', effort: 'high' }))
);
vi.mock('../../../cli/services/storage', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../../cli/services/storage')>();
	return { ...actual, readAgentConfig: readAgentConfigMock };
});

function claudeQuery(
	params: {
		options: {
			canUseTool: (
				name: string,
				input: Record<string, unknown>,
				options: { signal: AbortSignal }
			) => Promise<{ behavior: string }>;
		};
	},
	onCanUseTool: (options: {
		canUseTool: (
			name: string,
			input: Record<string, unknown>,
			options: { signal: AbortSignal }
		) => Promise<{ behavior: string }>;
	}) => void | Promise<void>
) {
	return {
		close: vi.fn(),
		async *[Symbol.asyncIterator]() {
			await onCanUseTool(params.options);
			yield {
				type: 'result',
				subtype: 'success',
				is_error: false,
				result: 'DONE',
				session_id: 'claude-session',
			};
		},
	} as never;
}

describe('CLI native SDK ownership', () => {
	beforeAll(() => initializeOutputParsers());

	it('marks native preparation complete before starting the SDK turn', async () => {
		const onProcessStarted = vi.fn();
		queryMock.mockImplementation((params) => {
			expect(onProcessStarted).toHaveBeenCalledExactlyOnceWith(undefined);
			return claudeQuery(params, () => undefined);
		});

		await spawnNativeSdkAgent('claude-code', process.cwd(), 'test', undefined, {
			harnessControlMode: 'native',
			onProcessStarted,
		});

		expect(onProcessStarted).toHaveBeenCalledExactlyOnceWith(undefined);
	});

	it('uses saved model and effort when native options omit overrides', async () => {
		queryMock.mockImplementation((params) => claudeQuery(params, () => undefined));

		await spawnNativeSdkAgent('claude-code', process.cwd(), 'test', undefined, {
			harnessControlMode: 'native',
		});

		expect(queryMock.mock.calls.at(-1)?.[0].options).toMatchObject({
			model: 'saved-model',
			effort: 'high',
		});
	});

	it('preserves explicit effort for RPC providers without a shared effort option', async () => {
		rpcRequestMock.mockImplementation(async (method: string) => {
			if (method === 'get_state') {
				return { sessionId: 'omp-session', isStreaming: false, pendingMessageCount: 0 };
			}
			if (method === 'prompt') return { disposition: 'handled' };
			return {};
		});

		await spawnNativeSdkAgent(
			'omp',
			process.cwd(),
			'test',
			undefined,
			{
				harnessControlMode: 'native',
				customEffort: 'max',
				agentConfigValues: {},
			},
			'omp'
		);

		expect(rpcRequestMock).toHaveBeenCalledWith('set_thinking_level', { level: 'max' });
	});

	it('finishes a CLI Pi turn when agent_end reports an idle state', async () => {
		rpcRequestMock.mockClear();
		rpcRequestMock.mockImplementation(async (method: string) => {
			if (method === 'get_state') {
				return { sessionId: 'pi-session', isStreaming: false, pendingMessageCount: 0 };
			}
			if (method === 'prompt') return { disposition: 'started' };
			return {};
		});
		const pending = spawnNativeSdkAgent(
			'pi',
			process.cwd(),
			'test',
			undefined,
			{ harnessControlMode: 'native', agentConfigValues: {} },
			'pi'
		);
		await vi.waitFor(() =>
			expect(rpcRequestMock).toHaveBeenCalledWith('prompt', { message: 'test' })
		);

		rpcNotification.current({
			type: 'agent_end',
			messages: [{ role: 'assistant', content: [{ type: 'text', text: 'PI_DONE' }] }],
		});

		await expect(pending).resolves.toMatchObject({ success: true });
	});

	it('denies a standard approval immediately when no interactive owner exists', async () => {
		let decision = '';
		queryMock.mockImplementation((params) => {
			return claudeQuery(params, (options) => {
				void options
					.canUseTool('Bash', { command: 'echo one' }, { signal: new AbortController().signal })
					.then((result) => {
						decision = result.behavior;
					});
			});
		});

		await spawnNativeSdkAgent('claude-code', process.cwd(), 'test', undefined, {
			harnessControlMode: 'native',
			permissionMode: 'standard',
		});

		expect(decision).toBe('deny');
	});

	it('routes standard approval to the authorized CLI owner', async () => {
		let decision = '';
		let requests = 0;
		queryMock.mockImplementation((params) => {
			return claudeQuery(params, (options) => {
				void options
					.canUseTool('Bash', { command: 'echo one' }, { signal: new AbortController().signal })
					.then((result) => {
						decision = result.behavior;
					});
			});
		});

		await spawnNativeSdkAgent('claude-code', process.cwd(), 'test', undefined, {
			harnessControlMode: 'native',
			permissionMode: 'standard',
			nativeSessionId: 'cli-owner',
			onHarnessInteraction: (request) => {
				requests += 1;
				expect(request.sessionId).toBe('cli-owner');
				return { outcome: 'selected', optionId: 'allow' };
			},
		});

		expect({ decision, requests }).toEqual({ decision: 'allow', requests: 1 });
	});

	it('allows read-only built-ins and denies writes in read-only mode', async () => {
		const decisions: string[] = [];
		queryMock.mockImplementation((params) => {
			return claudeQuery(params, async (options) => {
				const signal = new AbortController().signal;
				decisions.push((await options.canUseTool('Read', { file_path: 'a' }, { signal })).behavior);
				decisions.push(
					(await options.canUseTool('Bash', { command: 'echo one' }, { signal })).behavior
				);
			});
		});

		await spawnNativeSdkAgent('claude-code', process.cwd(), 'test', undefined, {
			harnessControlMode: 'native',
			readOnlyMode: true,
		});

		expect(decisions).toEqual(['allow', 'deny']);
	});

	it('preserves full-access defaults without creating an approval request', async () => {
		let decision = '';
		queryMock.mockImplementation((params) => {
			return claudeQuery(params, (options) => {
				void options
					.canUseTool('Bash', { command: 'echo one' }, { signal: new AbortController().signal })
					.then((result) => {
						decision = result.behavior;
					});
			});
		});

		await spawnNativeSdkAgent('claude-code', process.cwd(), 'test', undefined, {
			harnessControlMode: 'native',
			onHarnessInteraction: () => {
				throw new Error('Full-access mode must not prompt');
			},
		});

		expect(decision).toBe('allow');
	});

	it('passes resolved environment and required secrets to the SDK', async () => {
		let environment: NodeJS.ProcessEnv | undefined;
		process.env.NATIVE_TEST_SECRET = 'resolved-secret';
		queryMock.mockImplementation((params) => {
			environment = params.options.env;
			return claudeQuery(params, () => {});
		});
		try {
			await spawnNativeSdkAgent('claude-code', process.cwd(), 'test', undefined, {
				harnessControlMode: 'native',
				customEnvVars: { CUSTOM_ENV: 'session-value' },
				globalEnvVars: { GLOBAL_ENV: 'global-value' },
				requiredSecrets: ['NATIVE_TEST_SECRET'],
			});
		} finally {
			delete process.env.NATIVE_TEST_SECRET;
		}
		expect(environment).toMatchObject({
			CUSTOM_ENV: 'session-value',
			GLOBAL_ENV: 'global-value',
			NATIVE_TEST_SECRET: 'resolved-secret',
		});
	});

	it('settles a hung native turn with the caller timeout', async () => {
		vi.useFakeTimers();
		queryMock.mockImplementation(
			() =>
				({
					close: vi.fn(),
					[Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
				}) as never
		);
		try {
			const pending = spawnNativeSdkAgent('claude-code', process.cwd(), 'test', undefined, {
				harnessControlMode: 'native',
				timeoutMs: 10,
			});
			await vi.advanceTimersByTimeAsync(6_000);
			const result = await pending;
			expect(result.success).toBe(false);
			expect(result.error).toContain('timed out');
		} finally {
			vi.useRealTimers();
		}
	});

	it('classifies a deadline as crashed even when the provider aborts promptly', async () => {
		vi.useFakeTimers();
		queryMock.mockImplementation(
			() =>
				({
					close: vi.fn(),
					async *[Symbol.asyncIterator]() {
						await new Promise((resolve) => setTimeout(resolve, 20));
						yield {
							type: 'result',
							subtype: 'success',
							is_error: false,
							result: 'DONE',
							session_id: 'session-timeout',
						};
					},
				}) as never
		);
		try {
			const pending = spawnNativeSdkAgent('claude-code', process.cwd(), 'test', undefined, {
				harnessControlMode: 'native',
				timeoutMs: 10,
			});
			await vi.advanceTimersByTimeAsync(20);
			const result = await pending;
			expect(result.outcome).toBe('crashed');
			expect(result.error).toContain('timed out');
		} finally {
			vi.useRealTimers();
		}
	});

	it('preserves session identity and usage when a started turn is cancelled', async () => {
		const controller = new AbortController();
		queryMock.mockImplementation(
			() =>
				({
					close: vi.fn(),
					async *[Symbol.asyncIterator]() {
						yield {
							type: 'result',
							subtype: 'success',
							is_error: false,
							result: 'DONE',
							session_id: 'session-cancelled',
							usage: { input_tokens: 2, output_tokens: 3 },
						};
					},
				}) as never
		);
		const pending = spawnNativeSdkAgent('claude-code', process.cwd(), 'test', undefined, {
			harnessControlMode: 'native',
			signal: controller.signal,
		});
		controller.abort();
		const result = await pending;
		expect(result.outcome).toBe('interrupted');
		expect(result.agentSessionId).toBe('session-cancelled');
		expect(result.usageStats).toBeDefined();
	});
});
