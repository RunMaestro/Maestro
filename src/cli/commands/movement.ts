// Movement command - compose the agent-driven "living view" in the Maestro desktop
// app. The movement is a roomy main-window surface where the agent free-places
// items (add/update/move/remove/clear), each rendering a BlockView spec (the
// same JSON block vocabulary as `view --type view`). Rides the same bridge as
// notify/view.

import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { withMaestroClient } from '../services/maestro-client';
import {
	MOVEMENT_OPS,
	MOVEMENT_VIEW_TYPES,
	type MovementOp,
	type MovementPayload,
	type MovementStateSnapshot,
	type MovementViewType,
} from '../../shared/movement-types';
import type {
	ConcertoDesignerAction,
	ConcertoDesignerActionResult,
	MovementDesignerInspection,
} from '../../shared/concerto-html';

interface MovementAddOptions {
	type?: string;
	x?: string;
	y?: string;
	width?: string;
	height?: string;
	title?: string;
	body?: string;
	bodyFile?: string;
	htmlFile?: string;
	json?: boolean;
}

interface MovementMoveOptions {
	x?: string;
	y?: string;
	json?: boolean;
}

interface MovementRemoveOptions {
	json?: boolean;
}

interface MovementInspectOptions {
	output?: string;
	json?: boolean;
}

interface MovementInteractOptions {
	click?: string;
	type?: string;
	value?: string;
	json?: boolean;
}

/** Read the block spec from --body (inline) or --body-file (a file path). */
function resolveBody(body: string | undefined, bodyFile: string | undefined): string | undefined {
	if (bodyFile) {
		try {
			return readFileSync(bodyFile, 'utf8');
		} catch (error) {
			console.error(
				`Error: could not read --body-file: ${error instanceof Error ? error.message : String(error)}`
			);
			process.exit(1);
		}
	}
	return body;
}

/** Resolve and validate a Movement's native-view or HTML document mode. */
function resolveViewType(
	options: MovementAddOptions,
	defaultToView: boolean
): MovementViewType | undefined {
	if (options.htmlFile && options.type && options.type !== 'html') {
		console.error('Error: --html-file requires --type html (or omit --type)');
		process.exit(1);
	}
	const raw = options.type ?? (options.htmlFile ? 'html' : defaultToView ? 'view' : undefined);
	if (raw === undefined) return undefined;
	if (!MOVEMENT_VIEW_TYPES.includes(raw as MovementViewType)) {
		console.error(`Error: --type must be one of: ${MOVEMENT_VIEW_TYPES.join(', ')}`);
		process.exit(1);
	}
	return raw as MovementViewType;
}

/** Resolve inline/file content, with --html-file as an ergonomic HTML alias. */
function resolveMovementBody(options: MovementAddOptions): string | undefined {
	if (options.bodyFile && options.htmlFile) {
		console.error('Error: use only one of --body-file or --html-file');
		process.exit(1);
	}
	return resolveBody(options.body, options.htmlFile ?? options.bodyFile);
}

/** Parse an optional numeric flag, exiting on a non-number. */
function parseNum(name: string, raw: string | undefined): number | undefined {
	if (raw === undefined) return undefined;
	const n = Number(raw);
	if (!Number.isFinite(n)) {
		console.error(`Error: --${name} must be a number`);
		process.exit(1);
	}
	return n;
}

/** Send one movement op over the bridge and report the result. */
async function sendMovement(
	payload: MovementPayload,
	json: boolean | undefined,
	successMessage: string
): Promise<void> {
	if (!MOVEMENT_OPS.includes(payload.op)) {
		console.error(`Error: op must be one of: ${MOVEMENT_OPS.join(', ')}`);
		process.exit(1);
	}
	try {
		const result = await withMaestroClient(async (client) =>
			client.sendCommand<{ type: string; success: boolean; error?: string }>(
				{ type: 'movement', ...payload },
				'movement_result'
			)
		);
		if (result.success) {
			if (json) console.log(JSON.stringify({ success: true, id: payload.id, op: payload.op }));
			else console.log(successMessage);
		} else {
			const error = result.error || 'Failed to update movement';
			if (json) console.log(JSON.stringify({ success: false, error }));
			else console.error(`Error: ${error}`);
			process.exit(1);
		}
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		if (json) console.log(JSON.stringify({ success: false, error: msg }));
		else console.error(`Error: ${msg}`);
		process.exit(1);
	}
}

function requireId(id: string, op: MovementOp): void {
	if (!id.trim()) {
		console.error(`Error: id cannot be empty for movement ${op}`);
		process.exit(1);
	}
}

export async function movementAdd(id: string, options: MovementAddOptions): Promise<void> {
	requireId(id, 'add');
	const viewType = resolveViewType(options, true);
	const body = resolveMovementBody(options);
	if (!body) {
		console.error(
			viewType === 'html'
				? 'Error: --body, --body-file, or --html-file (an HTML document) is required'
				: 'Error: --body or --body-file (a JSON block spec) is required'
		);
		process.exit(1);
	}
	await sendMovement(
		{
			op: 'add',
			id,
			viewType,
			x: parseNum('x', options.x),
			y: parseNum('y', options.y),
			width: parseNum('width', options.width),
			height: parseNum('height', options.height),
			title: options.title,
			body,
		},
		options.json,
		`Movement item '${id}' added`
	);
}

export async function movementUpdate(id: string, options: MovementAddOptions): Promise<void> {
	requireId(id, 'update');
	const viewType = resolveViewType(options, false);
	await sendMovement(
		{
			op: 'update',
			id,
			viewType,
			x: parseNum('x', options.x),
			y: parseNum('y', options.y),
			width: parseNum('width', options.width),
			height: parseNum('height', options.height),
			title: options.title,
			body: resolveMovementBody(options),
		},
		options.json,
		`Movement item '${id}' updated`
	);
}

