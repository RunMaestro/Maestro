/**
 * The desktop turn recordings, replayed through the CLI's spawn path.
 *
 * `src/__tests__/main/process-manager/recordings/` feeds the nine Part Two
 * scenarios through desktop chat's StdoutHandler/ExitHandler. This file feeds
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
}));

import { spawnAgent, type AgentResult } from '../../../cli/services/agent-spawner';
import { RECORDINGS, type TurnRecording } from '../../main/process-manager/recordings/fixtures';

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

	if (recording.interrupted) {
		controller.abort();
		mockChild.emit('close', recording.exitCode, 'SIGTERM');
	} else {
		mockChild.emit('close', recording.exitCode, null);
	}
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

	it('declares an expectation for every recording (and none for a recording that no longer exists)', () => {
		expect(Object.keys(EXPECTED).sort()).toEqual(Object.keys(RECORDINGS).sort());
	});
});
