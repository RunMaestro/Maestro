/**
 * E2E Tests: Role-Based Dispatch Pipeline (#427)
 *
 * These tests exercise the state-machine transitions and role-enforcement logic
 * added in #427. They drive the state machine and engine directly — no Electron
 * app launch required — keeping the suite fast and deterministic.
 *
 * Pipeline shape:
 *   runner-done    → reviewer
 *   review-approve → merger
 *   merger-done    → terminal
 *
 * Reject branch:
 *   review-reject  → fixer
 *   fixer-done     → reviewer  (loops until approve)
 *
 * Track D wiring: uses `pm:setStatus` IPC channel indirectly via
 * `AgentDispatchEngine.advancePipeline` (#428 will add the slash command
 * surface; for now the IPC channel is called directly in tests).
 */
import { test, expect } from '@playwright/test';
import {
	nextRole,
	isTerminal,
	validateTransition,
	createInitialPipeline,
} from '../src/main/agent-dispatch/state-machine';
import type { WorkItemPipeline } from '../src/shared/work-graph-types';
import type {
	AgentDispatchFleetEntry,
	AgentDispatchProfile,
} from '../src/shared/agent-dispatch-types';
import {
	AgentDispatchEngine,
	isRoleEligibilityError,
} from '../src/main/agent-dispatch/dispatch-engine';
import type { WorkItem } from '../src/shared/work-graph-types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePipeline(
	currentRole: WorkItemPipeline['currentRole'],
	completedRoles: WorkItemPipeline['completedRoles'] = []
): WorkItemPipeline {
	return { currentRole, completedRoles };
}

function makeProfile(roles: AgentDispatchProfile['roles']): AgentDispatchProfile {
	return {
		autoPickupEnabled: true,
		capabilityTags: ['feature'],
		maxConcurrentClaims: 1,
		roles,
	};
}

function makeFleetEntry(id: string, roles: AgentDispatchProfile['roles']): AgentDispatchFleetEntry {
	return {
		id,
		agentId: 'claude-code',
		sessionId: id,
		displayName: `Agent-${id}`,
		providerType: 'claude-code',
		host: 'local',
		locality: 'local',
		readiness: 'idle',
		currentClaims: [],
		currentLoad: 0,
		dispatchCapabilities: ['feature'],
		dispatchProfile: makeProfile(roles),
		pickupEnabled: true,
		updatedAt: new Date().toISOString(),
	};
}

function makeWorkItem(id: string, pipeline?: WorkItemPipeline): WorkItem {
	const now = new Date().toISOString();
	return {
		id,
		type: 'task',
		status: 'ready',
		title: `Task ${id}`,
		projectPath: '/test/project',
		gitPath: '/test/project',
		source: 'manual',
		readonly: false,
		tags: ['agent-ready', 'feature'],
		createdAt: now,
		updatedAt: now,
		pipeline,
	};
}

// ---------------------------------------------------------------------------
// State machine: nextRole + isTerminal + validateTransition
// ---------------------------------------------------------------------------

test.describe('State machine — happy path (runner → reviewer → merger)', () => {
	test('createInitialPipeline starts at runner', () => {
		const pipeline = createInitialPipeline();
		expect(pipeline.currentRole).toBe('runner');
		expect(pipeline.completedRoles).toEqual([]);
	});

	test('runner-done advances to reviewer', () => {
		const pipeline = makePipeline('runner');
		const next = nextRole(pipeline, 'runner-done');
		expect(next.currentRole).toBe('reviewer');
		expect(next.completedRoles).toContain('runner');
	});

	test('review-approve advances to merger', () => {
		const pipeline = makePipeline('reviewer', ['runner']);
		const next = nextRole(pipeline, 'review-approve');
		expect(next.currentRole).toBe('merger');
		expect(next.completedRoles).toContain('reviewer');
	});

	test('merger-done marks pipeline terminal', () => {
		const pipeline = makePipeline('merger', ['runner', 'reviewer']);
		const next = nextRole(pipeline, 'merger-done');
		expect(isTerminal(next)).toBe(true);
	});

	test('pipeline is NOT terminal before merger-done', () => {
		expect(isTerminal(makePipeline('runner'))).toBe(false);
		expect(isTerminal(makePipeline('reviewer', ['runner']))).toBe(false);
		expect(isTerminal(makePipeline('merger', ['runner', 'reviewer']))).toBe(false);
	});
});

