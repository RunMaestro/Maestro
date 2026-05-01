/**
 * tasks-agent-ready-trigger.ts
 *
 * Concrete trigger handler that fires when a work item transitions
 * `epic-decomposed → tasks-decomposed` inside the Planning Pipeline.
 *
 * Responsibility: walk every task child of the epic and tag each unblocked task
 * with `WORK_GRAPH_READY_TAG` ('agent-ready'), making them eligible for agent
 * auto-pickup via the Agent Dispatch queue.
 *
 * A task is considered **unblocked** when it has no `WorkItemDependency` entries
 * whose blocking item's status is not 'done'.  Tasks that still have active
 * blockers are skipped — they will be unblocked by the task-completed trigger
 * (a later pipeline step) once their blocking tasks close.
 *
 * Errors are logged and swallowed — the registry already isolates handler
 * failures; this is belt-and-suspenders.
 *
 * @see src/main/planning-pipeline/trigger-registry.ts  — registry contract
 * @see src/shared/work-graph-types.ts                  — WorkItem, WORK_GRAPH_READY_TAG
 * @see src/shared/planning-pipeline-types.ts           — PipelineStageEvent
 */

import { logger } from '../../utils/logger';
import { WORK_GRAPH_READY_TAG } from '../../../shared/work-graph-types';
import type { WorkItem } from '../../../shared/work-graph-types';
import type { PipelineTriggerRegistry, TriggerHandler } from '../trigger-registry';
import type { PipelineStageEvent } from '../../../shared/planning-pipeline-types';

// ---------------------------------------------------------------------------
// Dependency interface — narrow and stub-able in tests
// ---------------------------------------------------------------------------

/**
 * Minimal Work Graph store surface required by this trigger.
 *
 * Decoupled from `WorkGraphStorage` so the trigger can be tested without a
 * real DB and wired to any backing store that satisfies this shape.
 */
export interface TasksAgentReadyTriggerDeps {
	workGraphStore: {
		/**
		 * Returns all direct children of `parentId`.
		 * Implementors may back this with `listItems({ parentWorkItemId })` if the
		 * storage layer supports it, or by listing and filtering in-process.
		 */
		listChildrenOf(parentId: string): Promise<WorkItem[]>;
		/**
		 * Returns the work item with the given `id`, or `null` if not found.
		 */
		getItem(id: string): Promise<WorkItem | null>;
		/**
		 * Merges `tags` into the item's existing tag set.
		 * Implementors may back this with `updateItem({ patch: { tags: [...] } })`.
		 */
		addTags(id: string, tags: string[]): Promise<void>;
	};
}

// ---------------------------------------------------------------------------
// Helper — unblocked predicate
// ---------------------------------------------------------------------------

/**
 * Returns `true` when the task has no dependency that is still blocking it.
 *
 * A dependency blocks when:
 *   - Its `type` is 'blocks' (directional blocker) OR the type is absent/any
 *     (we consider all active edges as potential blockers for safety), AND
 *   - Its `status` on the blocker item is NOT 'done'.
 *
 * Because the dep interface exposes `getItem` rather than a join, we resolve
 * each blocking item individually.  For typical decomposed epic sizes (≤ 20
 * tasks each with ≤ 5 deps) this is perfectly acceptable.
 *
 * @internal
 */
async function isTaskUnblocked(
	task: WorkItem,
	getItem: TasksAgentReadyTriggerDeps['workGraphStore']['getItem']
): Promise<boolean> {
	const deps = task.dependencies;
	if (!deps || deps.length === 0) {
		return true;
	}

	for (const dep of deps) {
		// Only 'active' dependency edges represent real blockers.
		if (dep.status !== 'active') {
			continue;
		}

		const blocker = await getItem(dep.toWorkItemId);
		// If we can't resolve the blocker, treat it as a live blocker to be safe.
		if (!blocker) {
			return false;
		}
		if (blocker.status !== 'done') {
			return false;
		}
	}

	return true;
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

/**
 * Creates the `epic-decomposed → tasks-decomposed` trigger handler.
 *
 * The handler is a no-op for any other `(fromStage, toStage)` pair — this
 * guard is belt-and-suspenders because the registry only calls handlers
 * registered under the matching key.
 */
export function createTasksAgentReadyTrigger(deps: TasksAgentReadyTriggerDeps): TriggerHandler {
	const { workGraphStore } = deps;

	return async function tasksAgentReadyTriggerHandler(event: PipelineStageEvent): Promise<void> {
		// Guard: only act on the exact transition this handler was built for.
		if (event.fromStage !== 'epic-decomposed' || event.toStage !== 'tasks-decomposed') {
			return;
		}

		try {
			const children = await workGraphStore.listChildrenOf(event.workItemId);

			// Restrict to items that are actually tasks (not nested epics, documents, etc.)
			const tasks = children.filter((item) => item.type === 'task');

			for (const task of tasks) {
				try {
					const unblocked = await isTaskUnblocked(
						task,
						workGraphStore.getItem.bind(workGraphStore)
					);
					if (!unblocked) {
						continue;
					}

					// Idempotent: skip if the tag is already present.
					if (task.tags.includes(WORK_GRAPH_READY_TAG)) {
						continue;
					}

					await workGraphStore.addTags(task.id, [WORK_GRAPH_READY_TAG]);

					logger.info(`tasksAgentReadyTrigger: tagged task as agent-ready`, 'PipelineTrigger', {
						taskId: task.id,
						epicId: event.workItemId,
					});
				} catch (taskErr) {
					// Per-task errors are isolated — remaining tasks still get processed.
					logger.error('tasksAgentReadyTrigger: error tagging task — skipping', 'PipelineTrigger', {
						error: taskErr instanceof Error ? taskErr.message : String(taskErr),
						taskId: task.id,
						epicId: event.workItemId,
					});
				}
			}
		} catch (err) {
			// Top-level error (e.g. listChildrenOf failed) — log and swallow.
			logger.error(
				'tasksAgentReadyTrigger: failed to process epic children — no tasks tagged',
				'PipelineTrigger',
				{
					error: err instanceof Error ? err.message : String(err),
					workItemId: event.workItemId,
					fromStage: event.fromStage,
					toStage: event.toStage,
				}
			);
		}
	};
}

// ---------------------------------------------------------------------------
// Registration helper
// ---------------------------------------------------------------------------

/**
 * Registers the `epic-decomposed → tasks-decomposed` trigger on `registry`.
 *
 * Intended to be called once during application startup (or test setup).
 * The registry does not deduplicate handlers, so calling this more than once
 * will register the handler multiple times — callers are responsible for
 * ensuring single-call semantics at the wiring layer.
 */
export function registerTasksAgentReadyTrigger(
	registry: PipelineTriggerRegistry,
	deps: TasksAgentReadyTriggerDeps
): void {
	registry.register('epic-decomposed', 'tasks-decomposed', createTasksAgentReadyTrigger(deps));
}
