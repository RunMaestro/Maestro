/**
 * `startTurn` against a real process.
 *
 * The run layer is the part that owns a process, so its tests start one: the
 * fake agent in `src/__tests__/fixtures/fake-agent.mjs`, replaying a turn.
 * The ownership-race cases below isolate process operations with scoped spies.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import * as childProcess from 'child_process';
import * as artifactFs from 'fs';
import * as parserFactory from '../../../../shared/maestro-lib/parsers/parser-factory';
import { logger } from '../../../../shared/maestro-lib/host';
import * as processTree from '../../../../shared/maestro-lib/control/process-tree';
import * as platform from '../../../../shared/platformDetection';
import {
	trackProcessTree,
	TREE_REFRESH_MS,
} from '../../../../shared/maestro-lib/control/termination';

// Mutable facades allow scoped spies without changing the real-process cases.
vi.mock('child_process', async (original) => ({
	...(await original<typeof import('child_process')>()),
}));
vi.mock('fs', async (original) => ({ ...(await original<typeof import('fs')>()) }));
vi.mock('../../../../shared/maestro-lib/parsers/parser-factory', async (original) => ({
	...(await original<typeof import('../../../../shared/maestro-lib/parsers/parser-factory')>()),
}));
vi.mock('../../../../shared/maestro-lib/control/process-tree', async (original) => ({
	...(await original<typeof import('../../../../shared/maestro-lib/control/process-tree')>()),
}));
vi.mock('../../../../shared/platformDetection', async (original) => ({
	...(await original<typeof import('../../../../shared/platformDetection')>()),
}));
import fs from 'node:fs';
import path from 'node:path';

import {
	applyWindowsShellRules,
	startTurn,
	turnProcessSpecFromPlan,
	type TurnProcessSpec,
	type LocalLaunchPlan,
	type StartTurnOptions,
	type TurnHandlers,
	type TurnHandle,
} from '../../../../shared/maestro-lib/run/start-turn';
import type { ParsedEvent } from '../../../../shared/maestro-lib/parsers/agent-output-parser';
import { createOutputParser } from '../../../../shared/maestro-lib/parsers/parser-factory';
// The desktop spawners' own import path: the library must escape with that code.
import { escapeCmdArg } from '../../../../main/process-manager/utils/shellEscape';
import { cmdShellArgProblem } from '../../../../shared/maestro-lib/launch/windows-command';
import { CAPTURED_RECORDINGS } from '../../../main/process-manager/recordings/captured';
import { createScratchDir, fakeAgentSpec, fakeTurnFromRecording } from './fakeAgent';

const OPTIONS: StartTurnOptions = { stopGraceMs: 200 };
const posixIt = it.skipIf(process.platform === 'win32');

/** A real OpenCode turn, as captured: every chunk exactly as it arrived. */
const OPENCODE_TURN = fakeTurnFromRecording(CAPTURED_RECORDINGS['captured-opencode-normal']);
const OPENCODE_LINES = OPENCODE_TURN.chunks
	.join('')
	.split('\n')
	.filter((text) => text.length > 0);

/** What the provider's parser makes of those lines, with no process involved. */
function parseInProcess(lines: string[]): ParsedEvent[] {
	const parser = createOutputParser('opencode')!;
	return lines
		.map((text) => parser.parseJsonLine(text))
		.filter((event): event is ParsedEvent => event !== null);
}

let scratch: { dir: string; cleanup: () => void };

beforeAll(() => {
	scratch = createScratchDir('maestro-run-layer');
});

afterAll(() => {
	scratch.cleanup();
});

/** Handlers that record everything they hear, in the order they hear it. */
function recorder() {
	const heard: string[] = [];
	const lines: string[] = [];
	const events: ParsedEvent[] = [];
	const handlers: TurnHandlers = {
		onStarted: () => heard.push('started'),
		onStdout: () => heard.push('stdout'),
		onStderr: () => heard.push('stderr'),
		onLine: (text) => {
			heard.push('line');
			lines.push(text);
		},
		onEvent: (event) => {
			heard.push(`event:${event.type}`);
			events.push(event);
		},
	};
	return { heard, lines, events, handlers };
}

