// src/main/codex-app-server/steering.ts

/**
 * Chat steering for a Codex turn on the app-server transport: the `turn/steer`
 * counterpart of maestro-p's socket client (`process-manager/steering-client.ts`).
 *
 * Answers in the SAME two steps as the Claude path, with the same frame shape
 * (`SteeringResultFrame` in `src/shared/chatSteering.ts`), so the renderer holds
 * and settles a Codex steer exactly as it does a Claude one:
 *
 *   1. The returned frame is the RPC's answer: `delivered` when the server took
 *      the input, `refused` (`not-running`) when the turn had already ended or
 *      moved on, `unknown` when nobody can say where the text went.
 *   2. A delivered steer is later settled through `onVerdict`: `absorbed` when
 *      the server echoes the text back as a `userMessage` inside the steered
 *      turn, `dropped` when the turn ends (or the child exits) first. A turn
 *      that ended before the RPC's answer was read is `refused` instead (see
 *      the end of `steerCodexAppServerTurn`).
 *
 * There is no `queued` verdict on this transport: a process runs one turn, so a
 * steer either lands in the running turn or never lands at all.
 *
 * Evidence for every outcome is in `docs/agent-guides/CODEX-APP-SERVER.md`
 * ("Steering").
 */

import {
	STEERING_REPLY_TIMEOUT_MS,
	STEERING_TOO_LONG_DETAIL,
	STEERING_TURN_FINISHED_DETAIL,
	steeringTextMatches,
	steeringTextTooLong,
	type SteeringResultFrame,
	type SteeringVerdict,
} from '../../shared/chatSteering';
import type { CodexAppServerProcessHandle } from './protocol';
import { CodexRpcRequestError } from './rpc-client';

/**
 * The JSON-RPC code the server answers a steer with when the turn it names is
 * not the one running: "no active turn to steer" (`late-steer:38`), and the
 * same code when `expectedTurnId` no longer matches. Nothing was taken in, so
 * the caller still owns the message.
 */
export const CODEX_STEER_NOT_RUNNING_CODE = -32600;

/**
 * `userMessage` items already credited to a steer, per turn handle. Two steers
 * with the same text must not both be absorbed by one echo; the first one to
 * see the item claims it and the other keeps waiting.
 */
const claimedItems = new WeakMap<CodexAppServerProcessHandle, Set<string>>();

function claimedItemsFor(handle: CodexAppServerProcessHandle): Set<string> {
	let claimed = claimedItems.get(handle);
	if (!claimed) {
		claimed = new Set();
		claimedItems.set(handle, claimed);
	}
	return claimed;
}

/**
 * Ask a running app-server turn to take `text` into the turn in flight.
 * Resolves with the immediate answer and never rejects; the later verdict for a
 * delivered steer arrives through `onVerdict`, carrying the same `id`.
 */
export async function steerCodexAppServerTurn(
	handle: CodexAppServerProcessHandle,
	request: { id: string; text: string },
	onVerdict: (verdict: SteeringResultFrame) => void,
	options: { timeoutMs?: number } = {}
): Promise<SteeringResultFrame> {
	const { id, text } = request;
	const frame = (
		verdict: SteeringVerdict,
		extra: Partial<SteeringResultFrame> = {}
	): SteeringResultFrame => ({ type: 'steering', id, verdict, ...extra });
	const notRunning = () =>
		frame('refused', { refusal: 'not-running', detail: STEERING_TURN_FINISHED_DETAIL });

	if (steeringTextTooLong(text)) {
		return frame('refused', { refusal: 'too-long', detail: STEERING_TOO_LONG_DETAIL });
	}
	const threadId = handle.threadId;
	const turnId = handle.activeTurnId;
	if (!threadId || !turnId) return notRunning();

	// Subscribe BEFORE sending: the echo or the turn's end can race the RPC's
	// answer, and an outcome seen early is held until the steer is `delivered`.
	let outcome: 'absorbed' | 'dropped' | null = null;
	// Read through a call: the listeners assign `outcome`, and TS would otherwise
	// keep it narrowed to `null` for the rest of this function.
	const seen = () => outcome;
	let delivered = false;
	let settled = false;
	const claimed = claimedItemsFor(handle);
	const unsubscribe = () => {
		offMessage();
		offTurnEnd();
	};
	const settle = () => {
		if (settled || !outcome) return;
		settled = true;
		unsubscribe();
		onVerdict(frame(outcome));
	};

	const offMessage = handle.onUserMessage((message) => {
		if (outcome || message.turnId !== turnId || claimed.has(message.itemId)) return;
		if (!steeringTextMatches(message.text, text)) return;
		claimed.add(message.itemId);
		outcome = 'absorbed';
		if (delivered) settle();
	});
	const offTurnEnd = handle.onTurnEnd(() => {
		if (outcome) return;
		outcome = 'dropped';
		if (delivered) settle();
	});

	// The child left without a `turn/completed` (which would have cleared the
	// active turn id): there is no turn to steer.
	if (seen() === 'dropped') {
		unsubscribe();
		return notRunning();
	}

	try {
		await handle.sendRequest(
			'turn/steer',
			{ threadId, expectedTurnId: turnId, input: [{ type: 'text', text }] },
			{ timeoutMs: options.timeoutMs ?? STEERING_REPLY_TIMEOUT_MS }
		);
	} catch (error) {
		settled = true;
		unsubscribe();
		if (error instanceof CodexRpcRequestError && error.code === CODEX_STEER_NOT_RUNNING_CODE) {
			return notRunning();
		}
		// A timeout or a lost child may have followed a successful write, so this
		// is `unknown`, never `refused`: a re-send could double the message.
		return frame('unknown', {
			detail: `Codex did not confirm the steer: ${error instanceof Error ? error.message : String(error)}`,
		});
	}

	// The turn ended, with no echo, before the server's answer was even read:
	// answer the way `dropped` would settle it (the caller keeps the message and
	// sends it normally) but synchronously. A `dropped` raised after `delivered`
	// would race the turn's exit to the renderer, and an exit that wins settles
	// the held steer as unconfirmed instead.
	if (seen() === 'dropped') {
		settled = true;
		unsubscribe();
		return notRunning();
	}

	delivered = true;
	// An echo seen while the request was in flight is reported on the next tick,
	// so the caller has `delivered` in hand before the verdict that settles it.
	if (seen()) setTimeout(settle, 0);
	return frame('delivered');
}
