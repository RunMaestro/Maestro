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
 * See fixtures.ts for the recordings themselves and why they're hand-
 * authored rather than loaded from captured transcripts (there is no
 * existing recording infrastructure in this codebase to build on).
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
} from '../../../../main/process-manager/types';
import { RECORDINGS, type TurnRecording } from './fixtures';

interface CapturedEvents {
	sessionIds: string[];
	usages: UsageStats[];
	data: string[];
	agentErrors: AgentError[];
	exits: number[];
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
	};
	emitter.on('session-id', (_sid: string, id: string) => captured.sessionIds.push(id));
	emitter.on('usage', (_sid: string, usage: UsageStats) => captured.usages.push(usage));
	emitter.on('data', (_sid: string, text: string) => captured.data.push(text));
	emitter.on('agent-error', (_sid: string, error: AgentError) => captured.agentErrors.push(error));
	emitter.on('exit', (_sid: string, code: number) => captured.exits.push(code));

	for (const chunk of recording.chunks) {
		stdoutHandler.handleData(sessionId, chunk);
	}

	await exitHandler.handleExit(sessionId, recording.exitCode);

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
	});

	it('interrupted: no agent-error fires, and the partial answer still flushes at exit', async () => {
		const events = await runRecording(RECORDINGS.interrupted);

		expect(events.agentErrors).toEqual([]);
		expect(events.data.join('')).toContain('Working on it when stopped');
		expect(events.exits).toEqual([1]);
	});

	it('chunked: fragmented delivery of every line produces the identical result to an unfragmented stream', async () => {
		const events = await runRecording(RECORDINGS.chunked);

		expect(events.sessionIds).toEqual(['sess-chunked-1']);
		expect(events.data.join('')).toContain('Here is the chunked answer.');
		expect(events.agentErrors).toEqual([]);
	});

	it('interleaved: text and tool_use events interleave without corrupting the final answer', async () => {
		const events = await runRecording(RECORDINGS.interleaved);

		expect(events.sessionIds).toEqual(['sess-interleaved-1']);
		expect(events.data.join('')).toContain('Done - final answer.');
		expect(events.agentErrors).toEqual([]);
	});

	it("cut-stream: a result with no trailing newline is recovered by ExitHandler's exit-time flush", async () => {
		const events = await runRecording(RECORDINGS['cut-stream']);

		expect(events.sessionIds).toEqual(['sess-cutstream-1']);
		expect(events.data.join('')).toContain('Answer that arrived with no trailing newline.');
		expect(events.agentErrors).toEqual([]);
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
	});

	it('silent-resume: the provider silently reports a rotated session id, which the pipeline follows', async () => {
		const events = await runRecording(RECORDINGS['silent-resume']);

		// The NEW id from the stream wins, not the pre-spawn assumption.
		expect(events.sessionIds).toEqual(['sess-new-after-rotation']);
		expect(events.agentErrors).toEqual([]);
		expect(events.data.join('')).toContain('Answer under the rotated session.');
	});

	it('stop-vs-crash: identical rate-limit stderr is suppressed when interrupted and surfaced when not', async () => {
		const stopped = await runRecording(RECORDINGS['stop-vs-crash-stopped']);
		const crashed = await runRecording(RECORDINGS['stop-vs-crash-crashed']);

		expect(stopped.agentErrors).toEqual([]);

		expect(crashed.agentErrors).toHaveLength(1);
		expect(crashed.agentErrors[0].type).toBe('rate_limited');
	});
});
