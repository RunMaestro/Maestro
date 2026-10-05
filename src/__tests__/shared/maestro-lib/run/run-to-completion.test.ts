/**
 * `runTurn` replaying every turn recording through a real process.
 *
 * The recordings are what desktop chat and the CLI already replay in their own
 * harnesses. Here each one is run twice: once fed straight to the capture and
 * the resolver with no process involved, and once through `runTurn` with the
 * fake agent writing the same bytes to a real pipe. The two must agree on every
 * fact, which is what proves the run layer adds nothing and loses nothing.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import {
	runTurn,
	runToCompletion,
	UnknownProviderError,
	type CompletedTurn,
	type RunTurnOptions,
} from '../../../../shared/maestro-lib/run/run-to-completion';
import { TurnCapture } from '../../../../shared/maestro-lib/run/turn-capture';
import { createOutputParser } from '../../../../shared/maestro-lib/parsers/parser-factory';
import { resolveTurnOutcome } from '../../../../shared/maestro-lib/streaming/turn-outcome';
import { BufferedLineReader } from '../../../../shared/maestro-lib/streaming/buffered-line-reader';
import { RECORDINGS, type TurnRecording } from '../../../main/process-manager/recordings/fixtures';
import {
	CAPTURED_RECORDINGS,
	CAPTURED_CLAUDE_CODE_SESSION_ID,
	CAPTURED_OPENCODE_SESSION_ID,
} from '../../../main/process-manager/recordings/captured';
import { createScratchDir, fakeAgentSpec, fakeTurnFromRecording } from './fakeAgent';

const SESSION_LABEL = 'agent-1-ai-tab-1';
const ALL_RECORDINGS: TurnRecording[] = [
	...Object.values(RECORDINGS),
	...Object.values(CAPTURED_RECORDINGS),
];
// A recording that ends on a signal needs a process that can die on one.
const REPLAYABLE = ALL_RECORDINGS.filter(
	(recording) => process.platform !== 'win32' || !recording.exitSignal
);

let scratch: { dir: string; cleanup: () => void };

beforeAll(() => {
	scratch = createScratchDir('maestro-run-recordings');
});

afterAll(() => {
	scratch.cleanup();
});

function optionsFor(recording: TurnRecording): RunTurnOptions {
	return { agentId: recording.toolType, sessionId: SESSION_LABEL, stopGraceMs: 200 };
}

/** The same turn with no process: the recorded bytes fed straight to the capture. */
function replayInProcess(recording: TurnRecording) {
	const parser = createOutputParser(recording.toolType)!;
	const capture = new TurnCapture(recording.toolType, parser);
	const reader = new BufferedLineReader();
	const lines = recording.chunks.flatMap((chunk) => reader.push(chunk));
	const trailing = reader.flush();
	if (trailing) lines.push(trailing);
	for (const text of lines) {
		const event = parser.parseJsonLine(text);
		if (event) capture.handleEvent(event);
	}

	const { outcome, error } = resolveTurnOutcome(
		{
			exitCode: recording.exitCode,
			signal: recording.exitSignal ?? null,
			// No stop is requested in a replay: the recorded process ends by itself.
			interrupted: false,
			stderrText: recording.stderrBuffer ?? '',
			stdoutText: recording.chunks.join(''),
			explicitError: capture.inBandError,
			capturedAnswerText: capture.answerText,
			resultMessageSeen: capture.resultMessageSeen,
		},
		parser,
		{ providerId: recording.toolType, sessionId: SESSION_LABEL }
	);
	return { capture, outcome, error };
}

describe('runTurn over the turn recordings', () => {
	it.each(REPLAYABLE.map((recording) => [recording.name, recording] as const))(
		'%s: a real process reports the same turn as an in-process replay',
		async (_name, recording) => {
			const expected = replayInProcess(recording);

			const turn = await runToCompletion(
				fakeAgentSpec(scratch.dir, fakeTurnFromRecording(recording)),
				optionsFor(recording)
			);

			expect(turn.exit.exitCode).toBe(recording.exitCode);
			expect(turn.exit.signal).toBe(recording.exitSignal ?? null);
			expect(turn.exit.stderrText).toBe(recording.stderrBuffer ?? '');
			expect(turn.exit.interrupted).toBe(false);
			expect(turn.exit.droppedOutputBytes).toBe(0);

			expect(turn.answerText).toBe(expected.capture.answerText);
			expect(turn.sessionId).toBe(expected.capture.sessionId);
			expect(turn.usage).toEqual(expected.capture.usage);
			expect(turn.outcome).toBe(expected.outcome);
			expect(turn.error?.type).toBe(expected.error?.type);
			expect(turn.error?.message).toBe(expected.error?.message);
		}
	);

	it('covers every recording the desktop and CLI harnesses replay', () => {
		expect(ALL_RECORDINGS.length).toBeGreaterThanOrEqual(20);
	});
});

