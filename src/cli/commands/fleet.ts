// Agent Dispatch fleet commands — board/list/claim/release/pause/resume via HTTP API.
//
// NOTE ON NAMING: This command is `fleet` (NOT `dispatch`).
//   fleet   = Agent Dispatch: long-lived agents claiming Work Graph items automatically.
//   dispatch = Tab Dispatch: send a prompt to an existing agent tab (see `maestro-cli dispatch`).
//
// All sub-commands communicate with the running Maestro app over the local HTTP API.
// The desktop app must be running with the Agent Dispatch encore feature enabled.
//
// Sub-command tree:
//   maestro-cli fleet board [--project <path>] [--json]
//   maestro-cli fleet list [--json]
//   maestro-cli fleet claim <workItemId> --to <fleetEntryId> [--note <text>] [--json]
//   maestro-cli fleet release <workItemId> [--json]
//   maestro-cli fleet pause <agentId> [--json]
//   maestro-cli fleet resume <agentId> [--json]

import { readCliServerInfo, isCliServerRunning } from '../../shared/cli-server-discovery';
import type { AgentDispatchFleetEntry } from '../../shared/agent-dispatch-types';
import type { WorkItem } from '../../shared/work-graph-types';

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

interface FleetApiError {
	success: false;
	code?: string;
	feature?: string;
	error?: string;
}

interface FleetApiOk<T> {
	success: true;
	data: T;
	timestamp?: number;
}

type FleetApiResult<T> = FleetApiOk<T> | FleetApiError;

