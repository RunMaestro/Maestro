/**
 * Phase 01 — chain lineage write-path tests.
 *
 * Verifies that `cue-run-manager.execute(...)` snapshots the right
 * `pipeline_id` / `chain_root_id` / `parent_event_id` onto every
 * `cue_events` row, and that all three are written as NULL when the
 * `usageStats` Encore gate is disabled.
 *
 * Note: `better-sqlite3` is a native module compiled against Electron's
 * NODE_MODULE_VERSION and fails to load under vitest's plain-Node runtime
 * (the other Cue tests work around this the same way). Each test starts
 * with a fresh `vi.fn()` mock for `safeRecordCueEvent` and asserts on its
 * captured call args — the equivalent of "no disk writes, fresh state per
 * test" the brief asks for.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CueEvent, CueRunResult, CueSettings } from '../../../main/cue/cue-types';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockSafeRecordCueEvent = vi.fn();
const mockUpdateCueEventStatus = vi.fn();
const mockSafeUpdateCueEventStatus = vi.fn();

vi.mock('../../../main/cue/cue-db', () => ({
	recordCueEvent: vi.fn(),
	updateCueEventStatus: (...args: unknown[]) => mockUpdateCueEventStatus(...args),
	safeRecordCueEvent: (...args: unknown[]) => mockSafeRecordCueEvent(...args),
	safeUpdateCueEventStatus: (...args: unknown[]) => mockSafeUpdateCueEventStatus(...args),
}));

vi.mock('../../../main/utils/sentry', () => ({
	captureException: vi.fn(),
}));

// Output-prompt phase isn't exercised by these tests, but the module is
// imported by cue-run-manager so we stub it to keep the dependency tree quiet.
vi.mock('../../../main/cue/cue-cli-executor', () => ({
	runMaestroCliSend: vi.fn(async () => ({
		ok: true,
		exitCode: 0,
		stdout: '',
		stderr: '',
		resolvedTarget: '',
	})),
}));

let uuidCounter = 0;
vi.mock('crypto', () => ({
	randomUUID: vi.fn(() => `run-${++uuidCounter}`),
}));

import { createCueRunManager, type CueRunManagerDeps } from '../../../main/cue/cue-run-manager';

// ─── Helpers ────────────────────────────────────────────────────────────────

function createEvent(overrides: Partial<CueEvent> = {}): CueEvent {
	return {
		id: 'evt-1',
		type: 'time.heartbeat',
		timestamp: new Date().toISOString(),
		triggerName: 'test-trigger',
		payload: {},
		...overrides,
	};
}

function makeResult(overrides: Partial<CueRunResult> = {}): CueRunResult {
	return {
		runId: 'r1',
		sessionId: 'session-1',
		sessionName: 'Test Session',
		subscriptionName: 'test-sub',
		event: createEvent(),
		status: 'completed',
		stdout: '',
		stderr: '',
		exitCode: 0,
		durationMs: 0,
		startedAt: new Date().toISOString(),
		endedAt: new Date().toISOString(),
		...overrides,
	};
}

const defaultSettings: CueSettings = {
	timeout_minutes: 30,
	timeout_on_fail: 'break',
	// max_concurrent set high so multiple execute() calls in one test all
	// dispatch immediately rather than queueing — we want each call to record
	// its event synchronously so we can assert on the lineage args without
	// shuffling timer advancement around.
	max_concurrent: 10,
	queue_size: 10,
};

function createDeps(overrides: Partial<CueRunManagerDeps> = {}): CueRunManagerDeps {
	return {
		getSessions: vi.fn(() => [{ id: 'session-1', name: 'Test Session' }]),
		getSessionSettings: vi.fn(() => defaultSettings),
		onCueRun: vi.fn(async () => makeResult()),
		onStopCueRun: vi.fn(() => true),
		onLog: vi.fn(),
		onRunCompleted: vi.fn(),
		onRunStopped: vi.fn(),
		onPreventSleep: vi.fn(),
		onAllowSleep: vi.fn(),
		// Default to ON for the lineage-populated tests; individual tests
		// override with `() => false` to exercise the gate.
		getUsageStatsEnabled: () => true,
		...overrides,
	};
}

/**
 * Find the captured `safeRecordCueEvent` call where `id` matches the run ID
 * we're interested in. The run-manager records the run with `id === runId`
 * at the start of `doExecuteCueRun`, plus may record an output-prompt phase
 * row with a different id; this picks the one we care about.
 */