describe('runTurn on real provider output', () => {
	async function replay(name: string): Promise<CompletedTurn> {
		const recording = CAPTURED_RECORDINGS[name];
		return runToCompletion(
			fakeAgentSpec(scratch.dir, fakeTurnFromRecording(recording)),
			optionsFor(recording)
		);
	}

	it('completes a Claude Code turn with its answer and session id', async () => {
		const turn = await replay('captured-claude-code-normal');

		expect(turn.outcome).toBe('completed');
		expect(turn.sessionId).toBe(CAPTURED_CLAUDE_CODE_SESSION_ID);
		expect(turn.answerText).toBeTruthy();
		expect(turn.usage?.outputTokens).toBeGreaterThan(0);
		expect(turn.error).toBeUndefined();
	});

	it('completes an OpenCode turn with its answer and session id', async () => {
		const turn = await replay('captured-opencode-normal');

		expect(turn.outcome).toBe('completed');
		expect(turn.sessionId).toBe(CAPTURED_OPENCODE_SESSION_ID);
		expect(turn.answerText).toBe('The capital of France is Paris.');
		expect(turn.error).toBeUndefined();
	});

	it('returns the same session id from a resumed turn, so the conversation can continue', async () => {
		const claude = await replay('captured-claude-code-resumed');
		const opencode = await replay('captured-opencode-resumed');

		expect(claude.sessionId).toBe(CAPTURED_CLAUDE_CODE_SESSION_ID);
		expect(opencode.sessionId).toBe(CAPTURED_OPENCODE_SESSION_ID);
	});
});

describe('runTurn', () => {
	const recording = CAPTURED_RECORDINGS['captured-opencode-normal'];

	it('streams to the caller while it captures', async () => {
		const heard: string[] = [];

		const running = runTurn(
			fakeAgentSpec(scratch.dir, fakeTurnFromRecording(recording)),
			optionsFor(recording),
			{
				onStarted: () => heard.push('started'),
				onEvent: (event) => heard.push(event.type),
			}
		);
		const turn = await running.completed;

		expect(heard[0]).toBe('started');
		expect(heard).toContain('result');
		expect(turn.answerText).toBe('The capital of France is Paris.');
	});

	it('reports a stopped turn as interrupted, whatever it had written', async () => {
		let replayed!: () => void;
		const ready = new Promise<void>((resolve) => {
			replayed = resolve;
		});
		const running = runTurn(
			fakeAgentSpec(scratch.dir, fakeTurnFromRecording(recording), { hold: true }),
			optionsFor(recording),
			{
				onEvent: (event) => {
					if (event.type === 'result') replayed();
				},
			}
		);
		await ready;

		running.handle.interrupt();
		const turn = await running.completed;

		expect(turn.outcome).toBe('interrupted');
		expect(turn.answerText).toBe('The capital of France is Paris.');
		expect(turn.sessionId).toBe(CAPTURED_OPENCODE_SESSION_ID);
	});

	it('reports a provider that could not be started as a crash that names the command', async () => {
		const turn = await runToCompletion(
			{ command: '/no/such/provider', args: [], cwd: scratch.dir, env: process.env },
			optionsFor(recording)
		);

		expect(turn.outcome).toBe('crashed');
		expect(turn.error?.type).toBe('agent_crashed');
		expect(turn.error?.message).toContain('/no/such/provider');
		expect(turn.exit.spawnError).toBeInstanceOf(Error);
	});

	it('refuses an unknown provider before anything is started', () => {
		expect(() =>
			runTurn(fakeAgentSpec(scratch.dir, fakeTurnFromRecording(recording)), {
				agentId: 'no-such-provider',
				sessionId: SESSION_LABEL,
				stopGraceMs: 200,
			})
		).toThrow(UnknownProviderError);
	});

	it("passes the caller's completion policy to the resolver", async () => {
		// A clean exit that said nothing: completed by default, a crash once the
		// caller asks for the empty-answer rule to apply to every provider.
		const silent = { chunks: [], close: { code: 0, signal: null } };

		const lenient = await runToCompletion(
			fakeAgentSpec(scratch.dir, silent),
			optionsFor(recording)
		);
		const strict = await runToCompletion(fakeAgentSpec(scratch.dir, silent), {
			...optionsFor(recording),
			outcome: { generalizeEmptyAnswerRule: true },
		});

		expect(lenient.outcome).toBe('completed');
		expect(strict.outcome).toBe('crashed');
	});
});

describe('answerSoFar', () => {
	const claudeNormal = CAPTURED_RECORDINGS['captured-claude-code-normal'];

	it('is empty before the turn has said anything, and the answer once it has', async () => {
		const running = runTurn(
			fakeAgentSpec(scratch.dir, fakeTurnFromRecording(claudeNormal), { hold: true }),
			{ agentId: 'claude-code', sessionId: SESSION_LABEL, stopGraceMs: 200 }
		);
		try {
			await new Promise<void>((resolve) => {
				const poll = setInterval(() => {
					if (running.answerSoFar() !== undefined) {
						clearInterval(poll);
						resolve();
					}
				}, 10);
			});
			// The process is still held open: this is what a stopped turn can still show.
			expect(running.answerSoFar()).toContain('Paris');
		} finally {
			running.handle.terminate();
			await running.completed;
		}
	});

	it('agrees with the finished turn’s answer', async () => {
		const running = runTurn(fakeAgentSpec(scratch.dir, fakeTurnFromRecording(claudeNormal)), {
			agentId: 'claude-code',
			sessionId: SESSION_LABEL,
			stopGraceMs: 200,
		});
		const completed = await running.completed;
		expect(running.answerSoFar()).toBe(completed.answerText);
	});
});
