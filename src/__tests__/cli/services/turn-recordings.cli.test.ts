/**
 * The desktop turn recordings, replayed through the CLI's spawn path.
 *
 * `src/__tests__/main/process-manager/recordings/` feeds the nine Part Two
 * scenarios, plus the captured Claude Code and OpenCode turns, through desktop
 * chat's StdoutHandler/ExitHandler. This file feeds
 * the SAME recordings (same bytes, same chunk boundaries, same exit code and
 * stderr) through `spawnAgent`, so the two surfaces can be compared on
 * identical input rather than by reading two implementations.
 *
 * Every recording must declare its expected CLI result below. Where the CLI
 * and desktop deliberately differ, the entry says so; a new recording with no
 * entry fails the coverage test at the bottom instead of silently going
 * unchecked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

const mockSpawn = vi.fn();
const mockKill = vi.fn();
const mockStdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
const mockStderr = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
const mockChild = Object.assign(new EventEmitter(), {
	stdin: { end: vi.fn(), write: vi.fn() },
	stdout: mockStdout,
	stderr: mockStderr,
	kill: mockKill,
});

vi.mock('child_process', async (importOriginal) => {
	const actual = await importOriginal<typeof import('child_process')>();
	return {
		...actual,
		spawn: (...args: unknown[]) => mockSpawn(...args),
		default: { ...actual, spawn: (...args: unknown[]) => mockSpawn(...args) },
	};
});

vi.mock('fs', async () => {
	const actual = await vi.importActual<typeof import('fs')>('fs');
	const mocked = {
		...actual,
		readFileSync: vi.fn(),
		existsSync: vi.fn(() => false),
		accessSync: vi.fn(() => {
			throw new Error('ENOENT');
		}),
		readdirSync: vi.fn(() => []),
		// A configured custom path resolves through these two calls, which is how
		// the spawner finds the binary WITHOUT spawning a `which`/`where` lookup
		// process (a lookup would consume the fake child before the agent does).
		promises: {
			...actual.promises,
			stat: vi.fn(async () => ({ isFile: () => true })),
			access: vi.fn(async () => undefined),
			readdir: vi.fn(async () => []),
		},
		constants: { X_OK: 1 },
	};
	return { ...mocked, default: mocked };
});

vi.mock('../../../cli/services/storage', () => ({
	// Resolves the agent binary from settings so detection never spawns a lookup.
	getAgentCustomPath: vi.fn(() => '/custom/path/to/claude'),
	readAgentConfig: vi.fn(() => ({})),
	readSshRemotes: vi.fn(() => []),
	readGlobalShellEnvVars: vi.fn(() => ({})),
}));

import { spawnAgent, type AgentResult } from '../../../cli/services/agent-spawner';
import { RECORDINGS, type TurnRecording } from '../../main/process-manager/recordings/fixtures';
import {
	CAPTURED_CLAUDE_CODE_SESSION_ID,
	CAPTURED_OPENCODE_SESSION_ID,
} from '../../main/process-manager/recordings/captured';

/** What the CLI reports for a recording. `note` records a CLI-vs-desktop difference. */
interface CliExpectation {
	success: boolean;
	outcome: NonNullable<AgentResult['outcome']>;
	response?: string;
	agentSessionId?: string;
	errorIncludes?: string;
	note?: string;
}

