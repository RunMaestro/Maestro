/**
 * Movement domain WebSocket message handlers.
 *
 * Extracted from WebSocketMessageHandler.ts. Handles: movement, get_movement_state,
 * get_movement_designer_inspection, interact_movement_designer.
 */

import {
	CONCERTO_CREATION_PHASES,
	CONCERTO_PROGRESS_MAX_STEPS,
	CONCERTO_PROGRESS_NOTE_VALUES,
	MOVEMENT_OPS,
	MOVEMENT_VIEW_TYPES,
	type ConcertoCreationPhase,
	type ConcertoProgressNote,
	type ConcertoProgressNoteValue,
	type MovementOp,
	type MovementPayload,
	type MovementStateSnapshot,
	type MovementViewType,
} from '../../../../shared/movement-types';
import type {
	ConcertoDesignerAction,
	ConcertoDesignerActionResult,
	MovementDesignerInspection,
} from '../../../../shared/concerto-html';
import type { WebClient, WebClientMessage, MessageHandlerContext } from './types';

/**
 * Handle movement - begin/add/update/move/remove/clear an item on the agent-driven
 * movement. Validates op + id, then hands a typed payload to the renderer via
 * the movementView callback (the `remote:movement` channel).
 */
export function handleMovement(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const op = typeof message.op === 'string' ? (message.op as MovementOp) : undefined;
	const rawId = typeof message.id === 'string' ? message.id : '';
	const id = rawId.trim();

	const sendResult = (success: boolean, error?: string) => {
		ctx.send(client, { type: 'movement_result', success, error, requestId: message.requestId });
	};

	if (!op || !MOVEMENT_OPS.includes(op)) {
		sendResult(false, `Invalid or missing op. Must be one of: ${MOVEMENT_OPS.join(', ')}`);
		return;
	}
	if (op !== 'clear' && !id) {
		sendResult(false, `Missing movement item id for op '${op}'`);
		return;
	}
	if (op !== 'clear' && rawId !== id) {
		sendResult(false, 'Movement item id must not contain surrounding whitespace');
		return;
	}

	let viewType: MovementViewType | undefined;
	const rawViewType = typeof message.viewType === 'string' ? message.viewType : undefined;
	if (rawViewType !== undefined) {
		if (!MOVEMENT_VIEW_TYPES.includes(rawViewType as MovementViewType)) {
			sendResult(
				false,
				`Invalid viewType: ${rawViewType}. Must be one of: ${MOVEMENT_VIEW_TYPES.join(', ')}`
			);
			return;
		}
		viewType = rawViewType as MovementViewType;
	}
	const body = typeof message.body === 'string' ? message.body : undefined;
	if ((op === 'add' || op === 'update') && viewType === 'html' && body === undefined) {
		sendResult(false, `Movement ${op} requires HTML content when viewType is 'html'`);
		return;
	}
	const title = typeof message.title === 'string' ? message.title.trim() : '';
	if (op === 'begin') {
		if (!title) {
			sendResult(false, 'Movement begin requires a non-empty title');
			return;
		}
		if (body !== undefined) {
			sendResult(false, 'Movement begin uses a host-rendered shell and does not accept content');
			return;
		}
		viewType = 'html';
	}
	let phase: ConcertoCreationPhase | undefined;
	let step: number | undefined;
	let steps: number | undefined;
	let notes: ConcertoProgressNote[] | undefined;
	if (op === 'progress') {
		const rawPhase = typeof message.phase === 'string' ? message.phase : '';
		if (!CONCERTO_CREATION_PHASES.includes(rawPhase as ConcertoCreationPhase)) {
			sendResult(
				false,
				`Invalid or missing phase. Must be one of: ${CONCERTO_CREATION_PHASES.join(', ')}`
			);
			return;
		}
		if (!title) {
			sendResult(false, 'Movement progress requires a non-empty title');
			return;
		}
		phase = rawPhase as ConcertoCreationPhase;
		if (message.notes !== undefined) {
			if (!Array.isArray(message.notes) || message.notes.length === 0) {
				sendResult(false, 'Invalid notes: expected a non-empty array');
				return;
			}
			notes = [];
			for (const [index, rawNote] of message.notes.entries()) {
				if (!rawNote || typeof rawNote !== 'object') {
					sendResult(false, `Invalid note ${index + 1}: expected an object`);
					return;
				}
				const note = rawNote as Record<string, unknown>;
				if (!CONCERTO_PROGRESS_NOTE_VALUES.includes(note.value as ConcertoProgressNoteValue)) {
					sendResult(false, `Invalid note ${index + 1}: unsupported value`);
					return;
				}
				const invalidModifier = (['dotted', 'triad', 'tie'] as const).find(
					(modifier) => note[modifier] !== undefined && typeof note[modifier] !== 'boolean'
				);
				if (invalidModifier) {
					sendResult(false, `Invalid note ${index + 1}: ${invalidModifier} must be boolean`);
					return;
				}
				notes.push({
					value: note.value as ConcertoProgressNoteValue,
					...(note.dotted === true && { dotted: true }),
					...(note.triad === true && { triad: true }),
					...(note.tie === true && { tie: true }),
				});
			}
			if (notes.at(-1)?.tie) {
				sendResult(false, 'Invalid notes: the final note cannot tie forward');
				return;
			}
		}
		steps = message.steps === undefined ? (notes?.length ?? 1) : Number(message.steps);
		step = message.step === undefined ? 1 : Number(message.step);
		if (!Number.isInteger(steps) || steps < 1 || steps > CONCERTO_PROGRESS_MAX_STEPS) {
			sendResult(
				false,
				`Invalid steps: must be an integer from 1 through ${CONCERTO_PROGRESS_MAX_STEPS}`
			);
			return;
		}
		if (!Number.isInteger(step) || step < 1 || step > steps) {
			sendResult(false, `Invalid step: must be an integer from 1 through steps (${steps})`);
			return;
		}
		if (notes && notes.length !== steps) {
			sendResult(false, `Invalid notes: expected exactly ${steps} entries`);
			return;
		}
	}

	// Finite-only: JSON can smuggle Infinity (1e400) or NaN through `typeof
	// v === 'number'`, which would become invalid CSS geometry downstream.
	const num = (v: unknown): number | undefined =>
		typeof v === 'number' && Number.isFinite(v) ? v : undefined;
	const badGeometry = (['x', 'y', 'width', 'height'] as const).find(
		(k) => message[k] !== undefined && num(message[k]) === undefined
	);
	if (badGeometry) {
		sendResult(false, `Invalid ${badGeometry}: must be a finite number`);
		return;
	}
	const payload: MovementPayload = {
		op,
		id: id || undefined,
		viewType,
		x: num(message.x),
		y: num(message.y),
		width: num(message.width),
		height: num(message.height),
		title: title || undefined,
		body,
		phase,
		step,
		steps,
		notes,
	};

	if (!ctx.callbacks.movementView) {
		sendResult(false, 'Movement not configured');
		return;
	}
	ctx.callbacks
		.movementView(payload)
		.then((success) => sendResult(success, success ? undefined : 'Failed to update movement'))
		.catch((error) => sendResult(false, `Failed to update movement: ${error.message}`));
}