describe('startTurn private prompt artifacts', () => {
	let files: ReturnType<typeof createScratchDir>;
	let child: childProcess.ChildProcess;
	let current: TurnHandle | undefined;
	let spec: TurnProcessSpec;
	let artifact: NonNullable<TurnProcessSpec['promptArtifact']>;
	let descriptor: number | undefined;
	let descriptorOpen: boolean;

	beforeEach(() => {
		vi.useFakeTimers();
		files = createScratchDir('maestro-prompt-artifact');
		current = undefined;
		descriptor = undefined;
		descriptorOpen = false;
		artifact = {
			owner: 'local',
			path: path.join(files.dir, 'private-prompt.json'),
			content: JSON.stringify({ prompt: 'synthetic-private-content 🦊\nnext line' }),
			encoding: 'utf8',
			mode: 0o600,
			flag: 'wx',
			cleanup: 'turn',
		};
		spec = {
			command: process.execPath,
			args: ['--prompt-file', artifact.path],
			cwd: files.dir,
			env: {},
			promptArtifact: artifact,
		};
		child = Object.assign(new EventEmitter(), {
			pid: 4242,
			exitCode: null,
			signalCode: null,
			kill: vi.fn(() => true),
			stdin: new PassThrough(),
			stdout: new PassThrough(),
			stderr: new PassThrough(),
		}) as unknown as childProcess.ChildProcess;
		vi.spyOn(childProcess, 'spawn').mockReturnValue(child);
		vi.spyOn(platform, 'isWindows').mockReturnValue(false);
		vi.spyOn(processTree, 'snapshotProcessTree').mockReturnValue({ owned: false, descendants: [] });
		vi.spyOn(processTree, 'killProcessTreeNow').mockImplementation(() => {});
		vi.spyOn(process, 'kill').mockReturnValue(true);
		vi.spyOn(artifactFs, 'openSync').mockImplementation((...args) => {
			descriptor = fs.openSync(...args);
			descriptorOpen = true;
			return descriptor;
		});
		vi.spyOn(artifactFs, 'closeSync').mockImplementation((fd) => {
			fs.closeSync(fd);
			if (fd === descriptor) descriptorOpen = false;
		});
		vi.spyOn(logger, 'warn').mockImplementation(() => {});
	});

	afterEach(async () => {
		try {
			child.emit('close', 0, null);
			await current?.done;
		} finally {
			child.stdin?.destroy();
			child.stdout?.destroy();
			child.stderr?.destroy();
			vi.clearAllTimers();
			vi.useRealTimers();
			vi.restoreAllMocks();
			// Also release a leaked descriptor when an assertion exposes a regression.
			if (descriptorOpen && descriptor !== undefined) {
				try {
					fs.closeSync(descriptor);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== 'EBADF') throw error;
				}
			}
			files.cleanup();
		}
	});

	function expectClosed() {
		expect(descriptor).toBeTypeOf('number');
		expect(artifactFs.closeSync).toHaveBeenCalledExactlyOnceWith(descriptor);
		expect(() => fs.fstatSync(descriptor!)).toThrow(expect.objectContaining({ code: 'EBADF' }));
	}

	it.each([
		['empty bytes', '', 0],
		['empty JSON prompt', '{"prompt":""}', 0],
		['Unicode JSON', JSON.stringify({ prompt: '雪 🦊\n"quoted"\r\n\t' }), 0],
		['large JSON', JSON.stringify({ prompt: '🦊\n'.repeat(100_000) }), 7],
	] as const)('preserves %s until reader close', async (_label, content, code) => {
		artifact.content = content;
		current = startTurn(spec, {}, OPTIONS);
		expect(artifactFs.openSync).toHaveBeenCalledExactlyOnceWith(artifact.path, 'wx', 0o600);
		expect(fs.readFileSync(artifact.path)).toEqual(Buffer.from(content, 'utf8'));
		if (process.platform !== 'win32') expect(fs.statSync(artifact.path).mode & 0o777).toBe(0o600);
		expect((child.stdin as PassThrough).read()).toBeNull();
		Object.assign(child, { exitCode: code });
		child.emit('exit', code, null);
		expect(fs.existsSync(artifact.path)).toBe(true);
		expect(artifactFs.closeSync).not.toHaveBeenCalled();
		child.emit('close', code, null);
		expect(await current.done).toMatchObject({ exitCode: code, interrupted: false });
		expect(fs.existsSync(artifact.path)).toBe(false);
		expectClosed();
	});

	it('preserves an exclusive-create collision without acquiring a descriptor', () => {
		fs.writeFileSync(artifact.path, 'other owner');
		expect(() => startTurn(spec, {}, OPTIONS)).toThrow(
			/^Could not prepare the private prompt artifact\.$/
		);
		expect(fs.readFileSync(artifact.path, 'utf8')).toBe('other owner');
		expect(descriptor).toBeUndefined();
		expect(artifactFs.closeSync).not.toHaveBeenCalled();
		expect(childProcess.spawn).not.toHaveBeenCalled();
	});

	it.each(['replacement', 'missing'] as const)(
		'closes its descriptor after a %s path',
		async (kind) => {
			current = startTurn(spec, {}, OPTIONS);
			if (kind === 'replacement')
				fs.renameSync(artifact.path, path.join(files.dir, 'original.json'));
			else fs.unlinkSync(artifact.path);
			if (kind === 'replacement') fs.writeFileSync(artifact.path, 'other owner');
			child.emit('close', 0, null);
			await current.done;
			if (kind === 'replacement') {
				expect(fs.readFileSync(artifact.path, 'utf8')).toBe('other owner');
				expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
					'Prompt artifact changed ownership; cleanup skipped.',
					'startTurn'
				);
			} else expect(logger.warn).not.toHaveBeenCalled();
			expectClosed();
		}
	);

	it('removes partial writes and reports a fixed preparation error', () => {
		vi.spyOn(artifactFs, 'writeFileSync').mockImplementationOnce((fd) => {
			fs.writeSync(fd as number, 'partial');
			throw new Error(`write failed: ${artifact.path} ${artifact.content}`);
		});
		expect(() => startTurn(spec, {}, OPTIONS)).toThrow(
			/^Could not prepare the private prompt artifact\.$/
		);
		expect(fs.existsSync(artifact.path)).toBe(false);
		expect(childProcess.spawn).not.toHaveBeenCalled();
		expect(logger.warn).not.toHaveBeenCalled();
		expectClosed();
	});

	it.each(['synchronous', 'asynchronous'] as const)(
		'cleans up a %s spawn failure',
		async (kind) => {
			const error = Object.assign(new Error('synthetic spawn failure'), { code: 'ENOENT' });
			if (kind === 'synchronous') {
				vi.mocked(childProcess.spawn).mockImplementationOnce(() => {
					throw error;
				});
				expect(() => startTurn(spec, {}, OPTIONS)).toThrow(
					expect.objectContaining({ name: 'TurnNotStartedError', message: error.message })
				);
			} else {
				Object.assign(child, { pid: undefined });
				current = startTurn(spec, {}, OPTIONS);
				child.emit('error', error);
				expect((await current.done).spawnError).toBe(error);
				child.emit('close', -2, null);
			}
			expect(fs.existsSync(artifact.path)).toBe(false);
			expectClosed();
		}
	);

	it('constructs the parser before acquiring a file or child', () => {
		vi.spyOn(parserFactory, 'createOutputParser').mockImplementationOnce(() => {
			throw new Error('synthetic parser failure');
		});
		expect(() => startTurn(spec, {}, { ...OPTIONS, agentId: 'grok' })).toThrow(
			'synthetic parser failure'
		);
		expect(artifactFs.openSync).not.toHaveBeenCalled();
		expect(artifactFs.closeSync).not.toHaveBeenCalled();
		expect(childProcess.spawn).not.toHaveBeenCalled();
	});

	it.each(['before', 'after'] as const)(
		'cleans cancellation %s preparation without spawning',
		(when) => {
			const controller = new AbortController();
			if (when === 'before') controller.abort();
			else {
				const write = artifactFs.writeFileSync;
				vi.spyOn(artifactFs, 'writeFileSync').mockImplementationOnce((...args) => {
					fs.writeFileSync(...(args as Parameters<typeof write>));
					controller.abort();
				});
			}
			expect(() => startTurn(spec, {}, { ...OPTIONS, signal: controller.signal })).toThrow(
				/^Prompt-file launch was cancelled before spawn\.$/
			);
			expect(fs.existsSync(artifact.path)).toBe(false);
			expect(childProcess.spawn).not.toHaveBeenCalled();
			if (when === 'after') expectClosed();
			else expect(artifactFs.openSync).not.toHaveBeenCalled();
		}
	);

	it.each(['cancellation', 'signal error'] as const)(
		'retains ownership after %s until reader close',
		async (reason) => {
			const controller = new AbortController();
			current = startTurn(spec, {}, { ...OPTIONS, signal: controller.signal });
			if (reason === 'cancellation') controller.abort();
			else child.emit('error', Object.assign(new Error('signal denied'), { code: 'EPERM' }));
			expect(child.kill).toHaveBeenCalledWith('SIGTERM');
			Object.assign(child, { signalCode: 'SIGTERM' });
			child.emit('exit', null, 'SIGTERM');
			expect(fs.readFileSync(artifact.path, 'utf8')).toBe(artifact.content);
			expect(artifactFs.closeSync).not.toHaveBeenCalled();
			child.emit('close', null, 'SIGTERM');
			expect(await current.done).toMatchObject({ signal: 'SIGTERM', interrupted: true });
			expect((await current.done).spawnError).toBeUndefined();
			expect(fs.existsSync(artifact.path)).toBe(false);
			expectClosed();
		}
	);

	it.each(['fstatSync', 'lstatSync', 'unlinkSync', 'closeSync'] as const)(
		'reports %s cleanup failure without private data',
		async (operation) => {
			current = startTurn(spec, {}, OPTIONS);
			vi.spyOn(artifactFs, operation).mockImplementationOnce(() => {
				// Simulate an error after closing so the fixture never intentionally leaks.
				if (operation === 'closeSync') {
					fs.closeSync(descriptor!);
					descriptorOpen = false;
				}
				throw Object.assign(new Error(`${artifact.path}: ${artifact.content}`), { code: 'EIO' });
			});
			child.emit('close', 0, null);
			await current.done;
			expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
				operation === 'closeSync'
					? 'Could not close an owned prompt artifact.'
					: 'Could not remove an owned prompt artifact.',
				'startTurn'
			);
			expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain(artifact.path);
			expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain(artifact.content);
			expect(fs.existsSync(artifact.path)).toBe(operation !== 'closeSync');
			expectClosed();
		}
	);
});

