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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
import { clearRememberedClaudeSessionCosts } from '../../../../shared/claudeCostTracker';
import type {
	ManagedProcess,
	AgentError,
	UsageStats,
	TurnSettlement,
} from '../../../../main/process-manager/types';
import { RECORDINGS, type TurnRecording } from './fixtures';
import { DOCUMENTED_ANSWER, DOCUMENTED_RECORDINGS, DOCUMENTED_SESSION_IDS } from './documented';
import { PICKABLE_AGENT_IDS } from '../../../../shared/agentMetadata';
import { CAPTURED_CLAUDE_CODE_SESSION_ID, CAPTURED_OPENCODE_SESSION_ID } from './captured';
import {
	GROK_SYNTHETIC_ROUNDS,
	GROK_SYNTHETIC_SESSION_ID,
	grokSyntheticStream,
	rechunk,
	type GrokSyntheticStream,
} from '../../../helpers/grokSyntheticStream';

interface CapturedEvents {
	sessionIds: string[];
	usages: UsageStats[];
	data: string[];
	agentErrors: AgentError[];
	exits: number[];
	settlements: Array<TurnSettlement | undefined>;
	thinking: string[];
	tools: Array<{ toolName: string; state?: { status?: string }; toolCallId?: string }>;
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

async function runRecording(
	recording: TurnRecording,
	inspect?: (state: {
		emitter: EventEmitter;
		processes: Map<string, ManagedProcess>;
		managedProcess: ManagedProcess;
	}) => void
): Promise<CapturedEvents> {
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
		thinking: [],
		tools: [],
	};
	emitter.on('session-id', (_sid: string, id: string) => captured.sessionIds.push(id));
	emitter.on('usage', (_sid: string, usage: UsageStats) => captured.usages.push(usage));
	emitter.on('data', (_sid: string, text: string) => captured.data.push(text));
	emitter.on('thinking-chunk', (_sid: string, text: string) => captured.thinking.push(text));
	emitter.on('tool-execution', (_sid: string, tool: CapturedEvents['tools'][number]) =>
		captured.tools.push(tool)
	);
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

