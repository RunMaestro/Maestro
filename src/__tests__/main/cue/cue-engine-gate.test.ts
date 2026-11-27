/**
 * Tests for a subscription `gate`, end to end through the Cue engine.
 *
 * The unit tests cover the policy (`shared/cue/gate.test.ts`) and where it is
 * applied (`cue-dispatch-service.test.ts`). These guard what the engine owes a
 * gated event: nothing is spawned, the event and its reason reach the activity
 * log and `cue_events`, it is counted as gated and not as a run, and nothing
 * downstream fires off a run that never happened.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CueConfig } from '../../../main/cue/cue-types';

const mockLoadCueConfig = vi.fn<(projectRoot: string) => CueConfig | null>();
vi.mock('../../../main/cue/cue-yaml-loader', () => ({
	loadCueConfig: (projectRoot: string) => mockLoadCueConfig(projectRoot),
	loadCueConfigDetailed: (projectRoot: string) => {
		const config = mockLoadCueConfig(projectRoot);
		return config ? { ok: true, config, warnings: [] } : { ok: false, reason: 'missing' };
	},
	watchCueYaml: () => () => {},
}));

vi.mock('../../../main/cue/cue-file-watcher', () => ({
	createCueFileWatcher: () => () => {},
}));

vi.mock('../../../main/cue/cue-github-poller', () => ({
	createCueGitHubPoller: () => () => {},
}));

vi.mock('../../../main/cue/cue-engine-lock', () => ({
	acquireCueEngineLock: () => ({ acquired: true }),
	releaseCueEngineLock: () => {},
	touchCueEngineLock: () => 'held',
	CUE_ENGINE_LOCK_HEARTBEAT_MS: 30_000,
	readCueEngineLock: () => null,
}));

const mockSafeRecordCueEvent = vi.fn();
vi.mock('../../../main/cue/cue-db', () => ({
	initCueDb: vi.fn(),
	closeCueDb: vi.fn(),
	pruneCueEvents: vi.fn(),
	failOrphanedRunningEvents: () => 0,
	isCueDbReady: () => true,
	recordCueEvent: vi.fn(),
	updateCueEventStatus: vi.fn(),
	safeRecordCueEvent: (...args: unknown[]) => mockSafeRecordCueEvent(...args),
	safeUpdateCueEventStatus: vi.fn(),
	persistQueuedEvent: vi.fn(),
	removeQueuedEvent: vi.fn(),
	getQueuedEvents: vi.fn(() => []),
	clearPersistedQueue: vi.fn(),
	safePersistQueuedEvent: vi.fn(),
	safeRemoveQueuedEvent: vi.fn(),
	clearGitHubSeenForSubscription: vi.fn(),
	getRecentCueEvents: vi.fn(() => []),
	countCueEvents: vi.fn(() => 0),
}));

import { CueEngine } from '../../../main/cue/cue-engine';
import {
	readCueGateRecord,
	type CueGateCheck,
	type CueGateEvaluator,
} from '../../../shared/cue/gate';
import type { CueSubscription } from '../../../shared/cue';
import { createMockConfig, createMockDeps } from './cue-test-helpers';

/** A heartbeat fires once as soon as the engine starts, which is the event under test. */
function heartbeat(overrides: Partial<CueSubscription> = {}): CueSubscription {
	return {
		name: 'triage',
		event: 'time.heartbeat',
		enabled: true,
		prompt: 'Triage the inbox',
		interval_minutes: 60,
		gate: 'there is unread mail from a customer',
		...overrides,
	};
}

function gateAnswering(check: CueGateCheck) {
	return vi.fn<CueGateEvaluator>(async () => check);
}

/** Let the gate check, the dispatch behind it, and the mocked run settle. */
const settle = () => vi.advanceTimersByTimeAsync(50);

