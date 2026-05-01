/**
 * GitHub Project v2 Reverse-Sync Poller (#435).
 *
 * Runs on a configurable interval (default: 1 hour). For every work item that
 * has a linked GitHub Project v2 item (`github.projectItemId`), it reads the
 * current field values from GitHub, diffs them against local state, and applies
 * any changes that were made by humans directly on the GitHub board.
 *
 * Fields tracked: Status, Role
 * (Maestro Major / Work Item Type / Parent Work Item / External Mirror ID /
 * Agent Pickup / Stage / Priority are write-only from Maestro — not reverse-synced.)
 *
 * On each detected diff the poller:
 *   1. Updates the work item via `workGraph.updateItem()`
 *   2. Records a `status_changed` or `updated` event with actor `github-poller`
 *   3. Logs the change at info level
 *
 * The poller is started once after setupIpcHandlers() in main/index.ts and
 * remains active for the lifetime of the app. Stop it via the returned handle.
 *
 * Design notes:
 *   - Uses `gh project item-list --format json` to read all project items in
 *     one call, keyed by `content.url`, then matches against local items using
 *     `github.issueNumber` extracted from the URL.
 *   - GraphQL `projectItems(first: 100)` would be more precise but requires a
 *     PAT with `project` scope; `gh project item-list` works with the default
 *     `gh` credential that the rest of the sync already uses.
 *   - If `gh` is not authenticated or the project cannot be read, the error is
 *     caught and logged — the poller retries on the next interval.
 */

import { execFileNoThrow } from '../utils/execFile';
import { getWorkGraphItemStore } from '../work-graph';
import { logger } from '../utils/logger';
import {
	DELIVERY_PLANNER_GITHUB_PROJECT_NUMBER,
	DELIVERY_PLANNER_GITHUB_PROJECT_OWNER,
} from '../delivery-planner/github-sync';
import type { WorkItem, WorkItemStatus, WorkItemPipelineRole } from '../../shared/work-graph-types';

const LOG_CONTEXT = '[GhProjectPoller]';

// ---------------------------------------------------------------------------
// GitHub response shapes
// ---------------------------------------------------------------------------

interface GhProjectItemFieldValue {
	text?: string;
	name?: string; // single-select option name
	date?: string;
}

interface GhProjectItemContent {
	url?: string;
	number?: number;
}

interface GhProjectItem {
	id: string;
	content?: GhProjectItemContent;
	/** Keyed by field name */
	fieldValues?: Record<string, GhProjectItemFieldValue | undefined>;
	/** Some versions return a flat top-level key per field */
	[key: string]: unknown;
}

interface GhProjectItemListResult {
	items?: GhProjectItem[];
}

// ---------------------------------------------------------------------------
// Field → WorkItem mappings (inverse of github-sync.ts helpers)
// ---------------------------------------------------------------------------

/**
 * Maps the GitHub Projects v2 "Status" single-select option name to a
 * WorkItemStatus. Returns `undefined` when the value is not recognised —
 * unrecognised values are skipped rather than applied.
 */
function githubStatusToWorkItemStatus(value: string): WorkItemStatus | undefined {
	const map: Record<string, WorkItemStatus> = {
		Idea: 'discovered',
		'PRD Draft': 'planned',
		Refinement: 'planned',
		'Tasks Ready': 'ready',
		'In Progress': 'in_progress',
		'In Review': 'review',
		Blocked: 'blocked',
		Done: 'done',
	};
	return map[value];
}

/**
 * Maps the GitHub Projects v2 "Role" single-select option name to a
 * WorkItemPipelineRole. Returns `undefined` when the value is not recognised.
 */
function githubRoleToWorkItemRole(value: string): WorkItemPipelineRole | undefined {
	const validRoles: WorkItemPipelineRole[] = ['runner', 'fixer', 'reviewer', 'merger'];
	return validRoles.includes(value as WorkItemPipelineRole)
		? (value as WorkItemPipelineRole)
		: undefined;
}

// ---------------------------------------------------------------------------
// Poller options and start function
// ---------------------------------------------------------------------------

export interface GhProjectPollerOptions {
	/** How often to run the poll. Default: 60 minutes. */
	intervalMs?: number;
	/** If true, run an initial poll immediately on start. Default: false. */
	runImmediately?: boolean;
}

