// Dataview commands - `maestro-cli dataview ...` (D8, DV-13).
//
// The CLI half of Dataview: every result the preview shows can be printed
// here. The CLI has no index of its own. Each verb rides the `dataview_command`
// WS message to the SAME DataviewService request methods the `dataview:*` IPC
// handlers call, so the app must be running and the answer is the preview's.
//
// - `query <file>` runs the note's `dataview` blocks (main reads the note, so an
//   SSH agent's note is read on its remote). `--block n` counts `dataview`
//   fences only, 1-based. A `dataviewjs` block is never run here.
// - `eval <file> "<dql>"` runs an ad-hoc query with `this` bound to the file;
//   input that starts with `=` is an inline expression.
// - `index status [<root>]` and `index rebuild <root>` read and reset an index.
// - `trust <root>`, `untrust <root>`, and `trusted` edit and list the vaults
//   whose DataviewJS blocks run without asking (D3). The CLI never runs a
//   script; these only change what the desktop app's sandbox may do. The root
//   is resolved against the shell's cwd and normalized the way the app compares
//   roots, and the app stores it through the same service as the settings UI.
//
// Encore-gated (D3): `src/cli/index.ts` registers the command with
// `encoreCommand()`, so it is hidden and refused while the `dataview` flag is
// off. The app's service refuses too, with the same text; that reply carries
// the same `--json` code.

import { withMaestroClient, resolveTargetSessionId } from '../services/maestro-client';
import { failFromError } from '../services/session-command';
import { ExitCode, exitWith } from '../exit-codes';
import { resolveCliPath } from '../utils/parse';
import { resolveOwningAgent } from '../utils/owning-agent';
import { formatTextTable } from '../output/formatter';
import { encoreDisabledCode, encoreDisabledMessage } from '../utils/encore-gate';
import { normalizeTrustedRoot } from '../../shared/dataview/trust';
import type {
	DataviewCommandAction,
	DataviewFileQueryResult,
	DataviewIndexStatus,
	DataviewInlineResult,
	DataviewQueryResponse,
	DataviewResult,
	DataviewTrustResponse,
	Literal,
	RevivedDataviewResult,
} from '../../shared/dataview';

/** The message `query` prints for a `dataviewjs` block, which only the desktop app renders (D8). */
export const DATAVIEWJS_DESKTOP_ONLY = 'DataviewJS renders in the desktop app only';

/** The first query of a vault indexes it, which can outlast the bridge's default budget. */
const DATAVIEW_TIMEOUT_MS = 2 * 60_000;

export interface DataviewCliOptions {
	/** The agent whose cwd roots a note outside any vault, and whose SSH remote holds the file. */
	agent?: string;
	/** `query`: 1-based position among the note's `dataview` fences. */
	block?: string;
	json?: boolean;
}

interface DataviewReply<T> {
	type: string;
	success: boolean;
	error?: string;
	response?: T;
}

/** The vendored core, loaded only when a verb prints a result (its parsers build at load). */
const loadDataview = () => import('../../shared/dataview');
type DataviewModule = Awaited<ReturnType<typeof loadDataview>>;

function fail(
	message: string,
	options: { json?: boolean },
	code: ExitCode = ExitCode.GeneralError,
	extra: Record<string, unknown> = {}
): never {
	if (options.json) console.log(JSON.stringify({ success: false, error: message, ...extra }));
	else console.error(`Error: ${message}`);
	return exitWith(code);
}

async function send<T>(
	action: DataviewCommandAction,
	fields: Record<string, unknown>,
	options: { json?: boolean }
): Promise<T> {
	let reply: DataviewReply<T>;
	try {
		reply = await withMaestroClient((client) =>
			client.sendCommand<DataviewReply<T>>(
				{ type: 'dataview_command', action, ...fields },
				'dataview_result',
				DATAVIEW_TIMEOUT_MS
			)
		);
	} catch (error) {
		failFromError(error, options.json);
	}
	if (!reply.success || reply.response === undefined) {
		const error = reply.error || `dataview ${action} failed`;
		// The app read the flag as off (it was switched off after this verb checked the settings file).
		const disabled = error === encoreDisabledMessage('dataview');
		fail(
			error,
			options,
			ExitCode.GeneralError,
			disabled ? { code: encoreDisabledCode('dataview') } : {}
		);
	}
	return reply.response;
}

