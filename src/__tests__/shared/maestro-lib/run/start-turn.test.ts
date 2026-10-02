/**
 * `startTurn` against a real process.
 *
 * The run layer is the part that owns a process, so its tests start one: the
 * fake agent in `src/__tests__/fixtures/fake-agent.mjs`, replaying a turn.
 * Nothing about the process is mocked.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import {
	startTurn,
	turnProcessSpecFromPlan,
	type LocalLaunchPlan,
	type StartTurnOptions,
	type TurnHandlers,
} from '../../../../shared/maestro-lib/run/start-turn';
import type { ParsedEvent } from '../../../../shared/maestro-lib/parsers/agent-output-parser';
import { createOutputParser } from '../../../../shared/maestro-lib/parsers/parser-factory';
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

		const turn = startTurn(
			fakeAgentSpec(scratch.dir, {
				chunks: ['y'.repeat(4096), '\nshort\n'],
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