/**
 * Start the GitHub Project v2 reverse-sync poller.
 *
 * Returns the interval handle so the caller can clear it on app shutdown.
 */
export function startGhProjectPoller(opts: GhProjectPollerOptions = {}): NodeJS.Timeout {
	const intervalMs = opts.intervalMs ?? 60 * 60 * 1000; // 1 hour

	logger.info(`GitHub Project reverse-sync poller started (intervalMs=${intervalMs})`, LOG_CONTEXT);

	if (opts.runImmediately) {
		runPoll().catch((err) => {
			logger.warn(
				`GitHub Project reverse-sync poll error (immediate): ${err instanceof Error ? err.message : String(err)}`,
				LOG_CONTEXT
			);
		});
	}

	const handle = setInterval(() => {
		runPoll().catch((err) => {
			logger.warn(
				`GitHub Project reverse-sync poll error: ${err instanceof Error ? err.message : String(err)}`,
				LOG_CONTEXT
			);
		});
	}, intervalMs);

	// Don't block Node from exiting if the poller is the last thing alive.
	if (handle.unref) handle.unref();

	return handle;
}

// ---------------------------------------------------------------------------
// Core poll logic
// ---------------------------------------------------------------------------

async function runPoll(): Promise<void> {
	const workGraph = getWorkGraphItemStore();

	// Fetch all work items that have a project item ID linked.
	const { items: allItems } = await workGraph.listItems({
		githubRepository: 'HumpfTech/Maestro',
		statuses: [
			'discovered',
			'planned',
			'ready',
			'claimed',
			'in_progress',
			'blocked',
			'review',
			'done',
			'canceled',
			'archived',
		],
	});

	const linkedItems = allItems.filter((item) => item.github?.projectItemId);

	if (linkedItems.length === 0) {
		logger.info(
			'GitHub Project reverse-sync: no linked project items — skipping poll',
			LOG_CONTEXT
		);
		return;
	}

	logger.info(
		`GitHub Project reverse-sync: polling ${linkedItems.length} linked item(s)`,
		LOG_CONTEXT
	);

	// Read all project items from GitHub in one call.
	const ghItems = await fetchProjectItems();

	if (ghItems.length === 0) {
		logger.info('GitHub Project reverse-sync: project returned 0 items — skipping', LOG_CONTEXT);
		return;
	}

	// Build a lookup map: projectItemId → GhProjectItem
	const ghItemById = new Map<string, GhProjectItem>();
	for (const ghItem of ghItems) {
		ghItemById.set(ghItem.id, ghItem);
	}

	let changed = 0;
	let skipped = 0;

	for (const item of linkedItems) {
		const ghItem = item.github?.projectItemId
			? ghItemById.get(item.github.projectItemId)
			: undefined;

		if (!ghItem) {
			skipped++;
			continue;
		}

		const didChange = await applyFieldDiff(item, ghItem);
		if (didChange) changed++;
	}

	logger.info(
		`GitHub Project reverse-sync: poll complete — changed=${changed}, skipped=${skipped}`,
		LOG_CONTEXT
	);
}

// ---------------------------------------------------------------------------
// GitHub API helpers
// ---------------------------------------------------------------------------

async function fetchProjectItems(): Promise<GhProjectItem[]> {
	const result = await execFileNoThrow('gh', [
		'project',
		'item-list',
		String(DELIVERY_PLANNER_GITHUB_PROJECT_NUMBER),
		'--owner',
		DELIVERY_PLANNER_GITHUB_PROJECT_OWNER,
		'--format',
		'json',
		'--limit',
		'500',
	]);

	if (result.exitCode !== 0) {
		throw new Error(`gh project item-list failed: ${result.stderr.trim() || 'unknown error'}`);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(result.stdout);
	} catch {
		throw new Error('gh project item-list returned invalid JSON');
	}

	// `gh project item-list --format json` returns `{ "items": [...] }`
	if (
		parsed &&
		typeof parsed === 'object' &&
		Array.isArray((parsed as GhProjectItemListResult).items)
	) {
		return (parsed as GhProjectItemListResult).items ?? [];
	}

	// Some versions return an array directly.
	if (Array.isArray(parsed)) {
		return parsed as GhProjectItem[];
	}

	return [];
}