function findRecordedRow(runId: string): Record<string, unknown> | undefined {
	for (const call of mockSafeRecordCueEvent.mock.calls) {
		const row = call[0] as Record<string, unknown>;
		if (row?.id === runId) return row;
	}
	return undefined;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('cue chain lineage write path', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		uuidCounter = 0;
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('root event records chainRootId === runId, parentEventId === null', async () => {
		const manager = createCueRunManager(createDeps());

		manager.execute('session-1', 'prompt', createEvent(), 'root-sub');
		// Let the dispatched run resolve so the captured row is final, but
		// note the safeRecordCueEvent call happens synchronously inside
		// doExecuteCueRun BEFORE any await.
		await vi.advanceTimersByTimeAsync(0);

		expect(mockSafeRecordCueEvent).toHaveBeenCalled();
		const row = mockSafeRecordCueEvent.mock.calls[0][0] as Record<string, unknown>;
		expect(row.id).toBe('run-1');
		expect(row.chainRootId).toBe('run-1');
		expect(row.parentEventId).toBeNull();
	});

	it('direct child of a root records chainRootId === root.runId, parentEventId === root.runId', async () => {
		const manager = createCueRunManager(createDeps());

		// Dispatch the root first.
		manager.execute('session-1', 'prompt', createEvent(), 'root-sub');
		await vi.advanceTimersByTimeAsync(0);
		const rootRow = findRecordedRow('run-1');
		expect(rootRow?.chainRootId).toBe('run-1');

		// Dispatch the child as the engine would after onRunCompleted: pass
		// the parent's chainRootId (which equals its runId for a root) and
		// set parentEventId to the parent's runId.
		manager.execute(
			'session-1',
			'prompt',
			createEvent(),
			'child-sub',
			undefined, // outputPrompt
			1, // chainDepth
			undefined, // cliOutput
			undefined, // action
			undefined, // command
			undefined, // queuedAtOverride
			undefined, // pipelineName
			'run-1', // chainRootId — inherited from root
			'run-1' // parentEventId — root's runId
		);
		await vi.advanceTimersByTimeAsync(0);

		const childRow = findRecordedRow('run-2');
		expect(childRow).toBeDefined();
		expect(childRow?.chainRootId).toBe('run-1');
		expect(childRow?.parentEventId).toBe('run-1');
	});

	it('grandchild records chainRootId === root.runId (root identity propagates), parentEventId === parent.runId', async () => {
		const manager = createCueRunManager(createDeps());

		// Root
		manager.execute('session-1', 'prompt', createEvent(), 'root-sub');
		await vi.advanceTimersByTimeAsync(0);

		// Direct child (parent = root)
		manager.execute(
			'session-1',
			'prompt',
			createEvent(),
			'child-sub',
			undefined,
			1,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			'run-1',
			'run-1'
		);
		await vi.advanceTimersByTimeAsync(0);

		// Grandchild — chainRootId stays at the root, parentEventId points at
		// the direct child.
		manager.execute(
			'session-1',
			'prompt',
			createEvent(),
			'grandchild-sub',
			undefined,
			2,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			'run-1', // chainRootId — still the original root, NOT the direct child
			'run-2' // parentEventId — direct child's runId
		);
		await vi.advanceTimersByTimeAsync(0);

		const grandchildRow = findRecordedRow('run-3');
		expect(grandchildRow).toBeDefined();
		expect(grandchildRow?.chainRootId).toBe('run-1');
		expect(grandchildRow?.parentEventId).toBe('run-2');
	});

	it('writes all three lineage fields as NULL when getUsageStatsEnabled returns false', async () => {
		const manager = createCueRunManager(createDeps({ getUsageStatsEnabled: () => false }));

		// Even though we pass live lineage values, the gate must zero them.
		manager.execute(
			'session-1',
			'prompt',
			createEvent(),
			'gated-sub',
			undefined,
			1,
			undefined,
			undefined,
			undefined,
			undefined,
			'my-pipeline', // pipelineName — would otherwise become pipeline_id
			'parent-root',
			'parent-run'
		);
		await vi.advanceTimersByTimeAsync(0);

		const row = findRecordedRow('run-1');
		expect(row).toBeDefined();
		expect(row?.pipelineId).toBeNull();
		expect(row?.chainRootId).toBeNull();
		expect(row?.parentEventId).toBeNull();
	});

	it('writes pipelineId from pipelineName when usageStats is enabled', async () => {
		const manager = createCueRunManager(createDeps());

		manager.execute(
			'session-1',
			'prompt',
			createEvent(),
			'sub-with-pipeline',
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			'my-pipeline'
		);
		await vi.advanceTimersByTimeAsync(0);

		const row = findRecordedRow('run-1');
		expect(row?.pipelineId).toBe('my-pipeline');
		// Root semantics still hold for the other two: chainRootId === runId,
		// parentEventId === null.
		expect(row?.chainRootId).toBe('run-1');
		expect(row?.parentEventId).toBeNull();
	});

	it('defaults to NULL lineage when getUsageStatsEnabled is omitted (back-compat)', async () => {
		// Tests that don't construct the run manager via the engine omit the
		// gate. The run-manager treats missing as off so legacy tests don't
		// accidentally write stats lineage.
		const deps = createDeps();
		delete (deps as Partial<CueRunManagerDeps>).getUsageStatsEnabled;
		const manager = createCueRunManager(deps);

		manager.execute(
			'session-1',
			'prompt',
			createEvent(),
			'no-gate-sub',
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			'my-pipeline',
			'some-root',
			'some-parent'
		);
		await vi.advanceTimersByTimeAsync(0);

		const row = findRecordedRow('run-1');
		expect(row?.pipelineId).toBeNull();
		expect(row?.chainRootId).toBeNull();
		expect(row?.parentEventId).toBeNull();
	});
});
