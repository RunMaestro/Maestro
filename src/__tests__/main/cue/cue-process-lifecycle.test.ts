/**
 * Tests for the Cue Process Lifecycle module.
 *
 * Verifies process spawning, stdio capture, timeout enforcement with
 * SIGTERM → SIGKILL escalation, active process tracking, and stop logic.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import type { SpawnSpec } from '../../../main/cue/cue-spawn-builder';
import { ClaudeOutputParser } from '../../../shared/maestro-lib/parsers/claude-output-parser';
import { GrokOutputParser } from '../../../shared/maestro-lib/parsers/grok-output-parser';

// ─── Mocks ───────────────────────────────────────────────────────────────────

// Mock parsers - default returns null (no parser)
const mockGetOutputParser = vi.fn((..._args: unknown[]) => null as any);
vi.mock('../../../main/parsers', () => ({
	getOutputParser: (...args: unknown[]) => mockGetOutputParser(...args),
	createOutputParser: (...args: unknown[]) => mockGetOutputParser(...args),
}));

// Mock Sentry
const mockCaptureException = vi.fn();
vi.mock('../../../main/utils/sentry', () => ({
	captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

// Platform is mockable per-test. Default is the POSIX kill path
// (child.kill('SIGTERM')) so the SIGTERM → SIGKILL assertions hold regardless
// of host OS - mirroring what CI exercises on Unix. The Windows process-tree
// kill tests flip this to true to exercise the taskkill branch.
const { mockIsWindows, mockExecFile, mockExecFileSync } = vi.hoisted(() => ({
	mockIsWindows: vi.fn(() => false),
	mockExecFile: vi.fn((_cmd: unknown, _args: unknown, _options: unknown, cb?: unknown) => {
		if (typeof cb === 'function') (cb as (e: Error | null) => void)(null);
	}),
	mockExecFileSync: vi.fn(),
}));
vi.mock('../../../shared/platformDetection', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../../shared/platformDetection')>();
	return {
		...actual,
		isWindows: () => mockIsWindows(),
	};
});

// Mock child_process.spawn
class MockChildProcess extends EventEmitter {
	pid = 12345;
	exitCode: number | null = null;
	signalCode: string | null = null;
	// An EventEmitter, like a real pipe: emitting 'error' with no listener throws.
	stdin = Object.assign(new EventEmitter(), {
		write: vi.fn(),
		end: vi.fn(),
	});
	stdout = new EventEmitter();
	stderr = new EventEmitter();
	killed = false;

	kill(_signal?: string) {
		this.killed = true;
		return true;
	}

	constructor() {
		super();
		(this.stdout as any).setEncoding = vi.fn();
		(this.stderr as any).setEncoding = vi.fn();
	}
}

let mockChild: MockChildProcess;
const mockSpawn = vi.fn((..._args: unknown[]) => {
	mockChild = new MockChildProcess();
	return mockChild as unknown as ChildProcess;
});

vi.mock('child_process', async (importOriginal) => {
	const actual = await importOriginal<typeof import('child_process')>();
	return {
		...actual,
		spawn: (...args: unknown[]) => mockSpawn(...args),
		execFile: (...args: unknown[]) =>
			mockExecFile(...(args as [unknown, unknown, unknown, unknown?])),
		execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
		default: {
			...actual,
			spawn: (...args: unknown[]) => mockSpawn(...args),
			execFile: (...args: unknown[]) =>
				mockExecFile(...(args as [unknown, unknown, unknown, unknown?])),
			execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
		},
	};
});

const { mockSignalRemoteAgent } = vi.hoisted(() => ({ mockSignalRemoteAgent: vi.fn() }));
vi.mock('../../../main/utils/ssh-remote-signal', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../main/utils/ssh-remote-signal')>()),
	signalRemoteAgent: mockSignalRemoteAgent,
}));

// Must import after mocks
import {
	runProcess,
	stopProcess,
	stopAllProcesses,
	trackCueProcess,
	getActiveProcessMap,
	getProcessList,
} from '../../../main/cue/cue-process-lifecycle';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createSpec(overrides: Partial<SpawnSpec> = {}): SpawnSpec {
	return {
		command: 'claude',
		args: ['--print', '--', 'test prompt'],
		cwd: '/projects/test',
		env: { PATH: '/usr/bin' },
		...overrides,
	};
}

function createOptions(overrides = {}) {
	return {
		toolType: 'claude-code',
		timeoutMs: 30000,
		onLog: vi.fn(),
		...overrides,
	};
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('cue-process-lifecycle', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// Default to the POSIX branch; Windows tests opt in via mockReturnValue(true).
		mockIsWindows.mockReturnValue(false);
		vi.useFakeTimers();
		getActiveProcessMap().clear();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	// Cue spawns agents directly rather than through the ProcessManager, so the
	// desktop's WakaTime listener never sees these runs. `onActivity` is the
	// hook that lets a run beat for its whole duration instead of going
	// unrecorded - a long Cue run would otherwise blow past WakaTime's idle
	// timeout with nothing reported.
	describe('onActivity (WakaTime heartbeat hook)', () => {
		it('fires on each stdout chunk so long runs keep beating', async () => {
			const onActivity = vi.fn();
			const resultPromise = runProcess('run-1', createSpec(), createOptions({ onActivity }));
			await vi.advanceTimersByTimeAsync(0);

			mockChild.stdout.emit('data', 'chunk one');
			mockChild.stdout.emit('data', 'chunk two');

			expect(onActivity).toHaveBeenCalledTimes(2);

			mockChild.emit('close', 0);
			await resultPromise;
		});

		it('fires on stderr too - a run streaming only stderr is still working', async () => {
			const onActivity = vi.fn();
			const resultPromise = runProcess('run-1', createSpec(), createOptions({ onActivity }));
			await vi.advanceTimersByTimeAsync(0);

			mockChild.stderr.emit('data', 'progress on stderr');

			expect(onActivity).toHaveBeenCalledTimes(1);

			mockChild.emit('close', 0);
			await resultPromise;
		});

		it('is optional - runs still complete and capture output without it', async () => {
			const resultPromise = runProcess('run-1', createSpec(), createOptions());
			await vi.advanceTimersByTimeAsync(0);

			mockChild.stdout.emit('data', 'hello');
			mockChild.emit('close', 0);

			const result = await resultPromise;
			expect(result.stdout).toContain('hello');
			expect(result.status).toBe('completed');
		});
	});

	// The result's `stdout` is cleaned text, so a caller that needs the stream
	// the agent actually printed (the chain of thought export) reads it here.
	describe('onRawStdout (raw stream hook)', () => {
		// `mockReturnValue` outlives `clearAllMocks`, so put the no-parser default
		// back for the tests that run after these.
		afterEach(() => {
			mockGetOutputParser.mockReturnValue(null);
		});

		const parsingParser = {
			parseJsonLine: (line: string) => {
				const msg = JSON.parse(line);
				return msg.type === 'result' ? { type: 'result', text: msg.result } : null;
			},
		};

		it('hands over the raw stream while the result carries the cleaned text', async () => {
			mockGetOutputParser.mockReturnValue(parsingParser as any);
			const onRawStdout = vi.fn();
			const raw = [
				JSON.stringify({ type: 'system', note: 'init' }),
				JSON.stringify({ type: 'result', result: 'Cleaned answer' }),
			].join('\n');

			const resultPromise = runProcess(
				'run-1',
				createSpec(),
				createOptions({ toolType: 'claude-code', onRawStdout })
			);
			await vi.advanceTimersByTimeAsync(0);
			mockChild.stdout.emit('data', raw.slice(0, 20));
			mockChild.stdout.emit('data', raw.slice(20));
			mockChild.emit('close', 0);
			const result = await resultPromise;

			expect(result.stdout).toBe('Cleaned answer');
			expect(onRawStdout).toHaveBeenCalledTimes(1);
			expect(onRawStdout).toHaveBeenCalledWith(raw);
		});

		it('leaves the result unchanged when the observer throws', async () => {
			mockGetOutputParser.mockReturnValue(parsingParser as any);
			const raw = JSON.stringify({ type: 'result', result: 'Answer' });

			const run = async (options: Record<string, unknown>) => {
				const resultPromise = runProcess('run-1', createSpec(), createOptions(options));
				await vi.advanceTimersByTimeAsync(0);
				mockChild.stdout.emit('data', raw);
				mockChild.emit('close', 0);
				return resultPromise;
			};

			const without = await run({ toolType: 'claude-code' });
			const throwing = await run({
				toolType: 'claude-code',
				onRawStdout: () => {
					throw new Error('observer failed');
				},
			});

			expect(throwing).toEqual(without);
			expect(throwing.status).toBe('completed');
		});

		it('is not called when the process never started', async () => {
			mockSpawn.mockImplementationOnce(() => {
				throw new Error('spawn blew up');
			});
			const onRawStdout = vi.fn();

			const result = await runProcess('run-1', createSpec(), createOptions({ onRawStdout }));

			expect(result.status).toBe('failed');
			expect(onRawStdout).not.toHaveBeenCalled();
			expect(result.executionStarted).toBe(false);
		});
	});

	describe('runProcess', () => {
		it('retains execution uncertainty if setup throws after spawn returned', async () => {
			mockSpawn.mockImplementationOnce(() => {
				mockChild = new MockChildProcess();
				mockChild.stdin.end.mockImplementationOnce(() => {
					throw Error('post-spawn setup failed');
				});
				return mockChild as unknown as ChildProcess;
			});
			const result = await runProcess('uncertain-run', createSpec(), createOptions());
			expect(result.executionStarted).toBe(true);
			expect(result.stderr).toContain('post-spawn setup failed');
		});
		it('neither spawns nor registers a process for a run already stopped', async () => {
			const controller = new AbortController();
			controller.abort();
			const result = await runProcess(
				'stopped-run',
				createSpec(),
				createOptions({ signal: controller.signal })
			);
			expect(mockSpawn).not.toHaveBeenCalled();
			expect(getActiveProcessMap().has('stopped-run')).toBe(false);
			expect(result).toMatchObject({
				status: 'stopped',
				executionStarted: false,
				exitCode: null,
				stdout: '',
				stderr: '',
			});
		});

		it('spawns process with correct command, args, and cwd', async () => {
			const spec = createSpec();
			const resultPromise = runProcess('run-1', spec, createOptions());
			await vi.advanceTimersByTimeAsync(0);

			// Local mode: stdin is `'ignore'` so agents like Codex don't print
			// "Reading additional input from stdin..." into the run output.
			expect(mockSpawn).toHaveBeenCalledWith(
				'claude',
				['--print', '--', 'test prompt'],
				expect.objectContaining({
					cwd: '/projects/test',
					stdio: ['ignore', 'pipe', 'pipe'],
				})
			);

			mockChild.emit('close', 0);
			await resultPromise;
		});

		it('starts a local Windows .cmd shim through cmd.exe (MAESTRO-R0)', async () => {
			mockIsWindows.mockReturnValue(true);
			const shim = 'C:\\Users\\First Last\\AppData\\Roaming\\npm\\codex.cmd';
			const spec = createSpec({ command: shim, args: ['exec', '--json'] });
			const resultPromise = runProcess(
				'run-1',
				spec,
				createOptions({ stdinPrompt: 'line one\nline two' })
			);
			await vi.advanceTimersByTimeAsync(0);

			expect(mockSpawn).toHaveBeenCalledWith(
				`"${shim}"`,
				['exec', '--json'],
				expect.objectContaining({ shell: true, stdio: ['pipe', 'pipe', 'pipe'] })
			);
			expect(mockChild.stdin.write).toHaveBeenCalledWith(
				'line one\nline two',
				expect.any(Function)
			);

			mockChild.emit('close', 0);
			await resultPromise;
		});

		it('absorbs stdin EPIPE when the child exits mid-write, and settles on the exit', async () => {
			mockIsWindows.mockReturnValue(true);
			const shim = 'C:\\Users\\dev\\AppData\\Roaming\\npm\\codex.cmd';
			const prompt = 'x'.repeat(2_000_000);
			const resultPromise = runProcess(
				'run-1',
				createSpec({ command: shim, args: ['exec', '--json'] }),
				createOptions({ stdinPrompt: prompt })
			);
			await vi.advanceTimersByTimeAsync(0);

			const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
			expect(() => mockChild.stdin.emit('error', epipe)).not.toThrow();
			const writeCallback = mockChild.stdin.write.mock.calls[0][1] as (e?: Error) => void;
			writeCallback(epipe);

			mockChild.emit('close', 1);
			expect((await resultPromise).status).toBe('failed');
		});

		it('does not put an SSH client behind a shell on Windows', async () => {
			mockIsWindows.mockReturnValue(true);
			const spec = createSpec({ command: 'C:\\Tools\\ssh.cmd', args: ['host'] });
			const resultPromise = runProcess(
				'run-1',
				spec,
				createOptions({ sshRemoteEnabled: true, sshStdinScript: 'echo hi' })
			);
			await vi.advanceTimersByTimeAsync(0);

			expect(mockSpawn).toHaveBeenCalledWith(
				'C:\\Tools\\ssh.cmd',
				['host'],
				expect.objectContaining({ shell: false })
			);

			mockChild.emit('close', 0);
			await resultPromise;
		});

		it('captures stdout and returns it in result', async () => {
			const resultPromise = runProcess('run-1', createSpec(), createOptions());
			await vi.advanceTimersByTimeAsync(0);

			mockChild.stdout.emit('data', 'Hello ');
			mockChild.stdout.emit('data', 'world');
			mockChild.emit('close', 0);

			const result = await resultPromise;
			expect(result.stdout).toBe('Hello world');
		});

		it('captures stderr and returns it in result', async () => {
			const resultPromise = runProcess('run-1', createSpec(), createOptions());
			await vi.advanceTimersByTimeAsync(0);

			mockChild.stderr.emit('data', 'Warning: something');
			mockChild.emit('close', 0);

			const result = await resultPromise;
			expect(result.stderr).toBe('Warning: something');
		});

		it('returns completed status on exit code 0', async () => {
			const resultPromise = runProcess('run-1', createSpec(), createOptions());
			await vi.advanceTimersByTimeAsync(0);

			mockChild.emit('close', 0);
			const result = await resultPromise;

			expect(result.status).toBe('completed');
			expect(result.exitCode).toBe(0);
		});

		it('returns failed status on non-zero exit code', async () => {
			const resultPromise = runProcess('run-1', createSpec(), createOptions());
			await vi.advanceTimersByTimeAsync(0);

			mockChild.emit('close', 1);
			const result = await resultPromise;

			expect(result.status).toBe('failed');
			expect(result.exitCode).toBe(1);
		});

		it('handles spawn errors gracefully', async () => {
			const resultPromise = runProcess('run-1', createSpec(), createOptions());
			await vi.advanceTimersByTimeAsync(0);

			mockChild.emit('error', new Error('spawn ENOENT'));
			const result = await resultPromise;

			expect(result.status).toBe('failed');
			expect(result.stderr).toContain('Spawn error: spawn ENOENT');
			expect(result.exitCode).toBeNull();
		});

		it('tracks the process in activeProcesses while running', async () => {
			const resultPromise = runProcess('tracked-run', createSpec(), createOptions());
			await vi.advanceTimersByTimeAsync(0);

			expect(getActiveProcessMap().has('tracked-run')).toBe(true);

			mockChild.emit('close', 0);
			await resultPromise;

			expect(getActiveProcessMap().has('tracked-run')).toBe(false);
		});

		it('closes stdin for local execution', async () => {
			const resultPromise = runProcess('run-1', createSpec(), createOptions());
			await vi.advanceTimersByTimeAsync(0);

			expect(mockChild.stdin.end).toHaveBeenCalled();

			mockChild.emit('close', 0);
			await resultPromise;
		});

		describe('stdin modes', () => {
			it('writes sshStdinScript to stdin for SSH stdin-script mode', async () => {
				const spec = createSpec({ sshStdinScript: '#!/bin/bash\nclaude "prompt"' });
				const resultPromise = runProcess(
					'run-1',
					spec,
					createOptions({
						sshRemoteEnabled: true,
						sshStdinScript: '#!/bin/bash\nclaude "prompt"',
					})
				);
				await vi.advanceTimersByTimeAsync(0);

				expect(mockChild.stdin.write).toHaveBeenCalledWith(
					'#!/bin/bash\nclaude "prompt"',
					expect.any(Function)
				);
				expect(mockChild.stdin.end).toHaveBeenCalled();

				mockChild.emit('close', 0);
				await resultPromise;
			});

			// Killing the local ssh client alone leaves the remote agent running, so a
			// stop must also reach the remote host.
			it('records the remote pid and terminates the remote agent on stop', async () => {
				const sshArgs = ['u@h', '/bin/bash', '--norc', '--noprofile', '-s'];
				const spec = createSpec({ command: '/usr/bin/ssh', args: sshArgs });
				const resultPromise = runProcess(
					'run-ssh',
					spec,
					createOptions({ sshRemoteEnabled: true, sshStdinScript: 'exec claude\n' })
				);
				await vi.advanceTimersByTimeAsync(0);

				const written = mockChild.stdin.write.mock.calls[0][0] as string;
				const pidFile = getActiveProcessMap().get('run-ssh')?.sshRemotePidFile;
				expect(pidFile).toMatch(/^\/tmp\/maestro-agent-/);
				expect(written).toContain(pidFile);
				expect(written.endsWith('exec claude\n')).toBe(true);

				expect(stopProcess('run-ssh')).toBe(true);
				expect(mockSignalRemoteAgent).toHaveBeenCalledWith(
					{ sshCommand: '/usr/bin/ssh', sshArgs, pidFile, sessionId: 'run-ssh' },
					'terminate'
				);

				mockChild.emit('close', 143);
				await resultPromise;
			});

			it('terminates the remote agent when the run times out', async () => {
				const sshArgs = ['u@h', '/bin/bash', '--norc', '--noprofile', '-s'];
				const spec = createSpec({ command: '/usr/bin/ssh', args: sshArgs });
				const resultPromise = runProcess(
					'run-ssh-timeout',
					spec,
					createOptions({
						sshRemoteEnabled: true,
						sshStdinScript: 'exec claude\n',
						timeoutMs: 5000,
					})
				);
				await vi.advanceTimersByTimeAsync(0);
				const pidFile = getActiveProcessMap().get('run-ssh-timeout')?.sshRemotePidFile;
				expect(mockSignalRemoteAgent).not.toHaveBeenCalled();

				await vi.advanceTimersByTimeAsync(5000);
				expect(mockSignalRemoteAgent).toHaveBeenCalledWith(
					{ sshCommand: '/usr/bin/ssh', sshArgs, pidFile, sessionId: 'run-ssh-timeout' },
					'terminate'
				);

				mockChild.emit('close', null);
				expect((await resultPromise).status).toBe('timeout');
			});

			it('terminates the remote agent on shutdown', async () => {
				const sshArgs = ['u@h', '/bin/bash', '--norc', '--noprofile', '-s'];
				const spec = createSpec({ command: '/usr/bin/ssh', args: sshArgs });
				const resultPromise = runProcess(
					'run-ssh-shutdown',
					spec,
					createOptions({ sshRemoteEnabled: true, sshStdinScript: 'exec claude\n' })
				);
				await vi.advanceTimersByTimeAsync(0);
				const pidFile = getActiveProcessMap().get('run-ssh-shutdown')?.sshRemotePidFile;

				stopAllProcesses();
				expect(mockSignalRemoteAgent).toHaveBeenCalledWith(
					{ sshCommand: '/usr/bin/ssh', sshArgs, pidFile, sessionId: 'run-ssh-shutdown' },
					'terminate'
				);

				mockChild.emit('close', 143);
				await resultPromise;
			});

			// The pid record only fits a script piped to `bash -s`; any other spawn
			// keeps its stdin byte for byte and has nothing remote to signal.
			it('records no remote pid for a spawn that is not a stdin-script ssh', async () => {
				const resultPromise = runProcess(
					'run-local',
					createSpec(),
					createOptions({ sshRemoteEnabled: true, sshStdinScript: 'exec claude\n' })
				);
				await vi.advanceTimersByTimeAsync(0);

				expect(getActiveProcessMap().get('run-local')?.sshRemotePidFile).toBeUndefined();
				expect(mockChild.stdin.write.mock.calls[0][0]).toBe('exec claude\n');
				stopProcess('run-local');
				expect(mockSignalRemoteAgent).not.toHaveBeenCalled();

				mockChild.emit('close', 143);
				await resultPromise;
			});

			it('writes stdinPrompt to stdin for SSH prompt mode', async () => {
				const spec = createSpec({ stdinPrompt: 'large prompt' });
				const resultPromise = runProcess(
					'run-1',
					spec,
					createOptions({
						sshRemoteEnabled: true,
						stdinPrompt: 'large prompt',
					})
				);
				await vi.advanceTimersByTimeAsync(0);

				expect(mockChild.stdin.write).toHaveBeenCalledWith('large prompt', expect.any(Function));
				expect(mockChild.stdin.end).toHaveBeenCalled();

				mockChild.emit('close', 0);
				await resultPromise;
			});
		});

		describe('timeout enforcement', () => {
			it('sends SIGTERM when timeout expires', async () => {
				const resultPromise = runProcess('run-1', createSpec(), createOptions({ timeoutMs: 5000 }));
				await vi.advanceTimersByTimeAsync(0);

				const childKill = vi.spyOn(mockChild, 'kill');

				await vi.advanceTimersByTimeAsync(5000);
				expect(childKill).toHaveBeenCalledWith('SIGTERM');

				mockChild.emit('close', null);
				const result = await resultPromise;
				expect(result.status).toBe('timeout');
			});

			it('escalates to SIGKILL after SIGTERM + delay', async () => {
				const resultPromise = runProcess('run-1', createSpec(), createOptions({ timeoutMs: 5000 }));
				await vi.advanceTimersByTimeAsync(0);

				const childKill = vi.spyOn(mockChild, 'kill');

				await vi.advanceTimersByTimeAsync(5000);
				expect(childKill).toHaveBeenCalledWith('SIGTERM');

				mockChild.killed = false;
				await vi.advanceTimersByTimeAsync(5000);
				expect(childKill).toHaveBeenCalledWith('SIGKILL');

				mockChild.emit('close', null);
				await resultPromise;
			});

			it('does not timeout when timeoutMs is 0', async () => {
				const resultPromise = runProcess('run-1', createSpec(), createOptions({ timeoutMs: 0 }));
				await vi.advanceTimersByTimeAsync(0);

				const childKill = vi.spyOn(mockChild, 'kill');

				await vi.advanceTimersByTimeAsync(60000);
				expect(childKill).not.toHaveBeenCalled();

				mockChild.emit('close', 0);
				await resultPromise;
			});

			it('logs timeout messages', async () => {
				const onLog = vi.fn();
				const resultPromise = runProcess(
					'run-1',
					createSpec(),
					createOptions({
						timeoutMs: 5000,
						onLog,
					})
				);
				await vi.advanceTimersByTimeAsync(0);

				await vi.advanceTimersByTimeAsync(5000);

				expect(onLog).toHaveBeenCalledWith('cue', expect.stringContaining('timed out'));

				mockChild.emit('close', null);
				await resultPromise;
			});
		});

		describe('turn outcome', () => {
			const resultParser = (detectErrorFromExit?: () => unknown) =>
				({
					parseJsonLine: (line: string) => {
						try {
							const msg = JSON.parse(line);
							if (msg.type === 'result') return { type: 'result', text: msg.result || '' };
							return { type: 'system', raw: msg };
						} catch {
							return null;
						}
					},
					detectErrorFromExit: detectErrorFromExit ?? (() => null),
				}) as any;

			it('completes a run that answered in full and then exited non-zero', async () => {
				mockGetOutputParser.mockReturnValue(resultParser());

				const resultPromise = runProcess('run-1', createSpec(), createOptions());
				await vi.advanceTimersByTimeAsync(0);

				mockChild.stdout.emit('data', JSON.stringify({ type: 'result', result: 'all done' }));
				mockChild.emit('close', 1, null);
				const result = await resultPromise;

				expect(result.status).toBe('completed');
				expect(result.stdout).toBe('all done');
				expect(result.exitCode).toBe(1);
			});

			it('fails a run whose provider classified the exit as an error', async () => {
				mockGetOutputParser.mockReturnValue(
					resultParser(() => ({ type: 'auth_required', message: 'token expired' }))
				);

				const resultPromise = runProcess('run-1', createSpec(), createOptions());
				await vi.advanceTimersByTimeAsync(0);

				mockChild.stdout.emit('data', JSON.stringify({ type: 'result', result: 'partial' }));
				mockChild.emit('close', 1, null);

				expect((await resultPromise).status).toBe('failed');
			});

			it('reports a stopped run as stopped, not failed', async () => {
				mockGetOutputParser.mockReturnValue(resultParser());

				const resultPromise = runProcess('run-1', createSpec(), createOptions());
				await vi.advanceTimersByTimeAsync(0);

				expect(stopProcess('run-1')).toBe(true);
				mockChild.emit('close', null, 'SIGTERM');

				expect((await resultPromise).status).toBe('stopped');
			});

			it('sums per-step usage across a run', async () => {
				mockGetOutputParser.mockReturnValue({
					...resultParser(),
					extractUsage: (event: any) => event?.usage ?? null,
					parseJsonLine: (line: string) => {
						const msg = JSON.parse(line);
						return msg.type === 'result'
							? { type: 'result', text: msg.result || '', usage: msg.usage }
							: { type: 'system', raw: msg, usage: msg.usage };
					},
				} as any);

				const resultPromise = runProcess(
					'run-1',
					createSpec(),
					createOptions({ toolType: 'copilot-cli' })
				);
				await vi.advanceTimersByTimeAsync(0);

				mockChild.stdout.emit(
					'data',
					JSON.stringify({ type: 'step', usage: { inputTokens: 10, outputTokens: 5 } }) +
						'\n' +
						JSON.stringify({
							type: 'result',
							result: 'done',
							usage: { inputTokens: 3, outputTokens: 7, costUsd: 0.5 },
						}) +
						'\n'
				);
				mockChild.emit('close', 0, null);

				const result = await resultPromise;
				expect(result.usage?.inputTokens).toBe(13);
				expect(result.usage?.outputTokens).toBe(12);
				expect(result.usage?.totalCostUsd).toBe(0.5);
			});

			it('takes Claude usage from the last event, which carries the turn total', async () => {
				mockGetOutputParser.mockReturnValue({
					...resultParser(),
					extractUsage: (event: any) => event?.usage ?? null,
					parseJsonLine: (line: string) => {
						const msg = JSON.parse(line);
						return msg.type === 'result'
							? { type: 'result', text: msg.result || '', usage: msg.usage }
							: { type: 'text', isPartial: true, text: '', usage: msg.usage };
					},
				} as any);

				const resultPromise = runProcess(
					'run-1',
					createSpec(),
					createOptions({ toolType: 'claude-code' })
				);
				await vi.advanceTimersByTimeAsync(0);

				// Per-call usage, then the result's whole-turn total. Summing would
				// report 130 input tokens instead of 100.
				mockChild.stdout.emit(
					'data',
					JSON.stringify({ type: 'assistant', usage: { inputTokens: 30, outputTokens: 4 } }) +
						'\n' +
						JSON.stringify({
							type: 'result',
							result: 'done',
							usage: { inputTokens: 100, outputTokens: 12 },
						}) +
						'\n'
				);
				mockChild.emit('close', 0, null);

				const result = await resultPromise;
				expect(result.usage?.inputTokens).toBe(100);
				expect(result.usage?.outputTokens).toBe(12);
			});

			it('keeps the Codex occupancy snapshot and reported window on the result (#1669)', async () => {
				mockGetOutputParser.mockReturnValue({
					...resultParser(),
					extractUsage: (event: any) => event?.usage ?? null,
					parseJsonLine: (line: string) => {
						const msg = JSON.parse(line);
						return msg.type === 'result'
							? { type: 'result', text: msg.result || '' }
							: { type: 'usage', raw: msg, usage: msg.usage };
					},
				} as any);

				const resultPromise = runProcess(
					'run-1',
					createSpec(),
					createOptions({ toolType: 'codex' })
				);
				await vi.advanceTimersByTimeAsync(0);

				// Running session totals, as Codex reports them.
				const tokenCount = (inputTokens: number, outputTokens: number) =>
					JSON.stringify({
						type: 'token_count',
						usage: {
							inputTokens,
							outputTokens,
							contextWindow: 272_000,
							contextWindowReported: true,
						},
					}) + '\n';
				mockChild.stdout.emit(
					'data',
					tokenCount(100, 10) +
						tokenCount(300, 30) +
						JSON.stringify({ type: 'result', result: 'done' }) +
						'\n'
				);
				mockChild.emit('close', 0, null);

				const result = await resultPromise;
				expect(result.usage?.inputTokens).toBe(300);
				expect(result.usage?.outputTokens).toBe(30);
				expect(result.usage?.absoluteUsage).toEqual({
					inputTokens: 300,
					outputTokens: 30,
					cacheReadInputTokens: 0,
					cacheCreationInputTokens: 0,
					reasoningTokens: 0,
				});
				expect(result.usage?.contextWindow).toBe(272_000);
				expect(result.usage?.contextWindowResolved).toBe(true);
			});

			it('keeps the Claude occupancy snapshot when a later usage event carries none (#1669)', async () => {
				mockGetOutputParser.mockReturnValue({
					...resultParser(),
					extractUsage: (event: any) => event?.usage ?? null,
					parseJsonLine: (line: string) => {
						const msg = JSON.parse(line);
						return msg.type === 'result'
							? { type: 'result', text: msg.result || '', usage: msg.usage }
							: { type: 'usage', raw: msg, usage: msg.usage };
					},
				} as any);

				const resultPromise = runProcess(
					'run-1',
					createSpec(),
					createOptions({ toolType: 'claude-code' })
				);
				await vi.advanceTimersByTimeAsync(0);

				const occupancy = {
					inputTokens: 1000,
					outputTokens: 20,
					cacheReadInputTokens: 500,
					cacheCreationInputTokens: 0,
					reasoningTokens: 0,
				};
				mockChild.stdout.emit(
					'data',
					JSON.stringify({
						type: 'result',
						result: 'done',
						usage: {
							inputTokens: 4000,
							outputTokens: 60,
							costUsd: 0.1,
							contextWindow: 1_000_000,
							contextWindowReported: true,
							absoluteUsage: occupancy,
						},
					}) +
						'\n' +
						JSON.stringify({
							type: 'usage',
							usage: { inputTokens: 4000, outputTokens: 60, costUsd: 0.1, contextWindow: 200_000 },
						}) +
						'\n'
				);
				mockChild.emit('close', 0, null);

				const result = await resultPromise;
				// Last write wins for the totals, as before...
				expect(result.usage?.inputTokens).toBe(4000);
				expect(result.usage?.totalCostUsd).toBe(0.1);
				// ...but the trailing event does not erase the metadata.
				expect(result.usage?.absoluteUsage).toEqual(occupancy);
				expect(result.usage?.contextWindow).toBe(1_000_000);
				expect(result.usage?.contextWindowResolved).toBe(true);
			});

			it('fails a parser-less agent that exits non-zero, whatever it printed', async () => {
				mockGetOutputParser.mockReturnValue(null);

				const resultPromise = runProcess('run-1', createSpec(), createOptions());
				await vi.advanceTimersByTimeAsync(0);

				mockChild.stdout.emit('data', 'command not found: something\n');
				mockChild.emit('close', 127, null);

				const result = await resultPromise;
				expect(result.status).toBe('failed');
				expect(result.stdout).toBe('command not found: something\n');
			});

			it('records unknown Claude usage when the provider reports none', async () => {
				mockGetOutputParser.mockReturnValue(resultParser());

				const resultPromise = runProcess('run-1', createSpec(), createOptions());
				await vi.advanceTimersByTimeAsync(0);

				mockChild.stdout.emit('data', JSON.stringify({ type: 'result', result: 'done' }));
				mockChild.emit('close', 0, null);

				expect((await resultPromise).usage?.accounting?.cost.status).toBe('unknown');
			});

			it('fails a signal kill even when the agent had streamed an answer', async () => {
				mockGetOutputParser.mockReturnValue(resultParser());

				const resultPromise = runProcess('run-1', createSpec(), createOptions());
				await vi.advanceTimersByTimeAsync(0);

				// A truncated answer must not chain onward as a success.
				mockChild.stdout.emit('data', JSON.stringify({ type: 'result', result: 'half an ans' }));
				mockChild.emit('close', null, 'SIGKILL');

				expect((await resultPromise).status).toBe('failed');
			});

			it('fails a signal kill nobody requested', async () => {
				mockGetOutputParser.mockReturnValue(resultParser());

				const resultPromise = runProcess('run-1', createSpec(), createOptions());
				await vi.advanceTimersByTimeAsync(0);

				mockChild.emit('close', null, 'SIGKILL');

				expect((await resultPromise).status).toBe('failed');
			});

			// Claude Code reports a failed turn in-band (a result flagged
			// `is_error: true`) and then exits 0. The real parser is used so the
			// classification under test is the one production runs.
			it('fails a run whose provider reported the failure in-band and exited 0', async () => {
				mockGetOutputParser.mockReturnValue(new ClaudeOutputParser());

				const resultPromise = runProcess('run-1', createSpec(), createOptions());
				await vi.advanceTimersByTimeAsync(0);

				mockChild.stdout.emit(
					'data',
					JSON.stringify({
						type: 'result',
						subtype: 'error_max_turns',
						is_error: true,
						session_id: 'sess-1',
					}) + '\n'
				);
				mockChild.emit('close', 0, null);
				const result = await resultPromise;

				expect(result.status).toBe('failed');
				expect(result.stderr).toContain('maximum number of turns');
			});

			it('still completes a run whose provider recovered past an in-turn API error notice', async () => {
				mockGetOutputParser.mockReturnValue(new ClaudeOutputParser());

				const resultPromise = runProcess('run-1', createSpec(), createOptions());
				await vi.advanceTimersByTimeAsync(0);

				const lines = [
					{
						type: 'assistant',
						error: 'server_error',
						is_api_error_message: true,
						message: { model: '<synthetic>', content: [{ type: 'text', text: 'API Error' }] },
					},
					{ type: 'assistant', message: { content: [{ type: 'text', text: 'Recovered.' }] } },
					{ type: 'result', subtype: 'success', is_error: false, result: 'Recovered.' },
				];
				mockChild.stdout.emit('data', lines.map((l) => JSON.stringify(l) + '\n').join(''));
				mockChild.emit('close', 0, null);
				const result = await resultPromise;

				expect(result.status).toBe('completed');
				expect(result.stdout).toBe('Recovered.');
			});

			it('reports a stopped run as stopped even when the provider flushes a failed result', async () => {
				mockGetOutputParser.mockReturnValue(new ClaudeOutputParser());

				const resultPromise = runProcess('run-1', createSpec(), createOptions());
				await vi.advanceTimersByTimeAsync(0);

				expect(stopProcess('run-1')).toBe(true);
				mockChild.stdout.emit(
					'data',
					JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true }) +
						'\n'
				);
				mockChild.emit('close', 0, null);

				expect((await resultPromise).status).toBe('stopped');
			});
		});

		describe('output parsing', () => {
			it('returns raw stdout when no parser is registered', async () => {
				mockGetOutputParser.mockReturnValue(null);

				const resultPromise = runProcess('run-1', createSpec(), createOptions());
				await vi.advanceTimersByTimeAsync(0);

				mockChild.stdout.emit('data', 'plain text output\n');
				mockChild.emit('close', 0);
				const result = await resultPromise;

				expect(result.stdout).toBe('plain text output\n');
			});

			it('extracts result-event text when parser is available', async () => {
				mockGetOutputParser.mockReturnValue({
					parseJsonLine: (line: string) => {
						try {
							const msg = JSON.parse(line);
							if (msg.type === 'text') {
								return { type: 'result', text: msg.part?.text || '' };
							}
							return { type: 'system', raw: msg };
						} catch {
							return { type: 'text', text: line };
						}
					},
				} as any);

				const ndjson = JSON.stringify({ type: 'text', part: { text: 'Parsed output' } });

				const resultPromise = runProcess(
					'run-1',
					createSpec(),
					createOptions({ toolType: 'opencode' })
				);
				await vi.advanceTimersByTimeAsync(0);

				mockChild.stdout.emit('data', ndjson);
				mockChild.emit('close', 0);
				const result = await resultPromise;

				expect(result.stdout).toBe('Parsed output');
			});

			it('falls back to assistant text when result text is empty', async () => {
				mockGetOutputParser.mockReturnValue({
					parseJsonLine: (line: string) => {
						try {
							const msg = JSON.parse(line);
							if (msg.type === 'result') {
								return { type: 'result', text: msg.result || '' };
							}
							if (msg.type === 'assistant') {
								return { type: 'text', text: msg.text, isPartial: true };
							}
							return { type: 'system', raw: msg };
						} catch {
							return { type: 'text', text: line };
						}
					},
				} as any);

				const lines = [
					JSON.stringify({ type: 'assistant', text: 'Hello from the agent' }),
					JSON.stringify({ type: 'result', result: '' }),
				].join('\n');

				const resultPromise = runProcess(
					'run-1',
					createSpec(),
					createOptions({ toolType: 'claude-code' })
				);
				await vi.advanceTimersByTimeAsync(0);

				mockChild.stdout.emit('data', lines);
				mockChild.emit('close', 0);
				const result = await resultPromise;

				expect(result.stdout).toBe('Hello from the agent');
			});
		});

		// Live stream capture (Plans/maestro-lib-cli-migration.md, "Cue"): the
		// same single pass that builds clean stdout also tracks the provider
		// session id and delta-normalized usage, so the dashboard has a token
		// figure for a run even when it executed over SSH (whose on-disk
		// session file cue-token-accessor.ts can never read).
		describe('providerSessionId and usage capture', () => {
			it('captures the last session id the parser reports', async () => {
				mockGetOutputParser.mockReturnValue({
					parseJsonLine: (line: string) => JSON.parse(line),
					extractSessionId: (event: any) => event.session_id ?? null,
					extractUsage: () => null,
				} as any);

				const lines = [
					JSON.stringify({ session_id: 'sess-1' }),
					JSON.stringify({ session_id: 'sess-2' }),
				].join('\n');

				const resultPromise = runProcess(
					'run-1',
					createSpec(),
					createOptions({ toolType: 'claude-code' })
				);
				await vi.advanceTimersByTimeAsync(0);

				mockChild.stdout.emit('data', lines + '\n');
				mockChild.emit('close', 0);
				const result = await resultPromise;

				expect(result.providerSessionId).toBe('sess-2');
			});

			it('retains unknown provider provenance when no parser is registered', async () => {
				mockGetOutputParser.mockReturnValue(null);

				const resultPromise = runProcess('run-1', createSpec(), createOptions());
				await vi.advanceTimersByTimeAsync(0);

				mockChild.stdout.emit('data', 'plain text\n');
				mockChild.emit('close', 0);
				const result = await resultPromise;

				expect(result.providerSessionId).toBeNull();
				expect(result.usage?.accounting?.providerId).toBe('claude-code');
				expect(result.usage?.accounting?.cost.status).toBe('unknown');
			});

			it('passes through per-turn usage unmodified for a non-combined-context provider', async () => {
				mockGetOutputParser.mockReturnValue({
					parseJsonLine: (line: string) => JSON.parse(line),
					extractSessionId: () => null,
					extractUsage: (event: any) => event.usage ?? null,
				} as any);

				const resultPromise = runProcess(
					'run-1',
					createSpec(),
					createOptions({ toolType: 'claude-code' })
				);
				await vi.advanceTimersByTimeAsync(0);

				mockChild.stdout.emit(
					'data',
					JSON.stringify({ usage: { inputTokens: 100, outputTokens: 50 } }) + '\n'
				);
				mockChild.emit('close', 0);
				const result = await resultPromise;

				expect(result.usage).toMatchObject({ inputTokens: 100, outputTokens: 50 });
			});

			it('delta-normalizes cumulative usage for a combined-context-window provider (codex)', async () => {
				mockGetOutputParser.mockReturnValue({
					parseJsonLine: (line: string) => JSON.parse(line),
					extractSessionId: () => null,
					extractUsage: (event: any) => event.usage ?? null,
				} as any);

				const resultPromise = runProcess(
					'run-1',
					createSpec({ command: 'codex' }),
					createOptions({ toolType: 'codex' })
				);
				await vi.advanceTimersByTimeAsync(0);

				// Codex reports a running SESSION TOTAL on every event, not a
				// per-turn delta - exactly the shape the CLI migration's
				// UsageAccumulator test pins (100, then 100+200=300 cumulative).
				mockChild.stdout.emit(
					'data',
					JSON.stringify({ usage: { inputTokens: 100, outputTokens: 0 } }) + '\n'
				);
				mockChild.stdout.emit(
					'data',
					JSON.stringify({ usage: { inputTokens: 300, outputTokens: 0 } }) + '\n'
				);
				mockChild.emit('close', 0);
				const result = await resultPromise;

				// Deltas are 100, then 300 - 100 = 200, and the run consumed both:
				// 300. Keeping only the newest delta would report 200 and lose
				// the first event; taking the raw value would double-count.
				expect(result.usage).toMatchObject({ inputTokens: 300 });
			});
		});

		describe('Grok Cue accounting receipts', () => {
			afterEach(() => mockGetOutputParser.mockReturnValue(null));

			const model = {
				inputTokens: 50,
				outputTokens: 20,
				cacheReadInputTokens: 10,
				cacheCreationInputTokens: 5,
				modelCalls: 1,
			};
			const terminal = {
				type: 'end',
				stopReason: 'end_turn',
				sessionId: 'native-shared',
				requestId: 'new',
				usage: {
					input_tokens: 100,
					output_tokens: 40,
					cache_read_input_tokens: 20,
					cache_creation_input_tokens: 10,
					reasoning_tokens: 5,
					total_tokens: 170,
				},
				total_cost_usd_ticks: '9007199254740993',
				modelUsage: {
					'grok/raw-a': { ...model, costUSD: 0.01 },
					'grok/raw-b': model,
				},
			};

			it.each([false, true])(
				'preserves new/resumed terminal receipts with missing ID=%s',
				async (missingId) => {
					for (const requestId of ['new', 'resumed']) {
						mockGetOutputParser.mockReturnValue(new GrokOutputParser());
						const spec = createSpec({
							command: 'grok',
							args: requestId === 'new' ? [] : ['--resume', 'native-shared'],
						});
						const pending = runProcess(requestId, spec, createOptions({ toolType: 'grok' }));
						await vi.advanceTimersByTimeAsync(0);
						const end = JSON.stringify({
							...terminal,
							requestId,
							sessionId: missingId ? undefined : terminal.sessionId,
						});
						// Per-call occupancy and repeated finals cannot add the turn twice.
						mockChild.stdout.emit(
							'data',
							JSON.stringify({ type: 'usage', usage: terminal.usage }) + '\n' + end + '\n' + end
						);
						mockChild.emit('close', 0);
						const result = await pending;
						expect(result.status).toBe('completed');
						expect(result.providerSessionId).toBe(missingId ? null : 'native-shared');
						const receipt = JSON.parse(JSON.stringify(result.usage));
						expect(receipt).toMatchObject({
							inputTokens: 100,
							outputTokens: 40,
							cacheReadInputTokens: 20,
							cacheCreationInputTokens: 10,
							reasoningTokens: 5,
							accounting: {
								providerId: 'grok',
								source: 'runtime-stream',
								route: 'native-headless',
								scope: 'turn',
								final: true,
								requestId,
								cacheReadCounting: 'beside-input',
								cacheCreationCounting: 'beside-input',
								completeness: 'complete',
								cost: { status: 'exact', costUsdTicks: '9007199254740993' },
							},
						});
						expect(receipt.accounting.models).toMatchObject([
							{ model: 'grok/raw-a', inputTokens: 50, cost: { status: 'exact', costUsd: 0.01 } },
							{ model: 'grok/raw-b', cacheCreationInputTokens: 5, cost: { status: 'unknown' } },
						]);
					}
				}
			);

			it.each(['native-session', 'process-session', 'child'] as const)(
				'never adds %s snapshots to a turn',
				async (scope) => {
					const event = new GrokOutputParser().parseJsonObject(terminal)!;
					mockGetOutputParser.mockReturnValue({
						parseJsonLine: JSON.parse,
						extractUsage: (parsed: typeof event) => parsed.usage ?? null,
					});
					const pending = runProcess('scoped', createSpec(), createOptions({ toolType: 'grok' }));
					await vi.advanceTimersByTimeAsync(0);
					const lifetime = structuredClone(event);
					lifetime.usage!.inputTokens = 9000000;
					lifetime.usage!.accounting!.scope = scope;
					mockChild.stdout.emit(
						'data',
						[lifetime, event, lifetime].map((row) => JSON.stringify(row)).join('\n') + '\n'
					);
					mockChild.emit('close', 0);
					const receipt = (await pending).usage;
					expect(receipt?.inputTokens).toBe(100);
					expect(receipt?.accounting?.scope).toBe('turn');
				}
			);

			it.each([
				['cancelled', { cost_is_partial: true }, 'partial'],
				['error', { total_cost_usd_ticks: undefined }, 'unknown'],
			] as const)(
				'retains %s spend without complete cost',
				async (stopReason, changes, costStatus) => {
					mockGetOutputParser.mockReturnValue(new GrokOutputParser());
					const pending = runProcess('fail', createSpec(), createOptions({ toolType: 'grok' }));
					await vi.advanceTimersByTimeAsync(0);
					mockChild.stdout.emit(
						'data',
						JSON.stringify({ ...terminal, ...changes, stopReason }) + '\n'
					);
					mockChild.emit('close', 1);
					const result = await pending;
					expect(result.status).toBe('failed');
					expect(result.usage).toMatchObject({
						inputTokens: 100,
						cacheReadInputTokens: 20,
						accounting: { providerId: 'grok', cost: { status: costStatus } },
					});
				}
			);

			it.each([
				'prelaunch-stop',
				'spawn-throw',
				'spawn-error',
				'completed',
				'failed',
				'stopped',
				'timeout',
			] as const)('emits an unknown provider receipt without usage/ID on %s', async (ending) => {
				mockGetOutputParser.mockReturnValue(new GrokOutputParser());
				const controller = new AbortController();
				if (ending === 'prelaunch-stop') controller.abort();
				if (ending === 'spawn-throw')
					mockSpawn.mockImplementationOnce(() => {
						throw new Error('synthetic spawn failure');
					});
				const pending = runProcess(
					'no-usage',
					createSpec(),
					createOptions({ toolType: 'grok', signal: controller.signal })
				);
				await vi.advanceTimersByTimeAsync(0);
				if (ending === 'spawn-error') mockChild.emit('error', new Error('synthetic ENOENT'));
				else if (ending !== 'prelaunch-stop' && ending !== 'spawn-throw') {
					if (ending === 'stopped') stopProcess('no-usage');
					if (ending === 'timeout') await vi.advanceTimersByTimeAsync(30000);
					if (ending === 'completed')
						mockChild.stdout.emit('data', '{"type":"end","stopReason":"end_turn"}\n');
					mockChild.emit('close', ending === 'completed' ? 0 : 1);
				}
				const result = await pending;
				expect(result.status).toBe(
					ending === 'prelaunch-stop' ? 'stopped' : ending.startsWith('spawn-') ? 'failed' : ending
				);
				expect(result.providerSessionId).toBeNull();
				expect(result.usage).toMatchObject({
					inputTokens: 0,
					outputTokens: 0,
					totalCostUsd: 0,
					accounting: {
						providerId: 'grok',
						source: 'none',
						scope: 'turn',
						reporting: 'snapshot',
						completeness: 'unknown',
						cost: { status: 'unknown' },
					},
				});
			});
		});

		// A Grok Cue turn read through the real parser: what {{CUE_SOURCE_OUTPUT}}
		// hands the next agent, the session a chain resumes, and the status that
		// decides whether a success chain fires.
		describe('Grok Cue turn text and status', () => {
			afterEach(() => mockGetOutputParser.mockReturnValue(null));

			const line = (record: Record<string, unknown>) => JSON.stringify(record) + '\n';
			const end = line({
				type: 'end',
				stopReason: 'end_turn',
				sessionId: 'grok-chain-session',
				usage: { input_tokens: 30, output_tokens: 6 },
			});

			async function runGrok(chunks: string[], exitCode: number | null, options = {}) {
				mockGetOutputParser.mockReturnValue(new GrokOutputParser());
				const pending = runProcess(
					'grok-run',
					createSpec({ command: 'grok', args: ['--prompt-file', '/tmp/prompt.json'] }),
					createOptions({ toolType: 'grok', ...options })
				);
				await vi.advanceTimersByTimeAsync(0);
				for (const chunk of chunks) mockChild.stdout.emit('data', chunk);
				return { pending, close: () => mockChild.emit('close', exitCode) };
			}

			it('joins split-word deltas, drops thoughts and keeps the final session and usage', async () => {
				const { pending, close } = await runGrok(
					[
						line({ type: 'thought', data: 'The user wants a greeting.' }),
						line({ type: 'text', data: 'Hel' }),
						// A chunk boundary inside one record must not split the word either.
						'{"type":"text","da',
						'ta":"lo wor"}\n',
						line({ type: 'thought', data: 'Add punctuation.' }),
						line({ type: 'text', data: 'ld!' }),
						end,
					],
					0
				);
				close();
				const result = await pending;

				expect(result.status).toBe('completed');
				expect(result.stdout).toBe('Hello world!');
				expect(result.stdout).not.toContain('greeting');
				expect(result.providerSessionId).toBe('grok-chain-session');
				expect(result.usage).toMatchObject({
					inputTokens: 30,
					outputTokens: 6,
					accounting: { providerId: 'grok', final: true },
				});
			});

			it.each([
				['empty stdout', []],
				['plain text from a CLI that ignored the stream flag', ['pong\n']],
			] as const)('fails a clean exit with %s and names why', async (_label, chunks) => {
				const { pending, close } = await runGrok([...chunks], 0);
				close();
				const result = await pending;

				expect(result.status).toBe('failed');
				expect(result.stderr).toContain('Grok exited without a native terminal record.');
			});

			// The parser fails a native stream that stopped short of its terminal
			// record, so no success chain fires. The stream wrote no stderr of its
			// own, so the run names the parser's reason there.
			it('fails answer deltas that never reached a terminal record', async () => {
				const { pending, close } = await runGrok([line({ type: 'text', data: 'pong' })], 0);
				close();
				const result = await pending;

				expect(result.status).toBe('failed');
				expect(result.stderr).toBe(
					'Grok closed the native stream without a successful terminal record. Any response is incomplete.'
				);
				// The partial answer is not the reason, and nothing marks it as a
				// finished turn a chain could read: no session, no final usage.
				expect(result.stderr).not.toContain('pong');
				expect(result.providerSessionId).toBeNull();
				expect(result.usage?.accounting).toMatchObject({ source: 'none', providerId: 'grok' });
				expect(result.usage?.accounting).not.toMatchObject({ final: true });
				expect(result.usage?.outputTokens).toBe(0);
			});

			it('fails an in-band auth error and names it in stderr for the auth classifier', async () => {
				const { pending, close } = await runGrok(
					[line({ type: 'error', message: 'Not authenticated. Run grok login.' })],
					0
				);
				close();
				const result = await pending;

				expect(result.status).toBe('failed');
				expect(result.stderr).toContain('Grok authentication is required or failed.');
			});

			it('fails a stderr-only auth rejection on a non-zero exit', async () => {
				const { pending } = await runGrok([], 1);
				mockChild.stderr.emit('data', 'Error: authentication required\n');
				mockChild.emit('close', 1);
				const result = await pending;

				expect(result.status).toBe('failed');
				expect(result.stderr).toContain('authentication required');
			});

			it('stops a Grok turn mid-stream as stopped, never completed', async () => {
				const { pending } = await runGrok([line({ type: 'text', data: 'partial ' })], null);
				expect(stopProcess('grok-run')).toBe(true);
				mockChild.emit('close', null, 'SIGTERM');
				const result = await pending;

				expect(result.status).toBe('stopped');
				expect(getActiveProcessMap().has('grok-run')).toBe(false);
			});

			it('times a silent Grok turn out instead of waiting forever', async () => {
				const { pending } = await runGrok([], null, { timeoutMs: 5000 });
				await vi.advanceTimersByTimeAsync(5000);
				mockChild.emit('close', null, 'SIGTERM');
				const result = await pending;

				expect(result.status).toBe('timeout');
			});
		});

		// Grok Cue runs as a workflow. This lifecycle is the one the desktop
		// executor and the headless engine (`maestro-cli cue`) both settle a prompt run
		// on, so a run it reads as completed is what fires a downstream chain. Composed
		// with the Grok failure cases above (empty stdout, auth, stop, timeout).
		describe('Grok Cue workflow outcomes', () => {
			afterEach(() => mockGetOutputParser.mockReturnValue(null));

			const line = (record: Record<string, unknown>) => JSON.stringify(record) + '\n';
			const end = (stopReason = 'end_turn') =>
				line({ type: 'end', stopReason, sessionId: 'grok-cue-session' });

			async function runGrok(chunks: string[]) {
				mockGetOutputParser.mockReturnValue(new GrokOutputParser());
				const pending = runProcess(
					'grok-flow',
					createSpec({ command: 'grok', args: ['--prompt-file', '/tmp/prompt.json'] }),
					createOptions({ toolType: 'grok' })
				);
				await vi.advanceTimersByTimeAsync(0);
				for (const chunk of chunks) mockChild.stdout.emit('data', chunk);
				return pending;
			}

			it('fails an in-band rate limit, names it, and spawns the run once', async () => {
				const pending = runGrok([
					line({ type: 'text', data: 'Working on' }),
					line({ type: 'error', message: 'Rate limit exceeded (429). Try again later.' }),
				]);
				const result = await (async () => {
					await vi.advanceTimersByTimeAsync(0);
					mockChild.emit('close', 1);
					return pending;
				})();

				expect(result.status).toBe('failed');
				expect(result.stderr).toMatch(/rate limit/i);
				// No second process: a failed run is never retried behind the chain's back.
				expect(mockSpawn).toHaveBeenCalledTimes(1);
			});

			it('fails a turn a failed tool cancelled, with the headless approval hint', async () => {
				const pending = runGrok([
					line({ type: 'text', data: 'Deleting the build folder' }),
					line({ type: 'tool_call', toolCallId: 't1', toolName: 'run_terminal_command' }),
					line({ type: 'tool_call_update', toolCallId: 't1', status: 'failed' }),
					end('cancelled'),
				]);
				await vi.advanceTimersByTimeAsync(0);
				mockChild.emit('close', 0);
				const result = await pending;

				expect(result.status).toBe('failed');
				expect(result.stderr).toContain('stopReason: cancelled');
				expect(result.stderr).toContain('permission approval');
				// The streamed partial stays as the record; the failed status is what keeps
				// it from reaching a chain as a finished answer.
				expect(result.usage?.accounting).not.toMatchObject({ final: true });
			});

			it('completes a turn that finished after one of its tools failed, with the answer alone', async () => {
				const pending = runGrok([
					line({ type: 'tool_call', toolCallId: 't1', toolName: 'read_file' }),
					line({
						type: 'tool_call_update',
						toolCallId: 't1',
						status: 'failed',
						rawOutput: 'ENOENT: tool output',
					}),
					line({ type: 'text', data: 'The file is missing.' }),
					end(),
				]);
				await vi.advanceTimersByTimeAsync(0);
				mockChild.emit('close', 0);
				const result = await pending;

				expect(result.status).toBe('completed');
				expect(result.stdout).toBe('The file is missing.');
				expect(result.stdout).not.toContain('ENOENT');
				expect(result.providerSessionId).toBe('grok-cue-session');
			});

			it.each(['max_tokens', 'refusal', 'max_turn_requests'])(
				'fails a turn interrupted by stopReason %s instead of chaining partial text',
				async (stopReason) => {
					const pending = runGrok([line({ type: 'text', data: 'half an answ' }), end(stopReason)]);
					await vi.advanceTimersByTimeAsync(0);
					mockChild.emit('close', 0);
					const result = await pending;

					expect(result.status).toBe('failed');
					expect(result.stderr).toContain(`stopReason: ${stopReason}`);
				}
			);

			it('settles a Grok run once, whatever the child emits after its close', async () => {
				const pending = runGrok([line({ type: 'text', data: 'ok' }), end()]);
				await vi.advanceTimersByTimeAsync(0);
				mockChild.emit('close', 0);
				mockChild.emit('error', new Error('late failure'));
				mockChild.emit('close', 1);
				const result = await pending;

				expect(result.status).toBe('completed');
				expect(result.stdout).toBe('ok');
				expect(getActiveProcessMap().has('grok-flow')).toBe(false);
				expect(mockSpawn).toHaveBeenCalledTimes(1);
			});
		});

		describe('stderr cleaning (benign noise filter)', () => {
			it('strips "Reading additional input from stdin..." from Codex stderr', async () => {
				const resultPromise = runProcess(
					'run-1',
					createSpec({ command: 'codex' }),
					createOptions({ toolType: 'codex' })
				);
				await vi.advanceTimersByTimeAsync(0);

				// Codex emits this diagnostic on stderr on every run - it's
				// informational, not an error, and should never surface in the
				// activity log's "Errors" panel.
				mockChild.stderr.emit('data', 'Reading additional input from stdin...\n');
				mockChild.emit('close', 0);

				const result = await resultPromise;
				expect(result.stderr).toBe('');
			});

			it('preserves real Codex errors while dropping benign noise', async () => {
				const resultPromise = runProcess(
					'run-1',
					createSpec({ command: 'codex' }),
					createOptions({ toolType: 'codex' })
				);
				await vi.advanceTimersByTimeAsync(0);

				mockChild.stderr.emit(
					'data',
					'Reading additional input from stdin...\nError: model rate limited\n'
				);
				mockChild.emit('close', 1);

				const result = await resultPromise;
				expect(result.stderr).toContain('Error: model rate limited');
				expect(result.stderr).not.toContain('Reading additional input from stdin');
			});

			it('strips Codex noise with ANSI dim codes', async () => {
				const resultPromise = runProcess(
					'run-1',
					createSpec({ command: 'codex' }),
					createOptions({ toolType: 'codex' })
				);
				await vi.advanceTimersByTimeAsync(0);

				// Simulate a Codex build that wraps the diagnostic in ANSI dimming.
				mockChild.stderr.emit('data', '\u001b[2mReading additional input from stdin...\u001b[0m\n');
				mockChild.emit('close', 0);

				const result = await resultPromise;
				expect(result.stderr).toBe('');
			});

			it('strips Codex noise regardless of trailing text on the same prefix line', async () => {
				const resultPromise = runProcess(
					'run-1',
					createSpec({ command: 'codex' }),
					createOptions({ toolType: 'codex' })
				);
				await vi.advanceTimersByTimeAsync(0);

				// A prefix match catches variants with or without trailing dots,
				// extra whitespace, or future additions to the diagnostic line.
				mockChild.stderr.emit('data', 'Reading additional input from stdin\n');
				mockChild.emit('close', 0);

				const result = await resultPromise;
				expect(result.stderr).toBe('');
			});

			it('does not filter stderr for agents without a noise filter', async () => {
				const resultPromise = runProcess(
					'run-1',
					createSpec(),
					createOptions({ toolType: 'claude-code' })
				);
				await vi.advanceTimersByTimeAsync(0);

				// Even a message that happens to look like Codex noise stays put
				// for non-Codex agents - filtering is opt-in per agent.
				mockChild.stderr.emit('data', 'Reading additional input from stdin...\n');
				mockChild.emit('close', 0);

				const result = await resultPromise;
				expect(result.stderr).toContain('Reading additional input from stdin');
			});
		});
	});

	describe('stopProcess', () => {
		it('returns false for unknown runId', () => {
			expect(stopProcess('nonexistent')).toBe(false);
		});

		it('sends SIGTERM to a running process', async () => {
			const resultPromise = runProcess('stop-test', createSpec(), createOptions());
			await vi.advanceTimersByTimeAsync(0);

			const childKill = vi.spyOn(mockChild, 'kill');

			const stopped = stopProcess('stop-test');
			expect(stopped).toBe(true);
			expect(childKill).toHaveBeenCalledWith('SIGTERM');

			mockChild.emit('close', null);
			await resultPromise;
		});

		it('escalates to SIGKILL after delay if process survives SIGTERM', async () => {
			const resultPromise = runProcess('stop-test', createSpec(), createOptions());
			await vi.advanceTimersByTimeAsync(0);

			const childKill = vi.spyOn(mockChild, 'kill');

			stopProcess('stop-test');
			expect(childKill).toHaveBeenCalledWith('SIGTERM');

			// Process hasn't exited - SIGKILL should fire after delay
			await vi.advanceTimersByTimeAsync(5000);
			expect(childKill).toHaveBeenCalledWith('SIGKILL');

			mockChild.emit('close', null);
			await resultPromise;
		});
	});

	describe('Windows process-tree kill (taskkill)', () => {
		it('kills via taskkill /pid <pid> /t /f instead of POSIX signals', async () => {
			mockIsWindows.mockReturnValue(true);

			const resultPromise = runProcess('win-stop', createSpec(), createOptions());
			await vi.advanceTimersByTimeAsync(0);

			const childKill = vi.spyOn(mockChild, 'kill');

			const stopped = stopProcess('win-stop');
			expect(stopped).toBe(true);
			expect(mockExecFile).toHaveBeenCalledWith(
				'taskkill',
				['/pid', String(mockChild.pid), '/t', '/f'],
				{ timeout: 5000 },
				expect.any(Function)
			);
			// POSIX signals must not be used on Windows (no-op for shell-spawned trees).
			expect(childKill).not.toHaveBeenCalled();

			mockChild.emit('close', null);
			await resultPromise;
		});

		it('tolerates taskkill failing because the process is already dead', async () => {
			mockIsWindows.mockReturnValue(true);
			mockExecFile.mockImplementationOnce(
				(_cmd: unknown, _args: unknown, _options: unknown, cb?: unknown) => {
					// The child exits after dispatch, before taskkill reports its failure.
					// Its exit state, not localized error text, makes the failure benign.
					mockChild.exitCode = 1;
					if (typeof cb === 'function') {
						(cb as (e: Error | null) => void)(new Error('ERROR: The process "12345" not found.'));
					}
				}
			);

			const resultPromise = runProcess('win-dead', createSpec(), createOptions());
			await vi.advanceTimersByTimeAsync(0);

			const childKill = vi.spyOn(mockChild, 'kill');
			expect(stopProcess('win-dead')).toBe(true);
			expect(mockExecFile).toHaveBeenCalledWith(
				'taskkill',
				['/pid', String(mockChild.pid), '/t', '/f'],
				{ timeout: 5000 },
				expect.any(Function)
			);
			expect(mockChild.exitCode).toBe(1);
			expect(childKill).not.toHaveBeenCalled();
			// Already-dead is expected on Windows and must not be reported to Sentry.
			expect(mockCaptureException).not.toHaveBeenCalled();

			mockChild.emit('close', null);
			await resultPromise;
		});
	});

	describe('trackCueProcess', () => {
		function trackedEntry(child: MockChildProcess) {
			return {
				child: child as unknown as ChildProcess,
				command: 'sh',
				args: ['-c', 'true'],
				cwd: '/projects/test',
				toolType: 'terminal',
				startTime: Date.now(),
				getStdout: () => '',
				getStderr: () => '',
			};
		}

		it('a stale unregister does not drop a newer run under the same id', () => {
			const untrackOld = trackCueProcess('same-id', trackedEntry(new MockChildProcess()));
			const newer = trackedEntry(new MockChildProcess());
			trackCueProcess('same-id', newer);

			untrackOld();
			expect(getActiveProcessMap().get('same-id')).toBe(newer);
		});

		it('stopAllProcesses escalates to SIGKILL at once (shutdown cannot wait on a timer)', () => {
			const child = new MockChildProcess();
			const childKill = vi.spyOn(child, 'kill');
			trackCueProcess('shutdown-run', trackedEntry(child));

			stopAllProcesses();
			expect(childKill).toHaveBeenCalledWith('SIGTERM');
			expect(childKill).toHaveBeenCalledWith('SIGKILL');
			expect(getActiveProcessMap().size).toBe(0);
		});
	});

	describe('getProcessList', () => {
		it('returns empty array when no active processes', () => {
			expect(getProcessList()).toEqual([]);
		});

		it('returns process info during active run', async () => {
			const resultPromise = runProcess('list-test', createSpec(), createOptions());
			await vi.advanceTimersByTimeAsync(0);

			const list = getProcessList();
			expect(list).toHaveLength(1);
			expect(list[0].runId).toBe('list-test');
			expect(list[0].pid).toBe(12345);
			expect(list[0].toolType).toBe('claude-code');
			expect(list[0].cwd).toBe('/projects/test');
			expect(list[0].command).toBe('claude');
			expect(Array.isArray(list[0].args)).toBe(true);
			expect(typeof list[0].startTime).toBe('number');

			mockChild.emit('close', 0);
			await resultPromise;
		});

		it('excludes completed processes', async () => {
			const resultPromise = runProcess('completed-run', createSpec(), createOptions());
			await vi.advanceTimersByTimeAsync(0);

			expect(getProcessList().some((p) => p.runId === 'completed-run')).toBe(true);

			mockChild.emit('close', 0);
			await resultPromise;

			expect(getProcessList().some((p) => p.runId === 'completed-run')).toBe(false);
		});
	});

	describe('Sentry error reporting', () => {
		it('reports synchronous spawn failure to Sentry', async () => {
			mockSpawn.mockImplementationOnce(() => {
				throw new Error('spawn EPERM');
			});

			const result = await runProcess('run-1', createSpec(), createOptions());

			expect(result.status).toBe('failed');
			expect(result.stderr).toContain('Spawn error: spawn EPERM');
			expect(result.executionStarted).toBe(false);
			expect(mockCaptureException).toHaveBeenCalledWith(
				expect.objectContaining({ message: 'spawn EPERM' }),
				expect.objectContaining({ operation: 'cue:spawn', runId: 'run-1' })
			);
		});

		it('reports async child process error to Sentry', async () => {
			const resultPromise = runProcess('run-1', createSpec(), createOptions());
			await vi.advanceTimersByTimeAsync(0);

			const spawnError = new Error('spawn ENOENT');
			mockChild.emit('error', spawnError);
			await resultPromise;

			expect(mockCaptureException).toHaveBeenCalledWith(
				spawnError,
				expect.objectContaining({ operation: 'cue:childProcess:error', runId: 'run-1' })
			);
		});
	});

	describe('settled guard', () => {
		it('ignores duplicate close events', async () => {
			const resultPromise = runProcess('run-1', createSpec(), createOptions());
			await vi.advanceTimersByTimeAsync(0);

			mockChild.emit('close', 0);
			mockChild.emit('close', 1); // duplicate - should be ignored
			const result = await resultPromise;

			expect(result.status).toBe('completed');
			expect(result.exitCode).toBe(0);
		});

		it('ignores error after close', async () => {
			const resultPromise = runProcess('run-1', createSpec(), createOptions());
			await vi.advanceTimersByTimeAsync(0);

			mockChild.emit('close', 0);
			mockChild.emit('error', new Error('late error')); // should be ignored
			const result = await resultPromise;

			expect(result.status).toBe('completed');
		});
	});
});
