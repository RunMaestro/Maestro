/**
 * @file setup-recovery.test.ts
 * @description Startup wiring tests for setupAgentRunRecovery (F1 / ISC-1.10).
 * The pure pass (recover-runs.test.ts) covers reconciliation semantics; this
 * file covers the WIRING invariants of the startup call:
 *   - liveness is answered by the ProcessManager process table (a run whose
 *     session is in the table is untouched; one whose session is absent fails).
 *   - an empty store is a clean no-op (0 recovered, no writes).
 *   - the pass is idempotent across a double invocation (second run writes
 *     nothing - the exact "called twice at startup" hazard).
 *   - a store failure is swallowed and logged; startup must never throw (-1).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { AgentRun } from '../../../shared/agent-run';

const { storeMocks, loggerMock } = vi.hoisted(() => ({
	storeMocks: {
		readAgentRuns: vi.fn(),
		upsertAgentRun: vi.fn(),
		appendAgentRunEvent: vi.fn(),
	},
	loggerMock: {
		info: vi.fn(),
		warn: vi.fn(),
	},
}));

vi.mock('../../../cli/services/agent-run-store', () => storeMocks);
vi.mock('../../../main/utils/logger', () => ({ logger: loggerMock }));

import { setupAgentRunRecovery } from '../../../main/agent-run/setup-recovery';
import type { ProcessManager } from '../../../main/process-manager';

/** ProcessManager stand-in: only `get` is consulted by the recovery wiring. */
function processManagerWithLiveSessions(live: string[]): ProcessManager {
	return {
		get: (sessionId: string) => (live.includes(sessionId) ? { sessionId } : undefined),
	} as unknown as ProcessManager;
}

const run = (overrides: Partial<AgentRun> = {}): AgentRun => ({
	id: 'run-1',
	createdAt: 100,
	updatedAt: 100,
	provider: 'claude-code',
	status: 'running',
	sessionId: 'sess-1',
	artifacts: [],
	touchedFiles: [],
	checks: [],
	reviews: [],
	...overrides,
});

describe('setupAgentRunRecovery', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		storeMocks.upsertAgentRun.mockImplementation((r: AgentRun) => r);
		storeMocks.appendAgentRunEvent.mockImplementation((e: unknown) => e);
	});

	it('settles a non-terminal run whose session is not in the process table', () => {
		storeMocks.readAgentRuns.mockReturnValue([run()]);

		const recovered = setupAgentRunRecovery(processManagerWithLiveSessions([]));

		expect(recovered).toBe(1);
		expect(storeMocks.upsertAgentRun).toHaveBeenCalledWith(
			expect.objectContaining({
				id: 'run-1',
				status: 'failed',
				metadata: expect.objectContaining({ recoveredFrom: 'running' }),
			})
		);
		expect(storeMocks.appendAgentRunEvent).toHaveBeenCalledWith(
			expect.objectContaining({ runId: 'run-1', type: 'status_change', status: 'failed' })
		);
	});

	it('leaves a run alone when the ProcessManager still tracks its session', () => {
		storeMocks.readAgentRuns.mockReturnValue([run()]);

		const recovered = setupAgentRunRecovery(processManagerWithLiveSessions(['sess-1']));

		expect(recovered).toBe(0);
		expect(storeMocks.upsertAgentRun).not.toHaveBeenCalled();
		expect(storeMocks.appendAgentRunEvent).not.toHaveBeenCalled();
	});

	it('tolerates an empty store: 0 recovered, no writes, no throw', () => {
		storeMocks.readAgentRuns.mockReturnValue([]);

		expect(setupAgentRunRecovery(processManagerWithLiveSessions([]))).toBe(0);
		expect(storeMocks.upsertAgentRun).not.toHaveBeenCalled();
		expect(storeMocks.appendAgentRunEvent).not.toHaveBeenCalled();
	});

	it('is idempotent: a second startup pass over the settled store writes nothing', () => {
		const crashed = run();
		storeMocks.readAgentRuns.mockReturnValue([crashed]);
		const pm = processManagerWithLiveSessions([]);

		expect(setupAgentRunRecovery(pm)).toBe(1);
		// Simulate the store after the first pass persisted the settle.
		const settled = storeMocks.upsertAgentRun.mock.calls[0][0] as AgentRun;
		storeMocks.readAgentRuns.mockReturnValue([settled]);
		storeMocks.upsertAgentRun.mockClear();
		storeMocks.appendAgentRunEvent.mockClear();

		expect(setupAgentRunRecovery(pm)).toBe(0);
		expect(storeMocks.upsertAgentRun).not.toHaveBeenCalled();
		expect(storeMocks.appendAgentRunEvent).not.toHaveBeenCalled();
	});

	it('swallows a store failure, logs it, and returns -1 (startup never throws)', () => {
		storeMocks.readAgentRuns.mockImplementation(() => {
			throw new Error('corrupt snapshot');
		});

		expect(() => setupAgentRunRecovery(processManagerWithLiveSessions([]))).not.toThrow();
		expect(setupAgentRunRecovery(processManagerWithLiveSessions([]))).toBe(-1);
		expect(loggerMock.warn).toHaveBeenCalledWith(
			expect.stringContaining('recovery failed'),
			expect.any(String)
		);
	});

	it('skips runs with no sessionId only when they cannot transition, settles them otherwise', () => {
		// A run with no sessionId is never "live" - it must settle too (a crash
		// can strand a queued run before its session was ever bound).
		storeMocks.readAgentRuns.mockReturnValue([run({ id: 'r-nosess', sessionId: undefined })]);

		const recovered = setupAgentRunRecovery(processManagerWithLiveSessions(['sess-1']));

		expect(recovered).toBe(1);
		expect(storeMocks.upsertAgentRun).toHaveBeenCalledWith(
			expect.objectContaining({ id: 'r-nosess', status: 'failed' })
		);
	});
});