/** `--agent`, else the agent whose working directory holds the note (deepest cwd wins). */
function resolveNoteAgent(filePath: string, options: DataviewCliOptions): string {
	if (options.agent) return resolveTargetSessionId(options.agent);
	const owned = resolveOwningAgent(filePath);
	if (!owned) {
		fail(
			`${filePath} is not inside any agent's working directory. Pick an agent with --agent <id>.`,
			options,
			ExitCode.InvalidUsage
		);
	}
	if (owned.others.length > 0 && !options.json) {
		const others = owned.others.map((s) => s.name).join(', ');
		console.error(
			`Note: ${owned.others.length + 1} agents own this path; using ${owned.agent.name}. Other candidates: ${others}. Use --agent to override.`
		);
	}
	return owned.agent.id;
}

function parseBlockOption(
	value: string | undefined,
	options: DataviewCliOptions
): number | undefined {
	if (value === undefined) return undefined;
	const block = /^\d+$/.test(value.trim()) ? Number(value) : NaN;
	if (!Number.isSafeInteger(block) || block < 1) {
		fail(`--block expects a whole number from 1, got "${value}"`, options, ExitCode.InvalidUsage);
	}
	return block;
}

/** The terminal width a table is capped to; uncapped when stdout is not a terminal. */
function terminalWidth(): number | undefined {
	return process.stdout.isTTY && process.stdout.columns ? process.stdout.columns : undefined;
}

/** Dataview's own text for a value, with null as a plain `-` instead of the escaped markdown `\-`. */
function valueText(dv: DataviewModule, value: Literal): string {
	return dv.Values.toString(value, { ...dv.DataviewSettings, renderNullAs: '-' });
}

function taskLines(dv: DataviewModule, entries: unknown[], depth: number): string[] {
	const indent = '  '.repeat(depth);
	const lines: string[] = [];
	for (const entry of entries) {
		if (dv.isTaskGroup<Literal>(entry)) {
			lines.push(`${indent}${valueText(dv, entry.key)}`);
			lines.push(...taskLines(dv, entry.rows as unknown[], depth + 1));
			continue;
		}
		const item = (entry ?? {}) as Record<string, Literal>;
		const isTask = item.task !== false;
		const status = typeof item.status === 'string' ? item.status : item.completed ? 'x' : ' ';
		const where =
			typeof item.path === 'string' && typeof item.line === 'number'
				? `  (${item.path}:${item.line + 1})`
				: '';
		lines.push(`${indent}- ${isTask ? `[${status}] ` : ''}${valueText(dv, item.text)}${where}`);
		if (Array.isArray(item.children) && item.children.length > 0) {
			lines.push(...taskLines(dv, item.children, depth + 1));
		}
	}
	return lines;
}

/** One result as terminal text. Warnings, and the note on a result cut at the row cap, go to stderr. */
function printResult(dv: DataviewModule, result: RevivedDataviewResult): void {
	let shown = 0;
	switch (result.kind) {
		case 'table':
			if (result.rows.length === 0) console.log('No results.');
			else {
				const rows = result.rows.map((row) => row.map((cell) => valueText(dv, cell)));
				console.log(formatTextTable(result.headers, rows, { maxWidth: terminalWidth() }));
			}
			shown = result.rows.length;
			break;
		case 'list':
			if (result.items.length === 0) console.log('No results.');
			for (const item of result.items) console.log(`- ${valueText(dv, item)}`);
			shown = result.items.length;
			break;
		case 'task': {
			const lines = taskLines(dv, result.groups as unknown[], 0);
			console.log(lines.length > 0 ? lines.join('\n') : 'No results.');
			shown = dv.countTaskGroupRows(result.groups as unknown[]);
			break;
		}
		case 'unsupported':
			console.log(`${result.feature} queries are not supported in Maestro.`);
			return;
		case 'error':
			console.error(
				`Error: ${result.message}${result.line === undefined ? '' : ` (line ${result.line})`}`
			);
			return;
	}
	const truncationNote = dv.dataviewTruncationNote(result, shown);
	if (truncationNote) console.error(`Note: ${truncationNote}`);
	for (const warning of result.warnings) console.error(`Warning: ${warning}`);
}