const EXPECTED: Record<string, CliExpectation> = {
	normal: {
		success: true,
		outcome: 'completed',
		response: 'Here is the answer.',
		agentSessionId: 'sess-normal-1',
	},
	resumed: {
		success: true,
		outcome: 'completed',
		response: 'Continuing where we left off.',
		agentSessionId: 'sess-continuing-conversation',
	},
	interrupted: {
		success: false,
		outcome: 'interrupted',
		agentSessionId: 'sess-interrupted-1',
		note: 'Desktop flushes the partial text as the answer; the CLI returns no response for a stopped turn.',
	},
	chunked: {
		success: true,
		outcome: 'completed',
		response: 'Here is the chunked answer.',
		agentSessionId: 'sess-chunked-1',
	},
	interleaved: {
		success: true,
		outcome: 'completed',
		response: 'Done - final answer.',
		agentSessionId: 'sess-interleaved-1',
	},
	'cut-stream': {
		success: true,
		outcome: 'completed',
		response: 'Answer that arrived with no trailing newline.',
		agentSessionId: 'sess-cutstream-1',
	},
	'bad-exit-with-answer': {
		success: false,
		outcome: 'crashed',
		agentSessionId: 'sess-badexit-1',
		note: 'Matches desktop (generic agent_crashed) and the old Claude CLI rule (code === 0 && finalResult). Only the generic JSON-line path keeps an answer over a bare bad exit.',
	},
	'classified-exit-with-answer': {
		success: false,
		outcome: 'crashed',
		agentSessionId: 'sess-classified-1',
		errorIncludes: 'oauth token has expired',
		note: 'Matches desktop: a SPECIFIC exit classification outranks a captured answer, so the auth failure is reported rather than the answer. Its sibling bad-exit-with-answer covers the unmatched exit, which reaches the generic fallback instead.',
	},

	'silent-resume': {
		success: true,
		outcome: 'completed',
		response: 'Answer under the rotated session.',
		agentSessionId: 'sess-new-after-rotation',
		note: "The provider's reported id wins over the id the turn was resumed from.",
	},
	'stop-vs-crash-stopped': {
		success: false,
		outcome: 'interrupted',
		agentSessionId: 'sess-stopvscrash-a',
		note: 'Identical stderr to the crashed twin; the interrupt is what makes it a stop.',
	},
	'stop-vs-crash-crashed': {
		success: false,
		outcome: 'crashed',
		agentSessionId: 'sess-stopvscrash-b',
		errorIncludes: 'rate limit',
		note: 'A SPECIFIC classification fails the turn even though partial assistant text was captured.',
	},
	'in-band-error': {
		success: false,
		outcome: 'crashed',
		agentSessionId: 'sess-inband-1',
		note: 'Matches desktop: a result flagged is_error fails the turn despite exit 0.',
	},
	'in-band-error-unterminated': {
		success: false,
		outcome: 'crashed',
		agentSessionId: 'sess-inband-2',
		errorIncludes: 'maximum number of turns',
		note: 'Matches desktop: the failed result arrives with no trailing newline and still fails the turn.',
	},

	'captured-claude-code-normal': {
		success: true,
		outcome: 'completed',
		response: 'The capital of France is Paris.',
		agentSessionId: CAPTURED_CLAUDE_CODE_SESSION_ID,
	},
	'captured-claude-code-resumed': {
		success: true,
		outcome: 'completed',
		response: 'Paris',
		agentSessionId: CAPTURED_CLAUDE_CODE_SESSION_ID,
	},
	'captured-claude-code-stopped-sigint': {
		success: false,
		outcome: 'interrupted',
		agentSessionId: '6c153215-46e7-482f-b644-877267688c15',
		note: 'Claude answers SIGINT with an error result and exit 0; the stop still reads as interrupted.',
	},
	'captured-claude-code-stopped-sigterm': {
		success: false,
		outcome: 'interrupted',
		agentSessionId: '827735bf-54d8-4768-8e3a-c14d4016af29',
	},
	'captured-claude-code-killed-sigterm': {
		success: false,
		outcome: 'crashed',
		agentSessionId: '827735bf-54d8-4768-8e3a-c14d4016af29',
		errorIncludes: 'code 143',
		note: 'The same bytes with nobody pressing Stop are a crash, as on desktop.',
	},
	'captured-opencode-normal': {
		success: true,
		outcome: 'completed',
		response: 'The capital of France is Paris.',
		agentSessionId: CAPTURED_OPENCODE_SESSION_ID,
	},
	'captured-opencode-resumed': {
		success: true,
		outcome: 'completed',
		response: 'Paris',
		agentSessionId: CAPTURED_OPENCODE_SESSION_ID,
	},
	'captured-opencode-stopped-sigint': {
		success: false,
		outcome: 'interrupted',
		agentSessionId: 'ses_f1670fa0cffec9SBOfmQDDuvFz',
	},
	'captured-opencode-stopped-sigterm': {
		success: false,
		outcome: 'interrupted',
		agentSessionId: 'ses_f1670a7e6ffecQgVAvhIMMjTox',
		note: 'Desktop flushes the partial text as the answer; the CLI returns no response for a stopped turn.',
	},
	'captured-opencode-killed-sigterm': {
		success: false,
		outcome: 'crashed',
		agentSessionId: 'ses_f1670a7e6ffecQgVAvhIMMjTox',
		errorIncludes: 'signal sigterm',
		note: 'Matches desktop: an unrequested signal kill is a crash even with partial text captured.',
	},
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function replayThroughCli(recording: TurnRecording): Promise<AgentResult> {
	const controller = new AbortController();
	const resultPromise = spawnAgent(
		recording.toolType,
		'/project',
		'prompt',
		recording.agentSessionIdBeforeStart,
		{ signal: controller.signal }
	);
	await tick();

	for (const chunk of recording.chunks) mockStdout.emit('data', Buffer.from(chunk));
	if (recording.stderrBuffer) mockStderr.emit('data', Buffer.from(recording.stderrBuffer));

	// A captured recording carries the real close signal (null when the provider
	// exited on its own after the stop); a synthetic one is stopped with the
	// SIGTERM the CLI sends.
	const closeSignal =
		recording.exitSignal !== undefined
			? recording.exitSignal
			: recording.interrupted
				? 'SIGTERM'
				: null;
	if (recording.interrupted) controller.abort();
	mockChild.emit('close', recording.exitCode, closeSignal);
	return resultPromise;
}

describe('turn recordings replayed through the CLI spawner', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockStdout.removeAllListeners();
		mockStderr.removeAllListeners();
		(mockChild as EventEmitter).removeAllListeners();
		mockSpawn.mockReturnValue(mockChild);
	});

	for (const [key, recording] of Object.entries(RECORDINGS)) {
		const expected = EXPECTED[key];

		it(`${key}: ${expected?.note ?? 'matches desktop'}`, async () => {
			expect(expected, `no CLI expectation declared for recording "${key}"`).toBeDefined();

			const result = await replayThroughCli(recording);

			expect(result.success).toBe(expected.success);
			expect(result.outcome).toBe(expected.outcome);
			if (expected.response !== undefined) expect(result.response).toBe(expected.response);
			if (expected.agentSessionId) expect(result.agentSessionId).toBe(expected.agentSessionId);
			if (expected.errorIncludes) {
				expect(result.error?.toLowerCase()).toContain(expected.errorIncludes);
			}
		});
	}

	it('resumes with the provider-native flag when the recording was spawned with an existing session', async () => {
		await replayThroughCli(RECORDINGS.resumed);

		const args = mockSpawn.mock.calls[0][1] as string[];
		const at = args.indexOf('--resume');
		expect(at).toBeGreaterThanOrEqual(0);
		expect(args[at + 1]).toBe('sess-continuing-conversation');
	});

	it('resumes OpenCode with --session when the recording was spawned with an existing session', async () => {
		await replayThroughCli(RECORDINGS['captured-opencode-resumed']);

		const args = mockSpawn.mock.calls[0][1] as string[];
		const at = args.indexOf('--session');
		expect(at).toBeGreaterThanOrEqual(0);
		expect(args[at + 1]).toBe(CAPTURED_OPENCODE_SESSION_ID);
	});

	it('declares an expectation for every recording (and none for a recording that no longer exists)', () => {
		expect(Object.keys(EXPECTED).sort()).toEqual(Object.keys(RECORDINGS).sort());
	});
});