describe('startTurn', () => {
	it('streams every line and parsed event, then reports a clean exit', async () => {
		const { heard, lines, events, handlers } = recorder();

		const turn = startTurn(fakeAgentSpec(scratch.dir, OPENCODE_TURN), handlers, {
			...OPTIONS,
			agentId: 'opencode',
		});
		const exit = await turn.done;

		expect(exit).toMatchObject({
			exitCode: 0,
			signal: null,
			interrupted: false,
			droppedOutputBytes: 0,
		});
		expect(exit.spawnError).toBeUndefined();
		expect(lines).toEqual(OPENCODE_LINES);
		// A process in between adds nothing and loses nothing.
		expect(events).toEqual(parseInProcess(OPENCODE_LINES));
		expect(events.length).toBeGreaterThan(0);
		expect(heard[0]).toBe('started');
		expect(turn.pid).toBeGreaterThan(0);
	});

	it('has delivered every event by the time done resolves', async () => {
		const { events, handlers } = recorder();

		const turn = startTurn(fakeAgentSpec(scratch.dir, OPENCODE_TURN), handlers, {
			...OPTIONS,
			agentId: 'opencode',
		});
		let eventsAtSettle = -1;
		await turn.done.then(() => {
			eventsAtSettle = events.length;
		});

		expect(eventsAtSettle).toBe(parseInProcess(OPENCODE_LINES).length);
	});

	it('reads a last line that has no trailing newline', async () => {
		const { lines, handlers } = recorder();

		const turn = startTurn(
			fakeAgentSpec(scratch.dir, {
				chunks: ['first\n', 'second with no newline'],
				close: { code: 0, signal: null },
			}),
			handlers,
			OPTIONS
		);
		await turn.done;

		expect(lines).toEqual(['first', 'second with no newline']);
	});

	it('reassembles a line that arrived split across chunks', async () => {
		const { lines, handlers } = recorder();
		const whole = JSON.stringify({ type: 'text', text: 'a'.repeat(200) });

		const turn = startTurn(
			fakeAgentSpec(scratch.dir, {
				chunks: [whole.slice(0, 40), whole.slice(40, 120), `${whole.slice(120)}\n`],
				close: { code: 0, signal: null },
			}),
			handlers,
			OPTIONS
		);
		await turn.done;

		expect(lines).toEqual([whole]);
	});

	it('keeps a multibyte character that was split across two reads', async () => {
		const { lines, handlers } = recorder();

		const turn = startTurn(
			fakeAgentSpec(scratch.dir, {
				chunks: ['café \u{1F600} déjà vu\n'],
				close: { code: 0, signal: null },
			}),
			handlers,
			OPTIONS
		);
		await turn.done;

		expect(lines).toEqual(['café \u{1F600} déjà vu']);
	});

	it('reports stderr and a non-zero exit code', async () => {
		const { handlers } = recorder();

		const turn = startTurn(
			fakeAgentSpec(scratch.dir, {
				chunks: [],
				stderr: 'Error: not logged in\n',
				close: { code: 7, signal: null },
			}),
			handlers,
			OPTIONS
		);
		const exit = await turn.done;

		expect(exit.exitCode).toBe(7);
		expect(exit.stderrText).toBe('Error: not logged in\n');
		expect(exit.interrupted).toBe(false);
	});

	it('keeps only a bounded tail of stdout', async () => {
		const turn = startTurn(
			fakeAgentSpec(scratch.dir, {
				chunks: [`${'x'.repeat(500)}\n`, 'the end\n'],
				close: { code: 0, signal: null },
			}),
			{},
			{ ...OPTIONS, stdoutTailLimit: 16 }
		);
		const exit = await turn.done;

		expect(exit.stdoutText).toHaveLength(16);
		expect(exit.stdoutText.endsWith('the end\n')).toBe(true);
	});

	it('keeps all of stderr unless the caller sets a limit', async () => {
		const noisy = `${'w'.repeat(500)}\nError: not logged in\n`;
		const spec = () =>
			fakeAgentSpec(scratch.dir, { chunks: [], stderr: noisy, close: { code: 7, signal: null } });

		const whole = await startTurn(spec(), {}, OPTIONS).done;
		const tail = await startTurn(spec(), {}, { ...OPTIONS, stderrTailLimit: 21 }).done;

		expect(whole.stderrText).toBe(noisy);
		expect(tail.stderrText).toBe('Error: not logged in\n');
	});

	it('keeps no copy of either stream for a caller that holds its own', async () => {
		let heardStdout = '';
		let heardStderr = '';

		const turn = startTurn(
			fakeAgentSpec(scratch.dir, {
				chunks: ['the answer\n'],
				stderr: 'a warning\n',
				close: { code: 0, signal: null },
			}),
			{
				onStdout: (text) => (heardStdout += text),
				onStderr: (text) => (heardStderr += text),
			},
			{ ...OPTIONS, stdoutTailLimit: 0, stderrTailLimit: 0 }
		);
		const exit = await turn.done;

		expect(exit.stdoutText).toBe('');
		expect(exit.stderrText).toBe('');
		// The handlers still receive every chunk.
		expect(heardStdout).toBe('the answer\n');
		expect(heardStderr).toBe('a warning\n');
	});

	it('reports a stdin error to its handler instead of throwing it at the host', async () => {
		// With no listener on the stream, this error is an uncaught exception.
		const errors: Error[] = [];
		const turn = startTurn(
			fakeAgentSpec(scratch.dir, OPENCODE_TURN),
			{ onStdinError: (error) => errors.push(error) },
			OPTIONS
		);
		const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });

		expect(() => turn.child.stdin!.emit('error', epipe)).not.toThrow();
		const exit = await turn.done;

		expect(errors).toEqual([epipe]);
		expect(exit.exitCode).toBe(0);
	});

	it('survives a stdin error when the caller passes no handler for it', async () => {
		const turn = startTurn(fakeAgentSpec(scratch.dir, OPENCODE_TURN), {}, OPTIONS);

		expect(() => turn.child.stdin!.emit('error', new Error('write EPIPE'))).not.toThrow();
		const exit = await turn.done;
		expect(exit.exitCode).toBe(0);
		// Not a failure of the prompt's own write, so the turn is not charged with it.
		expect(exit.stdinError).toBeUndefined();
	});

	posixIt(
		'keeps the error of a prompt the process closed stdin on, even on a clean exit',
		async () => {
			// A prompt larger than the pipe's buffer is still being written when the
			// process closes its end, so the write fails with EPIPE. The process then
			// exits 0, which alone would read as a finished turn.
			const errors: Error[] = [];
			const turn = startTurn(
				{
					command: process.execPath,
					args: ['-e', 'require("fs").closeSync(0); setTimeout(() => process.exit(0), 200);'],
					cwd: scratch.dir,
					env: process.env,
					stdin: 'p'.repeat(4 * 1024 * 1024),
				},
				{ onStdinError: (error) => errors.push(error) },
				OPTIONS
			);
			const exit = await turn.done;

			expect(exit.exitCode).toBe(0);
			expect((exit.stdinError as NodeJS.ErrnoException | undefined)?.code).toBe('EPIPE');
			expect(errors).toContain(exit.stdinError);
		}
	);

	it('has no stdin error for a prompt the process read', async () => {
		const turn = startTurn(
			fakeAgentSpec(scratch.dir, OPENCODE_TURN, { stdin: 'the prompt' }),
			{},
			OPTIONS
		);

		expect((await turn.done).stdinError).toBeUndefined();
	});

	it('counts and reports the bytes of a line too long to buffer', async () => {
		const { lines, handlers } = recorder();
		let reported = 0;

		// The long line is the unterminated tail. A long line followed by its
		// newline only trips the cap when the pipe delivers the two in separate
		// reads; when they coalesce the line is complete and nothing is dropped,
		// which made this test flake under CI load. An unterminated tail is
		// over the cap however the pipe splits it.
		const turn = startTurn(
			fakeAgentSpec(scratch.dir, {
				chunks: ['short\n', 'y'.repeat(4096)],
				close: { code: 0, signal: null },
			}),
			{ ...handlers, onOversizedLine: (dropped) => (reported += dropped) },
			{ ...OPTIONS, maxLineLength: 1024 }
		);
		const exit = await turn.done;

		expect(exit.droppedOutputBytes).toBeGreaterThan(0);
		expect(reported).toBe(exit.droppedOutputBytes);
		expect(lines).toContain('short');
	});

	it('frames no lines for a caller that takes only the raw stream', async () => {
		// Desktop chat frames the stream itself. With nobody to hand a line to,
		// nothing is buffered, so a stream that never ends a line costs nothing
		// and nothing is reported as dropped.
		let raw = '';
		let reported = 0;

		const turn = startTurn(
			fakeAgentSpec(scratch.dir, {
				chunks: ['y'.repeat(8192)],
				close: { code: 0, signal: null },
			}),
			{ onStdout: (text) => (raw += text), onOversizedLine: (dropped) => (reported += dropped) },
			{ ...OPTIONS, maxLineLength: 1024 }
		);
		const exit = await turn.done;

		expect(raw).toHaveLength(8192);
		expect(exit.droppedOutputBytes).toBe(0);
		expect(reported).toBe(0);
	});

	it('buffers a line of any length when no limit is set', async () => {
		const { lines, handlers } = recorder();
		const long = 'z'.repeat(2 * 1024 * 1024);

		const turn = startTurn(
			fakeAgentSpec(scratch.dir, { chunks: [`${long}\n`], close: { code: 0, signal: null } }),
			handlers,
			OPTIONS
		);
		const exit = await turn.done;

		expect(exit.droppedOutputBytes).toBe(0);
		expect(lines).toEqual([long]);
	});

	it('writes the spec stdin to the process and closes it', async () => {
		const stdinOut = path.join(scratch.dir, 'stdin-delivered.txt');

		const turn = startTurn(
			fakeAgentSpec(scratch.dir, OPENCODE_TURN, {
				stdin: 'What is the capital of France?',
				stdinOut,
			}),
			{},
			OPTIONS
		);
		const exit = await turn.done;

		// The fake agent reads stdin to its END before replaying, so a clean exit
		// also proves stdin was closed.
		expect(exit.exitCode).toBe(0);
		expect(fs.readFileSync(stdinOut, 'utf8')).toBe('What is the capital of France?');
	});

	it('closes stdin when there is nothing to write', async () => {
		const stdinOut = path.join(scratch.dir, 'stdin-empty.txt');

		const turn = startTurn(fakeAgentSpec(scratch.dir, OPENCODE_TURN, { stdinOut }), {}, OPTIONS);
		const exit = await turn.done;

		expect(exit.exitCode).toBe(0);
		expect(fs.readFileSync(stdinOut, 'utf8')).toBe('');
	});

	it('gives the process the null device when asked to ignore an empty stdin', async () => {
		const stdinOut = path.join(scratch.dir, 'stdin-ignored.txt');

		const turn = startTurn(
			fakeAgentSpec(scratch.dir, OPENCODE_TURN, { stdinOut }),
			{},
			{ ...OPTIONS, emptyStdin: 'ignore' }
		);
		const exit = await turn.done;

		expect(turn.child.stdin).toBeNull();
		expect(exit.exitCode).toBe(0);
		expect(fs.readFileSync(stdinOut, 'utf8')).toBe('');
	});

	it('reports a command that does not exist through done, not by throwing', async () => {
		const turn = startTurn(
			{
				command: path.join(scratch.dir, 'no-such-binary'),
				args: [],
				cwd: scratch.dir,
				env: process.env,
			},
			{},
			OPTIONS
		);
		const exit = await turn.done;

		expect(exit.spawnError).toBeInstanceOf(Error);
		expect((exit.spawnError as NodeJS.ErrnoException).code).toBe('ENOENT');
		expect(exit.exitCode).toBeNull();
	});

	it('parses nothing when no provider is named', async () => {
		const { lines, events, handlers } = recorder();

		const turn = startTurn(fakeAgentSpec(scratch.dir, OPENCODE_TURN), handlers, OPTIONS);
		await turn.done;

		expect(turn.parser).toBeNull();
		expect(lines).toEqual(OPENCODE_LINES);
		expect(events).toEqual([]);
	});

	it('gives each turn its own parser', async () => {
		const first = startTurn(
			fakeAgentSpec(scratch.dir, OPENCODE_TURN),
			{},
			{ ...OPTIONS, agentId: 'codex' }
		);
		const second = startTurn(
			fakeAgentSpec(scratch.dir, OPENCODE_TURN),
			{},
			{ ...OPTIONS, agentId: 'codex' }
		);
		await Promise.all([first.done, second.done]);

		expect(first.parser).not.toBeNull();
		expect(first.parser).not.toBe(second.parser);
	});

	posixIt('reports the signal that ended the process', async () => {
		const turn = startTurn(
			fakeAgentSpec(scratch.dir, { chunks: [], close: { code: null, signal: 'SIGTERM' } }),
			{},
			OPTIONS
		);
		const exit = await turn.done;

		expect(exit).toMatchObject({ exitCode: null, signal: 'SIGTERM', interrupted: false });
	});
});