/** `maestro-cli dataview query <file> [--block <n>]` */
export async function dataviewQuery(file: string, options: DataviewCliOptions): Promise<void> {
	const filePath = resolveCliPath(file);
	const block = parseBlockOption(options.block, options);
	const agentId = resolveNoteAgent(filePath, options);
	const response = await send<DataviewQueryResponse<DataviewFileQueryResult>>(
		'queryFile',
		{ filePath, agentId, block },
		options
	);
	const { result } = response;
	if (result.kind === 'error') fail(result.message, options);
	if (block !== undefined && block > result.blockCount) {
		fail(
			`${filePath} has ${result.blockCount} dataview block${result.blockCount === 1 ? '' : 's'}; there is no block ${block}`,
			options,
			ExitCode.InvalidUsage
		);
	}

	const dv = await loadDataview();
	const blocks = result.blocks.map((entry) => ({
		...entry,
		result: entry.result && dv.reviveDataviewResult(entry.result),
	}));
	const hasScript = blocks.some((entry) => entry.language === 'dataviewjs');
	const hasError = blocks.some((entry) => entry.result?.kind === 'error');
	const exitCode = hasScript
		? ExitCode.InvalidUsage
		: hasError
			? ExitCode.GeneralError
			: ExitCode.Success;

	if (options.json) {
		console.log(
			JSON.stringify({
				success: exitCode === ExitCode.Success,
				...(hasScript ? { error: DATAVIEWJS_DESKTOP_ONLY } : {}),
				root: response.root,
				path: response.path,
				revision: response.revision,
				blockCount: result.blockCount,
				blocks: blocks.map((entry) =>
					entry.language === 'dataviewjs' ? { ...entry, error: DATAVIEWJS_DESKTOP_ONLY } : entry
				),
			})
		);
	} else if (blocks.length === 0) {
		console.log(`No dataview blocks in ${filePath}.`);
	} else {
		blocks.forEach((entry, index) => {
			if (index > 0) console.log('');
			if (blocks.length > 1 || entry.language === 'dataviewjs') {
				const label = entry.block === null ? 'DataviewJS block' : `Block ${entry.block}`;
				console.log(`${label} (line ${entry.line})`);
			}
			if (entry.result) printResult(dv, entry.result);
			else console.error(DATAVIEWJS_DESKTOP_ONLY);
		});
	}
	if (exitCode !== ExitCode.Success) exitWith(exitCode);
}

/** `maestro-cli dataview eval <file> "<dql>"`; input starting with `=` is an inline expression. */
export async function dataviewEval(
	file: string,
	dql: string,
	options: DataviewCliOptions
): Promise<void> {
	const filePath = resolveCliPath(file);
	if (!dql.trim())
		fail('eval expects a query or an `= expression`', options, ExitCode.InvalidUsage);
	const agentId = resolveNoteAgent(filePath, options);
	const inline = dql.trimStart().startsWith('=');
	const response = inline
		? await send<DataviewQueryResponse<DataviewInlineResult>>(
				'queryInline',
				{ filePath, agentId, expression: dql },
				options
			)
		: await send<DataviewQueryResponse<DataviewResult>>(
				'query',
				{ filePath, agentId, source: dql },
				options
			);

	const dv = await loadDataview();
	const wire = response.result;
	const result =
		wire.kind === 'value'
			? dv.reviveDataviewInlineResult(wire)
			: dv.reviveDataviewResult(wire as DataviewResult);
	const failed = result.kind === 'error';

	if (options.json) {
		console.log(
			JSON.stringify({
				success: !failed,
				root: response.root,
				path: response.path,
				revision: response.revision,
				result,
			})
		);
	} else if (result.kind === 'value') {
		console.log(valueText(dv, result.value));
	} else {
		printResult(dv, result);
	}
	if (failed) exitWith(ExitCode.GeneralError);
}