describe('CueEngine - subscription gate', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	function start(subscriptions: CueSubscription[], evaluateGate?: CueGateEvaluator) {
		mockLoadCueConfig.mockReturnValue(createMockConfig({ subscriptions }));
		const deps = createMockDeps(evaluateGate ? { evaluateGate } : {});
		const engine = new CueEngine(deps);
		engine.start();
		return { engine, deps };
	}

	it('spawns nothing for a gated event and records it with the reason', async () => {
		const evaluateGate = gateAnswering({ status: 'fail', reason: 'The inbox is empty.' });
		const { engine, deps } = start([heartbeat()], evaluateGate);
		await settle();

		expect(evaluateGate).toHaveBeenCalledTimes(1);
		expect(evaluateGate.mock.calls[0][0]).toMatchObject({
			condition: 'there is unread mail from a customer',
			subscriptionName: 'triage',
		});
		expect(deps.onCueRun).not.toHaveBeenCalled();

		const log = engine.getActivityLog();
		expect(log).toHaveLength(1);
		expect(log[0]).toMatchObject({
			status: 'gated',
			subscriptionName: 'triage',
			sessionId: 'session-1',
			exitCode: null,
			stdout: '',
		});
		expect(readCueGateRecord(log[0].event.payload)).toEqual({
			outcome: 'gated',
			reason: 'The inbox is empty.',
		});

		// One row, born in its final status, carrying the reason in its payload.
		expect(mockSafeRecordCueEvent).toHaveBeenCalledTimes(1);
		const row = mockSafeRecordCueEvent.mock.calls[0][0];
		expect(row).toMatchObject({ status: 'gated', subscriptionName: 'triage', id: log[0].runId });
		expect(readCueGateRecord(JSON.parse(row.payload))?.reason).toBe('The inbox is empty.');

		expect(engine.getActiveRuns()).toEqual([]);
		engine.stop();
	});

	it('counts a gated event as gated, not as a run', async () => {
		const { engine, deps } = start(
			[heartbeat()],
			gateAnswering({ status: 'fail', reason: 'The inbox is empty.' })
		);
		await settle();

		const metrics = engine.getMetrics();
		expect(metrics.runsGated).toBe(1);
		expect(metrics.runsStarted).toBe(0);
		expect(metrics.runsCompleted).toBe(0);
		expect(deps.onLog).toHaveBeenCalledWith('cue', expect.stringContaining('Run gated'), {
			type: 'runGated',
			runId: engine.getActivityLog()[0].runId,
			sessionId: 'session-1',
			subscriptionName: 'triage',
			reason: 'The inbox is empty.',
		});
		// No run lifecycle payloads: nothing started, nothing finished.
		const types = vi
			.mocked(deps.onLog)
			.mock.calls.map((call) => (call[2] as { type?: string } | undefined)?.type);
		expect(types).not.toContain('runStarted');
		expect(types).not.toContain('runFinished');
		engine.stop();
	});

	it('starts the run when the gate passes, carrying the verdict on the event', async () => {
		const { engine, deps } = start(
			[heartbeat()],
			gateAnswering({ status: 'pass', reason: 'Two unread customer emails.' })
		);
		await settle();

		expect(deps.onCueRun).toHaveBeenCalledTimes(1);
		const request = vi.mocked(deps.onCueRun).mock.calls[0][0];
		expect(request.subscriptionName).toBe('triage');
		expect(readCueGateRecord(request.event.payload)).toEqual({
			outcome: 'passed',
			reason: 'Two unread customer emails.',
		});
		expect(engine.getMetrics().runsGated).toBe(0);
		engine.stop();
	});

	it('fails OPEN with a warning when the gate model is unavailable', async () => {
		const { engine, deps } = start(
			[heartbeat()],
			gateAnswering({ status: 'unavailable', reason: 'Cue gate is off.' })
		);
		await settle();

		expect(deps.onCueRun).toHaveBeenCalledTimes(1);
		expect(
			readCueGateRecord(vi.mocked(deps.onCueRun).mock.calls[0][0].event.payload)?.outcome
		).toBe('ran-unchecked');
		expect(deps.onLog).toHaveBeenCalledWith('warn', expect.stringContaining('gate not checked'), {
			type: 'gateUnavailable',
			sessionId: 'session-1',
			subscriptionName: 'triage',
			message: expect.stringContaining('Cue gate is off.'),
			ran: true,
		});
		engine.stop();
	});

	it('skips, with a warning, when unavailable and gate_on_unavailable is skip', async () => {
		const { engine, deps } = start(
			[heartbeat({ gate_on_unavailable: 'skip' })],
			gateAnswering({ status: 'unavailable', reason: 'Model not installed.' })
		);
		await settle();

		expect(deps.onCueRun).not.toHaveBeenCalled();
		const log = engine.getActivityLog();
		expect(log).toHaveLength(1);
		expect(log[0].status).toBe('gated');
		expect(readCueGateRecord(log[0].event.payload)?.reason).toContain('Model not installed.');
		expect(deps.onLog).toHaveBeenCalledWith(
			'warn',
			expect.any(String),
			expect.objectContaining({ type: 'gateUnavailable', ran: false })
		);
		engine.stop();
	});

	it('treats an engine built without an evaluator as an unavailable gate', async () => {
		// The standalone runner (`maestro-cli cue engine`) does not load the
		// model stack. Its gates must follow the policy, not vanish.
		const { engine, deps } = start([
			heartbeat({ name: 'open' }),
			heartbeat({ name: 'closed', gate_on_unavailable: 'skip' }),
		]);
		await settle();

		const ran = vi.mocked(deps.onCueRun).mock.calls.map((call) => call[0].subscriptionName);
		expect(ran).toEqual(['open']);
		expect(
			engine.getActivityLog().find((entry) => entry.status === 'gated')?.subscriptionName
		).toBe('closed');
		engine.stop();
	});

	it('fires no chain step off a gated event', async () => {
		const chain: CueSubscription = {
			name: 'triage-chain-2',
			event: 'agent.completed',
			enabled: true,
			prompt: 'Summarize what triage did',
			source_session: 'Test Session',
		};
		const { engine, deps } = start(
			[heartbeat(), chain],
			gateAnswering({ status: 'fail', reason: 'The inbox is empty.' })
		);
		await settle();
		await settle();

		// Nothing ran, so nothing completed, so the chain has nothing to fire on.
		expect(deps.onCueRun).not.toHaveBeenCalled();
		expect(engine.getActivityLog().map((entry) => entry.status)).toEqual(['gated']);
		engine.stop();
	});

	it('does not gate a manual trigger', async () => {
		const evaluateGate = gateAnswering({ status: 'fail', reason: 'The inbox is empty.' });
		const { engine, deps } = start([heartbeat()], evaluateGate);
		await settle();
		expect(deps.onCueRun).not.toHaveBeenCalled();
		evaluateGate.mockClear();

		expect(engine.triggerSubscription('triage')).toBe(true);
		await settle();

		expect(evaluateGate).not.toHaveBeenCalled();
		expect(deps.onCueRun).toHaveBeenCalledTimes(1);
		expect(vi.mocked(deps.onCueRun).mock.calls[0][0].event.payload.manual).toBe(true);
		engine.stop();
	});

	it('leaves a subscription with no gate untouched', async () => {
		const evaluateGate = gateAnswering({ status: 'fail', reason: 'no' });
		const { engine, deps } = start([heartbeat({ gate: undefined })], evaluateGate);
		await settle();

		expect(evaluateGate).not.toHaveBeenCalled();
		expect(deps.onCueRun).toHaveBeenCalledTimes(1);
		expect(readCueGateRecord(vi.mocked(deps.onCueRun).mock.calls[0][0].event.payload)).toBeNull();
		engine.stop();
	});
});