describe('stopping a turn', () => {
	/** Resolves once the fake agent has replayed its turn and is holding. */
	function startHeldTurn(options: Partial<StartTurnOptions> = {}) {
		let ready!: () => void;
		const replayed = new Promise<void>((resolve) => {
			ready = resolve;
		});
		const turn = startTurn(
			fakeAgentSpec(scratch.dir, OPENCODE_TURN, { hold: true }),
			{
				onEvent: (event) => {
					if (event.type === 'result') ready();
				},
			},
			{ ...OPTIONS, agentId: 'opencode', ...options }
		);
		return { turn, replayed };
	}

	it('interrupt ends the turn and marks it interrupted', async () => {
		const { turn, replayed } = startHeldTurn();
		await replayed;
		expect(turn.stopRequested()).toBe(false);

		turn.interrupt();
		const exit = await turn.done;

		expect(turn.stopRequested()).toBe(true);
		expect(exit.interrupted).toBe(true);
	});

	it('terminate ends the turn and marks it interrupted', async () => {
		const { turn, replayed } = startHeldTurn();
		await replayed;

		turn.terminate();
		const exit = await turn.done;

		expect(exit.interrupted).toBe(true);
	});

	it('terminateNow ends the turn without waiting out a grace period', async () => {
		const { turn, replayed } = startHeldTurn({ stopGraceMs: 60_000 });
		await replayed;

		const before = Date.now();
		turn.terminateNow();
		const exit = await turn.done;

		expect(exit.interrupted).toBe(true);
		expect(Date.now() - before).toBeLessThan(5000);
	});

	it('an abort signal stops the turn', async () => {
		const controller = new AbortController();
		const { turn, replayed } = startHeldTurn({ signal: controller.signal });
		await replayed;

		controller.abort();
		const exit = await turn.done;

		expect(exit.interrupted).toBe(true);
	});

	it('a signal that was already aborted stops the turn as soon as it starts', async () => {
		const controller = new AbortController();
		controller.abort();

		const { turn } = startHeldTurn({ signal: controller.signal });
		const exit = await turn.done;

		expect(exit.interrupted).toBe(true);
	});

	it('a turn that finished on its own is not marked interrupted by a late abort', async () => {
		const controller = new AbortController();
		const turn = startTurn(
			fakeAgentSpec(scratch.dir, OPENCODE_TURN),
			{},
			{ ...OPTIONS, signal: controller.signal }
		);
		const exit = await turn.done;
		controller.abort();

		expect(exit.interrupted).toBe(false);
		expect(turn.stopRequested()).toBe(false);
	});
});

