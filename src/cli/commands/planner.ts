// Delivery Planner CLI commands — PRD/epic/task lifecycle via the Maestro desktop app.
//
// All sub-commands communicate with the running Maestro app over the local HTTP API
// (the same REST surface used by the mobile/web client). The desktop app must be
// running with the Delivery Planner encore feature enabled.
//
// Sub-command tree:
//   maestro-cli planner dashboard [--project <path>] [--json]
//   maestro-cli planner prd create --title <title> [--project <path>] [--description <text>] [--json]
//   maestro-cli planner prd decompose <id> [--json]
//   maestro-cli planner epic decompose <id> [--json]
//   maestro-cli planner sync [--target github|mirror|all] <id> [--json]

import { readCliServerInfo, isCliServerRunning } from '../../shared/cli-server-discovery';
import type {
	DeliveryPlannerCreatePrdRequest,
	DeliveryPlannerDecomposePrdRequest,
	DeliveryPlannerDecomposeEpicRequest,
	DeliveryPlannerSyncRequest,
} from '../../shared/delivery-planner-types';
import type { WorkItem } from '../../shared/work-graph-types';

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

interface PlannerApiError {
	success: false;
	code?: string;
	feature?: string;
	error?: string;
}

interface PlannerApiOk<T> {
	success: true;
	data: T;
	timestamp?: number;
}

type PlannerApiResult<T> = PlannerApiOk<T> | PlannerApiError;

/**
 * Build a base URL for the Delivery Planner HTTP API using the CLI discovery
 * file written by the running Maestro desktop app.
 *
 * Throws a descriptive Error when the app is not running or the discovery file
 * is stale — callers translate this into a CLI exit(1).
 */
function getBaseUrl(): string {
	const info = readCliServerInfo();
	if (!info) {
		throw new Error('Maestro desktop app is not running');
	}
	if (!isCliServerRunning()) {
		throw new Error('Maestro discovery file is stale (app may have crashed)');
	}
	return `http://127.0.0.1:${info.port}/${info.token}/api/delivery-planner`;
}

