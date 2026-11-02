/**
 * @file agent-busy.test.ts
 * @description Unit tests for the main-process "is this agent working right now?" probe.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockIsSessionBusyWithCli = vi.fn<(sessionId: string) => boolean>();
vi.mock('../../../shared/cli-activity', () => ({
	isSessionBusyWithCli: (sessionId: string) => mockIsSessionBusyWithCli(sessionId),
}));

import {
	isAgentBusy,
	isAiTabProcessActive,
	snapshotAiTurnProcesses,
	waitForAiTurnsToExit,
	type TurnProcessTable,
} from '../../../main/utils/agent-busy';

/** Process manager double whose live keys are whatever this set contains. */
function probeWith(liveIds: string[]) {
	const live = new Set(liveIds);
	return { get: (sessionId: string) => (live.has(sessionId) ? { pid: 1 } : undefined) };
}

describe('agent-busy', () => {
	beforeEach(() => {
		mockIsSessionBusyWithCli.mockReset();
		mockIsSessionBusyWithCli.mockReturnValue(false);
	});

	describe('isAiTabProcessActive', () => {
		it('reports a live process on the compound tab id', () => {
			const probe = probeWith(['agent-1-ai-tab-a']);
			expect(isAiTabProcessActive(probe, 'agent-1', 'tab-a', false)).toBe(true);
		});

		it('reports idle when only another tab is running', () => {
			const probe = probeWith(['agent-1-ai-tab-b']);
			expect(isAiTabProcessActive(probe, 'agent-1', 'tab-a', false)).toBe(false);
		});

		it('accepts the legacy bare id for the active tab only', () => {
			const probe = probeWith(['agent-1-ai']);
			expect(isAiTabProcessActive(probe, 'agent-1', 'tab-a', true)).toBe(true);
			expect(isAiTabProcessActive(probe, 'agent-1', 'tab-a', false)).toBe(false);
		});

		it('reports idle with no process manager', () => {
			expect(isAiTabProcessActive(undefined, 'agent-1', 'tab-a', true)).toBe(false);
		});
	});

	describe('isAgentBusy', () => {
		const session = {
			id: 'agent-1',
			activeTabId: 'tab-a',
			aiTabs: [{ id: 'tab-a' }, { id: 'tab-b' }],
		};

		it('is busy when any tab is running, not just the active one', () => {
			expect(isAgentBusy(session, probeWith(['agent-1-ai-tab-b']))).toBe(true);
		});

		it('is idle when no tab has a live process', () => {
			expect(isAgentBusy(session, probeWith([]))).toBe(false);
		});

		it('is busy when the CLI is running a playbook against it', () => {
			mockIsSessionBusyWithCli.mockImplementation((id) => id === 'agent-1');
			expect(isAgentBusy(session, probeWith([]))).toBe(true);
		});

		it('ignores malformed tab entries', () => {
			const malformed = {
				id: 'agent-1',
				activeTabId: 'tab-a',
				aiTabs: [null, undefined, {} as { id?: string }],
			};
			expect(isAgentBusy(malformed, probeWith(['agent-1-ai-tab-a']))).toBe(false);
		});

		it('is idle for an agent with no tabs at all', () => {
			expect(isAgentBusy({ id: 'agent-1' }, probeWith(['agent-1-ai']))).toBe(false);
		});
	});
});

/** A live process table whose rows the test edits between polls. */
function tableWith(rows: Array<{ sessionId: string; startTime: number; isTerminal?: boolean }>) {
	const live = new Map(rows.map((r) => [r.sessionId, { ...r, isTerminal: r.isTerminal ?? false }]));
	const table: TurnProcessTable = {
		getAll: () => [...live.values()],
		get: (sessionId) => live.get(sessionId),
	};
	return { table, live };
}

describe('snapshotAiTurnProcesses', () => {
	const { table } = tableWith([
		{ sessionId: 'agent-1-ai-tab-a', startTime: 10 },
		{ sessionId: 'agent-1-ai-tab-a-fp-1700', startTime: 11 },
		{ sessionId: 'agent-1-ai-tab-b', startTime: 12 },
		{ sessionId: 'agent-1-synopsis-1', startTime: 13 },
		{ sessionId: 'agent-1-ai-shell', startTime: 14, isTerminal: true },
		{ sessionId: 'agent-2-ai-tab-a', startTime: 15 },
	]);

	it('takes every turn process of the agent when no tab is named', () => {
		expect([...snapshotAiTurnProcesses(table, 'agent-1', null)]).toEqual([
			['agent-1-ai-tab-a', 10],
			['agent-1-ai-tab-a-fp-1700', 11],
			['agent-1-ai-tab-b', 12],
		]);
	});

	it("takes one tab's turn and its forced-parallel siblings only", () => {
		expect([...snapshotAiTurnProcesses(table, 'agent-1', 'tab-a').keys()]).toEqual([
			'agent-1-ai-tab-a',
			'agent-1-ai-tab-a-fp-1700',
		]);
	});

	it('is empty without a process manager', () => {
		expect(snapshotAiTurnProcesses(null, 'agent-1', null).size).toBe(0);
	});
});

describe('waitForAiTurnsToExit', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('resolves true at once when nothing was running', async () => {
		const { table } = tableWith([]);
		await expect(waitForAiTurnsToExit(table, new Map(), 1000)).resolves.toBe(true);
	});

	it('resolves true once the stopped process leaves the table', async () => {
		const { table, live } = tableWith([{ sessionId: 'agent-1-ai-tab-a', startTime: 10 }]);
		const done = waitForAiTurnsToExit(table, snapshotAiTurnProcesses(table, 'agent-1', null), 1000);

		live.delete('agent-1-ai-tab-a');
		await vi.advanceTimersByTimeAsync(100);

		await expect(done).resolves.toBe(true);
	});

	it('treats a new turn on the same key as the old one having exited', async () => {
		// A queued item can start on the stopped tab right away: same id, new start.
		const { table, live } = tableWith([{ sessionId: 'agent-1-ai-tab-a', startTime: 10 }]);
		const done = waitForAiTurnsToExit(table, snapshotAiTurnProcesses(table, 'agent-1', null), 1000);

		live.set('agent-1-ai-tab-a', {
			sessionId: 'agent-1-ai-tab-a',
			startTime: 99,
			isTerminal: false,
		});
		await vi.advanceTimersByTimeAsync(100);

		await expect(done).resolves.toBe(true);
	});

	it('resolves false when the process outlives the budget', async () => {
		const { table } = tableWith([{ sessionId: 'agent-1-ai-tab-a', startTime: 10 }]);
		const done = waitForAiTurnsToExit(table, snapshotAiTurnProcesses(table, 'agent-1', null), 300);

		await vi.advanceTimersByTimeAsync(400);

		await expect(done).resolves.toBe(false);
	});
});
