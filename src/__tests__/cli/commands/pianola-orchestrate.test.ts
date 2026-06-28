/**
 * @file pianola-orchestrate.test.ts
 * @description Tests for the Pianola orchestrate CLI loop. The key invariant: a
 * transient iteration error (e.g. a WS sendCommand timeout that rejects out of
 * runOrchestratorIteration) is logged and the run KEEPS GOING - it must not tear
 * down the whole orchestration. Mirrors the watcher's per-iteration try/catch.
 * The orchestration engine and the WebSocket client are mocked.
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';
import type { OrchestratorState } from '../../../shared/pianola/pianola-orchestrator';
import type { PianolaPlan, PianolaPlanProgress } from '../../../shared/pianola/pianola-tasks';

const { connectMock, sendCommandMock, disconnectMock, runIterationMock } = vi.hoisted(() => ({
	connectMock: vi.fn(),
	sendCommandMock: vi.fn(),
	disconnectMock: vi.fn(),
	runIterationMock: vi.fn(),
}));

vi.mock('../../../cli/services/storage', () => ({ readSettingValue: vi.fn() }));
vi.mock('../../../cli/services/pianola-store', () => ({
	readPianolaPlans: vi.fn(() => []),
	getPianolaPlan: vi.fn(),
	upsertPianolaPlan: vi.fn(),
}));
vi.mock('../../../cli/services/maestro-client', () => ({
	MaestroClient: class {
		connect = connectMock;
		sendCommand = sendCommandMock;
		disconnect = disconnectMock;
	},
}));
vi.mock('../../../cli/commands/dispatch', () => ({ runDispatch: vi.fn() }));
vi.mock('../../../shared/pianola/pianola-orchestrator', () => ({
	runOrchestratorIteration: runIterationMock,
	initialOrchestratorState: (plan: PianolaPlan): OrchestratorState => ({ plan, prevStates: {} }),
}));

import { pianolaOrchestrate } from '../../../cli/commands/pianola-orchestrate';
import { readSettingValue } from '../../../cli/services/storage';
import { getPianolaPlan } from '../../../cli/services/pianola-store';

const PLAN: PianolaPlan = { id: 'plan-1', title: 'P', createdAt: 1, tasks: [] };

const DONE_PROGRESS: PianolaPlanProgress = {
	total: 0,
	pending: 0,
	running: 0,
	done: 0,
	failed: 0,
	blocked: 0,
	skipped: 0,
	complete: true,
};

function doneResult(state: OrchestratorState) {
	return {
		state,
		progress: DONE_PROGRESS,
		completedTaskIds: [],
		failedTaskIds: [],
		dispatchedTaskIds: [],
		done: true,
	};
}

describe('pianolaOrchestrate - iteration error resilience', () => {
	let errorSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, 'log').mockImplementation(() => {});
		errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('__exit__');
		});
		connectMock.mockResolvedValue(undefined);
		disconnectMock.mockReturnValue(undefined);
		vi.mocked(readSettingValue).mockReturnValue({ pianola: true });
		vi.mocked(getPianolaPlan).mockReturnValue(PLAN);
	});

	it('logs a thrown iteration and keeps running until the plan completes', async () => {
		let calls = 0;
		runIterationMock.mockImplementation(async (state: OrchestratorState) => {
			calls += 1;
			if (calls === 1) throw new Error('ws timeout');
			return doneResult(state);
		});

		// interval '1' is the 1s minimum; the first tick throws, the loop logs and
		// sleeps, then the second tick completes the plan - proving the error did
		// not end the run.
		await pianolaOrchestrate('plan-1', { interval: '1' });

		expect(runIterationMock).toHaveBeenCalledTimes(2);
		expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('iteration error: ws timeout'));
		expect(disconnectMock).toHaveBeenCalledTimes(1);
	});

	it('still completes cleanly when the first iteration succeeds (happy path intact)', async () => {
		runIterationMock.mockImplementation(async (state: OrchestratorState) => doneResult(state));
		await pianolaOrchestrate('plan-1', {});
		expect(runIterationMock).toHaveBeenCalledTimes(1);
		expect(errorSpy).not.toHaveBeenCalled();
		expect(disconnectMock).toHaveBeenCalledTimes(1);
	});
});