async function plannerFetch<T>(path: string, options?: RequestInit): Promise<PlannerApiResult<T>> {
	const baseUrl = getBaseUrl();
	const url = `${baseUrl}${path}`;

	let res: Response;
	try {
		res = await fetch(url, {
			headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
			...options,
		});
	} catch (err) {
		throw new Error(`Could not reach Maestro: ${err instanceof Error ? err.message : String(err)}`);
	}

	const body = (await res.json()) as PlannerApiResult<T>;

	// 403 means the deliveryPlanner encore feature is disabled
	if (
		res.status === 403 ||
		(body && !body.success && (body as PlannerApiError).code === 'FEATURE_DISABLED')
	) {
		throw new Error(
			'Delivery Planner is disabled. Enable it in Maestro → Settings → Encore Features → Delivery Planner.'
		);
	}

	return body;
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function renderWorkItems(items: WorkItem[]): void {
	if (items.length === 0) {
		console.log('No items found.');
		return;
	}

	// Column widths
	const idWidth = 12;
	const typeWidth = 10;
	const statusWidth = 12;
	const titleWidth = 50;

	const header = [
		'ID'.padEnd(idWidth),
		'TYPE'.padEnd(typeWidth),
		'STATUS'.padEnd(statusWidth),
		'TITLE',
	].join('  ');
	const divider = '-'.repeat(idWidth + typeWidth + statusWidth + titleWidth + 6);

	console.log(header);
	console.log(divider);

	for (const item of items) {
		const shortId = item.id.slice(0, idWidth - 1).padEnd(idWidth);
		const type = (item.type ?? '').padEnd(typeWidth);
		const status = (item.status ?? '').padEnd(statusWidth);
		const title = (item.title ?? '').slice(0, titleWidth);
		console.log(`${shortId}  ${type}  ${status}  ${title}`);
	}

	console.log(`\n${items.length} item${items.length !== 1 ? 's' : ''}`);
}

function exitWithError(message: string, json?: boolean, extra?: Record<string, unknown>): never {
	if (json) {
		console.log(JSON.stringify({ success: false, error: message, ...extra }, null, 2));
	} else {
		console.error(`Error: ${message}`);
	}
	process.exit(1);
}

// ---------------------------------------------------------------------------
// dashboard
// ---------------------------------------------------------------------------

export interface PlannerDashboardOptions {
	project?: string;
	gitPath?: string;
	json?: boolean;
}

export async function plannerDashboard(options: PlannerDashboardOptions): Promise<void> {
	let qs = '';
	const params: string[] = [];
	if (options.project) params.push(`projectPath=${encodeURIComponent(options.project)}`);
	if (options.gitPath) params.push(`gitPath=${encodeURIComponent(options.gitPath)}`);
	if (params.length) qs = `?${params.join('&')}`;

	let result: PlannerApiResult<{ items: WorkItem[] }>;
	try {
		result = await plannerFetch<{ items: WorkItem[] }>(`/dashboard${qs}`);
	} catch (err) {
		exitWithError(err instanceof Error ? err.message : String(err), options.json);
	}

	if (!result.success) {
		exitWithError((result as PlannerApiError).error ?? 'Unknown error from Maestro', options.json, {
			code: (result as PlannerApiError).code,
		});
	}

	const data = (result as PlannerApiOk<{ items: WorkItem[] }>).data;

	if (options.json) {
		console.log(JSON.stringify(data, null, 2));
		return;
	}

	console.log('\nDelivery Planner Dashboard\n');
	renderWorkItems(data.items ?? []);
}

// ---------------------------------------------------------------------------
// prd create
// ---------------------------------------------------------------------------

export interface PlannerPrdCreateOptions {
	title: string;
	project?: string;
	gitPath?: string;
	description?: string;
	json?: boolean;
}

export async function plannerPrdCreate(options: PlannerPrdCreateOptions): Promise<void> {
	if (!options.title) {
		exitWithError('--title is required', options.json);
	}

	// Resolve paths on the server side if none provided
	let projectPath = options.project ?? process.cwd();
	let gitPath = options.gitPath ?? projectPath;

	// Try to resolve via the server so we use the app's working directory
	try {
		const pathResult = await plannerFetch<{ projectPath: string; gitPath: string }>(
			'/resolve-paths',
			{
				method: 'POST',
				body: JSON.stringify({
					projectPath: options.project,
					gitPath: options.gitPath,
				}),
			}
		);
		if (pathResult.success) {
			projectPath = (pathResult as PlannerApiOk<{ projectPath: string; gitPath: string }>).data
				.projectPath;
			gitPath = (pathResult as PlannerApiOk<{ projectPath: string; gitPath: string }>).data.gitPath;
		}
	} catch {
		// Use local resolution if resolve-paths fails (app may be older build)
	}

	const body: DeliveryPlannerCreatePrdRequest = {
		title: options.title,
		projectPath,
		gitPath,
		...(options.description ? { description: options.description } : {}),
		actor: { type: 'user', id: 'cli', name: 'CLI' },
	};

	let result: PlannerApiResult<WorkItem>;
	try {
		result = await plannerFetch<WorkItem>('/prd', {
			method: 'POST',
			body: JSON.stringify(body),
		});
	} catch (err) {
		exitWithError(err instanceof Error ? err.message : String(err), options.json);
	}

	if (!result.success) {
		exitWithError((result as PlannerApiError).error ?? 'Failed to create PRD', options.json, {
			code: (result as PlannerApiError).code,
		});
	}

	const prd = (result as PlannerApiOk<WorkItem>).data;

	if (options.json) {
		console.log(JSON.stringify(prd, null, 2));
		return;
	}

	console.log(`PRD created: ${prd.id}`);
	console.log(`  Title:  ${prd.title}`);
	console.log(`  Status: ${prd.status}`);
	console.log(`  Type:   ${prd.type}`);
}

// ---------------------------------------------------------------------------
// prd decompose
// ---------------------------------------------------------------------------

export interface PlannerPrdDecomposeOptions {
	json?: boolean;
}

export async function plannerPrdDecompose(
	prdId: string,
	options: PlannerPrdDecomposeOptions
): Promise<void> {
	if (!prdId) {
		exitWithError('PRD ID is required', options.json);
	}

	const body: DeliveryPlannerDecomposePrdRequest = {
		prdId,
		actor: { type: 'user', id: 'cli', name: 'CLI' },
	};

	let result: PlannerApiResult<unknown>;
	try {
		result = await plannerFetch<unknown>(`/prd/${encodeURIComponent(prdId)}/decompose`, {
			method: 'POST',
			body: JSON.stringify(body),
		});
	} catch (err) {
		exitWithError(err instanceof Error ? err.message : String(err), options.json);
	}

	if (!result.success) {
		exitWithError((result as PlannerApiError).error ?? 'Failed to decompose PRD', options.json, {
			code: (result as PlannerApiError).code,
		});
	}

	const data = (result as PlannerApiOk<unknown>).data;

	if (options.json) {
		console.log(JSON.stringify(data, null, 2));
		return;
	}

	const decomposed = data as { epic?: WorkItem; items?: WorkItem[] };
	if (decomposed?.epic) {
		console.log(`PRD ${prdId} decomposed into epic: ${decomposed.epic.id}`);
		console.log(`  Epic title: ${decomposed.epic.title}`);
	} else if (Array.isArray((data as { items?: WorkItem[] })?.items)) {
		const items = (data as { items: WorkItem[] }).items;
		console.log(`PRD ${prdId} decomposed into ${items.length} item(s):`);
		renderWorkItems(items);
	} else {
		console.log(`PRD ${prdId} decomposed successfully.`);
		console.log(JSON.stringify(data, null, 2));
	}
}

// ---------------------------------------------------------------------------
// epic decompose
// ---------------------------------------------------------------------------

export interface PlannerEpicDecomposeOptions {
	json?: boolean;
}

export async function plannerEpicDecompose(
	epicId: string,
	options: PlannerEpicDecomposeOptions
): Promise<void> {
	if (!epicId) {
		exitWithError('Epic ID is required', options.json);
	}

	const body: DeliveryPlannerDecomposeEpicRequest = {
		epicId,
		actor: { type: 'user', id: 'cli', name: 'CLI' },
	};

	let result: PlannerApiResult<unknown>;
	try {
		result = await plannerFetch<unknown>(`/epic/${encodeURIComponent(epicId)}/decompose`, {
			method: 'POST',
			body: JSON.stringify(body),
		});
	} catch (err) {
		exitWithError(err instanceof Error ? err.message : String(err), options.json);
	}

	if (!result.success) {
		exitWithError((result as PlannerApiError).error ?? 'Failed to decompose epic', options.json, {
			code: (result as PlannerApiError).code,
		});
	}

	const data = (result as PlannerApiOk<unknown>).data;

	if (options.json) {
		console.log(JSON.stringify(data, null, 2));
		return;
	}

	const decomposed = data as { createdItems?: WorkItem[]; items?: WorkItem[] };
	const tasks = decomposed?.createdItems ?? (decomposed as { items?: WorkItem[] })?.items;
	if (Array.isArray(tasks) && tasks.length > 0) {
		console.log(`Epic ${epicId} decomposed into ${tasks.length} task(s):`);
		renderWorkItems(tasks);
	} else {
		console.log(`Epic ${epicId} decomposed successfully.`);
		console.log(JSON.stringify(data, null, 2));
	}
}

// ---------------------------------------------------------------------------
// sync
// ---------------------------------------------------------------------------

export interface PlannerSyncOptions {
	target?: 'github' | 'mirror' | 'all';
	json?: boolean;
}

export async function plannerSync(workItemId: string, options: PlannerSyncOptions): Promise<void> {
	if (!workItemId) {
		exitWithError('Work item ID is required', options.json);
	}

	// Map CLI target names to the API's target vocabulary
	// The API uses 'external-mirror' for the mirror target
	const rawTarget = options.target ?? 'all';
	const apiTarget: DeliveryPlannerSyncRequest['target'] =
		rawTarget === 'mirror' ? 'external-mirror' : rawTarget;

	const body: DeliveryPlannerSyncRequest = {
		workItemId,
		target: apiTarget,
	};

	let endpoint: string;
	if (apiTarget === 'github') {
		endpoint = '/sync-github';
	} else if (apiTarget === 'external-mirror') {
		endpoint = '/sync-mirror';
	} else {
		endpoint = '/sync';
	}

	let result: PlannerApiResult<WorkItem>;
	try {
		result = await plannerFetch<WorkItem>(endpoint, {
			method: 'POST',
			body: JSON.stringify(body),
		});
	} catch (err) {
		exitWithError(err instanceof Error ? err.message : String(err), options.json);
	}

	if (!result.success) {
		exitWithError((result as PlannerApiError).error ?? 'Sync failed', options.json, {
			code: (result as PlannerApiError).code,
		});
	}

	const item = (result as PlannerApiOk<WorkItem>).data;

	if (options.json) {
		console.log(JSON.stringify(item, null, 2));
		return;
	}

	console.log(`Synced ${workItemId} (target: ${rawTarget})`);
	if (item?.title) console.log(`  Title:  ${item.title}`);
	if (item?.status) console.log(`  Status: ${item.status}`);
}