	inspect?.({ emitter, processes, managedProcess });
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
		expect(events.settlements).toEqual([
			{ outcome: 'completed', answerCaptured: true, answerTail: 'Here is the answer.' },
		]);
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
		expect(events.settlements).toEqual([
			{ outcome: 'completed', answerCaptured: true, answerTail: 'Continuing where we left off.' },
		]);
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
		expect(events.settlements).toEqual([
			{ outcome: 'completed', answerCaptured: true, answerTail: 'Here is the chunked answer.' },
		]);
	});

	it('interleaved: text and tool_use events interleave without corrupting the final answer', async () => {
		const events = await runRecording(RECORDINGS.interleaved);

		expect(events.sessionIds).toEqual(['sess-interleaved-1']);
		expect(events.data.join('')).toContain('Done - final answer.');
		expect(events.agentErrors).toEqual([]);
		expect(events.settlements).toEqual([
			{ outcome: 'completed', answerCaptured: true, answerTail: 'Done - final answer.' },
		]);
	});

	it("cut-stream: a result with no trailing newline is recovered by ExitHandler's exit-time flush", async () => {
		const events = await runRecording(RECORDINGS['cut-stream']);

		expect(events.sessionIds).toEqual(['sess-cutstream-1']);
		expect(events.data.join('')).toContain('Answer that arrived with no trailing newline.');
		expect(events.agentErrors).toEqual([]);
		expect(events.settlements).toEqual([
			{
				outcome: 'completed',
				answerCaptured: true,
				answerTail: 'Answer that arrived with no trailing newline.',
			},
		]);
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
		expect(events.settlements).toEqual([
			{
				outcome: 'completed',
				answerCaptured: true,
				answerTail: 'Answer under the rotated session.',
			},
		]);
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
		// The Claude parser remembers each session's reported running total, so
		// one test's turn would otherwise become the next test's baseline.
		clearRememberedClaudeSessionCosts();
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

	it('Claude Code resumed: same session id, and the usage event is this turn alone', async () => {
		// The resumed turn follows the normal one in the same session. Its result
		// reports `modelUsage` and `total_cost_usd` for the WHOLE session (normal
		// turn plus this one), and the parser reduces them by the total that
		// session reported last (see src/shared/claudeCostTracker.ts).
		await runRecording(RECORDINGS['captured-claude-code-normal']);
		const events = await runRecording(RECORDINGS['captured-claude-code-resumed']);

		expect(events.sessionIds).toEqual([CAPTURED_CLAUDE_CODE_SESSION_ID]);
		expect(events.data.join('')).toBe('Paris');
		expect(events.agentErrors).toEqual([]);

		expect(events.usages).toHaveLength(1);
		expect(events.usages[0]).toMatchObject({ inputTokens: 2, outputTokens: 5 });
		expect(events.usages[0].totalCostUsd).toBeCloseTo(0.11075, 7);
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

describe('documented-format turns (providers with no captured turn yet)', () => {
	beforeEach(() => {
		resetSpawnGenerationsForTest();
	});

	// One normal turn per provider, written from its documented wire format
	// (see documented.ts). Each travels the desktop pipeline to the same four
	// facts: the session id, the answer shown once, no error, a completed turn.
	it.each(Object.values(DOCUMENTED_RECORDINGS).map((recording) => [recording.toolType, recording]))(
		'%s normal: session id, the answer once, no error, completed',
		async (_provider, recording) => {
			const events = await runRecording(recording);

			expect(events.sessionIds).toEqual([DOCUMENTED_SESSION_IDS[recording.name]]);
			expect(events.data.join('')).toBe(DOCUMENTED_ANSWER);
			expect(events.agentErrors).toEqual([]);
			expect(events.exits).toEqual([0]);
			expect(events.settlements[0]).toEqual({
				outcome: 'completed',
				answerCaptured: true,
				answerTail: DOCUMENTED_ANSWER,
			});
		}
	);

	it('reports usage for every provider that writes it, and none for Grok, which does not', async () => {
		for (const recording of Object.values(DOCUMENTED_RECORDINGS)) {
			const events = await runRecording(recording);

			if (recording.toolType === 'grok') {
				expect(events.usages).toEqual([]);
			} else {
				expect(events.usages).toHaveLength(1);
				expect(events.usages[0].outputTokens).toBe(8);
			}
			resetSpawnGenerationsForTest();
		}
	});

	it('covers every provider the pickers offer that has an output parser', () => {
		// Claude Code and OpenCode have captured turns. Hermes has no parser.
		const documented = Object.values(DOCUMENTED_RECORDINGS).map((recording) => recording.toolType);
		const expected = PICKABLE_AGENT_IDS.filter(
			(agentId) => agentId !== 'claude-code' && agentId !== 'opencode' && agentId !== 'hermes'
		);

		expect([...documented].sort()).toEqual([...expected].sort());
	});
});

function grokRecording(
	name: string,
	chunks: string[],
	extra: Partial<TurnRecording> = {}
): TurnRecording {
	return {
		name,
		description: 'Synthetic bounded Grok streaming-json turn (not captured).',
		toolType: 'grok',
		chunks,
		exitCode: 0,
		...extra,
	};
}

type RetainedState = ReturnType<typeof retainedStateOf>;

function retainedStateOf(state: {
	emitter: EventEmitter;
	processes: Map<string, ManagedProcess>;
	managedProcess: ManagedProcess;
}) {
	const parser = state.managedProcess.outputParser as unknown as {
		toolNamesById: Map<string, string>;
	};
	return {
		listenerCounts: Object.fromEntries(
			state.emitter.eventNames().map((event) => [String(event), state.emitter.listenerCount(event)])
		),
		processesLeft: state.processes.size,
		jsonBuffer: state.managedProcess.jsonBuffer ?? '',
		openToolNames: parser.toolNamesById.size,
		streamedTextLength: state.managedProcess.streamedText?.length ?? 0,
	};
}

describe('bounded synthetic Grok stream (many updates, cancellation, usage, identity)', () => {
	beforeEach(() => {
		resetSpawnGenerationsForTest();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('emits each delta once, so emitted bytes grow with the stream rather than its square', async () => {
		const stream = grokSyntheticStream(GROK_SYNTHETIC_ROUNDS);
		let retained: RetainedState | undefined;
		const events = await runRecording(grokRecording('grok-synthetic-normal', stream.lines), (s) => {
			retained = retainedStateOf(s);
		});

		// Stable final text: the answer is shown once, whole, in delta order.
		expect(events.data.join('')).toBe(stream.answer);
		expect(events.data).toHaveLength(1);
		// One thinking chunk per thought delta, never the accumulated reasoning
		// re-sent on every delta (which would emit about rounds^2 / 2 bytes).
		expect(events.thinking).toHaveLength(stream.rounds);
		expect(events.thinking.join('').length).toBe(stream.thoughtBytes);
		// Two badge events per call (running, then completed), keyed by id.
		expect(events.tools).toHaveLength(2 * stream.rounds);
		expect(new Set(events.tools.map((tool) => tool.toolCallId)).size).toBe(stream.rounds);
		expect(events.tools.filter((tool) => tool.state?.status === 'completed')).toHaveLength(
			stream.rounds
		);
		expect(events.tools.every((tool) => tool.toolName === 'read_file')).toBe(true);

		// Native session identity arrives once, from the end event.
		expect(events.sessionIds).toEqual([GROK_SYNTHETIC_SESSION_ID]);
		// Final usage is the end event's turn total, reported once.
		expect(events.usages).toHaveLength(1);
		expect(events.usages[0]).toMatchObject({
			inputTokens: 100 * stream.rounds,
			outputTokens: 20 * stream.rounds,
			cacheReadInputTokens: 50 * stream.rounds,
		});
		expect(events.usages[0].totalCostUsd).toBeCloseTo(0.25, 10);
		expect(events.agentErrors).toEqual([]);
		expect(events.exits).toEqual([0]);
		expect(events.settlements).toEqual([
			{ outcome: 'completed', answerCaptured: true, answerTail: stream.answer.slice(-4000) },
		]);

		// Bounded retention: one listener per subscribed event (the handlers add
		// none per delta), no buffered remainder, no unsettled tool names, the
		// process released, and the retained answer exactly the answer.
		expect(retained).toBeDefined();
		expect(Object.values(retained!.listenerCounts).every((count) => count === 1)).toBe(true);
		expect(retained!.jsonBuffer).toBe('');
		expect(retained!.openToolNames).toBe(0);
		expect(retained!.processesLeft).toBe(0);
		expect(retained!.streamedTextLength).toBe(stream.answer.length);
	});

	it('doubling the rounds doubles every emitted count and byte total (linear aggregation)', async () => {
		const small = grokSyntheticStream(GROK_SYNTHETIC_ROUNDS / 2);
		const large = grokSyntheticStream(GROK_SYNTHETIC_ROUNDS);
		const smallEvents = await runRecording(grokRecording('grok-synthetic-small', small.lines));
		resetSpawnGenerationsForTest();
		const largeEvents = await runRecording(grokRecording('grok-synthetic-large', large.lines));

		const emitted = (events: CapturedEvents) =>
			events.data.join('').length + events.thinking.join('').length;
		const inputBytes = (stream: GrokSyntheticStream) => stream.answer.length + stream.thoughtBytes;
		expect(emitted(smallEvents)).toBe(inputBytes(small));
		expect(emitted(largeEvents)).toBe(inputBytes(large));
		expect(largeEvents.thinking.length).toBe(2 * smallEvents.thinking.length);
		expect(largeEvents.tools.length).toBe(2 * smallEvents.tools.length);
	});

	it('fragmented delivery across line boundaries produces the identical turn', async () => {
		const stream = grokSyntheticStream(GROK_SYNTHETIC_ROUNDS);
		const whole = await runRecording(grokRecording('grok-synthetic-lines', stream.lines));
		resetSpawnGenerationsForTest();
		const cut = await runRecording(grokRecording('grok-synthetic-cut', rechunk(stream.lines, 97)));

		expect(cut.data.join('')).toBe(whole.data.join(''));
		expect(cut.thinking.join('')).toBe(whole.thinking.join(''));
		expect(cut.tools).toHaveLength(whole.tools.length);
		expect(cut.sessionIds).toEqual(whole.sessionIds);
		expect(cut.usages).toEqual(whole.usages);
		expect(cut.settlements).toEqual(whole.settlements);
	});

	it('Stop mid-stream settles as a quiet interrupt on the next microtask, with the partial answer', async () => {
		const stream = grokSyntheticStream(GROK_SYNTHETIC_ROUNDS / 2, { end: null });
		vi.useFakeTimers();
		let retained: RetainedState | undefined;
		let settled = false;
		const pending = runRecording(
			grokRecording('grok-synthetic-stopped', stream.lines, {
				exitCode: null,
				exitSignal: 'SIGINT',
				interrupted: true,
			}),
			(s) => {
				retained = retainedStateOf(s);
			}
		).then((events) => {
			settled = true;
			return events;
		});
		// Responsive: no timer has to fire for the stop to settle.
		await vi.advanceTimersByTimeAsync(0);
		expect(settled).toBe(true);
		const events = await pending;

		expect(events.agentErrors).toEqual([]);
		expect(events.data.join('')).toBe(stream.answer);
		expect(events.usages).toEqual([]);
		// No end event, so no native id was ever reported.
		expect(events.sessionIds).toEqual([]);
		expect(events.settlements).toEqual([{ outcome: 'interrupted', answerCaptured: true }]);
		expect(retained!.processesLeft).toBe(0);
		expect(retained!.jsonBuffer).toBe('');
	});

	it('a cancelled end under Stop is still quiet, and keeps the native session identity', async () => {
		const stream = grokSyntheticStream(GROK_SYNTHETIC_ROUNDS / 2, { end: 'cancelled' });
		const events = await runRecording(
			grokRecording('grok-synthetic-cancelled', stream.lines, { interrupted: true })
		);

		expect(events.agentErrors).toEqual([]);
		expect(events.data.join('')).toBe(stream.answer);
		expect(events.sessionIds).toEqual([GROK_SYNTHETIC_SESSION_ID]);
		expect(events.settlements).toEqual([{ outcome: 'interrupted', answerCaptured: true }]);
	});
});

// Pass two: sanitized Grok records through the desktop consumer (the real
// StdoutHandler, ExitHandler and Grok parser), asserting what the desktop shows and keeps:
// emitted session ids, answer, errors, the one exit and its settlement, and the released
// process. Synthetic records, not native qualification.
describe('Grok pass-two desktop records', () => {
	const line = (record: Record<string, unknown>) => JSON.stringify(record) + '\n';
	const text = (data: string) => line({ type: 'text', data });
	const end = (sessionId: string) => line({ type: 'end', stopReason: 'EndTurn', sessionId });

	async function replay(name: string, chunks: string[], extra: Partial<TurnRecording> = {}) {
		let retained: RetainedState | undefined;
		const events = await runRecording(grokRecording(name, chunks, extra), (s) => {
			retained = retainedStateOf(s);
		});
		// Every case: exactly one exit and one settlement, the process released, nothing buffered.
		expect(events.exits).toHaveLength(1);
		expect(events.settlements).toHaveLength(1);
		expect(retained!.processesLeft).toBe(0);
		expect(retained!.jsonBuffer).toBe('');
		return events;
	}

	beforeEach(() => {
		resetSpawnGenerationsForTest();
	});

	it('shows only the answer of a short turn, with thought and tool output on their own channels', async () => {
		const events = await replay('grok-pass2-short', [
			line({ type: 'thought', data: 'private plan' }),
			line({
				type: 'tool_call',
				toolCallId: 'call-1',
				toolName: 'read_file',
				kind: 'read',
				rawInput: { path: 'fixture/a.txt' },
			}),
			line({
				type: 'tool_call_update',
				toolCallId: 'call-1',
				status: 'completed',
				content: [{ type: 'content', content: { type: 'text', text: 'file body' } }],
			}),
			text('the answer'),
			end('grok-pass2-short'),
		]);
		expect(events.data.join('')).toBe('the answer');
		expect(events.thinking).toEqual(['private plan']);
		expect(events.tools.map((tool) => tool.state?.status)).toEqual(['running', 'completed']);
		expect(events.sessionIds).toEqual(['grok-pass2-short']);
		expect(events.settlements).toEqual([
			{ outcome: 'completed', answerCaptured: true, answerTail: 'the answer' },
		]);
	});

	it.each([
		[
			'a startup login failure on stderr (exit 1)',
			[] as string[],
			{ stderrBuffer: 'Error: please run `grok login` first\n', exitCode: 1 },
		],
		[
			'an in-band auth error on exit 0',
			[line({ type: 'error', message: 'Not authenticated. Run grok login to sign in.' })],
			{},
		],
	])('raises %s once as auth_expired, with no answer or session', async (_label, chunks, extra) => {
		const events = await replay('grok-pass2-auth', chunks, extra);
		expect(events.agentErrors.map((error) => error.type)).toEqual(['auth_expired']);
		expect(events.data).toEqual([]);
		expect(events.sessionIds).toEqual([]);
		expect(events.settlements).toEqual([{ outcome: 'crashed', answerCaptured: false }]);
	});

	it('reads a forced process loss nobody asked for as a crash that keeps the partial text', async () => {
		const events = await replay('grok-pass2-lost', [text('I started the')], {
			exitCode: null,
			exitSignal: 'SIGKILL',
		});
		expect(events.agentErrors).toHaveLength(1);
		expect(events.agentErrors[0].message).toMatch(/without a successful terminal record/);
		expect(events.data.join('')).toBe('I started the');
		expect(events.sessionIds).toEqual([]);
		expect(events.settlements).toEqual([{ outcome: 'crashed', answerCaptured: true }]);
	});

	it('fails a record cut at exit (partial JSONL) instead of completing', async () => {
		const events = await replay('grok-pass2-partial', [text('partial '), '{"type":"text","da']);
		expect(events.agentErrors).toHaveLength(1);
		expect(events.agentErrors[0].message).toMatch(/malformed/);
		expect(events.sessionIds).toEqual([]);
		expect(events.settlements[0]?.outcome).toBe('crashed');
	});

	it('keeps a malformed line between valid records out of the answer', async () => {
		const events = await replay('grok-pass2-malformed', [
			text('a '),
			'{not json}\n',
			text('b'),
			end('grok-pass2-malformed'),
		]);
		expect(events.data.join('')).toBe('a b');
		expect(events.sessionIds).toEqual(['grok-pass2-malformed']);
		// Current state, recorded as a known divergence: the desktop skips the line
		// and completes, while the runtime and the CLI fail the same bytes as malformed.
		expect(events.agentErrors).toEqual([]);
		expect(events.settlements).toEqual([
			{ outcome: 'completed', answerCaptured: true, answerTail: 'a b' },
		]);
	});

	it('shows an oversized record whole and once', async () => {
		const oversized = 'x'.repeat(2 * 1024 * 1024);
		const events = await replay('grok-pass2-oversized', [
			text(oversized),
			text('tail'),
			end('grok-pass2-oversized'),
		]);
		expect(events.data.join('')).toBe(oversized + 'tail');
		expect(events.sessionIds).toEqual(['grok-pass2-oversized']);
		expect(events.settlements).toEqual([
			{ outcome: 'completed', answerCaptured: true, answerTail: (oversized + 'tail').slice(-4000) },
		]);
	});

	it('settles exactly once on a duplicated end record', async () => {
		const events = await replay('grok-pass2-dup', [text('once'), end('grok-dup'), end('grok-dup')]);
		expect(events.data).toEqual(['once']);
		expect(events.sessionIds).toEqual(['grok-dup']);
		expect(events.agentErrors).toEqual([]);
		expect(events.settlements).toEqual([
			{ outcome: 'completed', answerCaptured: true, answerTail: 'once' },
		]);
	});

	it('emits a late native session id once, from an end record split across chunks', async () => {
		const events = await replay('grok-pass2-late', [
			text('a'),
			text('b'),
			'{"type":"end","stopReason":"EndTurn","sess',
			'ionId":"grok-late"}\n',
		]);
		expect(events.sessionIds).toEqual(['grok-late']);
		expect(events.data.join('')).toBe('ab');
		expect(events.settlements).toEqual([
			{ outcome: 'completed', answerCaptured: true, answerTail: 'ab' },
		]);
	});

	it.each([
		['the same id', 'grok-kept', 'grok-kept'],
		['a rotated id', 'grok-old', 'grok-new'],
	])('follows a resumed turn that reports %s', async (_label, before, reported) => {
		const events = await replay('grok-pass2-resumed', [text('again'), end(reported)], {
			agentSessionIdBeforeStart: before,
		});
		expect(events.sessionIds).toEqual([reported]);
		expect(events.settlements).toEqual([
			{ outcome: 'completed', answerCaptured: true, answerTail: 'again' },
		]);
	});
});
