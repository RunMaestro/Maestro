import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	spawn: vi.fn(),
	isWindows: vi.fn(() => false),
	readFileSync: vi.fn(),
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
	getAgentCapabilities: vi.fn(),
	getOutputParser: vi.fn(),
	buildChildProcessEnv: vi.fn(),
	collectMaestroEnvVars: vi.fn(),
	saveImageToTempFile: vi.fn(),
	buildImagePromptPrefix: vi.fn(),
	cleanupTempFiles: vi.fn(),
	buildStreamJsonMessage: vi.fn(),
	escapeArgsForShell: vi.fn(),
	isPowerShellShell: vi.fn(),
}));

vi.mock('child_process', async (importOriginal) => {
	const actual = await importOriginal<typeof import('child_process')>();
	return {
		...actual,
		spawn: mocks.spawn,
		default: {
			...actual,
			spawn: mocks.spawn,
		},
	};
});

vi.mock('fs', async (importOriginal) => {
	const actual = await importOriginal<typeof import('fs')>();
	return {
		...actual,
		readFileSync: mocks.readFileSync,
	};
});

vi.mock('../../main/utils/logger', () => ({
	logger: mocks.logger,
}));

vi.mock('../../main/parsers', () => ({
	createOutputParser: mocks.getOutputParser,
	getOutputParser: mocks.getOutputParser,
}));

vi.mock('../../main/agents', () => ({
	getAgentCapabilities: mocks.getAgentCapabilities,
}));

vi.mock('../../shared/platformDetection', () => ({
	isWindows: mocks.isWindows,
}));

vi.mock('../../main/process-manager/utils/envBuilder', () => ({
	buildChildProcessEnv: mocks.buildChildProcessEnv,
	collectMaestroEnvVars: mocks.collectMaestroEnvVars,
}));

vi.mock('../../main/process-manager/utils/imageUtils', () => ({
	saveImageToTempFile: mocks.saveImageToTempFile,
	buildImagePromptPrefix: mocks.buildImagePromptPrefix,
	cleanupTempFiles: mocks.cleanupTempFiles,
}));

vi.mock('../../main/process-manager/utils/streamJsonBuilder', () => ({
	buildStreamJsonMessage: mocks.buildStreamJsonMessage,
}));

vi.mock('../../main/process-manager/utils/shellEscape', () => ({
	escapeArgsForShell: mocks.escapeArgsForShell,
	isPowerShellShell: mocks.isPowerShellShell,
}));

import { ChildProcessSpawner } from '../../main/process-manager/spawners/ChildProcessSpawner';
import type { ManagedProcess, ProcessConfig } from '../../main/process-manager/types';

type MockStdio = EventEmitter & {
	setEncoding: ReturnType<typeof vi.fn>;
	write?: ReturnType<typeof vi.fn>;
	end?: ReturnType<typeof vi.fn>;
};

type MockChildProcess = EventEmitter & {
	pid?: number;
	stdout: MockStdio | null;
	stderr: MockStdio | null;
	stdin: MockStdio | null;
	killed: boolean;
	exitCode: number | null;
};

function createMockStdio(): MockStdio {
	return Object.assign(new EventEmitter(), {
		setEncoding: vi.fn(),
		write: vi.fn(),
		end: vi.fn(),
	});
}

function createMockChildProcess(overrides: Partial<MockChildProcess> = {}): MockChildProcess {
	return Object.assign(new EventEmitter(), {
		pid: 12345,
		stdout: createMockStdio(),
		stderr: createMockStdio(),
		stdin: createMockStdio(),
		killed: false,
		exitCode: null,
		...overrides,
	});
}

