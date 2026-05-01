/**
 * PM Orchestrator — `/PM` slash-command backend (#428 + #436)
 *
 * Registers all `pm:*` IPC channels consumed by the renderer when the user
 * types `/PM ...` in the chat input.
 *
 * Architecture
 * ------------
 * All commands live under the `pm:` IPC namespace. The renderer dispatches
 * the right channel based on the slash command verb
 * (see src/renderer/hooks/input/useInputProcessing.ts).
 *
 * Channels (#428)
 * ---------------
 *   pm:orchestrate   — /PM <idea>        seed Conv-PRD planning prompt
 *   pm:prd-new       — /PM prd-new       open Conv-PRD modal (new session)
 *   pm:prd-list      — /PM prd-list      list PRDs from Work Graph
 *   pm:next          — /PM next          next unblocked ready work item
 *   pm:status        — /PM status        board snapshot (rich Work Graph)
 *   pm:standup       — /PM standup       rich standup (yesterday/today/blockers)
 *
 * Channels (#436)
 * ---------------
 *   pm:prd-edit      — /PM prd-edit <id>          open Conv-PRD in edit mode
 *   pm:prd-status    — /PM prd-status <id>         quick PRD status lookup
 *   pm:prd-parse     — /PM prd-parse <id>          convert PRD to planner input
 *   pm:epic-decompose— /PM epic-decompose <prd-id> decompose PRD → epic+tasks
 *   pm:epic-edit     — /PM epic-edit <id>          open Delivery Planner edit mode
 *   pm:epic-list     — /PM epic-list               table of all epics
 *   pm:epic-show     — /PM epic-show <id>          full epic detail + tasks
 *   pm:epic-sync     — /PM epic-sync <id>          GitHub sync via Delivery Planner
 *   pm:epic-start    — /PM epic-start <id>         kick Planning Pipeline
 *   pm:issue-start   — /PM issue-start <task-id>   manual claim → Agent Dispatch
 *   pm:issue-show    — /PM issue-show <task-id>    full task detail
 *   pm:issue-status  — /PM issue-status <task-id>  quick task status
 *   pm:issue-sync    — /PM issue-sync <task-id>    GitHub roundtrip for a task
 *
 * Feature gate
 * ------------
 * All channels are gated by the `pmSuite` encore feature flag.
 */

import { ipcMain, BrowserWindow } from 'electron';
import { logger } from './utils/logger';
import { getWorkGraphItemStore } from './work-graph';
import type { WorkItemStatus } from '../shared/work-graph-types';

const LOG_CONTEXT = '[PMOrchestrator]';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PmOrchestratorDependencies {
	/** Getter for the main BrowserWindow (may be null before window creation) */
	getMainWindow: () => BrowserWindow | null;
	/** Settings store (electron-store instance) — used to gate pmSuite feature */
	settingsStore: { get(key: string, defaultValue?: unknown): unknown };
}

export interface PmCommandRequest {
	/** Arguments after the command verb, e.g. the idea text or PRD name */
	args?: string;
	/** Project path for the current session */
	projectPath?: string;
	/** Git path for the current session */
	gitPath?: string;
	actor?: { sessionId?: string; name?: string };
}