/**
 * Handle get_movement_state - return the current movement snapshot (items + size)
 * so an agent can compose around what's already placed.
 */
export function handleGetMovementState(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const sendResult = (snapshot: MovementStateSnapshot | null, error?: string) => {
		ctx.send(client, {
			type: 'movement_state_result',
			success: !error,
			snapshot,
			error,
			requestId: message.requestId,
		});
	};
	if (!ctx.callbacks.getMovementState) {
		sendResult(null, 'Movement not configured');
		return;
	}
	ctx.callbacks
		.getMovementState()
		// A null snapshot means the read did NOT happen (flag off, renderer gone,
		// or timeout) - report failure so callers can retry instead of composing
		// against a false empty 0x0 layout.
		.then((snapshot) =>
			snapshot
				? sendResult(snapshot)
				: sendResult(null, 'Movement state unavailable (Concerto off or renderer not responding)')
		)
		.catch((error) => sendResult(null, `Failed to read movement state: ${error.message}`));
}

/** Capture a live HTML Movement and return its diagnostics to the CLI. */
export function handleGetMovementDesignerInspection(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const rawId = typeof message.id === 'string' ? message.id : '';
	const id = rawId.trim();
	const sendResult = (inspection: MovementDesignerInspection | null, error?: string) => {
		ctx.send(client, {
			type: 'movement_designer_inspection_result',
			success: !error,
			inspection,
			error,
			requestId: message.requestId,
		});
	};
	if (!id) {
		sendResult(null, 'Missing movement item id');
		return;
	}
	if (rawId !== id) {
		sendResult(null, 'Movement item id must not contain surrounding whitespace');
		return;
	}
	if (!ctx.callbacks.getMovementDesignerInspection) {
		sendResult(null, 'Movement designer inspection is not configured');
		return;
	}
	ctx.callbacks
		.getMovementDesignerInspection(id)
		.then((inspection) =>
			inspection
				? sendResult(inspection)
				: sendResult(null, `HTML Movement '${id}' is not visible or did not load`)
		)
		.catch((error) => sendResult(null, `Failed to inspect Movement: ${error.message}`));
}

/** Perform a click or text entry inside the sandboxed HTML Movement. */
export function handleInteractMovementDesigner(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const rawId = typeof message.id === 'string' ? message.id : '';
	const id = rawId.trim();
	const rawAction = message.action as Record<string, unknown> | undefined;
	const selector = typeof rawAction?.selector === 'string' ? rawAction.selector.trim() : '';
	const kind = rawAction?.kind;
	const sendResult = (result: ConcertoDesignerActionResult) => {
		ctx.send(client, {
			type: 'movement_designer_interaction_result',
			success: result.ok,
			result,
			error: result.ok ? undefined : result.message,
			requestId: message.requestId,
		});
	};
	if (!id || !selector || (kind !== 'click' && kind !== 'type')) {
		sendResult({
			ok: false,
			action: kind === 'type' ? 'type' : 'click',
			selector,
			message: 'Interaction requires an id, a CSS selector, and click or type action',
		});
		return;
	}
	if (rawId !== id) {
		sendResult({
			ok: false,
			action: kind,
			selector,
			message: 'Movement item id must not contain surrounding whitespace',
		});
		return;
	}
	if (selector.length > 2048) {
		sendResult({
			ok: false,
			action: kind,
			selector,
			message: 'CSS selector is too long',
		});
		return;
	}
	const value = typeof rawAction?.value === 'string' ? rawAction.value : '';
	if (kind === 'type' && value.length > 100_000) {
		sendResult({ ok: false, action: kind, selector, message: 'Input value is too long' });
		return;
	}
	const action: ConcertoDesignerAction =
		kind === 'click' ? { kind, selector } : { kind, selector, value };
	if (!ctx.callbacks.interactMovementDesigner) {
		sendResult({
			ok: false,
			action: action.kind,
			selector,
			message: 'Movement designer interaction is not configured',
		});
		return;
	}
	ctx.callbacks
		.interactMovementDesigner(id, action)
		.then(sendResult)
		.catch((error) =>
			sendResult({
				ok: false,
				action: action.kind,
				selector,
				message: `Failed to interact with Movement: ${error.message}`,
			})
		);
}
