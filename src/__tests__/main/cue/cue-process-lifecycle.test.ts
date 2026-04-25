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

// ─── Mocks ───────────────────────────────────────────────────────────────────

// Mock parsers — default returns null (no parser)
const mockGetOutputParser = vi.fn(() => null as any);
vi.mock('../../../main/parsers', () => ({
	getOutputParser: (...args: unknown[]) => mockGetOutputParser(...args),
}));

// Mock Sentry
const mockCaptureException = vi.fn();
vi.mock('../../../main/utils/sentry', () => ({
	captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

// Mock child_process.spawn
class MockChildProcess extends EventEmitter {
	pid = 12345;
	exitCode: number | null = null;
	signalCode: string | null = null;
	stdin = {
		write: vi.fn(),
		end: vi.fn(),
	};
	stdout = new EventEmitter();
	stderr = new EventEmitter();
	killed = false;

	kill(signal?: string) {
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
const mockSpawn = vi.fn(() => {
	mockChild = new MockChildProcess();
	return mockChild as unknown as ChildProcess;
});

vi.mock('child_process', async (importOriginal) => {
	const actual = await importOriginal<typeof import('child_process')>();
	return {
		...actual,
		spawn: (...args: unknown[]) => mockSpawn(...args),
		default: {
			...actual,
			spawn: (...args: unknown[]) => mockSpawn(...args),
		},
	};
});

// Must import after mocks
import {
	runProcess,
	stopProcess,
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
		vi.useFakeTimers();
		getActiveProcessMap().clear();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe('runProcess', () => {
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

				expect(mockChild.stdin.write).toHaveBeenCalledWith('#!/bin/bash\nclaude "prompt"');
				expect(mockChild.stdin.end).toHaveBeenCalled();

				mockChild.emit('close', 0);
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

				expect(mockChild.stdin.write).toHaveBeenCalledWith('large prompt');
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

		describe('stderr cleaning (benign noise filter)', () => {
			it('strips "Reading additional input from stdin..." from Codex stderr', async () => {
				const resultPromise = runProcess(
					'run-1',
					createSpec({ command: 'codex' }),
					createOptions({ toolType: 'codex' })
				);
				await vi.advanceTimersByTimeAsync(0);

				// Codex emits this diagnostic on stderr on every run — it's
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
				// for non-Codex agents — filtering is opt-in per agent.
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

			// Process hasn't exited — SIGKILL should fire after delay
			await vi.advanceTimersByTimeAsync(5000);
			expect(childKill).toHaveBeenCalledWith('SIGKILL');

			mockChild.emit('close', null);
			await resultPromise;
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
			mockChild.emit('close', 1); // duplicate — should be ignored
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