describe('a turn in its own process group', () => {
	// An agent that, on SIGTERM, starts a tool and exits in the same tick: no
	// re-read of the descendant record can see the tool before the agent is
	// gone and the tool is reparented (#1689). The tool's pid goes to a file,
	// written synchronously, because a pipe write may not land before exit.
	function lateToolAgent(pidFile: string): TurnProcessSpec {
		const source = `
			const { spawn } = require('child_process');
			const fs = require('fs');
			process.on('SIGTERM', () => {
				const tool = spawn('sleep', ['60'], { stdio: 'ignore' });
				fs.writeFileSync(${JSON.stringify(pidFile)}, String(tool.pid));
				process.exit(0);
			});
			setInterval(() => {}, 1000);
			console.log('ready');
		`;
		return {
			command: process.execPath,
			args: ['-e', source],
			cwd: process.cwd(),
			env: process.env,
		};
	}

	function isAlive(pid: number): boolean {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	}

	async function waitUntilGone(pid: number, timeoutMs: number): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (!isAlive(pid)) return true;
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		return !isAlive(pid);
	}

	posixIt('stops a tool the agent started just before it exited', async () => {
		const pidFile = path.join(scratch.dir, 'late-tool.pid');
		let ready!: () => void;
		const started = new Promise<void>((resolve) => {
			ready = resolve;
		});
		const turn = startTurn(
			lateToolAgent(pidFile),
			{ onLine: (line) => line === 'ready' && ready() },
			{ ...OPTIONS, processGroup: true }
		);
		await started;

		turn.terminate();
		const exit = await turn.done;
		const toolPid = Number(fs.readFileSync(pidFile, 'utf8'));
		try {
			expect(exit.interrupted).toBe(true);
			expect(await waitUntilGone(toolPid, 2000)).toBe(true);
		} finally {
			if (isAlive(toolPid)) process.kill(toolPid, 'SIGKILL');
		}
	});
});

