import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ParsedArgs } from '../../maestro-p/args';

const mockState = vi.hoisted(() => ({
	drivers: [] as any[],
	tailers: [] as any[],
	emitters: [] as any[],
	tailerEntries: [] as unknown[],
	parseErrors: [] as unknown[],
	screenCapture: '',
	exitCodes: [] as unknown[],
	discoverSessionId: vi.fn(),
	parseUsage: vi.fn(),
	translateStreamJsonInput: vi.fn(),
	cleanupStreamJsonImages: vi.fn(),
	randomUUID: vi.fn(() => 'fresh-session-id'),
}));

vi.mock('node:crypto', async (importOriginal) => {
	const original = await importOriginal<typeof import('node:crypto')>();
	return {
		...original,
		default: { ...original, randomUUID: mockState.randomUUID },
		randomUUID: mockState.randomUUID,
	};
});

vi.mock('../../maestro-p/session-watcher', () => ({
	cwdSlug: vi.fn(() => 'cwd-slug'),
	discoverSessionId: mockState.discoverSessionId,
}));

vi.mock('../../maestro-p/stream-json-input', () => ({
	cleanupStreamJsonImages: mockState.cleanupStreamJsonImages,
	translateStreamJsonInput: mockState.translateStreamJsonInput,
}));

vi.mock('../../maestro-p/usage-parser', () => ({
	parseUsage: mockState.parseUsage,
}));

vi.mock('../../maestro-p/json-emitter', () => {
	class MockJsonEmitter {
		emitInit = vi.fn();
		emitResult = vi.fn();
		emitStatus = vi.fn();
		emitAssistantMessage = vi.fn();
		emitUserMessage = vi.fn();

		constructor() {
			mockState.emitters.push(this);
		}
	}

	return { JsonEmitter: MockJsonEmitter };
});

vi.mock('../../maestro-p/jsonl-tailer', () => {
	const { EventEmitter: NodeEventEmitter } = require('node:events');

	class MockJsonlTailer extends NodeEventEmitter {
		options: unknown;
		start = vi.fn(async () => {
			for (const payload of mockState.parseErrors) {
				this.emit('parse-error', payload);
			}
			for (const entry of mockState.tailerEntries) {
				this.emit('entry', entry);
			}
		});
		stop = vi.fn();
		getLastByteAt = vi.fn(() => Date.now());

		constructor(options: unknown) {
			super();
			this.options = options;
			mockState.tailers.push(this);
		}
	}

	return { JsonlTailer: MockJsonlTailer };
});

vi.mock('../../maestro-p/tui-driver', () => {
	const { EventEmitter: NodeEventEmitter } = require('node:events');

	class MockTuiDriver extends NodeEventEmitter {
		options: any;
		start = vi.fn(async () => {
			setTimeout(() => this.emit('ready'), 0);
		});
		send = vi.fn();
		resubmit = vi.fn();
		quit = vi.fn(async () => undefined);
		getScreenTail = vi.fn(() => 'mock screen tail');
		getScreenCapture = vi.fn(() => mockState.screenCapture);

		constructor(options: any) {
			super();
			this.options = options;
			mockState.drivers.push(this);
		}
	}

	return { TuiDriver: MockTuiDriver };
});

function makeArgs(overrides: Partial<ParsedArgs> = {}): ParsedArgs {
	return {
		prompt: 'hello',
		mode: 'run',
		passThroughArgs: ['--model', 'sonnet'],
		streamThinking: false,
		maxWaitSeconds: 300,
		firstByteTimeoutSeconds: 240,
		resumeSessionId: null,
		streamJsonInput: false,
		...overrides,
	};
}

async function flushMicrotasks() {
	await Promise.resolve();
	await Promise.resolve();
}