function createParser() {
	return {
		agentId: 'integration-agent',
		parseJsonObject: vi.fn((parsed: any) => {
			if (parsed?.type === 'result' || typeof parsed?.result === 'string') {
				return { type: 'result', text: parsed.text ?? parsed.result, raw: parsed };
			}
			if (parsed?.type === 'text') {
				return { type: 'text', text: parsed.text, isPartial: !!parsed.isPartial, raw: parsed };
			}
			return null;
		}),
		parseJsonLine: vi.fn((line: string) => {
			const parsed = JSON.parse(line);
			return { type: parsed.type, text: parsed.text ?? parsed.result };
		}),
		isResultMessage: vi.fn((event: any) => event?.type === 'result'),
		extractUsage: vi.fn((event: any) => {
			const usage = event?.raw?.usage;
			if (!usage) return null;
			return {
				inputTokens: usage.input_tokens ?? usage.inputTokens ?? 0,
				outputTokens: usage.output_tokens ?? usage.outputTokens ?? 0,
				costUsd: event.raw.total_cost_usd ?? usage.costUsd ?? 0,
			};
		}),
		extractSessionId: vi.fn((event: any) => event?.raw?.session_id ?? null),
		extractSlashCommands: vi.fn(() => []),
		detectErrorFromLine: vi.fn(() => null),
		detectErrorFromParsed: vi.fn(() => null),
		detectErrorFromExit: vi.fn(() => null),
	};
}

function createContext() {
	const processes = new Map<string, ManagedProcess>();
	const emitter = new EventEmitter();
	const bufferManager = {
		emitDataBuffered: vi.fn(),
		flushDataBuffer: vi.fn(),
	};
	const events: Array<[string, ...unknown[]]> = [];
	for (const event of [
		'raw-stdout',
		'data',
		'stderr',
		'exit',
		'agent-error',
		'session-id',
		'usage',
		'query-complete',
	]) {
		emitter.on(event, (...args) => events.push([event, ...args]));
	}

	const spawner = new ChildProcessSpawner(processes, emitter, bufferManager as any);

	return { processes, emitter, bufferManager, events, spawner };
}

function baseConfig(overrides: Partial<ProcessConfig> = {}): ProcessConfig {
	return {
		sessionId: 'session-1',
		toolType: 'claude-code',
		cwd: '/tmp/project',
		command: 'claude',
		args: ['--print'],
		...overrides,
	};
}