describe('turnProcessSpecFromPlan', () => {
	it('carries the plan command, arguments, directory, environment and stdin', () => {
		const plan: LocalLaunchPlan = {
			target: { kind: 'local' },
			command: '/usr/local/bin/hermes',
			args: ['chat', '--query-file', '-'],
			cwd: '/project',
			prompt: { via: 'stdin', format: 'raw', args: ['--query-file', '-'] },
			stdin: 'fix the bug',
			envVars: { HERMES_HOME: '/h' },
			env: { PATH: '/usr/bin', HERMES_HOME: '/h' },
			permission: { requested: 'standard' },
		};

		expect(turnProcessSpecFromPlan(plan)).toEqual({
			command: '/usr/local/bin/hermes',
			args: ['chat', '--query-file', '-'],
			cwd: '/project',
			env: { PATH: '/usr/bin', HERMES_HOME: '/h' },
			stdin: 'fix the bug',
		});
	});
});

describe('applyWindowsShellRules', () => {
	const SHIM = 'C:\\Users\\First Last\\AppData\\Roaming\\npm\\codex.cmd';
	const ARGS = ['exec', '--json', 'a b', 'say "hi"', 'x&y', 'up^down'];
	const spec = (command: string, extra: Partial<TurnProcessSpec> = {}): TurnProcessSpec => ({
		command,
		args: ARGS,
		cwd: 'C:\\project',
		env: {},
		stdin: 'the prompt',
		...extra,
	});

	it('turns the shell on for a .cmd shim, quotes its path and escapes every argument as the desktop does', () => {
		expect(applyWindowsShellRules(spec(SHIM), { isWindowsHost: true })).toEqual({
			...spec(SHIM),
			command: `"${SHIM}"`,
			args: ARGS.map(escapeCmdArg),
			shell: true,
		});
	});

	it('changes nothing the second time', () => {
		const once = applyWindowsShellRules(spec(SHIM), { isWindowsHost: true });
		expect(applyWindowsShellRules(once, { isWindowsHost: true })).toEqual(once);
	});

	it('turns the shell on for a bare .exe name, which only a shell finds on PATH', () => {
		expect(applyWindowsShellRules(spec('codex.exe'), { isWindowsHost: true }).shell).toBe(true);
	});

	it('starts an .exe with a path directly', () => {
		const direct = spec('C:\\Program Files\\Codex\\codex.exe');
		expect(applyWindowsShellRules(direct, { isWindowsHost: true })).toBe(direct);
	});

	it('leaves a spec that already names its shell to its caller', () => {
		const chosen = spec(SHIM, {
			shell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
		});
		expect(applyWindowsShellRules(chosen, { isWindowsHost: true })).toBe(chosen);
	});

	it('changes nothing off Windows', () => {
		const shim = spec(SHIM);
		expect(applyWindowsShellRules(shim, { isWindowsHost: false })).toBe(shim);
	});

	it('is applied by turnProcessSpecFromPlan', () => {
		const plan: LocalLaunchPlan = {
			target: { kind: 'local' },
			command: SHIM,
			args: ARGS,
			cwd: 'C:\\project',
			prompt: { via: 'stdin', format: 'raw', args: [] },
			stdin: 'the prompt',
			envVars: undefined,
			env: {},
			permission: { requested: 'standard' },
		};
		expect(turnProcessSpecFromPlan(plan, { isWindowsHost: true })).toEqual(
			applyWindowsShellRules(spec(SHIM), { isWindowsHost: true })
		);
	});

	// A real cmd.exe and a real npm-style shim: only the Windows CI leg has them.
	it.runIf(process.platform === 'win32')(
		'starts a .cmd shim under a path with spaces and delivers the prompt intact',
		async () => {
			const shimDir = path.join(scratch.dir, 'npm dir');
			fs.mkdirSync(shimDir, { recursive: true });
			fs.writeFileSync(
				path.join(shimDir, 'echo.mjs'),
				[
					"let stdin = '';",
					"process.stdin.setEncoding('utf8');",
					"process.stdin.on('data', (chunk) => (stdin += chunk));",
					"process.stdin.on('end', () => process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), stdin }) + '\\n'));",
				].join('\n')
			);
			const shimPath = path.join(shimDir, 'echo.cmd');
			// What npm writes, reduced to its essentials.
			fs.writeFileSync(shimPath, `@"${process.execPath}" "%~dp0\\echo.mjs" %*\r\n`);

			const prompt = 'say "hi" & echo 50% | more ^ done\nsecond line\r\nthird';
			const args = ['--flag', 'a b', 'x&y|z', 'say "hi"'];
			const handle = startTurn(
				applyWindowsShellRules({
					command: shimPath,
					args,
					cwd: scratch.dir,
					env: process.env,
					stdin: prompt,
				}),
				{},
				OPTIONS
			);
			const exit = await handle.done;

			expect(exit.spawnError).toBeUndefined();
			expect(exit.exitCode).toBe(0);
			expect(JSON.parse(exit.stdoutText.trim())).toEqual({ argv: args, stdin: prompt });
		}
	);

	// The other half of cmdShellArgProblem's % rule: a lone % (and an empty %%)
	// is left alone on a cmd.exe command line and by npm's bare %* forwarding.
	// Several in one command line also pair up ACROSS arguments, and those names
	// contain a quote, so nothing defines them and they pass unchanged too.
	it.runIf(process.platform === 'win32')(
		'delivers lone % signs through a .cmd shim unchanged',
		async () => {
			const shimDir = path.join(scratch.dir, 'percent shim');
			fs.mkdirSync(shimDir, { recursive: true });
			fs.writeFileSync(
				path.join(shimDir, 'echo.mjs'),
				"process.stdout.write(JSON.stringify(process.argv.slice(2)) + '\\n');\n"
			);
			const shimPath = path.join(shimDir, 'echo.cmd');
			fs.writeFileSync(shimPath, `@"${process.execPath}" "%~dp0\\echo.mjs" %*\r\n`);

			const args = ['100%', '%20', '50% off', '%%', 'plain'];
			for (const arg of args) expect(cmdShellArgProblem(arg)).toBeNull();
			const handle = startTurn(
				applyWindowsShellRules({ command: shimPath, args, cwd: scratch.dir, env: process.env }),
				{},
				OPTIONS
			);
			const exit = await handle.done;

			expect(exit.spawnError).toBeUndefined();
			expect(exit.exitCode).toBe(0);
			expect(JSON.parse(exit.stdoutText.trim())).toEqual(args);
		}
	);
});

