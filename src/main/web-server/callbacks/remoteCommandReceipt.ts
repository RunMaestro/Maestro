import { randomUUID } from 'crypto';
import { ipcMain, type BrowserWindow, type WebContents } from 'electron';
import {
	PENDING_REMOTE_COMMAND_RECEIPT,
	REMOTE_COMMAND_CLAIM_CHANNEL,
	REMOTE_COMMAND_CLAIM_TIMEOUT_MS,
	UNCLAIMED_REMOTE_COMMAND_RECEIPT,
	parseRemoteCommandReceipt,
	type RemoteCommandReceipt,
} from '../../../shared/remoteCommandReceipt';

/**
 * Main's half of the remote command receipt. The contract, and why it is a
 * claim followed by an outcome instead of one reply raced against a timer, is
 * in `src/shared/remoteCommandReceipt.ts`.
 */

/** A command sent to a renderer that has not been claimed yet. */
interface UnclaimedCommand {
	/** The only renderer allowed to claim it. */
	owner: WebContents;
	/** Move the wait from "is anyone there" to "what happened". */
	claim: () => void;
}

/** Commands still waiting for their claim, by receipt channel. */
const unclaimed = new Map<string, UnclaimedCommand>();

let claimHandlerRegistered = false;

/**
 * Answer a renderer's claim. Registered on the first request, which is always
 * before the first claim: a renderer can only claim a command it was sent.
 *
 * The lookup and the removal are one synchronous step on main's thread, which
 * is what makes the receipt true. A command whose claim window closed is no
 * longer in the map, so its late claim is refused and the renderer drops it.
 */
function ensureClaimHandler(): void {
	if (claimHandlerRegistered) return;
	claimHandlerRegistered = true;
	ipcMain.handle(REMOTE_COMMAND_CLAIM_CHANNEL, (event, receiptChannel: unknown): boolean => {
		if (typeof receiptChannel !== 'string') return false;
		const command = unclaimed.get(receiptChannel);
		if (!command || command.owner !== event.sender) return false;
		unclaimed.delete(receiptChannel);
		command.claim();
		return true;
	});
}

export interface RemoteCommandReceiptOptions {
	/**
	 * How long to wait for the outcome once the renderer has claimed the
	 * command. When it runs out the receipt is `accepted` and `pending`: the
	 * renderer owns the command, and the caller stops waiting to learn whether
	 * the turn started.
	 */
	outcomeTimeoutMs: number;
	/** How long the renderer has to claim the command. */
	claimTimeoutMs?: number;
}

/**
 * Send `remote:executeCommand` to a window and resolve with its receipt.
 *
 * `args` are the channel's positional arguments without the receipt channel,
 * which is appended last. Never rejects. The caller must have already
 * confirmed the window's webContents.
 */
export function requestRemoteCommandReceipt(
	win: BrowserWindow,
	args: unknown[],
	options: RemoteCommandReceiptOptions
): Promise<RemoteCommandReceipt> {
	const { outcomeTimeoutMs, claimTimeoutMs = REMOTE_COMMAND_CLAIM_TIMEOUT_MS } = options;
	ensureClaimHandler();
	return new Promise<RemoteCommandReceipt>((resolve) => {
		const receiptChannel = `remote:executeCommand:response:${randomUUID()}`;
		const owner = win.webContents;
		let settled = false;
		const finish = (receipt: RemoteCommandReceipt) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			unclaimed.delete(receiptChannel);
			ipcMain.removeListener(receiptChannel, onOutcome);
			resolve(receipt);
		};
		const onOutcome = (event: Electron.IpcMainEvent, raw: unknown) => {
			if (event.sender !== owner) return;
			finish(parseRemoteCommandReceipt(raw));
		};
		// Armed before the send, like `requestFromRenderer`: `finish` clears it,
		// and a send that throws runs `finish` at once.
		let timer = setTimeout(() => finish(UNCLAIMED_REMOTE_COMMAND_RECEIPT), claimTimeoutMs);
		unclaimed.set(receiptChannel, {
			owner,
			claim: () => {
				clearTimeout(timer);
				timer = setTimeout(() => finish(PENDING_REMOTE_COMMAND_RECEIPT), outcomeTimeoutMs);
			},
		});
		ipcMain.on(receiptChannel, onOutcome);
		try {
			owner.send('remote:executeCommand', ...args, receiptChannel);
		} catch {
			finish(UNCLAIMED_REMOTE_COMMAND_RECEIPT);
		}
	});
}