function statusRows(statuses: DataviewIndexStatus[]): string[][] {
	return statuses.map((status) => [
		status.sshRemoteId ? `${status.root} (${status.sshRemoteId})` : status.root,
		String(status.pageCount),
		String(status.revision),
		status.watchMode,
		status.cacheHit ? 'hit' : 'miss',
		status.lastScanDurationMs === null ? '-' : `${status.lastScanDurationMs} ms`,
	]);
}

const STATUS_HEADERS = ['ROOT', 'PAGES', 'REVISION', 'WATCH', 'CACHE', 'LAST SCAN'];

/** `maestro-cli dataview index status [<root>]`: one open root, or every open root. */
export async function dataviewIndexStatus(
	root: string | undefined,
	options: DataviewCliOptions
): Promise<void> {
	const fields: Record<string, unknown> = {};
	if (root !== undefined) fields.root = resolveCliPath(root);
	if (options.agent) fields.agentId = resolveTargetSessionId(options.agent);
	const statuses = await send<DataviewIndexStatus[]>('status', fields, options);

	if (options.json) {
		console.log(JSON.stringify({ success: true, indexes: statuses }));
	} else if (statuses.length > 0) {
		console.log(
			formatTextTable(STATUS_HEADERS, statusRows(statuses), { maxWidth: terminalWidth() })
		);
	} else if (root !== undefined) {
		console.log(`${fields.root} is not indexed. It opens on the first query of a note inside it.`);
	} else {
		console.log('No vault is indexed. A vault opens on the first query of a note inside it.');
	}
}

/** `maestro-cli dataview index rebuild <root>`: drop the root's cache and index it from scratch. */
export async function dataviewIndexRebuild(
	root: string,
	options: DataviewCliOptions
): Promise<void> {
	const fields: Record<string, unknown> = { root: resolveCliPath(root) };
	if (options.agent) fields.agentId = resolveTargetSessionId(options.agent);
	const status = await send<DataviewIndexStatus>('rebuild', fields, options);

	if (options.json) {
		console.log(JSON.stringify({ success: true, index: status }));
		return;
	}
	const took = status.lastScanDurationMs === null ? '' : ` in ${status.lastScanDurationMs} ms`;
	console.log(`Rebuilt ${status.root}: ${status.pageCount} pages${took}.`);
}

/** A root as the trust list stores it: resolved against the shell's cwd, then normalized like the app's. */
export function resolveTrustRoot(root: string): string {
	return normalizeTrustedRoot(resolveCliPath(root));
}

/** `maestro-cli dataview trust <root>`: run the vault's DataviewJS blocks without asking. */
export async function dataviewTrust(root: string, options: DataviewCliOptions): Promise<void> {
	const response = await send<DataviewTrustResponse>(
		'trust',
		{ root: resolveTrustRoot(root) },
		options
	);
	if (options.json) {
		console.log(JSON.stringify({ success: true, ...response }));
		return;
	}
	console.log(
		response.changed
			? `Trusted ${response.root}. Its DataviewJS blocks run without asking.`
			: `${response.root} is already trusted.`
	);
}

/** `maestro-cli dataview untrust <root>`: ask again before any DataviewJS block in the vault runs. */
export async function dataviewUntrust(root: string, options: DataviewCliOptions): Promise<void> {
	const response = await send<DataviewTrustResponse>(
		'untrust',
		{ root: resolveTrustRoot(root) },
		options
	);
	if (options.json) {
		console.log(JSON.stringify({ success: true, ...response }));
		return;
	}
	console.log(
		response.changed
			? `Stopped trusting ${response.root}. Its DataviewJS blocks ask before they run.`
			: `${response.root} was not trusted.`
	);
}

/** `maestro-cli dataview trusted`: the vaults whose DataviewJS blocks run without asking. */
export async function dataviewTrusted(options: DataviewCliOptions): Promise<void> {
	const roots = await send<string[]>('trusted', {}, options);
	if (options.json) {
		console.log(JSON.stringify({ success: true, roots }));
	} else if (roots.length === 0) {
		console.log('No vault is trusted. DataviewJS blocks ask before they run.');
	} else {
		for (const root of roots) console.log(root);
	}
}