export interface PmCommandResponse {
	success: boolean;
	/** Human-readable markdown body echoed into the session chat window */
	message?: string;
	/** Structured data for richer renderer rendering */
	data?: unknown;
	error?: string;
	code?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ok(message: string, data?: unknown): PmCommandResponse {
	return { success: true, message, data };
}

function err(message: string, code = 'PM_ERROR'): PmCommandResponse {
	return { success: false, error: message, code };
}

/** Returns a structured gate-disabled response when pmSuite feature is off. */
function checkGate(
	settingsStore: PmOrchestratorDependencies['settingsStore']
): PmCommandResponse | null {
	const encoreFeatures = settingsStore.get('encoreFeatures', {}) as Record<string, boolean>;
	if (!encoreFeatures.pmSuite) {
		return { success: false, code: 'FEATURE_DISABLED', error: 'pmSuite feature is disabled' };
	}
	return null;
}

/** Emit a push event to the renderer to open a modal or seed the chat. */
function pushEvent(deps: PmOrchestratorDependencies, channel: string, payload: unknown): void {
	const mainWindow = deps.getMainWindow();
	if (mainWindow && !mainWindow.isDestroyed()) {
		mainWindow.webContents.send(channel, payload);
	}
}

/** Format ISO date as YYYY-MM-DD */
function toDateStr(iso: string): string {
	return iso.split('T')[0] ?? iso;
}

/** Return yesterday midnight UTC as an ISO string */
function yesterdayIso(): string {
	const d = new Date();
	d.setUTCDate(d.getUTCDate() - 1);
	d.setUTCHours(0, 0, 0, 0);
	return d.toISOString();
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerPmOrchestratorHandlers(deps: PmOrchestratorDependencies): void {
	const workGraph = getWorkGraphItemStore();

	// -----------------------------------------------------------------------
	// pm:orchestrate  (/PM <idea>)
	// -----------------------------------------------------------------------
	ipcMain.handle('pm:orchestrate', (_event, req: PmCommandRequest): PmCommandResponse => {
		const gateError = checkGate(deps.settingsStore);
		if (gateError) return gateError;

		const idea = req.args?.trim();
		if (!idea) {
			return err('Please provide an idea: `/PM <your idea>`');
		}

		logger.info('PM orchestrate: seeding planning prompt', LOG_CONTEXT, {
			idea: idea.substring(0, 80),
		});

		pushEvent(deps, 'pm:openPlanningPrompt', {
			mode: 'orchestrate',
			idea,
			projectPath: req.projectPath,
			gitPath: req.gitPath,
		});

		return ok(
			[
				`**Starting PM planning for: ${idea}**`,
				'',
				'The PM orchestrator will guide you through:',
				'1. Defining the problem and user need',
				'2. Clarifying scope and success criteria',
				'3. Breaking the idea into an epic and tasks',
				'',
				'_Tip: When the draft looks complete, type `/PM prd-new <name>` to save it as a PRD._',
			].join('\n'),
			{ idea }
		);
	});

	// -----------------------------------------------------------------------
	// pm:prd-new  (/PM prd-new <name>)
	// -----------------------------------------------------------------------
	ipcMain.handle('pm:prd-new', (_event, req: PmCommandRequest): PmCommandResponse => {
		const gateError = checkGate(deps.settingsStore);
		if (gateError) return gateError;

		const name = req.args?.trim();
		if (!name) {
			return err('Please provide a PRD name: `/PM prd-new <name>`');
		}

		pushEvent(deps, 'pm:openConvPrd', { mode: 'new', seed: name, projectPath: req.projectPath });

		return ok(
			`**Opening PRD planner for: ${name}**\n\nDescribe the feature in the chat above. I'll ask clarifying questions to fill in the spec.`
		);
	});

	// -----------------------------------------------------------------------
	// pm:prd-edit  (/PM prd-edit <id>)  — #436
	// -----------------------------------------------------------------------
	ipcMain.handle(
		'pm:prd-edit',
		async (_event, req: PmCommandRequest): Promise<PmCommandResponse> => {
			const gateError = checkGate(deps.settingsStore);
			if (gateError) return gateError;

			const id = req.args?.trim();
			if (!id) return err('Please provide a PRD ID: `/PM prd-edit <id>`');

			try {
				const item = await workGraph.getItem(id);
				if (!item) return err(`PRD not found: ${id}`, 'NOT_FOUND');

				pushEvent(deps, 'pm:openConvPrd', {
					mode: 'edit',
					prdId: id,
					seed: item.title,
					projectPath: req.projectPath,
				});

				return ok(`**Editing PRD:** ${item.title} (\`${id}\`)`);
			} catch (e) {
				return err(String(e));
			}
		}
	);

	// -----------------------------------------------------------------------
	// pm:prd-status  (/PM prd-status <id>)  — #436
	// -----------------------------------------------------------------------
	ipcMain.handle(
		'pm:prd-status',
		async (_event, req: PmCommandRequest): Promise<PmCommandResponse> => {
			const gateError = checkGate(deps.settingsStore);
			if (gateError) return gateError;

			const id = req.args?.trim();
			if (!id) return err('Please provide a PRD ID: `/PM prd-status <id>`');

			try {
				const item = await workGraph.getItem(id);
				if (!item) return err(`PRD not found: ${id}`, 'NOT_FOUND');

				const lines = [
					`## PRD Status: ${item.title}`,
					'',
					`| Field   | Value |`,
					`|---------|-------|`,
					`| ID      | \`${item.id}\` |`,
					`| Status  | **${item.status}** |`,
					`| Source  | ${item.source ?? '—'} |`,
					`| Created | ${toDateStr(item.createdAt)} |`,
					`| Updated | ${toDateStr(item.updatedAt)} |`,
				];
				if (item.description) {
					lines.push('', '**Description**', item.description.substring(0, 300));
				}
				return ok(lines.join('\n'), { item });
			} catch (e) {
				return err(String(e));
			}
		}
	);

	// -----------------------------------------------------------------------
	// pm:prd-parse  (/PM prd-parse <id>)  — #436
	// -----------------------------------------------------------------------
	ipcMain.handle(
		'pm:prd-parse',
		async (_event, req: PmCommandRequest): Promise<PmCommandResponse> => {
			const gateError = checkGate(deps.settingsStore);
			if (gateError) return gateError;

			const id = req.args?.trim();
			if (!id) return err('Please provide a PRD ID: `/PM prd-parse <id>`');

			try {
				const item = await workGraph.getItem(id);
				if (!item) return err(`PRD not found: ${id}`, 'NOT_FOUND');

				pushEvent(deps, 'pm:openDeliveryPlanner', {
					mode: 'decompose-prd',
					prdId: id,
					projectPath: req.projectPath,
				});

				return ok(
					[
						`**Parsing PRD into structured planner input: ${item.title}**`,
						'',
						'The Delivery Planner is opening with this PRD pre-loaded.',
						`Use \`/PM epic-decompose ${id}\` to kick off full decomposition.`,
					].join('\n'),
					{ prdId: id, title: item.title }
				);
			} catch (e) {
				return err(String(e));
			}
		}
	);

	// -----------------------------------------------------------------------
	// pm:prd-list  (/PM prd-list)
	// -----------------------------------------------------------------------
	ipcMain.handle(
		'pm:prd-list',
		async (_event, _req: PmCommandRequest): Promise<PmCommandResponse> => {
			const gateError = checkGate(deps.settingsStore);
			if (gateError) return gateError;

			try {
				const result = await workGraph.listItems({ source: ['delivery-planner'] });
				const prds = result.items.filter(
					(it) => it.tags?.some((t) => t === 'prd') || it.type === 'document'
				);

				if (prds.length === 0) {
					return ok('**No PRDs found** for this project.\n\nStart one with `/PM prd-new <name>`.');
				}

				const rows = prds
					.map(
						(it) => `| \`${it.id}\` | ${it.title} | **${it.status}** | ${toDateStr(it.updatedAt)} |`
					)
					.join('\n');

				return ok(
					[
						'## PRDs',
						'',
						'| ID | Title | Status | Updated |',
						'|----|-------|--------|---------|',
						rows,
					].join('\n'),
					{ prds }
				);
			} catch (e) {
				return err(String(e));
			}
		}
	);

	// -----------------------------------------------------------------------
	// pm:epic-decompose  (/PM epic-decompose <prd-id>)  — #436
	// -----------------------------------------------------------------------
	ipcMain.handle(
		'pm:epic-decompose',
		async (_event, req: PmCommandRequest): Promise<PmCommandResponse> => {
			const gateError = checkGate(deps.settingsStore);
			if (gateError) return gateError;

			const prdId = req.args?.trim();
			if (!prdId) return err('Please provide a PRD ID: `/PM epic-decompose <prd-id>`');

			pushEvent(deps, 'pm:openDeliveryPlanner', {
				mode: 'decompose-prd',
				prdId,
				projectPath: req.projectPath,
			});

			return ok(
				[
					`**Decomposing PRD ${prdId} into Epic + Tasks**`,
					'',
					'The Delivery Planner is opening to run the decomposition.',
					'Once complete, use `/PM epic-list` to see the new epic.',
				].join('\n'),
				{ prdId }
			);
		}
	);

	// -----------------------------------------------------------------------
	// pm:epic-edit  (/PM epic-edit <id>)  — #436
	// -----------------------------------------------------------------------
	ipcMain.handle(
		'pm:epic-edit',
		async (_event, req: PmCommandRequest): Promise<PmCommandResponse> => {
			const gateError = checkGate(deps.settingsStore);
			if (gateError) return gateError;

			const id = req.args?.trim();
			if (!id) return err('Please provide an epic ID: `/PM epic-edit <id>`');

			try {
				const item = await workGraph.getItem(id);
				if (!item) return err(`Epic not found: ${id}`, 'NOT_FOUND');

				pushEvent(deps, 'pm:openDeliveryPlanner', {
					mode: 'edit-epic',
					epicId: id,
					projectPath: req.projectPath,
				});

				return ok(`**Editing epic:** ${item.title} (\`${id}\`)`);
			} catch (e) {
				return err(String(e));
			}
		}
	);

	// -----------------------------------------------------------------------
	// pm:epic-list  (/PM epic-list)  — #436
	// -----------------------------------------------------------------------
	ipcMain.handle(
		'pm:epic-list',
		async (_event, _req: PmCommandRequest): Promise<PmCommandResponse> => {
			const gateError = checkGate(deps.settingsStore);
			if (gateError) return gateError;

			try {
				const result = await workGraph.listItems({ tags: ['epic'] });
				const epics = result.items;

				if (epics.length === 0) {
					return ok('**No epics found.**\n\nStart one with `/PM epic-decompose <prd-id>`.');
				}

				const rows = epics
					.map((it) => {
						const numChildren = ((it.metadata?.childIds ?? []) as string[]).length;
						return `| \`${it.id}\` | ${it.title} | **${it.status}** | ${numChildren} tasks | ${toDateStr(it.updatedAt)} |`;
					})
					.join('\n');

				return ok(
					[
						'## Epics',
						'',
						'| ID | Title | Status | Tasks | Updated |',
						'|----|-------|--------|-------|---------|',
						rows,
					].join('\n'),
					{ epics }
				);
			} catch (e) {
				return err(String(e));
			}
		}
	);

	// -----------------------------------------------------------------------
	// pm:epic-show  (/PM epic-show <id>)  — #436
	// -----------------------------------------------------------------------
	ipcMain.handle(
		'pm:epic-show',
		async (_event, req: PmCommandRequest): Promise<PmCommandResponse> => {
			const gateError = checkGate(deps.settingsStore);
			if (gateError) return gateError;

			const id = req.args?.trim();
			if (!id) return err('Please provide an epic ID: `/PM epic-show <id>`');

			try {
				const epic = await workGraph.getItem(id);
				if (!epic) return err(`Epic not found: ${id}`, 'NOT_FOUND');

				const lines = [
					`## Epic: ${epic.title}`,
					'',
					`| Field   | Value |`,
					`|---------|-------|`,
					`| ID      | \`${epic.id}\` |`,
					`| Status  | **${epic.status}** |`,
					`| Source  | ${epic.source ?? '—'} |`,
					`| Created | ${toDateStr(epic.createdAt)} |`,
					`| Updated | ${toDateStr(epic.updatedAt)} |`,
				];

				if (epic.description) {
					lines.push('', '**Description**', epic.description.substring(0, 500));
				}

				const childIds = (epic.metadata?.childIds ?? []) as string[];
				if (childIds.length > 0) {
					const taskResults = await Promise.all(
						childIds.slice(0, 20).map((cid) => workGraph.getItem(cid).catch(() => null))
					);
					const tasks = taskResults.filter(Boolean);
					if (tasks.length > 0) {
						lines.push('', `### Tasks (${tasks.length})`);
						for (const t of tasks) {
							if (t) {
								lines.push(
									`- [${t.status === 'done' ? 'x' : ' '}] \`${t.id}\` ${t.title} — **${t.status}**`
								);
							}
						}
					}
				}

				return ok(lines.join('\n'), { epic });
			} catch (e) {
				return err(String(e));
			}
		}
	);

	// -----------------------------------------------------------------------
	// pm:epic-sync  (/PM epic-sync <id>)  — #436
	// -----------------------------------------------------------------------
	ipcMain.handle(
		'pm:epic-sync',
		async (_event, req: PmCommandRequest): Promise<PmCommandResponse> => {
			const gateError = checkGate(deps.settingsStore);
			if (gateError) return gateError;

			const id = req.args?.trim();
			if (!id) return err('Please provide an epic ID: `/PM epic-sync <id>`');

			try {
				const item = await workGraph.getItem(id);
				if (!item) return err(`Epic not found: ${id}`, 'NOT_FOUND');

				pushEvent(deps, 'pm:openDeliveryPlanner', {
					mode: 'sync-epic',
					epicId: id,
					projectPath: req.projectPath,
				});

				return ok(
					[
						`**Syncing epic with GitHub: ${item.title}**`,
						'',
						'The Delivery Planner is opening to run the GitHub sync.',
					].join('\n'),
					{ epicId: id }
				);
			} catch (e) {
				return err(String(e));
			}
		}
	);

	// -----------------------------------------------------------------------
	// pm:epic-start  (/PM epic-start <id>)  — #436
	// -----------------------------------------------------------------------
	ipcMain.handle(
		'pm:epic-start',
		async (_event, req: PmCommandRequest): Promise<PmCommandResponse> => {
			const gateError = checkGate(deps.settingsStore);
			if (gateError) return gateError;

			const id = req.args?.trim();
			if (!id) return err('Please provide an epic ID: `/PM epic-start <id>`');

			try {
				const item = await workGraph.getItem(id);
				if (!item) return err(`Epic not found: ${id}`, 'NOT_FOUND');

				pushEvent(deps, 'pm:openPlanningPipeline', {
					mode: 'start-epic',
					epicId: id,
					projectPath: req.projectPath,
				});

				return ok(
					[
						`**Starting Planning Pipeline for epic: ${item.title}**`,
						'',
						'The pipeline will route tasks through the agent fleet.',
						`Use \`/PM epic-show ${id}\` to track progress.`,
					].join('\n'),
					{ epicId: id }
				);
			} catch (e) {
				return err(String(e));
			}
		}
	);

	// -----------------------------------------------------------------------
	// pm:issue-start  (/PM issue-start <task-id>)  — #436
	// -----------------------------------------------------------------------
	ipcMain.handle(
		'pm:issue-start',
		async (_event, req: PmCommandRequest): Promise<PmCommandResponse> => {
			const gateError = checkGate(deps.settingsStore);
			if (gateError) return gateError;

			const taskId = req.args?.trim();
			if (!taskId) return err('Please provide a task ID: `/PM issue-start <task-id>`');

			try {
				const task = await workGraph.getItem(taskId);
				if (!task) return err(`Task not found: ${taskId}`, 'NOT_FOUND');

				pushEvent(deps, 'pm:openAgentDispatch', {
					mode: 'claim',
					taskId,
					sessionId: req.actor?.sessionId,
				});

				return ok(
					[
						`**Claiming task for manual start: ${task.title}**`,
						'',
						'Opening Agent Dispatch to assign this task to an agent.',
					].join('\n'),
					{ taskId }
				);
			} catch (e) {
				return err(String(e));
			}
		}
	);

	// -----------------------------------------------------------------------
	// pm:issue-show  (/PM issue-show <task-id>)  — #436
	// -----------------------------------------------------------------------
	ipcMain.handle(
		'pm:issue-show',
		async (_event, req: PmCommandRequest): Promise<PmCommandResponse> => {
			const gateError = checkGate(deps.settingsStore);
			if (gateError) return gateError;

			const taskId = req.args?.trim();
			if (!taskId) return err('Please provide a task ID: `/PM issue-show <task-id>`');

			try {
				const task = await workGraph.getItem(taskId);
				if (!task) return err(`Task not found: ${taskId}`, 'NOT_FOUND');

				const lines = [
					`## Task: ${task.title}`,
					'',
					`| Field   | Value |`,
					`|---------|-------|`,
					`| ID      | \`${task.id}\` |`,
					`| Status  | **${task.status}** |`,
					`| Source  | ${task.source ?? '—'} |`,
					`| Created | ${toDateStr(task.createdAt)} |`,
					`| Updated | ${toDateStr(task.updatedAt)} |`,
				];

				if (task.claim?.owner?.id) {
					lines.push(`| Claimed by | ${task.claim.owner.id} |`);
				}

				if (task.description) {
					lines.push('', '**Description**', task.description.substring(0, 600));
				}

				const blockedReason = task.metadata?.blockedReason as string | undefined;
				if (task.status === 'blocked' && blockedReason) {
					lines.push('', `**Blocked:** ${blockedReason}`);
				}

				return ok(lines.join('\n'), { task });
			} catch (e) {
				return err(String(e));
			}
		}
	);

	// -----------------------------------------------------------------------
	// pm:issue-status  (/PM issue-status <task-id>)  — #436
	// -----------------------------------------------------------------------
	ipcMain.handle(
		'pm:issue-status',
		async (_event, req: PmCommandRequest): Promise<PmCommandResponse> => {
			const gateError = checkGate(deps.settingsStore);
			if (gateError) return gateError;

			const taskId = req.args?.trim();
			if (!taskId) return err('Please provide a task ID: `/PM issue-status <task-id>`');

			try {
				const task = await workGraph.getItem(taskId);
				if (!task) return err(`Task not found: ${taskId}`, 'NOT_FOUND');

				const claimedBy = task.claim?.owner?.id;
				const blockedReason = task.metadata?.blockedReason as string | undefined;
				const extra = claimedBy
					? ` — claimed by ${claimedBy}`
					: blockedReason
						? ` — blocked: ${blockedReason}`
						: '';

				return ok(`**${task.title}** (\`${task.id}\`) — status: **${task.status}**${extra}`, {
					taskId: task.id,
					status: task.status,
				});
			} catch (e) {
				return err(String(e));
			}
		}
	);

	// -----------------------------------------------------------------------
	// pm:issue-sync  (/PM issue-sync <task-id>)  — #436
	// -----------------------------------------------------------------------
	ipcMain.handle(
		'pm:issue-sync',
		async (_event, req: PmCommandRequest): Promise<PmCommandResponse> => {
			const gateError = checkGate(deps.settingsStore);
			if (gateError) return gateError;

			const taskId = req.args?.trim();
			if (!taskId) return err('Please provide a task ID: `/PM issue-sync <task-id>`');

			try {
				const task = await workGraph.getItem(taskId);
				if (!task) return err(`Task not found: ${taskId}`, 'NOT_FOUND');

				pushEvent(deps, 'pm:openDeliveryPlanner', {
					mode: 'sync-issue',
					taskId,
					projectPath: req.projectPath,
				});

				return ok(
					[
						`**Syncing task with GitHub: ${task.title}**`,
						'',
						'The Delivery Planner will perform a GitHub roundtrip for this task.',
					].join('\n'),
					{ taskId }
				);
			} catch (e) {
				return err(String(e));
			}
		}
	);

	// -----------------------------------------------------------------------
	// pm:next  (/PM next)
	// -----------------------------------------------------------------------
	ipcMain.handle('pm:next', async (_event, _req: PmCommandRequest): Promise<PmCommandResponse> => {
		const gateError = checkGate(deps.settingsStore);
		if (gateError) return gateError;

		try {
			const readyStatuses: WorkItemStatus[] = ['ready', 'planned'];
			const result = await workGraph.listItems({ statuses: readyStatuses });
			const candidates = result.items.filter((it) => !it.claim && it.status !== 'blocked');

			if (candidates.length === 0) {
				return ok(
					'**No eligible work items found.** All tasks are claimed, blocked, or the board is empty.'
				);
			}

			candidates.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
			const next = candidates[0]!;

			return ok(
				[
					`## Next: ${next.title}`,
					'',
					`| Field  | Value |`,
					`|--------|-------|`,
					`| ID     | \`${next.id}\` |`,
					`| Status | **${next.status}** |`,
					`| Source | ${next.source ?? '—'} |`,
					'',
					`_Use \`/PM issue-start ${next.id}\` to claim this task._`,
				].join('\n'),
				{ item: next }
			);
		} catch (e) {
			return err(String(e));
		}
	});

	// -----------------------------------------------------------------------
	// pm:status  (/PM status)  — rich Work Graph board snapshot
	// -----------------------------------------------------------------------
	ipcMain.handle(
		'pm:status',
		async (_event, _req: PmCommandRequest): Promise<PmCommandResponse> => {
			const gateError = checkGate(deps.settingsStore);
			if (gateError) return gateError;

			try {
				const result = await workGraph.listItems({});
				const items = result.items;

				const count = (statuses: WorkItemStatus[]) =>
					items.filter((it) => statuses.includes(it.status)).length;

				const planned = count(['planned', 'discovered']);
				const ready = count(['ready']);
				const inProgress = count(['in_progress', 'claimed']);
				const blocked = count(['blocked']);
				const review = count(['review']);
				const done = count(['done']);

				const blockedItems = items
					.filter((it) => it.status === 'blocked')
					.slice(0, 5)
					.map((it) => {
						const br = it.metadata?.blockedReason as string | undefined;
						return `- \`${it.id}\` ${it.title}${br ? ' — ' + br : ''}`;
					})
					.join('\n');

				const readyItems = items
					.filter((it) => it.status === 'ready')
					.slice(0, 5)
					.map((it) => `- \`${it.id}\` ${it.title}`)
					.join('\n');

				const lines = [
					'## Project Status',
					'',
					'| Status      | Count |',
					'|-------------|-------|',
					`| Planned     | ${planned} |`,
					`| Ready       | ${ready} |`,
					`| In Progress | ${inProgress} |`,
					`| Review      | ${review} |`,
					`| Blocked     | ${blocked} |`,
					`| Done        | ${done} |`,
				];

				if (readyItems) {
					lines.push('', '**Ready items**', readyItems);
				}
				if (blockedItems) {
					lines.push('', '**Blocked items**', blockedItems);
				}

				return ok(lines.join('\n'), {
					counts: { planned, ready, inProgress, review, blocked, done },
				});
			} catch (e) {
				return err(String(e));
			}
		}
	);

	// -----------------------------------------------------------------------
	// pm:standup  (/PM standup)  — rich standup from Work Graph
	// -----------------------------------------------------------------------
	ipcMain.handle(
		'pm:standup',
		async (_event, _req: PmCommandRequest): Promise<PmCommandResponse> => {
			const gateError = checkGate(deps.settingsStore);
			if (gateError) return gateError;

			try {
				const yesterday = yesterdayIso();
				const result = await workGraph.listItems({});
				const items = result.items;

				const doneSinceYesterday = items.filter(
					(it) => it.status === 'done' && it.updatedAt >= yesterday
				);

				const inProgress = items.filter(
					(it) => it.status === 'in_progress' || it.status === 'claimed'
				);

				const blocked = items.filter((it) => it.status === 'blocked');

				const fmtItem = (it: {
					id: string;
					title: string;
					claim?: { owner?: { id?: string } };
				}) => {
					const who = it.claim?.owner?.id ? ` — ${it.claim.owner.id}` : '';
					return `- ${it.title} (\`${it.id}\`)${who}`;
				};

				const todaySection =
					inProgress.length > 0 ? inProgress.map(fmtItem).join('\n') : '- Nothing in progress';

				const yesterdaySection =
					doneSinceYesterday.length > 0
						? doneSinceYesterday.map(fmtItem).join('\n')
						: '- Nothing to report';

				const blockerSection =
					blocked.length > 0
						? blocked
								.map((it) => {
									const br = it.metadata?.blockedReason as string | undefined;
									return `- ${it.title} (\`${it.id}\`)${br ? ' — ' + br : ''}`;
								})
								.join('\n')
						: '- Nothing to report';

				const today = new Date().toISOString().split('T')[0];
				const standup = [
					`## Standup — ${today}`,
					'',
					'**Yesterday** (Done since yesterday):',
					yesterdaySection,
					'',
					'**Today** (In Progress or claimed):',
					todaySection,
					'',
					'**Blockers**:',
					blockerSection,
				].join('\n');

				return ok(standup, {
					done: doneSinceYesterday.length,
					inProgress: inProgress.length,
					blocked: blocked.length,
				});
			} catch (e) {
				return err(String(e));
			}
		}
	);

	logger.info('PM orchestrator IPC handlers registered (#428 + #436)', LOG_CONTEXT);
}