/**
 * Build a base URL for the Agent Dispatch HTTP API using the CLI discovery
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
	return `http://127.0.0.1:${info.port}/${info.token}/api/agent-dispatch`;
}

async function fleetFetch<T>(path: string, options?: RequestInit): Promise<FleetApiResult<T>> {
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

	const body = (await res.json()) as FleetApiResult<T>;

	// 403 means the agentDispatch encore feature is disabled
	if (
		res.status === 403 ||
		(body && !body.success && (body as FleetApiError).code === 'FEATURE_DISABLED')
	) {
		throw new Error(
			'Agent Dispatch is disabled. Enable it in Maestro → Settings → Encore Features → Agent Dispatch.'
		);
	}

	return body;
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function exitWithError(message: string, json?: boolean, extra?: Record<string, unknown>): never {
	if (json) {
		console.log(JSON.stringify({ success: false, error: message, ...extra }, null, 2));
	} else {
		console.error(`Error: ${message}`);
	}
	process.exit(1);
}

function renderBoardItems(items: WorkItem[]): void {
	if (items.length === 0) {
		console.log('No work items found.');
		return;
	}

	// Group by status
	const byStatus = new Map<string, WorkItem[]>();
	for (const item of items) {
		const status = item.status ?? 'unknown';
		if (!byStatus.has(status)) byStatus.set(status, []);
		byStatus.get(status)!.push(item);
	}

	const idWidth = 12;
	const typeWidth = 10;
	const titleWidth = 55;

	for (const [status, statusItems] of byStatus) {
		const label = status.toUpperCase().replace(/-/g, ' ');
		console.log(
			`\n── ${label} (${statusItems.length}) ${'─'.repeat(Math.max(0, 60 - label.length - 6))}`
		);

		const header = ['ID'.padEnd(idWidth), 'TYPE'.padEnd(typeWidth), 'TITLE'].join('  ');
		console.log(header);
		console.log('-'.repeat(idWidth + typeWidth + titleWidth + 4));

		for (const item of statusItems) {
			const shortId = item.id.slice(0, idWidth - 1).padEnd(idWidth);
			const type = (item.type ?? '').padEnd(typeWidth);
			const title = (item.title ?? '').slice(0, titleWidth);
			console.log(`${shortId}  ${type}  ${title}`);
		}
	}

	console.log(`\nTotal: ${items.length} item${items.length !== 1 ? 's' : ''}`);
}

function renderFleetEntries(entries: AgentDispatchFleetEntry[]): void {
	if (entries.length === 0) {
		console.log('No fleet entries found.');
		return;
	}

	const idWidth = 12;
	const nameWidth = 22;
	const readinessWidth = 12;
	const loadWidth = 6;
	const pickupWidth = 8;

	const header = [
		'ID'.padEnd(idWidth),
		'NAME'.padEnd(nameWidth),
		'READINESS'.padEnd(readinessWidth),
		'LOAD'.padEnd(loadWidth),
		'PICKUP'.padEnd(pickupWidth),
		'CAPABILITIES',
	].join('  ');
	const divider = '-'.repeat(idWidth + nameWidth + readinessWidth + loadWidth + pickupWidth + 50);

	console.log(header);
	console.log(divider);

	for (const entry of entries) {
		const shortId = entry.id.slice(0, idWidth - 1).padEnd(idWidth);
		const name = (entry.displayName ?? '').slice(0, nameWidth - 1).padEnd(nameWidth);
		const readiness = (entry.readiness ?? '').padEnd(readinessWidth);
		const load = String(entry.currentLoad ?? 0).padEnd(loadWidth);
		const pickup = (entry.pickupEnabled ? 'yes' : 'no').padEnd(pickupWidth);
		const caps = (entry.dispatchCapabilities ?? []).join(', ').slice(0, 40);
		console.log(`${shortId}  ${name}  ${readiness}  ${load}  ${pickup}  ${caps}`);
	}

	console.log(`\n${entries.length} entry${entries.length !== 1 ? 'entries' : ''}`);
}

// ---------------------------------------------------------------------------
// board
// ---------------------------------------------------------------------------

export interface FleetBoardOptions {
	project?: string;
	json?: boolean;
}

export async function fleetBoard(options: FleetBoardOptions): Promise<void> {
	const qs = options.project ? `?projectPath=${encodeURIComponent(options.project)}` : '';

	let result: FleetApiResult<WorkItem[] | { items: WorkItem[] }>;
	try {
		result = await fleetFetch<WorkItem[] | { items: WorkItem[] }>(`/board${qs}`);
	} catch (err) {
		exitWithError(err instanceof Error ? err.message : String(err), options.json);
	}

	if (!result.success) {
		exitWithError((result as FleetApiError).error ?? 'Unknown error from Maestro', options.json, {
			code: (result as FleetApiError).code,
		});
	}

	const raw = (result as FleetApiOk<WorkItem[] | { items: WorkItem[] }>).data;
	const items: WorkItem[] = Array.isArray(raw) ? raw : ((raw as { items: WorkItem[] }).items ?? []);

	if (options.json) {
		console.log(JSON.stringify(items, null, 2));
		return;
	}

	console.log('\nAgent Dispatch — Work Board\n');
	renderBoardItems(items);
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

export interface FleetListOptions {
	json?: boolean;
}

export async function fleetList(options: FleetListOptions): Promise<void> {
	let result: FleetApiResult<AgentDispatchFleetEntry[]>;
	try {
		result = await fleetFetch<AgentDispatchFleetEntry[]>('/fleet');
	} catch (err) {
		exitWithError(err instanceof Error ? err.message : String(err), options.json);
	}

	if (!result.success) {
		exitWithError((result as FleetApiError).error ?? 'Unknown error from Maestro', options.json, {
			code: (result as FleetApiError).code,
		});
	}

	const entries = (result as FleetApiOk<AgentDispatchFleetEntry[]>).data;

	if (options.json) {
		console.log(JSON.stringify(entries, null, 2));
		return;
	}

	console.log('\nAgent Dispatch — Fleet\n');
	renderFleetEntries(entries ?? []);
}

// ---------------------------------------------------------------------------
// claim
// ---------------------------------------------------------------------------

export interface FleetClaimOptions {
	to: string;
	note?: string;
	json?: boolean;
}

export async function fleetClaim(workItemId: string, options: FleetClaimOptions): Promise<void> {
	if (!workItemId) {
		exitWithError('workItemId argument is required', options.json);
	}
	if (!options.to) {
		exitWithError('--to <fleetEntryId> is required', options.json);
	}

	const body = {
		workItemId,
		agent: { id: options.to },
		...(options.note ? { note: options.note } : {}),
	};

	let result: FleetApiResult<unknown>;
	try {
		result = await fleetFetch<unknown>('/claims', {
			method: 'POST',
			body: JSON.stringify(body),
		});
	} catch (err) {
		exitWithError(err instanceof Error ? err.message : String(err), options.json);
	}

	if (!result.success) {
		exitWithError((result as FleetApiError).error ?? 'Claim failed', options.json, {
			code: (result as FleetApiError).code,
		});
	}

	const data = (result as FleetApiOk<unknown>).data;

	if (options.json) {
		console.log(JSON.stringify(data, null, 2));
		return;
	}

	console.log(`Claimed work item ${workItemId} → fleet entry ${options.to}`);
}

// ---------------------------------------------------------------------------
// release
// ---------------------------------------------------------------------------

export interface FleetReleaseOptions {
	json?: boolean;
}

export async function fleetRelease(
	workItemId: string,
	options: FleetReleaseOptions
): Promise<void> {
	if (!workItemId) {
		exitWithError('workItemId argument is required', options.json);
	}

	let result: FleetApiResult<unknown>;
	try {
		result = await fleetFetch<unknown>(`/claims/${encodeURIComponent(workItemId)}`, {
			method: 'DELETE',
		});
	} catch (err) {
		exitWithError(err instanceof Error ? err.message : String(err), options.json);
	}

	if (!result.success) {
		exitWithError((result as FleetApiError).error ?? 'Release failed', options.json, {
			code: (result as FleetApiError).code,
		});
	}

	const data = (result as FleetApiOk<unknown>).data;

	if (options.json) {
		console.log(JSON.stringify(data, null, 2));
		return;
	}

	console.log(`Released claim on work item ${workItemId}`);
}

// ---------------------------------------------------------------------------
// pause
// ---------------------------------------------------------------------------

export interface FleetPauseOptions {
	json?: boolean;
}

export async function fleetPause(agentId: string, options: FleetPauseOptions): Promise<void> {
	if (!agentId) {
		exitWithError('agentId argument is required', options.json);
	}

	let result: FleetApiResult<{ paused: boolean }>;
	try {
		result = await fleetFetch<{ paused: boolean }>(`/agents/${encodeURIComponent(agentId)}/pause`, {
			method: 'POST',
		});
	} catch (err) {
		exitWithError(err instanceof Error ? err.message : String(err), options.json);
	}

	if (!result.success) {
		exitWithError((result as FleetApiError).error ?? 'Pause failed', options.json, {
			code: (result as FleetApiError).code,
		});
	}

	const data = (result as FleetApiOk<{ paused: boolean }>).data;

	if (options.json) {
		console.log(JSON.stringify(data, null, 2));
		return;
	}

	console.log(`Agent ${agentId} auto-pickup paused.`);
}

// ---------------------------------------------------------------------------
// resume
// ---------------------------------------------------------------------------

export interface FleetResumeOptions {
	json?: boolean;
}

export async function fleetResume(agentId: string, options: FleetResumeOptions): Promise<void> {
	if (!agentId) {
		exitWithError('agentId argument is required', options.json);
	}

	let result: FleetApiResult<{ paused: boolean }>;
	try {
		result = await fleetFetch<{ paused: boolean }>(
			`/agents/${encodeURIComponent(agentId)}/resume`,
			{ method: 'POST' }
		);
	} catch (err) {
		exitWithError(err instanceof Error ? err.message : String(err), options.json);
	}

	if (!result.success) {
		exitWithError((result as FleetApiError).error ?? 'Resume failed', options.json, {
			code: (result as FleetApiError).code,
		});
	}

	const data = (result as FleetApiOk<{ paused: boolean }>).data;

	if (options.json) {
		console.log(JSON.stringify(data, null, 2));
		return;
	}

	console.log(`Agent ${agentId} auto-pickup resumed.`);
}