describe('maestro-p entrypoint', () => {
	let exitSpy: ReturnType<typeof vi.spyOn>;
	let stderrSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		vi.useFakeTimers();
		mockState.drivers.length = 0;
		mockState.tailers.length = 0;
		mockState.emitters.length = 0;
		mockState.tailerEntries = [];
		mockState.parseErrors = [];
		mockState.screenCapture = '';
		mockState.exitCodes = [];
		mockState.discoverSessionId.mockReset();
		mockState.discoverSessionId.mockResolvedValue({
			sessionId: 'session-1',
			jsonlPath: '/tmp/session-1.jsonl',
		});
		mockState.parseUsage.mockReset();
		mockState.translateStreamJsonInput.mockReset();
		mockState.cleanupStreamJsonImages.mockReset();
		mockState.randomUUID.mockClear();
		exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
			mockState.exitCodes.push(code);
			return undefined as never;
		}) as typeof process.exit);
		stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		delete process.env.CLAUDE_CONFIG_DIR;
		delete process.env.MAESTRO_CLAUDE_BIN;
		delete process.env.CLAUDE_CODE_SESSION_ID;
		delete process.env.CLAUDE_CODE_CHILD_SESSION;
	});

	it('exports import-safe helpers for config, binary, env, usage, and message parsing', async () => {
		const mod = await import('../../maestro-p/index');
		process.env.CLAUDE_CONFIG_DIR = '/tmp/claude-config';
		process.env.MAESTRO_CLAUDE_BIN = '/usr/local/bin/claude';
		process.env.CLAUDE_CODE_SESSION_ID = 'parent-session';
		process.env.CLAUDE_CODE_CHILD_SESSION = 'child-session';

		expect(mod.resolveConfigDir()).toBe('/tmp/claude-config');
		expect(mod.isMaestroPSelfPath('/opt/bin/maestro-p.exe')).toBe(true);
		expect(mod.resolveBinPath()).toBe('/usr/local/bin/claude');
		process.env.MAESTRO_CLAUDE_BIN = '/opt/bin/maestro-p';
		expect(mod.resolveBinPath()).toBe('claude');

		const env = mod.sanitizeChildEnv();
		expect(env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
		expect(env.CLAUDE_CODE_CHILD_SESSION).toBeUndefined();

		const usage = mod.emptyUsage();
		mod.addUsage(usage, {
			input_tokens: 10,
			output_tokens: 5,
			cache_creation_input_tokens: 3,
			cache_read_input_tokens: 2,
		});
		mod.addUsage(usage, { input_tokens: 'ignored' });
		expect(usage).toEqual({
			input_tokens: 10,
			output_tokens: 5,
			cache_creation_input_tokens: 3,
			cache_read_input_tokens: 2,
		});

		expect(mod.hasToolResultBlock({ content: [{ type: 'text' }, { type: 'tool_result' }] })).toBe(
			true
		);
		expect(mod.hasToolResultBlock({ content: [{ type: 'text' }] })).toBe(false);
		expect(
			mod.collectAssistantText({
				content: [
					{ type: 'text', text: 'A' },
					{ type: 'thinking', text: 'ignored' },
				],
			})
		).toBe('A');
	});

	it('runs status mode, parses the captured usage screen, emits status, and exits cleanly', async () => {
		const mod = await import('../../maestro-p/index');
		const snapshot = {
			type: 'status',
			config_dir: '/tmp/claude',
			session: { percent: 1, resets_at: '2026-06-18T12:00:00.000Z' },
			week_all_models: { percent: 2, resets_at: '2026-06-19T12:00:00.000Z' },
			week_sonnet_only: { percent: 3, resets_at: '2026-06-20T12:00:00.000Z' },
		};
		mockState.screenCapture = 'usage panel';
		mockState.parseUsage.mockReturnValue(snapshot);

		const promise = mod.statusMode(makeArgs({ mode: 'status', prompt: null }));
		await flushMicrotasks();
		await vi.advanceTimersByTimeAsync(2500);
		await promise;

		expect(mockState.drivers[0].options).toMatchObject({
			args: ['--model', 'sonnet'],
			captureScreen: true,
		});
		expect(mockState.drivers[0].send).toHaveBeenCalledWith('/usage');
		expect(mockState.parseUsage).toHaveBeenCalledWith(
			'usage panel',
			expect.any(String),
			expect.any(String)
		);
		expect(mockState.emitters[0].emitStatus).toHaveBeenCalledWith(snapshot);
		expect(mockState.drivers[0].quit).toHaveBeenCalledTimes(1);
		expect(exitSpy).toHaveBeenCalledWith(0);
	});

	it('runs a fresh prompt through the TUI, streams JSONL entries, aggregates usage, and cleans images', async () => {
		const mod = await import('../../maestro-p/index');
		mockState.translateStreamJsonInput.mockReturnValue({
			prompt: 'rewritten @/tmp/image.png',
			imagePaths: ['/tmp/image.png'],
		});
		mockState.parseErrors = [{ line: '{bad json}', error: new Error('bad parse') }];
		mockState.tailerEntries = [
			{ type: 'user', message: { content: [{ type: 'text', text: 'prompt echo' }] } },
			{ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } },
			{
				type: 'assistant',
				message: {
					content: [{ type: 'text', text: 'answer' }],
					stop_reason: 'end_turn',
					usage: {
						input_tokens: 11,
						output_tokens: 7,
						cache_creation_input_tokens: 5,
						cache_read_input_tokens: 3,
					},
				},
			},
		];

		void mod.runMode(makeArgs({ prompt: '{"type":"user"}', streamJsonInput: true }));
		await flushMicrotasks();
		await vi.advanceTimersByTimeAsync(700);
		await flushMicrotasks();

		const driver = mockState.drivers[0];
		const tailer = mockState.tailers[0];
		const emitter = mockState.emitters[0];

		expect(driver.options.args).toEqual(['--model', 'sonnet', '--session-id', 'fresh-session-id']);
		expect(driver.send).toHaveBeenCalledWith('rewritten @/tmp/image.png');
		expect(mockState.discoverSessionId).toHaveBeenCalledWith({
			configDir: expect.any(String),
			cwd: expect.any(String),
			spawnTimestamp: expect.any(Number),
			expectSessionId: 'fresh-session-id',
			timeoutMs: 240000,
		});
		expect(tailer.options).toEqual({ path: '/tmp/session-1.jsonl', skipExisting: false });
		expect(emitter.emitInit).toHaveBeenCalledWith({
			sessionId: 'session-1',
			model: null,
			cwd: expect.any(String),
		});
		expect(emitter.emitUserMessage).toHaveBeenCalledWith({
			content: [{ type: 'tool_result', content: 'ok' }],
		});
		expect(emitter.emitAssistantMessage).toHaveBeenCalledWith({
			content: [{ type: 'text', text: 'answer' }],
			stop_reason: 'end_turn',
			usage: {
				input_tokens: 11,
				output_tokens: 7,
				cache_creation_input_tokens: 5,
				cache_read_input_tokens: 3,
			},
		});
		expect(emitter.emitResult).toHaveBeenCalledWith({
			sessionId: 'session-1',
			durationMs: expect.any(Number),
			isError: false,
			result: 'answer',
			usage: {
				input_tokens: 11,
				output_tokens: 7,
				cache_creation_input_tokens: 5,
				cache_read_input_tokens: 3,
			},
		});
		expect(mockState.cleanupStreamJsonImages).toHaveBeenCalledWith(['/tmp/image.png']);
		expect(tailer.stop).toHaveBeenCalledTimes(1);
		expect(driver.quit).toHaveBeenCalledTimes(1);
		expect(exitSpy).toHaveBeenCalledWith(0);
		expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('JSONL parse error'));
	});

	it('runs resume mode from the known session transcript without rediscovery', async () => {
		const mod = await import('../../maestro-p/index');
		mockState.tailerEntries = [
			{
				type: 'assistant',
				message: {
					content: [{ type: 'text', text: 'resumed answer' }],
					stop_reason: 'end_turn',
					usage: { input_tokens: 1, output_tokens: 2 },
				},
			},
		];

		void mod.runMode(makeArgs({ resumeSessionId: 'resume-session-id' }));
		await flushMicrotasks();
		await vi.advanceTimersByTimeAsync(700);
		await flushMicrotasks();

		expect(mockState.discoverSessionId).not.toHaveBeenCalled();
		expect(mockState.tailers[0].options).toEqual({
			path: expect.stringContaining('/projects/cwd-slug/resume-session-id.jsonl'),
			skipExisting: true,
		});
		expect(mockState.drivers[0].send).toHaveBeenCalledWith('hello');
		expect(mockState.emitters[0].emitInit).toHaveBeenCalledWith({
			sessionId: 'resume-session-id',
			model: null,
			cwd: expect.any(String),
		});
		expect(mockState.emitters[0].emitResult).toHaveBeenCalledWith({
			sessionId: 'resume-session-id',
			durationMs: expect.any(Number),
			isError: false,
			result: 'resumed answer',
			usage: {
				input_tokens: 1,
				output_tokens: 2,
				cache_creation_input_tokens: 0,
				cache_read_input_tokens: 0,
			},
		});
		expect(exitSpy).toHaveBeenCalledWith(0);
	});

	it('reports status parse failures and prompt/discovery failures with explicit exit codes', async () => {
		const mod = await import('../../maestro-p/index');

		exitSpy.mockImplementationOnce(((code?: string | number | null) => {
			mockState.exitCodes.push(code);
			throw new Error(`exit:${code}`);
		}) as typeof process.exit);
		await expect(mod.runMode(makeArgs({ prompt: null }))).rejects.toThrow('exit:1');
		expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('no prompt provided'));

		exitSpy.mockImplementation(((code?: string | number | null) => {
			mockState.exitCodes.push(code);
			return undefined as never;
		}) as typeof process.exit);
		mockState.parseUsage.mockReturnValue(null);
		const statusPromise = mod.statusMode(makeArgs({ mode: 'status', prompt: null }));
		await flushMicrotasks();
		await vi.advanceTimersByTimeAsync(2500);
		await statusPromise;
		expect(stderrSpy).toHaveBeenCalledWith('maestro-p: failed to parse /usage output\n');
		expect(exitSpy).toHaveBeenCalledWith(1);

		mockState.discoverSessionId.mockRejectedValueOnce(new Error('missing transcript'));
		void mod.runMode(makeArgs({ prompt: 'will time out' }));
		await flushMicrotasks();
		await vi.advanceTimersByTimeAsync(0);
		await flushMicrotasks();
		expect(mockState.emitters.at(-1).emitResult).toHaveBeenCalledWith({
			sessionId: '',
			durationMs: expect.any(Number),
			isError: true,
			error: 'first_byte_timeout',
		});
		expect(exitSpy).toHaveBeenCalledWith(5);
	});

	it('finalizes ready timeouts, TUI exits, and limit hits through result envelopes', async () => {
		const mod = await import('../../maestro-p/index');

		void mod.runMode(makeArgs({ prompt: 'ready timeout' }));
		await flushMicrotasks();
		mockState.drivers[0].emit('ready-timeout');
		await flushMicrotasks();
		expect(mockState.emitters[0].emitResult).toHaveBeenCalledWith({
			sessionId: '',
			durationMs: expect.any(Number),
			isError: true,
			error: 'ready_timeout',
		});
		expect(exitSpy).toHaveBeenCalledWith(4);
		vi.clearAllTimers();

		void mod.runMode(makeArgs({ prompt: 'tui exit' }));
		await flushMicrotasks();
		mockState.drivers[1].emit('exit');
		await flushMicrotasks();
		expect(mockState.emitters[1].emitResult).toHaveBeenCalledWith({
			sessionId: '',
			durationMs: expect.any(Number),
			isError: true,
			error: 'tui_exited',
		});
		expect(exitSpy).toHaveBeenCalledWith(1);
		vi.clearAllTimers();

		void mod.runMode(makeArgs({ prompt: 'limit' }));
		await flushMicrotasks();
		mockState.drivers[2].emit('limit-hit');
		await vi.advanceTimersByTimeAsync(700);
		await flushMicrotasks();
		expect(mockState.emitters[2].emitResult).toHaveBeenCalledWith({
			sessionId: 'session-1',
			durationMs: expect.any(Number),
			isError: true,
			error: 'limit',
			result: '',
			usage: {
				input_tokens: 0,
				output_tokens: 0,
				cache_creation_input_tokens: 0,
				cache_read_input_tokens: 0,
			},
		});
		expect(exitSpy).toHaveBeenCalledWith(2);
	});

	it('routes main to status mode and installs quiet stream error handlers', async () => {
		const mod = await import('../../maestro-p/index');
		mockState.parseUsage.mockReturnValue({
			type: 'status',
			config_dir: '/tmp/claude',
			session: { percent: 1, resets_at: '2026-06-18T12:00:00.000Z' },
			week_all_models: { percent: 2, resets_at: '2026-06-19T12:00:00.000Z' },
			week_sonnet_only: { percent: 3, resets_at: '2026-06-20T12:00:00.000Z' },
		});

		const promise = mod.main(['--status']);
		await flushMicrotasks();
		await vi.advanceTimersByTimeAsync(2500);
		await promise;
		expect(exitSpy).toHaveBeenCalledWith(0);

		const stream = new EventEmitter() as NodeJS.WritableStream;
		mod.installProcessStreamErrorHandlers([stream]);
		stream.emit('error', { code: 'EPIPE' });
		expect(exitSpy).toHaveBeenCalledWith(0);
		expect(() => stream.emit('error', { code: 'OTHER' })).toThrow();
	});
});
