/**
 * Wire contract of the delivery receipt for a `remote:executeCommand` send
 * (`maestro-cli dispatch`, the web composer, a Cue pipeline, a voice session).
 *
 * The receipt has to be TRUE in both directions: "not delivered" must mean the
 * prompt will never run, and "accepted" must mean the renderer took it. A
 * single reply raced against a timer cannot promise either. A renderer that is
 * slow (a long `git status` while it builds the system prompt) or frozen
 * answers late, the sender has already reported a failure, and the prompt then
 * runs anyway. That is how a voice session ended on "The prompt was not
 * delivered (renderer-timeout)" beside the reply to that very prompt.
 *
 * So delivery is three steps, and no step guesses:
 *
 * 1. **Claim.** The renderer asks main whether the command is still wanted
 *    (`REMOTE_COMMAND_CLAIM_CHANNEL`, an invoke) before it runs any of it. Main
 *    answers on one thread, so exactly one of these is true: main is still
 *    waiting and the command runs, or main gave up and the command is dropped.
 * 2. **Outcome.** Once claimed, the renderer owns the command and reports what
 *    happened on the receipt channel when it knows: accepted when the turn
 *    started, or the reason it was refused. No timer answers for it.
 * 3. **Handover.** A sender that cannot wait for a slow outcome (the CLI has
 *    its own reply deadline) stops waiting and reports the claim itself:
 *    `accepted` with `pending`. The renderer still owns the command and shows
 *    any later failure in the tab.
 *
 * Main side: `requestRemoteCommandReceipt()` in
 * `src/main/web-server/callbacks/remoteCommandReceipt.ts`. Renderer side: the
 * `remote:executeCommand` listener in `src/main/preload/process/commandRemote.ts`.
 */

/** The renderer's answer to a remote command, as the sender reads it. */
export interface RemoteCommandReceipt {
	/** The renderer took the command for execution. */
	accepted: boolean;
	/** Why it was refused: `code` or `code:detail` (the detail can carry input). */
	reason?: string;
	/**
	 * The renderer never claimed the command. It was not run and never will be:
	 * a claim that arrives after this is refused.
	 */
	timedOut?: boolean;
	/**
	 * The renderer claimed the command and had not reported an outcome when the
	 * sender stopped waiting. Delivered; whether the turn started is not known.
	 */
	pending?: boolean;
	/** Accepted, and a hosted agent's host queued it behind the running turn. */
	queued?: { itemId: string; position: number };
}

/** The longest host queue item id a receipt may carry (ids are UUIDs; this bounds a bad one). */
const MAX_RECEIPT_ITEM_ID_CHARS = 200;

/** A receipt's `queued` field, checked: an item id and a 1-based position, or nothing. */
function parseReceiptQueued(raw: unknown): RemoteCommandReceipt['queued'] {
	if (typeof raw !== 'object' || raw === null) return undefined;
	const { itemId, position } = raw as { itemId?: unknown; position?: unknown };
	if (typeof itemId !== 'string' || !itemId || itemId.length > MAX_RECEIPT_ITEM_ID_CHARS) {
		return undefined;
	}
	if (typeof position !== 'number' || !Number.isSafeInteger(position) || position < 1) {
		return undefined;
	}
	return { itemId, position };
}

/**
 * The invoke channel a renderer claims a command on. The argument is the
 * command's receipt channel; the answer is `true` to run it, anything else to
 * drop it.
 */
export const REMOTE_COMMAND_CLAIM_CHANNEL = 'remote:claimCommand';

/**
 * How long main waits for a renderer to claim a command. A healthy renderer
 * claims within milliseconds, so this bounds only a frozen or missing one.
 */
export const REMOTE_COMMAND_CLAIM_TIMEOUT_MS = 3000;

/** The receipt of a command no renderer claimed in time. */
export const UNCLAIMED_REMOTE_COMMAND_RECEIPT: RemoteCommandReceipt = {
	accepted: false,
	reason: 'renderer-timeout',
	timedOut: true,
};

/** The receipt of a claimed command whose outcome the sender stopped waiting for. */
export const PENDING_REMOTE_COMMAND_RECEIPT: RemoteCommandReceipt = {
	accepted: true,
	pending: true,
};

/**
 * Narrow what a renderer sent on a receipt channel. Anything that is not a
 * boolean `accepted` is a failure, never a truthy object read as success.
 */
export function parseRemoteCommandReceipt(raw: unknown): RemoteCommandReceipt {
	if (typeof raw === 'object' && raw !== null && 'accepted' in raw) {
		const receipt = raw as { accepted: unknown; reason?: unknown; queued?: unknown };
		if (typeof receipt.accepted === 'boolean') {
			const queued = receipt.accepted ? parseReceiptQueued(receipt.queued) : undefined;
			return {
				accepted: receipt.accepted,
				reason: typeof receipt.reason === 'string' ? receipt.reason : undefined,
				...(queued ? { queued } : {}),
			};
		}
	}
	return { accepted: false, reason: 'malformed-receipt' };
}
