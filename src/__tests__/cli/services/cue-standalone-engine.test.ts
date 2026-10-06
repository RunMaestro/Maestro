/**
 * Standalone Cue engine wiring (`src/cli/services/cue-standalone-engine.ts`).
 *
 * The desktop registers every provider's output parser at boot; the standalone
 * runner has to do it itself, or every prompt run is recorded as raw
 * stream-json with no provider session id and no usage.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CueEvent, CueRunResult } from '../../../shared/cue/contracts';

const initializeOutputParsers = vi.fn();
const executeCuePrompt = vi.fn();

vi.mock('../../../shared/maestro-lib/parsers', () => ({ initializeOutputParsers }));
vi.mock('../../../main/cue/cue-executor', () => ({ executeCuePrompt, stopCueRun: vi.fn() }));
vi.mock('../../../main/cue/cue-shell-executor', () => ({
	executeCueShell: vi.fn(),
	stopCueShellRun: vi.fn(),
}));
vi.mock('../../../main/cue/cue-cli-executor', () => ({
	executeCueCli: vi.fn(),
	stopCueCliRun: vi.fn(),
}));
vi.mock('../../../main/cue/cue-notify-executor', () => ({ executeCueNotify: vi.fn() }));
vi.mock('../../../main/cue/cue-auth-detector', () => ({ detectCueAuthFailure: vi.fn(() => null) }));
vi.mock('../../../cli/services/storage', () => ({
	readSessions: () => [
		{ id: 'agent-1', name: 'alpha', toolType: 'claude-code', cwd: '/p', projectRoot: '/p' },
	],
	readSshRemotes: () => [],
	getAgentCustomPath: () => undefined,
	readAgentConfig: () => ({}),
	readSettings: () => ({}),
}));

import {
	buildStandaloneCueEngineDeps,
	consoleCueLog,
	cueLogForFormat,
	jsonCueLog,
	stderrCueLog,
} from '../../../cli/services/cue-standalone-engine';

const event: CueEvent = {
	id: 'evt-1',
	type: 'webhook.received',
	timestamp: new Date().toISOString(),
	triggerName: 'ask',
	payload: {},
};

describe('buildStandaloneCueEngineDeps', () => {
	beforeEach(() => {
		executeCuePrompt.mockResolvedValue({ status: 'completed' } as CueRunResult);
	});

	it('registers the output parsers before the first prompt run executes', async () => {
		executeCuePrompt.mockImplementation(async () => {
			expect(initializeOutputParsers).toHaveBeenCalledTimes(1);
			return { status: 'completed' } as CueRunResult;
		});
		const deps = buildStandaloneCueEngineDeps({ onLog: vi.fn() });

		await deps.onCueRun({
			runId: 'run-1',
			sessionId: 'agent-1',
			prompt: 'Say pong',
			subscriptionName: 'ask',
			event,
			timeoutMs: 1000,
		} as Parameters<typeof deps.onCueRun>[0]);

		expect(executeCuePrompt).toHaveBeenCalledTimes(1);
		expect(initializeOutputParsers).toHaveBeenCalledTimes(1);
	});
});

describe('engine log sinks (--log-format)', () => {
	it('picks text by default, JSON on request, and the stderr-only text form under --json', () => {
		expect(cueLogForFormat(undefined)).toBe(consoleCueLog);
		expect(cueLogForFormat('text')).toBe(consoleCueLog);
		expect(cueLogForFormat('text', { stderrOnly: true })).toBe(stderrCueLog);
		expect(cueLogForFormat('json')).toBe(jsonCueLog);
		expect(cueLogForFormat('json', { stderrOnly: true })).toBe(jsonCueLog);
	});

	it('jsonCueLog writes one JSON line to stderr with the run ids and never stdout', () => {
		const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
		const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
		jsonCueLog('cue', '[CUE] Run started: nightly', {
			type: 'runStarted',
			runId: 'run-9',
			sessionId: 'agent-1',
			subscriptionName: 'nightly',
			pipelineId: 'Build',
		});
		expect(stdout).not.toHaveBeenCalled();
		const written = String(stderr.mock.calls[0][0]);
		expect(written.endsWith('\n')).toBe(true);
		expect(JSON.parse(written)).toMatchObject({
			level: 'info',
			message: '[CUE] Run started: nightly',
			context: 'Cue',
			event: 'runStarted',
			runId: 'run-9',
			sessionId: 'agent-1',
			subscriptionName: 'nightly',
			pipelineId: 'Build',
		});
		expect(typeof JSON.parse(written).timestamp).toBe('string');
		stderr.mockRestore();
		stdout.mockRestore();
	});

	it('stderrCueLog keeps the text shape but never writes to stdout', () => {
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		stderrCueLog('info', 'Engine started');
		expect(log).not.toHaveBeenCalled();
		expect(error).toHaveBeenCalledWith('[Cue] Engine started');
		log.mockRestore();
		error.mockRestore();
	});
});