// Grok's ACP route (grok/acp-turn.ts) and provider probe (agents/grok-probe.ts)
// start their turns with `trackDescendants` and the raw byte handlers.
describe('observed descendant ownership', () => {
	const root = { pid: 4242, startedAt: 'original-root' };
	const tool = { pid: 5000, startedAt: 'original-tool' };
	let child: childProcess.ChildProcess;
	let tree: processTree.ProcessTreeSnapshot;
	let current: TurnHandle | undefined;
	let resolveRead: ((value: processTree.ProcessTreeSnapshot) => void) | undefined;

	beforeEach(() => {
		vi.useFakeTimers();
		current = undefined;
		resolveRead = undefined;
		tree = { owned: true, root, descendants: [tool] };
		child = Object.assign(new EventEmitter(), {
			pid: root.pid,
			exitCode: null,
			signalCode: null,
			kill: vi.fn(() => true),
			stdin: new PassThrough(),
			stdout: new PassThrough(),
			stderr: new PassThrough(),
		}) as unknown as childProcess.ChildProcess;
		vi.spyOn(childProcess, 'spawn').mockReturnValue(child);
		vi.spyOn(platform, 'isWindows').mockReturnValue(false);
		vi.spyOn(processTree, 'snapshotProcessTree').mockImplementation(() => tree);
		vi.spyOn(processTree, 'refreshProcessTree').mockImplementation(async (_pid, prior) => prior);
		vi.spyOn(processTree, 'killSurvivors').mockReturnValue(0);
		vi.spyOn(processTree, 'killProcessTreeNow').mockImplementation(() => {});
		// Defense in depth: no synthetic PID may reach the operating system.
		vi.spyOn(process, 'kill').mockReturnValue(true);
	});

	afterEach(async () => {
		resolveRead?.(tree);
		child.emit('close', 0, null);
		await current?.done;
		child.stdin?.destroy();
		child.stdout?.destroy();
		child.stderr?.destroy();
		vi.clearAllTimers();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	/** A tracked turn over the fake child, and whether its `done` has settled yet. */
	function observed(options: Partial<StartTurnOptions> = {}, handlers: TurnHandlers = {}) {
		const spec = { command: process.execPath, args: [], cwd: scratch.dir, env: {} };
		const turn = startTurn(spec, handlers, {
			...OPTIONS,
			trackDescendants: true,
			...options,
		});
		current = turn;
		let settled = false;
		void turn.done.then(() => {
			settled = true;
		});
		return { turn, settled: () => settled };
	}

	it.each(['both', 'stdout', 'stderr'] as const)(
		'preserves raw %s bytes alongside independently decoded text and lines',
		async (raw) => {
			const stdout = Buffer.from('out:雪\nlast🦊');
			const stderr = Buffer.concat([Buffer.from('err:☃'), Buffer.from([0xe2, 0x82])]);
			const outChunks = [stdout.subarray(0, 5), stdout.subarray(5, 13), stdout.subarray(13)];
			const errChunks = [stderr.subarray(0, 5), stderr.subarray(5, 7), stderr.subarray(7)];
			const outBytes: Buffer[] = [];
			const errBytes: Buffer[] = [];
			const outText: string[] = [];
			const errText: string[] = [];
			const lines: string[] = [];
			const { turn } = observed(
				{ stdoutTailLimit: 9, stderrTailLimit: 4 },
				{
					onStdoutBytes:
						raw !== 'stderr' ? (chunk) => outBytes.push(Buffer.from(chunk)) : undefined,
					onStderrBytes:
						raw !== 'stdout' ? (chunk) => errBytes.push(Buffer.from(chunk)) : undefined,
					onStdout: (text) => outText.push(text),
					onStderr: (text) => errText.push(text),
					onLine: (line) => lines.push(line),
				}
			);
			for (let index = 0; index < outChunks.length; index++) {
				(child.stdout as PassThrough).write(outChunks[index]);
				(child.stderr as PassThrough).write(errChunks[index]);
			}
			expect(outText.join('')).toBe(stdout.toString());
			expect(errText.join('')).toBe('err:☃');
			// Drain the legacy stream decoder as Node does before the process close.
			(child.stdout as PassThrough).end();
			(child.stderr as PassThrough).end();
			await vi.advanceTimersByTimeAsync(0);
			child.emit('close', 0, null);
			expect(await turn.done).toMatchObject({
				stdoutText: stdout.toString().slice(-9),
				stderrText: stderr.toString().slice(-4),
				droppedOutputBytes: 0,
			});
			expect(outBytes).toEqual(raw === 'stderr' ? [] : outChunks);
			expect(errBytes).toEqual(raw === 'stdout' ? [] : errChunks);
			expect(outText.join('')).toBe(stdout.toString());
			expect(errText.join('')).toBe(stderr.toString());
			expect(lines).toEqual(['out:雪', 'last🦊']);
			expect(vi.getTimerCount()).toBe(0);
		}
	);

	it.each(['exit', 'caller', 'spawn-error'] as const)(
		'settles exactly once after %s',
		async (ending) => {
			const stopped = vi.fn();
			const error = new Error('synthetic executable unavailable');
			if (ending === 'spawn-error') Object.assign(child, { pid: undefined });
			const { turn } = observed({}, { onStopRequested: stopped });
			if (ending === 'caller') turn.terminate();
			if (ending === 'spawn-error') child.emit('error', error);
			child.emit('close', 7, null);
			const settled = vi.fn();
			const exit = await turn.done.then((result) => {
				settled();
				return result;
			});
			expect(exit.spawnError).toBe(ending === 'spawn-error' ? error : undefined);
			expect(exit.interrupted).toBe(ending === 'caller');
			if (ending === 'caller') {
				expect(stopped).toHaveBeenCalledTimes(1);
				expect(child.kill).toHaveBeenCalledWith('SIGTERM');
			} else expect(stopped).not.toHaveBeenCalled();
			turn.terminateNow();
			child.emit('close', 0, null);
			expect(await turn.done).toBe(exit);
			expect(settled).toHaveBeenCalledTimes(1);
			expect(vi.getTimerCount()).toBe(0);
		}
	);

	it.each(['timeout', 'cancellation'] as const)(
		'joins a late observation after parent exit and %s before settling',
		async (reason) => {
			const controller = new AbortController();
			const removeAbort = vi.spyOn(controller.signal, 'removeEventListener');
			const { turn, settled } = observed({ signal: controller.signal });
			const finish = trackProcessTree(child);
			expect(trackProcessTree(child)).toBe(finish);
			expect(vi.getTimerCount()).toBe(1);
			vi.mocked(processTree.refreshProcessTree).mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						resolveRead = resolve;
					})
			);
			await vi.advanceTimersByTimeAsync(TREE_REFRESH_MS * 3);
			expect(processTree.refreshProcessTree).toHaveBeenCalledTimes(1);
			const synchronousTool = { pid: 5001, startedAt: 'sync-tool' };
			const lateTool = { pid: 5002, startedAt: 'late-tool' };
			tree = { ...tree, descendants: [tool, synchronousTool] };
			Object.assign(child, { exitCode: 0 });
			child.emit('exit', 0, null);
			if (reason === 'timeout') {
				setTimeout(() => turn.terminate(), 100);
				await vi.advanceTimersByTimeAsync(100);
			} else controller.abort();
			expect(processTree.killSurvivors).toHaveBeenLastCalledWith(
				[tool, synchronousTool],
				expect.any(Object)
			);
			expect(child.kill).not.toHaveBeenCalled();
			child.emit('close', 0, null);
			expect(vi.getTimerCount()).toBe(0);
			await Promise.resolve();
			expect(settled()).toBe(false);
			resolveRead!({ owned: true, root, descendants: [tool, lateTool] });
			const exit = await turn.done;
			expect(processTree.killSurvivors).toHaveBeenLastCalledWith(
				[tool, synchronousTool, lateTool],
				expect.any(Object)
			);
			expect(exit).toMatchObject({ exitCode: 0, interrupted: true });
			expect(removeAbort).toHaveBeenCalledWith('abort', expect.any(Function));
			expect(child.listenerCount('exit')).toBe(0);
			const sweeps = vi.mocked(processTree.killSurvivors).mock.calls.length;
			turn.terminateNow();
			controller.abort();
			child.emit('close', 0, null);
			expect(processTree.killSurvivors).toHaveBeenCalledTimes(sweeps);
			expect(process.kill).not.toHaveBeenCalled();
		}
	);

	it('drains trailing stdout and stderr after exit, then joins a normal pending read without stopping', async () => {
		const { lines, handlers } = recorder();
		const { turn, settled } = observed({}, handlers);
		vi.mocked(processTree.refreshProcessTree).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveRead = resolve;
				})
		);
		await vi.advanceTimersByTimeAsync(TREE_REFRESH_MS);
		child.stdout!.emit('data', 'first\nlast');
		Object.assign(child, { exitCode: 0 });
		child.emit('exit', 0, null);
		child.stdout!.emit('data', ' line');
		child.stderr!.emit('data', 'trailing warning');
		child.emit('close', 0, null);
		expect(lines).toEqual(['first', 'last line']);
		await Promise.resolve();
		expect(settled()).toBe(false);
		resolveRead!(tree);
		expect(await turn.done).toMatchObject({
			stdoutText: 'first\nlast line',
			stderrText: 'trailing warning',
			interrupted: false,
		});
		expect(processTree.killSurvivors).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it('retains ownership after a post-spawn signal error and cleans up a failed table read', async () => {
		const { turn, settled } = observed();
		vi.mocked(processTree.refreshProcessTree).mockRejectedValueOnce(new Error('table unavailable'));
		await vi.advanceTimersByTimeAsync(TREE_REFRESH_MS);
		child.emit('error', Object.assign(new Error('signal denied'), { code: 'EPERM' }));
		expect(child.kill).toHaveBeenCalledWith('SIGTERM');
		expect(settled()).toBe(false);
		expect(child.listenerCount('exit')).toBe(1);
		expect(vi.getTimerCount()).toBe(2); // one tracker and one escalation
		Object.assign(child, { signalCode: 'SIGTERM' });
		child.emit('exit', null, 'SIGTERM');
		child.emit('close', null, 'SIGTERM');
		expect(await turn.done).toMatchObject({ signal: 'SIGTERM', interrupted: true });
		expect((await turn.done).spawnError).toBeUndefined();
		expect(child.listenerCount('exit')).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('settles a failed spawn without starting observation', async () => {
		Object.assign(child, { pid: undefined });
		const { turn } = observed();
		const error = Object.assign(new Error('missing executable'), { code: 'ENOENT' });
		child.emit('error', error);
		child.emit('close', -2, null);
		expect((await turn.done).spawnError).toBe(error);
		expect(processTree.snapshotProcessTree).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each([undefined, false])(
		'preserves untracked spawn and stop behavior with trackDescendants=%s',
		async (trackDescendants) => {
			const { turn } = observed({ trackDescendants });
			expect(childProcess.spawn).toHaveBeenCalledWith(process.execPath, [], {
				cwd: scratch.dir,
				env: {},
				shell: false,
				stdio: ['pipe', 'pipe', 'pipe'],
			});
			expect(processTree.snapshotProcessTree).not.toHaveBeenCalled();
			expect(vi.getTimerCount()).toBe(0);
			turn.terminateNow();
			expect(processTree.killProcessTreeNow).toHaveBeenCalledWith(root.pid, expect.any(Object));
			child.emit('close', null, 'SIGKILL');
			await turn.done;
			expect(vi.getTimerCount()).toBe(0);
		}
	);
});