describe('ChildProcessSpawner integration', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.isWindows.mockReturnValue(false);
		mocks.getAgentCapabilities.mockReturnValue({
			supportsStreamJsonInput: true,
		});
		mocks.getOutputParser.mockImplementation(() => createParser());
		mocks.buildChildProcessEnv.mockReturnValue({ PATH: '/usr/bin', MAESTRO: '1' });
		mocks.collectMaestroEnvVars.mockReturnValue({});
		mocks.saveImageToTempFile.mockImplementation(
			(_image: string, index: number) => `/tmp/maestro-image-${index}.png`
		);
		mocks.buildImagePromptPrefix.mockImplementation((paths: string[]) =>
			paths.length ? `[Attached images: ${paths.join(', ')}]\n\n` : ''
		);
		mocks.buildStreamJsonMessage.mockReturnValue('{"type":"user","message":"hello"}');
		mocks.escapeArgsForShell.mockImplementation((args: string[]) => args);
		mocks.isPowerShellShell.mockReturnValue(false);
		mocks.readFileSync.mockImplementation(() => {
			throw new Error('unreadable');
		});
		mocks.spawn.mockImplementation(() => createMockChildProcess());
	});

	it('spawns an interactive process and routes stdio through the real handlers', async () => {
		const { processes, bufferManager, events, spawner } = createContext();

		const result = spawner.spawn(baseConfig({ args: ['chat'] }));
		const child = mocks.spawn.mock.results[0].value as MockChildProcess;

		expect(result).toEqual({ pid: 12345, success: true });
		expect(mocks.spawn).toHaveBeenCalledWith(
			'claude',
			['chat'],
			expect.objectContaining({
				cwd: '/tmp/project',
				env: { PATH: '/usr/bin', MAESTRO: '1' },
				shell: false,
				stdio: ['pipe', 'pipe', 'pipe'],
			})
		);
		expect(processes.get('session-1')).toMatchObject({
			sessionId: 'session-1',
			isBatchMode: false,
			isStreamJsonMode: true,
			pid: 12345,
		});

		const stdoutLine = '{"type":"result","text":"plain output"}\n';
		child.stdout?.emit('data', Buffer.from(stdoutLine));
		child.stderr?.emit('data', Buffer.from('warning output'));
		child.emit('close', 0);
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(events).toContainEqual(['raw-stdout', 'session-1', stdoutLine]);
		expect(bufferManager.emitDataBuffered).toHaveBeenCalledWith('session-1', 'plain output');
		expect(events).not.toContainEqual(['stderr', 'session-1', 'warning output']);
		expect(events).toContainEqual(['exit', 'session-1', 0]);
		expect(processes.has('session-1')).toBe(false);
	});

	it('accumulates batch output, emits metadata, and records environment context', async () => {
		const { events, bufferManager, spawner } = createContext();

		spawner.spawn(
			baseConfig({
				args: ['run'],
				prompt: 'summarize',
				promptArgs: (prompt) => ['--prompt', prompt],
				customEnvVars: { LOCAL_ONLY: '1' },
				shellEnvVars: { GLOBAL_TOKEN: 'redacted' },
				contextWindow: 200000,
				querySource: 'auto',
				tabId: 'tab-1',
				projectPath: '/tmp/project',
			})
		);
		const child = mocks.spawn.mock.results[0].value as MockChildProcess;

		expect(mocks.spawn.mock.calls[0][1]).toEqual(['run', '--prompt', 'summarize']);
		expect(mocks.buildChildProcessEnv).toHaveBeenCalledWith(
			{ LOCAL_ONLY: '1' },
			false,
			{
				GLOBAL_TOKEN: 'redacted',
			},
			undefined
		);
		expect(mocks.logger.debug).toHaveBeenCalledWith(
			'[ProcessManager] Applying global environment variables',
			'ProcessManager',
			expect.objectContaining({
				globalVarCount: 1,
				hasCustomVars: true,
				customVarCount: 1,
			})
		);

		child.stdout?.emit(
			'data',
			Buffer.from(
				`${JSON.stringify({
					result: 'batch result',
					session_id: 'agent-session',
					usage: { input_tokens: 3, output_tokens: 4 },
					total_cost_usd: 0.01,
				})}\n`
			)
		);
		child.emit('close', 0);
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(bufferManager.emitDataBuffered).toHaveBeenCalledWith('session-1', 'batch result');
		expect(events).toContainEqual(['session-id', 'session-1', 'agent-session']);
		expect(events).toContainEqual([
			'usage',
			'session-1',
			expect.objectContaining({
				inputTokens: 3,
				outputTokens: 4,
				totalCostUsd: 0.01,
				contextWindow: 200000,
			}),
		]);
		expect(events).toContainEqual([
			'query-complete',
			'session-1',
			expect.objectContaining({
				source: 'auto',
				projectPath: '/tmp/project',
				tabId: 'tab-1',
			}),
		]);

		spawner.spawn(
			baseConfig({
				sessionId: 'session-2',
				args: ['run'],
				prompt: 'no separator',
				noPromptSeparator: true,
			})
		);
		expect(mocks.spawn.mock.calls[1][1]).toEqual(['run', 'no separator']);
	});

	it('sends stream-json stdin for image prompts when the agent supports it', () => {
		const { processes, spawner } = createContext();

		spawner.spawn(
			baseConfig({
				args: ['--print', '--output-format', 'stream-json'],
				images: ['data:image/png;base64,abc123'],
				prompt: 'describe image',
			})
		);
		const child = mocks.spawn.mock.results[0].value as MockChildProcess;

		expect(mocks.spawn.mock.calls[0][1]).toEqual([
			'--print',
			'--output-format',
			'stream-json',
			'--input-format',
			'stream-json',
		]);
		expect(mocks.buildStreamJsonMessage).toHaveBeenCalledWith('describe image', [
			'data:image/png;base64,abc123',
		]);
		expect(child.stdin?.write).toHaveBeenCalledWith('{"type":"user","message":"hello"}\n');
		expect(child.stdin?.end).toHaveBeenCalled();
		expect(processes.get('session-1')).toMatchObject({
			isBatchMode: true,
			isStreamJsonMode: true,
		});

		spawner.spawn(
			baseConfig({
				sessionId: 'session-2',
				args: ['--input-format', 'stream-json'],
				images: ['data:image/png;base64,def456'],
				prompt: 'already configured',
			})
		);
		expect(mocks.spawn.mock.calls[1][1]).toEqual(['--input-format', 'stream-json']);
	});

	it('uses file image arguments and prompt-embedded resume prompts for non-stream-json agents', () => {
		mocks.getAgentCapabilities.mockReturnValue({
			supportsStreamJsonInput: false,
			imageResumeMode: 'prompt-embed',
		});
		const { processes, spawner } = createContext();

		spawner.spawn(
			baseConfig({
				toolType: 'codex',
				command: 'codex',
				args: ['exec', 'resume', '--resume', 'thread-1', '--json'],
				images: ['data:image/png;base64,abc123', 'data:image/jpeg;base64,def456'],
				prompt: 'compare images',
				imageArgs: (imagePath) => ['-i', imagePath],
				promptArgs: (prompt) => ['--prompt', prompt],
			})
		);
		const resumeArgs = mocks.spawn.mock.calls[0][1] as string[];
		expect(resumeArgs).not.toContain('-i');
		expect(resumeArgs).toContain('--prompt');
		expect(resumeArgs[resumeArgs.indexOf('--prompt') + 1]).toContain('/tmp/maestro-image-0.png');
		expect(resumeArgs[resumeArgs.indexOf('--prompt') + 1]).toContain('compare images');
		expect(mocks.buildChildProcessEnv).toHaveBeenCalledWith(undefined, true, undefined, undefined);
		expect(processes.get('session-1')?.tempImageFiles).toEqual([
			'/tmp/maestro-image-0.png',
			'/tmp/maestro-image-1.png',
		]);

		spawner.spawn(
			baseConfig({
				sessionId: 'session-2',
				toolType: 'codex',
				command: 'codex',
				args: ['exec', 'resume', 'thread-2'],
				images: ['data:image/png;base64,ghi789'],
				prompt: 'describe',
				imageArgs: (imagePath) => ['-i', imagePath],
				noPromptSeparator: true,
			})
		);
		const noSeparatorArgs = mocks.spawn.mock.calls[1][1] as string[];
		expect(noSeparatorArgs).not.toContain('--');
		expect(noSeparatorArgs.at(-1)).toContain('[Attached images:');

		mocks.getAgentCapabilities.mockReturnValue({
			supportsStreamJsonInput: false,
		});
		spawner.spawn(
			baseConfig({
				sessionId: 'session-3',
				toolType: 'opencode',
				command: 'opencode',
				args: ['run'],
				images: ['data:image/png;base64,jkl012'],
				prompt: 'initial',
				imageArgs: (imagePath) => ['-f', imagePath],
				promptArgs: (prompt) => ['--message', prompt],
			})
		);
		expect(mocks.spawn.mock.calls[2][1]).toEqual([
			'run',
			'-f',
			'/tmp/maestro-image-0.png',
			'--message',
			'initial',
		]);

		mocks.getAgentCapabilities.mockReturnValue({
			supportsStreamJsonInput: false,
			imageResumeMode: 'prompt-embed',
		});
		spawner.spawn(
			baseConfig({
				sessionId: 'session-4',
				toolType: 'codex',
				command: 'codex',
				args: ['exec', 'resume', 'thread-4'],
				images: ['data:image/png;base64,mno345'],
				prompt: 'default resume prompt',
				imageArgs: (imagePath) => ['-i', imagePath],
			})
		);
		const defaultResumeArgs = mocks.spawn.mock.calls[3][1] as string[];
		expect(defaultResumeArgs).toContain('--');
		expect(defaultResumeArgs[defaultResumeArgs.indexOf('--') + 1]).toContain(
			'default resume prompt'
		);

		mocks.getAgentCapabilities.mockReturnValue({
			supportsStreamJsonInput: false,
		});
		spawner.spawn(
			baseConfig({
				sessionId: 'session-5',
				toolType: 'opencode',
				command: 'opencode',
				args: ['run'],
				images: ['data:image/png;base64,pqr678'],
				prompt: 'initial no separator',
				imageArgs: (imagePath) => ['-f', imagePath],
				noPromptSeparator: true,
			})
		);
		expect(mocks.spawn.mock.calls[4][1]).toEqual([
			'run',
			'-f',
			'/tmp/maestro-image-0.png',
			'initial no separator',
		]);
	});

	it('supports raw stdin, SSH stdin scripts, and output-json prompt guards', () => {
		const { spawner } = createContext();

		spawner.spawn(
			baseConfig({
				args: ['ssh', 'dev-host', '/bin/bash'],
				sshStdinScript: 'cd /repo\nexec claude --print',
				sshRemoteId: 'remote-1',
				sshRemoteHost: 'dev.example.test',
			})
		);
		const sshChild = mocks.spawn.mock.results[0].value as MockChildProcess;
		expect(sshChild.stdin?.write).toHaveBeenCalledWith('cd /repo\nexec claude --print');
		expect(sshChild.stdin?.end).toHaveBeenCalled();
		expect(mocks.spawn.mock.calls[0][1]).toEqual(['ssh', 'dev-host', '/bin/bash']);

		spawner.spawn(
			baseConfig({
				sessionId: 'session-2',
				args: ['run'],
				prompt: 'literal text',
				sendPromptViaStdinRaw: true,
			})
		);
		const rawChild = mocks.spawn.mock.results[1].value as MockChildProcess;
		expect(mocks.spawn.mock.calls[1][1]).toEqual(['run']);
		expect(rawChild.stdin?.write).toHaveBeenCalledWith('literal text');
		expect(rawChild.stdin?.end).toHaveBeenCalled();

		mocks.getAgentCapabilities.mockReturnValue({
			supportsStreamJsonInput: false,
		});
		spawner.spawn(
			baseConfig({
				sessionId: 'session-3',
				toolType: 'codex',
				command: 'codex',
				args: ['exec', '--json'],
				prompt: 'codex prompt',
			})
		);
		const codexChild = mocks.spawn.mock.results[2].value as MockChildProcess;
		expect(mocks.spawn.mock.calls[2][1]).toEqual(['exec', '--json', '--', 'codex prompt']);
		expect(mocks.buildStreamJsonMessage).not.toHaveBeenCalledWith('codex prompt', []);
		expect(codexChild.stdin?.write).not.toHaveBeenCalled();
		expect(codexChild.stdin?.end).toHaveBeenCalled();
	});

	it('applies Windows shell handling for bare executables and shebang scripts', () => {
		mocks.isWindows.mockReturnValue(true);
		mocks.escapeArgsForShell.mockReturnValueOnce(['escaped prompt']);
		mocks.isPowerShellShell.mockReturnValueOnce(true);
		const { spawner } = createContext();

		spawner.spawn(
			baseConfig({
				command: 'agent.exe',
				args: ['--print'],
				prompt: 'hello',
				shell: 'pwsh.exe',
			})
		);

		expect(mocks.escapeArgsForShell).toHaveBeenCalledWith(['--print', '--', 'hello'], 'pwsh.exe');
		expect(mocks.spawn).toHaveBeenCalledWith(
			'agent.exe',
			['escaped prompt'],
			expect.objectContaining({ shell: 'pwsh.exe' })
		);
		expect(mocks.logger.info).toHaveBeenCalledWith(
			'[ProcessManager] Auto-enabling shell for Windows to allow PATH resolution of basename exe',
			'ProcessManager',
			{ command: 'agent.exe' }
		);

		mocks.readFileSync
			.mockReturnValueOnce('#!/usr/bin/env node\nprocess.exit(0)')
			.mockImplementationOnce(() => {
				throw new Error('denied');
			});
		spawner.spawn(
			baseConfig({
				sessionId: 'session-2',
				command: 'C:/tools/opencode',
				args: ['run'],
			})
		);
		spawner.spawn(
			baseConfig({
				sessionId: 'session-3',
				command: 'C:/tools/unreadable',
				args: ['run'],
			})
		);

		expect(mocks.spawn.mock.calls[1][2]).toEqual(expect.objectContaining({ shell: true }));
		expect(mocks.spawn.mock.calls[2][2]).toEqual(expect.objectContaining({ shell: false }));
	});

	it('logs stream errors, handles child errors, and cleans up image files', () => {
		mocks.getAgentCapabilities.mockReturnValue({
			supportsStreamJsonInput: false,
		});
		const { emitter, events, spawner } = createContext();
		emitter.on('raw-stdout', () => {
			throw new Error('raw listener failed');
		});

		spawner.spawn(
			baseConfig({
				args: ['exec'],
				images: ['data:image/png;base64,abc123'],
				prompt: 'describe',
				imageArgs: (imagePath) => ['-i', imagePath],
			})
		);
		const child = mocks.spawn.mock.results[0].value as MockChildProcess;

		child.stdin?.emit('error', Object.assign(new Error('closed'), { code: 'EPIPE' }));
		child.stdin?.emit('error', Object.assign(new Error('bad stdin'), { code: 'EINVAL' }));
		child.stdout?.emit('error', new Error('stdout failed'));
		child.stdout?.emit('data', Buffer.from('agent output'));
		child.stderr?.emit('error', new Error('stderr failed'));
		child.stderr?.emit('data', Buffer.from('agent stderr'));
		child.emit('error', new Error('child failed'));

		expect(mocks.logger.debug).toHaveBeenCalledWith(
			'[ProcessManager] stdin EPIPE - process closed before write completed',
			'ProcessManager',
			{ sessionId: 'session-1' }
		);
		expect(mocks.logger.error).toHaveBeenCalledWith(
			'[ProcessManager] stdin error',
			'ProcessManager',
			expect.objectContaining({ code: 'EINVAL' })
		);
		expect(mocks.logger.error).toHaveBeenCalledWith(
			'[ProcessManager] raw-stdout listener error',
			'ProcessManager',
			expect.objectContaining({ error: 'Error: raw listener failed' })
		);
		expect(mocks.logger.error).toHaveBeenCalledWith(
			'[ProcessManager] stderr error',
			'ProcessManager',
			expect.objectContaining({ error: 'Error: stderr failed' })
		);
		expect(mocks.cleanupTempFiles).toHaveBeenCalledWith(['/tmp/maestro-image-0.png']);
		expect(events).toContainEqual([
			'agent-error',
			'session-1',
			expect.objectContaining({
				type: 'agent_crashed',
				message: 'Agent process error: child failed',
			}),
		]);
		expect(events).toContainEqual(['exit', 'session-1', 1]);
	});

	it('handles missing stdio, missing parsers, missing pid, and spawn failures', () => {
		mocks.getOutputParser.mockReturnValueOnce(null);
		mocks.spawn
			.mockReturnValueOnce(
				createMockChildProcess({
					pid: undefined,
					stdout: null,
					stderr: null,
				})
			)
			.mockImplementationOnce(() => {
				throw new Error('spawn denied');
			});
		const { processes, spawner } = createContext();

		expect(spawner.spawn(baseConfig({ args: [], prompt: undefined }))).toEqual({
			pid: -1,
			success: true,
		});
		expect(processes.get('session-1')).toMatchObject({
			pid: -1,
			outputParser: undefined,
		});
		expect(mocks.logger.warn).toHaveBeenCalledWith(
			'[ProcessManager] childProcess.stdout is null',
			'ProcessManager',
			{ sessionId: 'session-1' }
		);

		expect(spawner.spawn(baseConfig({ sessionId: 'session-2' }))).toEqual({
			pid: -1,
			success: false,
		});
		expect(mocks.logger.error).toHaveBeenCalledWith(
			'[ProcessManager] Failed to spawn process',
			'ProcessManager',
			{ error: 'Error: spawn denied' }
		);
	});
});