export async function movementMove(id: string, options: MovementMoveOptions): Promise<void> {
	requireId(id, 'move');
	const x = parseNum('x', options.x);
	const y = parseNum('y', options.y);
	if (x === undefined || y === undefined) {
		console.error('Error: movement move requires --x and --y');
		process.exit(1);
	}
	await sendMovement({ op: 'move', id, x, y }, options.json, `Movement item '${id}' moved`);
}

export async function movementRemove(id: string, options: MovementRemoveOptions): Promise<void> {
	requireId(id, 'remove');
	await sendMovement({ op: 'remove', id }, options.json, `Movement item '${id}' removed`);
}

export async function movementClear(options: MovementRemoveOptions): Promise<void> {
	await sendMovement({ op: 'clear' }, options.json, 'Movement cleared');
}

/** Read the current movement layout (items + size) so you can place around it. */
export async function movementState(options: { json?: boolean }): Promise<void> {
	try {
		const result = await withMaestroClient(async (client) =>
			client.sendCommand<{
				success: boolean;
				snapshot?: MovementStateSnapshot | null;
				error?: string;
			}>({ type: 'get_movement_state' }, 'movement_state_result')
		);
		if (!result.success) {
			console.error(`Error: ${result.error || 'Failed to read movement state'}`);
			process.exit(1);
		}
		const snapshot = result.snapshot ?? { items: [], width: 0, height: 0 };
		if (options.json) {
			console.log(JSON.stringify(snapshot));
			return;
		}
		console.log(`Movement ${snapshot.width}x${snapshot.height}, ${snapshot.items.length} item(s):`);
		for (const it of snapshot.items) {
			const title = it.title ? `  "${it.title}"` : '';
			console.log(`  ${it.id}  (${it.x},${it.y}) ${it.width}x${it.height}${title}`);
		}
	} catch (error) {
		console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}
}

/** Capture the live mockup exactly as rendered and save it as a PNG. */
export async function movementInspect(id: string, options: MovementInspectOptions): Promise<void> {
	requireId(id, 'update');
	if (!options.output) {
		console.error('Error: movement inspect requires --output <png>');
		process.exit(1);
	}
	try {
		const result = await withMaestroClient(async (client) =>
			client.sendCommand<{
				success: boolean;
				inspection?: MovementDesignerInspection | null;
				error?: string;
			}>({ type: 'get_movement_designer_inspection', id }, 'movement_designer_inspection_result')
		);
		if (!result.success || !result.inspection) {
			console.error(`Error: ${result.error || `Could not inspect HTML Movement '${id}'`}`);
			process.exit(1);
		}
		const match = /^data:image\/png;base64,(.+)$/s.exec(result.inspection.imageDataUrl);
		if (!match) {
			console.error('Error: Maestro returned an invalid designer screenshot');
			process.exit(1);
		}
		const output = path.resolve(options.output);
		mkdirSync(path.dirname(output), { recursive: true });
		writeFileSync(output, Buffer.from(match[1], 'base64'));
		const report = {
			id,
			output,
			ready: result.inspection.ready,
			viewport: result.inspection.viewport,
			image: result.inspection.image,
			logs: result.inspection.logs,
		};
		if (options.json) {
			console.log(JSON.stringify(report));
			return;
		}
		console.log(
			`Saved HTML Movement '${id}' preview to ${output} (${report.viewport.width}x${report.viewport.height} CSS px, ${report.image.width}x${report.image.height} image px at ${report.image.scaleFactor}x)`
		);
		if (report.logs.length === 0) {
			console.log('Runtime diagnostics: clean');
			return;
		}
		console.log(`Runtime diagnostics (${report.logs.length}):`);
		for (const entry of report.logs) {
			const location = entry.line ? `:${entry.line}${entry.column ? `:${entry.column}` : ''}` : '';
			console.log(`  [${entry.level}]${location} ${entry.message}`);
		}
	} catch (error) {
		console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}
}

/** Click or enter text inside a live sandboxed HTML Movement by CSS selector. */
export async function movementInteract(
	id: string,
	options: MovementInteractOptions
): Promise<void> {
	requireId(id, 'update');
	const selected = [options.click !== undefined, options.type !== undefined].filter(Boolean).length;
	if (selected !== 1) {
		console.error('Error: movement interact requires exactly one of --click or --type');
		process.exit(1);
	}
	if (options.type !== undefined && options.value === undefined) {
		console.error('Error: --type requires --value');
		process.exit(1);
	}
	const action: ConcertoDesignerAction =
		options.click !== undefined
			? { kind: 'click', selector: options.click }
			: { kind: 'type', selector: options.type ?? '', value: options.value ?? '' };
	try {
		const response = await withMaestroClient(async (client) =>
			client.sendCommand<{
				success: boolean;
				result?: ConcertoDesignerActionResult;
				error?: string;
			}>({ type: 'interact_movement_designer', id, action }, 'movement_designer_interaction_result')
		);
		const result = response.result;
		if (!response.success || !result?.ok) {
			const error = result?.message || response.error || 'Designer interaction failed';
			if (options.json) console.log(JSON.stringify({ success: false, error, result }));
			else console.error(`Error: ${error}`);
			process.exit(1);
		}
		if (options.json) console.log(JSON.stringify({ success: true, result }));
		else console.log(`${result.message}: ${result.selector}`);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (options.json) console.log(JSON.stringify({ success: false, error: message }));
		else console.error(`Error: ${message}`);
		process.exit(1);
	}
}
