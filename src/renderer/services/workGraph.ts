/**
 * Work Graph renderer service — STUBBED (#444)
 *
 * The local work-graph SQLite DB and workGraph IPC namespace have been
 * removed in #444 (GitHub-as-truth refactor). This file is kept to avoid
 * breaking delivery-planner, kanban board, and other callers that still
 * reference workGraphService. Those callers will be migrated to GitHub-direct
 * queries in follow-up issues.
 *
 * All methods return empty results or no-ops so callers degrade gracefully
 * rather than crashing at runtime.
 *
 * TODO(#444-follow-up): remove this file once all callers are migrated.
 */

import type { WorkGraphListResult, WorkItem, WorkItemFilters } from '../../shared/work-graph-types';

const EMPTY_LIST: WorkGraphListResult = { items: [], total: 0 };

export const workGraphService = {
	listItems: (_filters?: WorkItemFilters): Promise<WorkGraphListResult> =>
		Promise.resolve(EMPTY_LIST),

	searchItems: (_filters: unknown): Promise<WorkGraphListResult> => Promise.resolve(EMPTY_LIST),

	getItem: (_id: string): Promise<WorkItem | undefined> => Promise.resolve(undefined),

	createItem: (_input: unknown): Promise<WorkItem> =>
		Promise.reject(new Error('workGraph removed (#444) — use GitHub directly')),

	updateItem: (_input: unknown): Promise<WorkItem> =>
		Promise.reject(new Error('workGraph removed (#444) — use GitHub directly')),

	deleteItem: (_id: string): Promise<boolean> =>
		Promise.reject(new Error('workGraph removed (#444) — use GitHub directly')),

	claimItem: (_input: unknown): Promise<unknown> =>
		Promise.reject(new Error('workGraph removed (#444) — use GitHub directly')),

	renewClaim: (_input: unknown): Promise<unknown> =>
		Promise.reject(new Error('workGraph removed (#444) — use GitHub directly')),

	releaseClaim: (_input: unknown): Promise<unknown> =>
		Promise.reject(new Error('workGraph removed (#444) — use GitHub directly')),

	completeClaim: (_input: unknown): Promise<unknown> =>
		Promise.reject(new Error('workGraph removed (#444) — use GitHub directly')),

	listEvents: (_workItemId: string): Promise<unknown[]> => Promise.resolve([]),

	listTags: (): Promise<unknown[]> => Promise.resolve([]),

	upsertTag: (_definition: unknown): Promise<unknown> =>
		Promise.reject(new Error('workGraph removed (#444) — use GitHub directly')),

	importItems: (_input: unknown): Promise<unknown> =>
		Promise.reject(new Error('workGraph removed (#444) — use GitHub directly')),

	getUnblockedAgentReadyWork: (_filters?: unknown): Promise<WorkGraphListResult> =>
		Promise.resolve(EMPTY_LIST),

	/** No-op: workGraph:changed events are gone (#444). Returns empty unsubscribe. */
	onChanged:
		(_handler: (event: unknown) => void): (() => void) =>
		() =>
			undefined,
};