/**
 * Extract the value of a named field from a GhProjectItem.
 *
 * `gh project item-list --format json` returns field values under
 * `fieldValues.<fieldName>.name` (for single-select) or
 * `fieldValues.<fieldName>.text` (for text fields).
 *
 * Older versions of the `gh` CLI may flatten field values directly onto the
 * item object, so we fall back to a top-level key lookup.
 */
function getFieldValue(ghItem: GhProjectItem, fieldName: string): string | undefined {
	const fv = ghItem.fieldValues;
	if (fv && typeof fv === 'object') {
		const entry = fv[fieldName];
		if (entry) {
			return entry.name ?? entry.text;
		}
	}

	// Fallback: top-level key (older gh CLI format)
	const topLevel = ghItem[fieldName];
	if (typeof topLevel === 'string') return topLevel;
	if (topLevel && typeof topLevel === 'object') {
		const obj = topLevel as GhProjectItemFieldValue;
		return obj.name ?? obj.text;
	}

	return undefined;
}

// ---------------------------------------------------------------------------
// Diff and apply
// ---------------------------------------------------------------------------

/**
 * Compare the GitHub field values against the local work item and apply any
 * differences. Returns true if the item was updated.
 */
async function applyFieldDiff(item: WorkItem, ghItem: GhProjectItem): Promise<boolean> {
	const workGraph = getWorkGraphItemStore();
	let updated = false;

	// --- Status field ---
	const ghStatusRaw = getFieldValue(ghItem, 'Status');
	if (ghStatusRaw) {
		const ghStatus = githubStatusToWorkItemStatus(ghStatusRaw);
		if (ghStatus && ghStatus !== item.status) {
			const before = { status: item.status };
			const after = { status: ghStatus };

			await workGraph.updateItem({
				id: item.id,
				patch: { status: ghStatus },
				actor: { type: 'github', id: 'github-poller', name: 'GitHub Project Poller' },
			});

			await workGraph.recordEvent({
				workItemId: item.id,
				type: 'status_changed',
				actor: { type: 'github', id: 'github-poller', name: 'GitHub Project Poller' },
				before,
				after,
				message: `Reverse-synced from GitHub Project: Status changed from "${item.status}" to "${ghStatus}" (projectItemId=${item.github?.projectItemId})`,
			});

			logger.info(
				`Reverse-sync applied: workItem=${item.id} status ${item.status} → ${ghStatus} (actor=github-poller)`,
				LOG_CONTEXT
			);

			updated = true;
		}
	}

	// --- Role field ---
	// The `pipeline` field is not in WorkItemPatch, so we mirror the GitHub role
	// into `github.projectFields.agentPickup` and record the event in the audit
	// log.  The dispatch engine reads `pipeline.currentRole` (set by Maestro) —
	// we intentionally do not override that here; the reverse-sync records
	// *observed* GitHub state for visibility only.
	const ghRoleRaw = getFieldValue(ghItem, 'Role');
	if (ghRoleRaw) {
		const ghRole = githubRoleToWorkItemRole(ghRoleRaw);
		const currentRole = item.pipeline?.currentRole;
		if (ghRole && ghRole !== currentRole) {
			// Patch the github.projectFields.agentPickup field with the observed role
			// as an audit trail without overwriting dispatch-controlled pipeline state.
			const updatedGithub = {
				...item.github,
				projectFields: {
					...(item.github?.projectFields ?? {}),
					agentPickup: ghRole,
				},
			} as typeof item.github;

			const before = { github: item.github };
			const after = { github: updatedGithub };

			await workGraph.updateItem({
				id: item.id,
				patch: { github: updatedGithub },
				actor: { type: 'github', id: 'github-poller', name: 'GitHub Project Poller' },
			});

			await workGraph.recordEvent({
				workItemId: item.id,
				type: 'updated',
				actor: { type: 'github', id: 'github-poller', name: 'GitHub Project Poller' },
				before,
				after,
				message: `Reverse-synced from GitHub Project: Role observed as "${ghRole}" on GitHub (was "${currentRole ?? 'none'}") — recorded in projectFields.agentPickup (projectItemId=${item.github?.projectItemId})`,
			});

			logger.info(
				`Reverse-sync applied: workItem=${item.id} observed GitHub role ${currentRole ?? 'none'} → ${ghRole} (actor=github-poller)`,
				LOG_CONTEXT
			);

			updated = true;
		}
	}

	return updated;
}