test.describe('State machine — reject branch (reviewer → fixer → reviewer loop)', () => {
	test('review-reject routes to fixer', () => {
		const pipeline = makePipeline('reviewer', ['runner']);
		const next = nextRole(pipeline, 'review-reject');
		expect(next.currentRole).toBe('fixer');
	});

	test('fixer-done routes back to reviewer', () => {
		const pipeline = makePipeline('fixer', ['runner', 'reviewer']);
		const next = nextRole(pipeline, 'fixer-done');
		expect(next.currentRole).toBe('reviewer');
	});

	test('reviewer can reject again after fixer round', () => {
		const pipeline = makePipeline('reviewer', ['runner', 'fixer']);
		const next = nextRole(pipeline, 'review-reject');
		expect(next.currentRole).toBe('fixer');
	});

	test('completedRoles does not duplicate fixer on second loop', () => {
		const pipeline = makePipeline('fixer', ['runner', 'reviewer', 'fixer']);
		const next = nextRole(pipeline, 'fixer-done');
		expect(next.currentRole).toBe('reviewer');
		const fixerCount = next.completedRoles.filter((r) => r === 'fixer').length;
		expect(fixerCount).toBeLessThanOrEqual(1);
	});
});

test.describe('State machine — validateTransition', () => {
	test('valid transitions return true', () => {
		expect(validateTransition('runner', 'reviewer', 'runner-done')).toBe(true);
		expect(validateTransition('reviewer', 'merger', 'review-approve')).toBe(true);
		expect(validateTransition('reviewer', 'fixer', 'review-reject')).toBe(true);
		expect(validateTransition('fixer', 'reviewer', 'fixer-done')).toBe(true);
		expect(validateTransition('merger', null, 'merger-done')).toBe(true);
	});

	test('wrong next role returns reason string', () => {
		const result = validateTransition('runner', 'merger', 'runner-done');
		expect(typeof result).toBe('string');
		expect(result).toContain('reviewer');
	});

	test('wrong event for role returns reason string', () => {
		const result = validateTransition('runner', 'reviewer', 'review-approve');
		expect(typeof result).toBe('string');
		expect(result).toContain('runner');
	});

	test('invalid event throws descriptive error via nextRole', () => {
		const pipeline = makePipeline('runner');
		expect(() => nextRole(pipeline, 'merger-done')).toThrow();
	});
});

// ---------------------------------------------------------------------------
// Manual claim role enforcement (Track C)
// ---------------------------------------------------------------------------

test.describe('assignManually — role enforcement', () => {
	function makeEngine(): AgentDispatchEngine {
		const store = {
			getUnblockedWorkItems: async () => ({ items: [], total: 0 }),
			claimItem: async (input: { workItemId: string }) => makeWorkItem(input.workItemId),
		};
		const fleetRegistry = {
			getEntries: () => [],
			on: () => undefined as unknown as typeof fleetRegistry,
			off: () => undefined as unknown as typeof fleetRegistry,
		};
		return new AgentDispatchEngine({
			workGraph: store,
			fleetRegistry: fleetRegistry as never,
		});
	}

	test('runner agent can claim a runner-gated work item', async () => {
		const engine = makeEngine();
		const runnerAgent = makeFleetEntry('runner-1', ['runner']);
		const workItem = makeWorkItem('wi-1', makePipeline('runner'));

		const result = await engine.assignManually({
			workItemId: 'wi-1',
			workItem,
			agent: runnerAgent,
			userInitiated: true,
		});

		expect(isRoleEligibilityError(result)).toBe(false);
		expect((result as WorkItem).id).toBe('wi-1');
	});

	test('reviewer agent is rejected for a runner-gated work item', async () => {
		const engine = makeEngine();
		const reviewerAgent = makeFleetEntry('reviewer-1', ['reviewer']);
		const workItem = makeWorkItem('wi-2', makePipeline('runner'));

		const result = await engine.assignManually({
			workItemId: 'wi-2',
			workItem,
			agent: reviewerAgent,
			userInitiated: true,
		});

		expect(isRoleEligibilityError(result)).toBe(true);
		if (isRoleEligibilityError(result)) {
			expect(result.code).toBe('ROLE_NOT_ELIGIBLE');
			expect(result.workItemCurrentRole).toBe('runner');
			expect(result.agentRoles).toContain('reviewer');
			expect(result.message).toMatch(/not eligible/i);
		}
	});

	test('multi-role agent can claim any of its roles', async () => {
		const engine = makeEngine();
		const multiAgent = makeFleetEntry('multi-1', ['runner', 'fixer']);

		const runnerItem = makeWorkItem('wi-3', makePipeline('runner'));
		const fixerItem = makeWorkItem('wi-4', makePipeline('fixer', ['runner', 'reviewer']));

		const r1 = await engine.assignManually({
			workItemId: 'wi-3',
			workItem: runnerItem,
			agent: multiAgent,
			userInitiated: true,
		});
		expect(isRoleEligibilityError(r1)).toBe(false);

		const r2 = await engine.assignManually({
			workItemId: 'wi-4',
			workItem: fixerItem,
			agent: multiAgent,
			userInitiated: true,
		});
		expect(isRoleEligibilityError(r2)).toBe(false);
	});

	test('agent with no roles is rejected for a role-gated item', async () => {
		const engine = makeEngine();
		const noRoleAgent = makeFleetEntry('no-role-1', undefined);
		const workItem = makeWorkItem('wi-5', makePipeline('reviewer', ['runner']));

		const result = await engine.assignManually({
			workItemId: 'wi-5',
			workItem,
			agent: noRoleAgent,
			userInitiated: true,
		});

		expect(isRoleEligibilityError(result)).toBe(true);
	});

	test('non-pipeline work item can be claimed by any agent', async () => {
		const engine = makeEngine();
		const reviewerAgent = makeFleetEntry('reviewer-2', ['reviewer']);
		const workItem = makeWorkItem('wi-6'); // no pipeline

		const result = await engine.assignManually({
			workItemId: 'wi-6',
			workItem,
			agent: reviewerAgent,
			userInitiated: true,
		});

		expect(isRoleEligibilityError(result)).toBe(false);
	});

	test('assignManually throws when userInitiated is false', async () => {
		const engine = makeEngine();
		const runnerAgent = makeFleetEntry('runner-3', ['runner']);
		const workItem = makeWorkItem('wi-7', makePipeline('runner'));

		await expect(
			engine.assignManually({
				workItemId: 'wi-7',
				workItem,
				agent: runnerAgent,
				userInitiated: false,
			})
		).rejects.toThrow(/user-initiated/i);
	});
});

