// Movement command - compose the agent-driven "living view" in the Maestro desktop
// app. The movement is a roomy main-window surface where the agent free-places
// items (add/update/move/remove/clear), each rendering a BlockView spec (the
// same JSON block vocabulary as `view --type view`). Rides the same bridge as
// notify/view.

import { readFileSync } from 'fs';
import { withMaestroClient } from '../services/maestro-client';
import {
	MOVEMENT_OPS,
	type MovementOp,
	type MovementPayload,
	type MovementStateSnapshot,
} from '../../shared/movement-types';

interface MovementAddOptions {
	x?: string;
	y?: string;
	width?: string;
	height?: string;
	title?: string;
	body?: string;
	bodyFile?: string;
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
	const body = resolveBody(options.body, options.bodyFile);
	if (!body) {
		console.error('Error: --body or --body-file (a JSON block spec) is required');
		process.exit(1);
	}
	await sendMovement(
		{
			op: 'add',
			id,
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
	await sendMovement(
		{
			op: 'update',
			id,
			x: parseNum('x', options.x),
			y: parseNum('y', options.y),
			width: parseNum('width', options.width),
			height: parseNum('height', options.height),
			title: options.title,
			body: resolveBody(options.body, options.bodyFile),
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
