/**
 * Turn recordings - end-to-end coverage for the 9 scenarios named in the
 * maestro-lib Part Two workplan, run through the REAL StdoutHandler,
 * ExitHandler, and the real Claude Code output parser (not mocked) - unlike
 * ExitHandler.test.ts/StdoutHandler.test.ts, which unit-test each handler in
 * isolation against a mock parser, this file's job is to catch integration
 * bugs between the new maestro-lib primitives (resolveTurnOutcome,
 * UsageAccumulator) and the real parser/handler wiring, end to end from raw
 * stdout chunks to emitted events.
 *
 * See fixtures.ts for the hand-authored recordings (each pins one edge case
 * on purpose) and captured.ts for real Claude Code and OpenCode turns (normal,
 * resumed, stopped), which the second describe block below replays.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../../main/utils/sentry', () => ({
	captureException: vi.fn(),
	captureMessage: vi.fn(),
}));

vi.mock('../../../../main/process-manager/utils/imageUtils', () => ({
	cleanupTempFiles: vi.fn(),
}));

vi.mock('../../../../main/stores/getters', () => ({
	getSshRemoteById: vi.fn(() => null),
}));

vi.mock('../../../../main/process-manager/CopilotShutdownWaiter', () => ({
	waitForCopilotShutdown: vi.fn(async () => 'not-copilot'),
	readCopilotFinalAnswer: vi.fn(),
	readCopilotShutdownUsage: vi.fn(),
}));

import { StdoutHandler } from '../../../../main/process-manager/handlers/StdoutHandler';
import { ExitHandler } from '../../../../main/process-manager/handlers/ExitHandler';
import { DataBufferManager } from '../../../../main/process-manager/handlers/DataBufferManager';
import {
	nextSpawnGeneration,
	resetSpawnGenerationsForTest,
} from '../../../../main/process-manager/generation';
import { createOutputParser } from '../../../../shared/maestro-lib/parsers/parser-factory';
import type {
	ManagedProcess,
	AgentError,
	UsageStats,
	TurnSettlement,
} from '../../../../main/process-manager/types';
import { RECORDINGS, type TurnRecording } from './fixtures';
import { CAPTURED_CLAUDE_CODE_SESSION_ID, CAPTURED_OPENCODE_SESSION_ID } from './captured';

interface CapturedEvents {
	sessionIds: string[];
	usages: UsageStats[];
	data: string[];
	agentErrors: AgentError[];
	exits: number[];
	settlements: Array<TurnSettlement | undefined>;
}

function createManagedProcess(sessionId: string, recording: TurnRecording): ManagedProcess {
	const outputParser = createOutputParser(recording.toolType);
	if (!outputParser) {
		throw new Error(`No output parser registered for ${recording.toolType}`);
	}
	return {
		sessionId,
		toolType: recording.toolType,
		cwd: '/tmp',
		pid: 4242,
		isTerminal: false,
		startTime: Date.now(),
		isStreamJsonMode: true,
		isBatchMode: false,
		jsonBuffer: '',
		stdoutBuffer: '',
		stderrBuffer: recording.stderrBuffer || '',
		contextWindow: 200000,
		sessionIdEmitted: false,
		resultEmitted: false,
		errorEmitted: false,
		outputParser,
		interrupted: recording.interrupted ?? false,
		agentSessionId: recording.agentSessionIdBeforeStart,
		streamedText: '',
	} as ManagedProcess;
}

async function runRecording(recording: TurnRecording): Promise<CapturedEvents> {
	const processes = new Map<string, ManagedProcess>();
	const emitter = new EventEmitter();
	const bufferManager = new DataBufferManager(processes, emitter);
	const stdoutHandler = new StdoutHandler({ processes, emitter, bufferManager });
	const exitHandler = new ExitHandler({ processes, emitter, bufferManager });

	const sessionId = recording.name;
	const managedProcess = createManagedProcess(sessionId, recording);
	processes.set(sessionId, managedProcess);
	// Store the generation: `isSupersededGeneration` reads an undefined one as
	// current, so leaving it unset bypasses the guard a recording is meant to run
	// under.
	managedProcess.spawnGeneration = nextSpawnGeneration(sessionId);

	const captured: CapturedEvents = {
		sessionIds: [],
		usages: [],
		data: [],
		agentErrors: [],
		exits: [],
		settlements: [],
	};
	emitter.on('session-id', (_sid: string, id: string) => captured.sessionIds.push(id));
	emitter.on('usage', (_sid: string, usage: UsageStats) => captured.usages.push(usage));
	emitter.on('data', (_sid: string, text: string) => captured.data.push(text));
	emitter.on('agent-error', (_sid: string, error: AgentError) => captured.agentErrors.push(error));
	emitter.on(
		'exit',
		(_sid: string, code: number, _signal?: string, settlement?: TurnSettlement) => {
			captured.exits.push(code);
			captured.settlements.push(settlement);
		}
	);

	for (const chunk of recording.chunks) {
		stdoutHandler.handleData(sessionId, chunk);
	}

	// ChildProcessSpawner hands ExitHandler `code || 0`, so a process that died on
	// a signal (code null) reaches it as 0, with the signal alongside. Mirror
	// that rather than the raw code.
	await exitHandler.handleExit(
		sessionId,
		recording.exitCode || 0,
		undefined,
		recording.exitSignal ?? null
	);

	return captured;
}

describe('turn recordings', () => {
	beforeEach(() => {
		resetSpawnGenerationsForTest();
	});

	it('normal: clean single turn produces session-id, usage, the final answer, no error', async () => {
		const events = await runRecording(RECORDINGS.normal);

		expect(events.sessionIds).toEqual(['sess-normal-1']);
		expect(events.usages).toHaveLength(1);
		expect(events.data.join('')).toContain('Here is the answer.');
		expect(events.agentErrors).toEqual([]);
		expect(events.exits).toEqual([0]);
		expect(events.settlements).toEqual([{ outcome: 'completed', answerCaptured: true }]);
	});

	it('resumed: a process pre-seeded with agentSessionId confirms continuity with the same id', async () => {
		const events = await runRecording(RECORDINGS.resumed);

		expect(events.sessionIds).toEqual(['sess-continuing-conversation']);
		expect(events.agentErrors).toEqual([]);
		expect(events.data.join('')).toContain('Continuing where we left off.');
		// This "resumed" turn is still a fresh PROCESS with a fresh
		// UsageAccumulator instance (per the turn contract's per-process
		// scoping decision, Plans/maestro-lib-turn-contract.md section 3) -
		// its first usage event is returned as-is, not delta-corrected against
		// whatever the previous process last reported. Resume continuity is a
		// conversation-identity concept, not a usage-accumulator one.
		expect(events.usages).toHaveLength(1);
		expect(events.usages[0].inputTokens).toBe(500);
		expect(events.settlements).toEqual([{ outcome: 'completed', answerCaptured: true }]);
	});

	it('interrupted: no agent-error fires, and the partial answer still flushes at exit', async () => {
		const events = await runRecording(RECORDINGS.interrupted);

		expect(events.agentErrors).toEqual([]);
		expect(events.data.join('')).toContain('Working on it when stopped');
		expect(events.exits).toEqual([1]);
		expect(events.settlements).toEqual([{ outcome: 'interrupted', answerCaptured: true }]);
	});

	it('chunked: fragmented delivery of every line produces the identical result to an unfragmented stream', async () => {
		const events = await runRecording(RECORDINGS.chunked);

		expect(events.sessionIds).toEqual(['sess-chunked-1']);
		expect(events.data.join('')).toContain('Here is the chunked answer.');
		expect(events.agentErrors).toEqual([]);
		expect(events.settlements).toEqual([{ outcome: 'completed', answerCaptured: true }]);
	});

	it('interleaved: text and tool_use events interleave without corrupting the final answer', async () => {
		const events = await runRecording(RECORDINGS.interleaved);

		expect(events.sessionIds).toEqual(['sess-interleaved-1']);
		expect(events.data.join('')).toContain('Done - final answer.');
		expect(events.agentErrors).toEqual([]);
		expect(events.settlements).toEqual([{ outcome: 'completed', answerCaptured: true }]);
	});

	it("cut-stream: a result with no trailing newline is recovered by ExitHandler's exit-time flush", async () => {
		const events = await runRecording(RECORDINGS['cut-stream']);

		expect(events.sessionIds).toEqual(['sess-cutstream-1']);
		expect(events.data.join('')).toContain('Answer that arrived with no trailing newline.');
		expect(events.agentErrors).toEqual([]);
		expect(events.settlements).toEqual([{ outcome: 'completed', answerCaptured: true }]);
	});

	it('classified-exit-with-answer: a specific exit classification outranks a captured answer', async () => {
		// Precedence, stated so it reads as a decision rather than an oversight:
		// resolveTurnOutcome consults the provider's exit classification BEFORE
		// it looks at capturedAnswerText, so a turn that produced a usable answer
		// and then exited on an auth failure is a crash carrying the specific
		// message, not a completed-with-warning carrying the answer. The sibling
		// bad-exit-with-answer covers the UNMATCHED exit, which reaches the
		// generic fallback instead.
		const events = await runRecording(RECORDINGS['classified-exit-with-answer']);

		expect(events.data.join('')).toContain('produced before the credential expired');
		expect(events.agentErrors).toHaveLength(1);
		expect(events.agentErrors[0]).toMatchObject({
			type: 'auth_expired',
			message: 'OAuth token has expired. Sign in again to continue.',
		});
		expect(events.exits).toEqual([1]);
		expect(events.settlements).toEqual([{ outcome: 'crashed', answerCaptured: true }]);
	});

	it('bad-exit-with-answer: documents a real CLI-vs-desktop divergence - desktop still reports a generic crash despite a captured answer', async () => {
		// Every provider's detectErrorFromExit falls back to a generic
		// agent_crashed for ANY unmatched non-zero exit (verified across all 9
		// providers with the check - none return null once exitCode !== 0).
		// The CLI's `!errorText && (code === 0 || hasAnswer)` override
		// (agent-spawner.ts ~line 1065) has no counterpart in ExitHandler, so
		// desktop chat has never had a "captured answer overrides a bad exit
		// code" path. This is NOT something this migration was approved to
		// change (only the interrupted-precedence fix and keeping the
		// empty-answer rule omp-only were approved) - it's an existing,
		// documented gap for a future CLI/desktop unification pass.
		const events = await runRecording(RECORDINGS['bad-exit-with-answer']);

		expect(events.data.join('')).toContain('The answer, despite what happens next.');
		expect(events.agentErrors).toHaveLength(1);
		expect(events.agentErrors[0]).toMatchObject({
			type: 'agent_crashed',
			message: 'Agent exited with code 1',
		});
		expect(events.exits).toEqual([1]);
		expect(events.settlements).toEqual([{ outcome: 'crashed', answerCaptured: true }]);
	});

	it('silent-resume: the provider silently reports a rotated session id, which the pipeline follows', async () => {
		const events = await runRecording(RECORDINGS['silent-resume']);

		// The NEW id from the stream wins, not the pre-spawn assumption.
		expect(events.sessionIds).toEqual(['sess-new-after-rotation']);
		expect(events.agentErrors).toEqual([]);
		expect(events.data.join('')).toContain('Answer under the rotated session.');
		expect(events.settlements).toEqual([{ outcome: 'completed', answerCaptured: true }]);
	});

	it('stop-vs-crash: identical rate-limit stderr is suppressed when interrupted and surfaced when not', async () => {
		const stopped = await runRecording(RECORDINGS['stop-vs-crash-stopped']);
		const crashed = await runRecording(RECORDINGS['stop-vs-crash-crashed']);

		expect(stopped.agentErrors).toEqual([]);
		expect(stopped.settlements).toEqual([{ outcome: 'interrupted', answerCaptured: true }]);

		expect(crashed.agentErrors).toHaveLength(1);
		expect(crashed.agentErrors[0].type).toBe('rate_limited');
		expect(crashed.settlements).toEqual([{ outcome: 'crashed', answerCaptured: true }]);
	});
});

describe('in-band failures that exit 0', () => {
	beforeEach(() => {
		resetSpawnGenerationsForTest();
	});

	it('in-band-error: a result flagged is_error fails the turn, and its spend is still reported', async () => {
		const events = await runRecording(RECORDINGS['in-band-error']);

		expect(events.sessionIds).toEqual(['sess-inband-1']);
		expect(events.agentErrors).toHaveLength(1);
		expect(events.agentErrors[0].sessionId).toBe('in-band-error');
		// The failure text is the error, not the agent's answer.
		expect(events.data.join('')).not.toContain('API Error');
		expect(events.usages).toHaveLength(1);
		expect(events.usages[0].totalCostUsd).toBe(0.01);
		expect(events.exits).toEqual([0]);
		expect(events.settlements[0]?.outcome).toBe('crashed');
	});

	it('in-band-error-unterminated: the exit-time flush classifies the failed result the same way', async () => {
		const events = await runRecording(RECORDINGS['in-band-error-unterminated']);

		expect(events.sessionIds).toEqual(['sess-inband-2']);
		expect(events.agentErrors).toHaveLength(1);
		expect(events.agentErrors[0]).toMatchObject({
			type: 'unknown',
			message: 'Claude Code stopped after reaching its maximum number of turns.',
		});
		expect(events.exits).toEqual([0]);
		expect(events.settlements[0]?.outcome).toBe('crashed');
	});
});

describe('captured turn recordings (real Claude Code and OpenCode output)', () => {
	beforeEach(() => {
		resetSpawnGenerationsForTest();
	});

	it('Claude Code normal: session id, the answer, one usage event, no error', async () => {
		const events = await runRecording(RECORDINGS['captured-claude-code-normal']);

		expect(events.sessionIds).toEqual([CAPTURED_CLAUDE_CODE_SESSION_ID]);
		expect(events.data.join('')).toBe('The capital of France is Paris.');
		expect(events.usages).toHaveLength(1);
		expect(events.usages[0]).toMatchObject({
			inputTokens: 2,
			outputTokens: 12,
			totalCostUsd: 0.0840728,
		});
		expect(events.agentErrors).toEqual([]);
		expect(events.exits).toEqual([0]);
	});

	it('Claude Code resumed: same session id, and the usage event carries the session running total', async () => {
		const events = await runRecording(RECORDINGS['captured-claude-code-resumed']);

		expect(events.sessionIds).toEqual([CAPTURED_CLAUDE_CODE_SESSION_ID]);
		expect(events.data.join('')).toBe('Paris');
		expect(events.agentErrors).toEqual([]);

		// On a resumed turn Claude Code reports `modelUsage` and `total_cost_usd`
		// for the WHOLE session, while `usage` covers this turn only. Each desktop
		// turn is a new process started with --resume, and its fresh
		// UsageAccumulator returns the first event as-is (see `resumed` above), so
		// this turn's usage event is the normal turn plus this one: 2 + 2 input
		// tokens, 12 + 5 output tokens, $0.0840728 + $0.11075. absoluteUsage,
		// taken from the last API call, is this turn alone.
		expect(events.usages).toHaveLength(1);
		expect(events.usages[0]).toMatchObject({ inputTokens: 4, outputTokens: 17 });
		expect(events.usages[0].totalCostUsd).toBeCloseTo(0.1948228, 7);
		expect(events.usages[0].absoluteUsage).toMatchObject({ inputTokens: 2, outputTokens: 5 });
	});

	it('Claude Code stopped with SIGINT (desktop Stop): an error result and exit 0 read as a quiet stop', async () => {
		const events = await runRecording(RECORDINGS['captured-claude-code-stopped-sigint']);

		expect(events.sessionIds).toEqual(['6c153215-46e7-482f-b644-877267688c15']);
		// Only a tool call streamed before the stop, so there is no answer to show.
		expect(events.data).toEqual([]);
		expect(events.agentErrors).toEqual([]);
		// Claude still writes its result on SIGINT, so the stopped turn's spend is reported.
		expect(events.usages).toHaveLength(1);
		expect(events.exits).toEqual([0]);
	});

	it('Claude Code stopped with SIGTERM: exit 143 with no result is a stop, not a crash', async () => {
		const events = await runRecording(RECORDINGS['captured-claude-code-stopped-sigterm']);

		expect(events.sessionIds).toEqual(['827735bf-54d8-4768-8e3a-c14d4016af29']);
		expect(events.data).toEqual([]);
		expect(events.usages).toEqual([]);
		expect(events.agentErrors).toEqual([]);
		expect(events.exits).toEqual([143]);
	});

	it('Claude Code killed with SIGTERM when nobody pressed Stop: the same bytes are a crash', async () => {
		const events = await runRecording(RECORDINGS['captured-claude-code-killed-sigterm']);

		expect(events.agentErrors).toHaveLength(1);
		expect(events.agentErrors[0]).toMatchObject({
			type: 'agent_crashed',
			message: 'Agent exited with code 143',
		});
		expect(events.exits).toEqual([143]);
	});

	it('OpenCode normal: session id, the answer, one usage event, no error', async () => {
		const events = await runRecording(RECORDINGS['captured-opencode-normal']);

		expect(events.sessionIds).toEqual([CAPTURED_OPENCODE_SESSION_ID]);
		expect(events.data.join('')).toBe('The capital of France is Paris.');
		expect(events.usages).toHaveLength(1);
		expect(events.usages[0]).toMatchObject({
			inputTokens: 7956,
			outputTokens: 8,
			cacheReadInputTokens: 1939,
		});
		expect(events.agentErrors).toEqual([]);
		expect(events.exits).toEqual([0]);
	});

	it('OpenCode resumed: same session id, and the usage event covers this turn only', async () => {
		const events = await runRecording(RECORDINGS['captured-opencode-resumed']);

		expect(events.sessionIds).toEqual([CAPTURED_OPENCODE_SESSION_ID]);
		expect(events.data.join('')).toBe('Paris');
		expect(events.agentErrors).toEqual([]);
		// Unlike Claude Code, OpenCode's step_finish counts this turn alone: the
		// earlier turn arrives as cache reads, not as its own tokens.
		expect(events.usages).toHaveLength(1);
		expect(events.usages[0]).toMatchObject({
			inputTokens: 27,
			outputTokens: 2,
			cacheReadInputTokens: 9901,
		});
	});

	it('OpenCode stopped with SIGINT (desktop Stop): a signal death is a quiet stop', async () => {
		const events = await runRecording(RECORDINGS['captured-opencode-stopped-sigint']);

		expect(events.sessionIds).toEqual(['ses_f1670fa0cffec9SBOfmQDDuvFz']);
		expect(events.data).toEqual([]);
		expect(events.usages).toEqual([]);
		expect(events.agentErrors).toEqual([]);
		// OpenCode died on the signal (code null), which reaches ExitHandler as 0.
		expect(events.exits).toEqual([0]);
	});

	it('OpenCode stopped with SIGTERM: no error, and the partial text flushes as the answer', async () => {
		const events = await runRecording(RECORDINGS['captured-opencode-stopped-sigterm']);

		expect(events.sessionIds).toEqual(['ses_f1670a7e6ffecQgVAvhIMMjTox']);
		expect(events.data.join('')).toBe("I'll run that command.");
		expect(events.agentErrors).toEqual([]);
		expect(events.exits).toEqual([0]);
	});

	it('OpenCode killed with SIGTERM when nobody pressed Stop: the partial text is shown, and the turn is a crash', async () => {
		// OpenCode dies on the signal (code null), which ChildProcessSpawner hands
		// ExitHandler as 0. The signal travels beside it, so the kill is not read
		// as a clean finish: the partial text still flushes, and the turn fails
		// visibly, as the CLI reports the same bytes (turn-recordings.cli.test.ts).
		const events = await runRecording(RECORDINGS['captured-opencode-killed-sigterm']);

		expect(events.data.join('')).toBe("I'll run that command.");
		expect(events.agentErrors).toHaveLength(1);
		expect(events.agentErrors[0]).toMatchObject({
			type: 'agent_crashed',
			message:
				'OpenCode was terminated by SIGTERM before it finished. Please send your message again.',
			recoverable: true,
		});
		expect(events.exits).toEqual([0]);
		expect(events.settlements[0]?.outcome).toBe('crashed');
	});
});