// ---------------------------------------------------------------------------
// advancePipeline — engine integration (Track A wiring)
// ---------------------------------------------------------------------------

test.describe('advancePipeline — engine integration', () => {
	function makeEngineWithPipelineStore(): {
		engine: AgentDispatchEngine;
		getStoredPipeline: () => WorkItemPipeline | null;
	} {
		let storedPipeline: WorkItemPipeline | null = null;

		const store = {
			getUnblockedWorkItems: async () => ({ items: [], total: 0 }),
			claimItem: async (input: { workItemId: string }) => makeWorkItem(input.workItemId),
			updatePipeline: async (_id: string, pipeline: WorkItemPipeline) => {
				storedPipeline = pipeline;
				return makeWorkItem(_id, pipeline);
			},
		};
		const fleetRegistry = {
			getEntries: () => [],
			on: () => undefined as unknown as typeof fleetRegistry,
			off: () => undefined as unknown as typeof fleetRegistry,
		};
		const engine = new AgentDispatchEngine({
			workGraph: store,
			fleetRegistry: fleetRegistry as never,
		});
		return { engine, getStoredPipeline: () => storedPipeline };
	}

	test('advancePipeline runner-done → reviewer', async () => {
		const { engine, getStoredPipeline } = makeEngineWithPipelineStore();
		const workItem = makeWorkItem('adv-1', makePipeline('runner'));

		const updated = await engine.advancePipeline(workItem, 'runner-done');
		expect(updated).not.toBeNull();
		expect(updated?.pipeline?.currentRole).toBe('reviewer');
		expect(getStoredPipeline()?.currentRole).toBe('reviewer');
	});

	test('advancePipeline review-approve → merger, then terminal', async () => {
		const { engine } = makeEngineWithPipelineStore();

		const afterRunner = makeWorkItem('adv-2', makePipeline('reviewer', ['runner']));
		const afterReview = await engine.advancePipeline(afterRunner, 'review-approve');
		expect(afterReview?.pipeline?.currentRole).toBe('merger');

		const afterMerger = makeWorkItem('adv-3', afterReview!.pipeline!);
		const terminal = await engine.advancePipeline(afterMerger, 'merger-done');
		expect(engine.isPipelineTerminal(terminal!)).toBe(true);
	});

	test('advancePipeline returns null for non-pipeline work item', async () => {
		const { engine } = makeEngineWithPipelineStore();
		const workItem = makeWorkItem('adv-4'); // no pipeline
		const result = await engine.advancePipeline(workItem, 'runner-done');
		expect(result).toBeNull();
	});

	test('advancePipeline reject branch: review-reject → fixer → reviewer', async () => {
		const { engine } = makeEngineWithPipelineStore();

		const reviewStage = makeWorkItem('adv-5', makePipeline('reviewer', ['runner']));
		const afterReject = await engine.advancePipeline(reviewStage, 'review-reject');
		expect(afterReject?.pipeline?.currentRole).toBe('fixer');

		const fixerStage = makeWorkItem('adv-6', afterReject!.pipeline!);
		const afterFix = await engine.advancePipeline(fixerStage, 'fixer-done');
		expect(afterFix?.pipeline?.currentRole).toBe('reviewer');
	});
});
