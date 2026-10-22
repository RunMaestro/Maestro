/**
 * Chain of thought export: the IPC handlers of its one control.
 *
 * WHO MAY CALL THESE
 * A person at the desktop app, through the section in the Edit Agent dialog.
 * Nobody else. That is the whole reason this file registers its channels by
 * hand: the web bridge (`web-server/handlers/bridgeHandlers.ts`) dispatches
 * ANY registered `ipcMain` handler to whoever holds its token, and an agent's
 * shell can read that token. So every handler here first proves that the call
 * came from a window of the desktop app (`assertDesktopSender`), and that
 * proof needs the IPC event.
 *
 * `createIpcHandler`, `createHandler`, and `withIpcErrorLogging` all drop the
 * event before they call the handler. Do not move these channels onto them: a
 * handler behind one of them cannot tell the desktop window from the bridge.
 *
 * WHAT THIS FILE NEVER DOES
 * - It sends nothing to the renderer. A value leaves only as the answer to
 *   the desktop window that asked. An event pushed with `safeSend` also fans
 *   out to every web client.
 * - It writes nothing to Maestro's logs, and reports nothing to Sentry.
 *   Agents can read the logs.
 * - It touches no agent (`Session`) object, no settings, no agent config.
 *
 * The one thing it raises by its own choice is a native OS notification, when
 * a log starts to fail. That goes to the person's screen and nowhere else.
 *
 * This feature is hidden from agents on purpose. Read the header of
 * `src/shared/cotExport/types.ts` before you change or expose anything here.
 * Do not add these channels to any guide.
 */

import { BrowserWindow, Notification, ipcMain, webContents } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { COT_EXPORT_CHANNELS } from '../../../shared/cotExport/channels';
import type { CotExportChannelName } from '../../../shared/cotExport/channels';
import type {
	CotAgentConfig,
	CotAgentStatus,
	CotChainVerifyResult,
	CotFolderValidation,
	CotSetResult,
} from '../../../shared/cotExport/types';
import { DURATION_MS } from '../../../shared/duration';
import {
	getCotConfigStore,
	setCotFailureListener,
	setCotStateAnchor,
} from '../../cot-export/config-store';
import type { CotFailureListener, CotStateProblemKind } from '../../cot-export/config-store';
import type { AnchorStore } from '../../utils/keyring-anchor';
import { getCotWriter } from '../../cot-export/runtime';
import { verifyAgentChain } from '../../cot-export/verify';
import { markDesktopOnlyChannel } from '../desktop-only-channels';

// ============================================================================
// The sender check
// ============================================================================

/**
 * The whole answer to a caller that is not the desktop app. It says nothing
 * more on purpose: not which check failed, and not what the channel is for.
 */
const NOT_AVAILABLE = 'Not available';

/** Whether a window is one the person works in. Set by `registerCotExportHandlers`. */
let isAppWindow: (window: BrowserWindow) => boolean = () => false;

/**
 * Whether an IPC call came from a window of the desktop app.
 *
 * Every one of these must hold, and any doubt is a no:
 * - The event has a sender, and it is the `WebContents` Electron itself keeps
 *   under that id. The bridge's synthetic event has no sender at all, and an
 *   object that only looks like a `WebContents` is not the one Electron has.
 * - The sender is a window. A `<webview>` guest (an embedded browser tab) is
 *   owned by a window too, so the owner alone does not tell them apart.
 * - The call came from the window's own page, not from a frame inside it.
 * - A `BrowserWindow` owns it, and it is a window the person works in. Other
 *   windows load the same page and the same preload (the floating HUD), and
 *   none of them shows this control.
 */
function isDesktopSender(event: IpcMainInvokeEvent | undefined): boolean {
	try {
		const sender = event?.sender;
		if (!sender || typeof sender.id !== 'number') return false;
		if (webContents.fromId(sender.id) !== sender) return false;
		if (sender.getType() !== 'window') return false;
		if (!event.senderFrame || event.senderFrame !== sender.mainFrame) return false;
		const window = BrowserWindow.fromWebContents(sender);
		return window !== null && isAppWindow(window);
	} catch {
		return false;
	}
}

/**
 * Throws unless the call came from a window of the desktop app. Every handler
 * in this file runs it before anything else, and before it reads an argument.
 *
 * The limit, stated plainly: this stops a caller that reaches the handlers
 * from outside the desktop window, which is what the web bridge and the CLI
 * are. It does not stop a process that drives the desktop window itself.
 */
export function assertDesktopSender(event: IpcMainInvokeEvent): void {
	if (!isDesktopSender(event)) throw new Error(NOT_AVAILABLE);
}

// ============================================================================
// The failure notice
// ============================================================================

/** How long an agent's failures stay quiet after the person was told of one. */
export const COT_FAILURE_NOTICE_INTERVAL_MS = DURATION_MS.hour;

/** The longest reason a notice carries. A notice is a line or two on screen. */
const MAX_NOTICE_REASON_CHARS = 120;

/**
 * The part of a failure's message that fits a notice: its first line, cut to
 * length. A file system error from Node ends in the call and the path it
 * failed on (`, open '/a/b.jsonl'`). That tail is dropped, because the path is
 * long and it is the log folder.
 */
export function shortFailureReason(message: string): string {
	const firstLine = message.split('\n', 1)[0].trim();
	const reason = firstLine.replace(/, \w+ ['"].*$/, '').trim();
	if (reason === '') return 'unknown error';
	return reason.length > MAX_NOTICE_REASON_CHARS
		? `${reason.slice(0, MAX_NOTICE_REASON_CHARS - 3).trimEnd()}...`
		: reason;
}

/**
 * Tells the person, with a native OS notification, that an agent's log is
 * failing: at most once per agent per `COT_FAILURE_NOTICE_INTERVAL_MS`.
 *
 * The store hands over every failure, and a disk that is full fails every
 * record of every turn, so the limit is kept here. The dialog shows the last
 * failure in full at any time. The notice is only what gets the person to
 * open it.
 *
 * The wording fits both things a failure can be: a record that could not be
 * written, and a head that could not be checked against the disk.
 */
export function createCotFailureNotifier(
	getAgentName: (agentId: string) => string | undefined
): CotFailureListener {
	/**
	 * The last notice of each agent, and when it was shown. The notice itself
	 * is kept because the OS can withdraw one whose object was collected.
	 */
	const shown = new Map<string, { at: number; notice: Notification }>();

	return (agentId, error) => {
		const last = shown.get(agentId);
		if (last && error.at - last.at < COT_FAILURE_NOTICE_INTERVAL_MS) return;
		if (!Notification.isSupported()) return;
		const name = getAgentName(agentId)?.trim() || 'an agent';
		const notice = new Notification({
			title: 'Maestro',
			body: `The audit log of ${name} is failing: ${shortFailureReason(error.message)}`,
		});
		notice.show();
		shown.set(agentId, { at: error.at, notice });
	};
}

/**
 * How long after the handlers are registered the saved state is compared with
 * its anchor in the OS credential store. That comparison is a synchronous call
 * into the OS, and nothing a turn does waits on it, so it is kept off startup.
 */
export const COT_STATE_ANCHOR_CHECK_DELAY_MS = 5 * DURATION_MS.second;

/** What the person is told at start, by what is wrong with the saved state. */
const STATE_PROBLEM_NOTICES: Record<CotStateProblemKind, string> = {
	unreadable:
		'The audit log is off for every agent: its saved settings could not be read. Open Edit Agent to turn it on again.',
	missing:
		'The audit log is off for every agent: its saved settings are missing. Open Edit Agent to turn it on again.',
	replaced:
		'The saved settings of the audit log were replaced with an older copy. Open Edit Agent to check which agents are recorded.',
};

/** Kept for the reason given in `createCotFailureNotifier`. Null until one was shown. */
let stateProblemNotice: Notification | null = null;

/** The check of the anchor that is still waiting, if one is. */
let pendingAnchorCheck: ReturnType<typeof setTimeout> | null = null;

/** Drops the check of the anchor that is still waiting. For tests. */
export function __cancelCotStateAnchorCheckForTests(): void {
	if (pendingAnchorCheck !== null) clearTimeout(pendingAnchorCheck);
	pendingAnchorCheck = null;
}

/**
 * Tells the person that the saved state is not the one they last left: it
 * could not be read, it is missing, or it is an older copy. Recording is then
 * off, or set as it once was, and nothing else would say so until someone
 * opened an Edit Agent dialog: a log that stopped must not stop without a
 * word. It is said once per start of the app, it does nothing when the state
 * is in order, and it never throws.
 */
function notifyCotStateProblem(): void {
	try {
		if (stateProblemNotice !== null) return;
		const problem = getCotConfigStore().getStateProblem();
		if (problem === null) return;
		if (!Notification.isSupported()) return;
		stateProblemNotice = new Notification({
			title: 'Maestro',
			body: STATE_PROBLEM_NOTICES[problem.kind],
		});
		stateProblemNotice.show();
	} catch {
		// The dialog still shows the reason. A notice that cannot be raised
		// must not keep the handlers from being registered.
	}
}

// ============================================================================
// The handlers
// ============================================================================

function requireAgentId(value: unknown): string {
	if (typeof value !== 'string' || value === '') throw new TypeError('An agent id is required.');
	return value;
}

/**
 * What the person chose, as the dialog sends it. A change is made only from a
 * well-formed choice: a value of the wrong type must not read as "off".
 */
function requireChoice(value: unknown): { enabled: boolean; folder: string | null } {
	const choice = (typeof value === 'object' && value !== null ? value : {}) as {
		enabled?: unknown;
		folder?: unknown;
	};
	if (
		typeof choice.enabled !== 'boolean' ||
		(choice.folder !== null && typeof choice.folder !== 'string')
	) {
		throw new TypeError('A change needs `enabled` (a boolean) and `folder` (a path or null).');
	}
	return { enabled: choice.enabled, folder: choice.folder };
}

/**
 * Checks the agent's chain in `folder` against the head Maestro holds for it.
 *
 * The walk runs with the chain at rest (`whileQuiet`). The agent's writes wait
 * behind it and none is lost, so the walk sees every record up to the head and
 * nothing half way in: a walk beside the writer reads one file before a record
 * lands in it and the next file after, and calls an intact log broken. The
 * stored head is checked against the disk first, because after a hard stop it
 * can be behind, and an intact log would then read as one with records added.
 *
 * It never rejects. A folder that cannot be read gives no verdict on its
 * chain, and says so, and the agent's other chains are still checked.
 */
async function verifyChain(agentId: string, folder: string): Promise<CotChainVerifyResult> {
	try {
		const result = await getCotWriter().whileQuiet(agentId, folder, (state) =>
			verifyAgentChain(folder, state?.head ?? null)
		);
		return { folder, ...result };
	} catch (error) {
		const code = (error as NodeJS.ErrnoException | null)?.code;
		return {
			folder,
			ok: false,
			filesChecked: 0,
			recordsChecked: 0,
			headMatches: false,
			error: code ? `The folder could not be read (${code}).` : 'The folder could not be read.',
		};
	}
}

/**
 * One handler per channel, keyed by the channel's name, so a channel added to
 * `COT_EXPORT_CHANNELS` does not compile until it has a handler here. The
 * arguments arrive untyped, as IPC delivers them.
 */
const HANDLERS: Record<CotExportChannelName, (...args: unknown[]) => unknown> = {
	get: (agentId): CotAgentConfig => getCotConfigStore().getAgentConfig(requireAgentId(agentId)),

	set: async (agentId, choice): Promise<CotSetResult> => {
		const id = requireAgentId(agentId);
		const store = getCotConfigStore();
		const result = store.setAgentConfig(id, requireChoice(choice));
		if (!result.ok) return { ok: false, reason: result.reason };
		return { ok: true, status: await store.getStatus(id) };
	},

	status: (agentId): Promise<CotAgentStatus> =>
		getCotConfigStore().getStatus(requireAgentId(agentId)),

	// The store's own check, never a rebuilt one: it also knows that no two
	// agents may share a folder. A folder that is not a path is refused there
	// the way an empty one is, with a reason for the person.
	validateFolder: (agentId, folder): CotFolderValidation =>
		getCotConfigStore().validateFolder(
			requireAgentId(agentId),
			typeof folder === 'string' ? folder : ''
		),

	verify: async (agentId): Promise<CotChainVerifyResult[]> => {
		const id = requireAgentId(agentId);
		const { current, past } = getCotConfigStore().getChains(id);
		const results: CotChainVerifyResult[] = [];
		// One after the other: the folders of one agent often share a disk, and
		// a verify is not worth a burst of reads on the main process.
		for (const chain of current ? [current, ...past] : past) {
			results.push(await verifyChain(id, chain.folder));
		}
		return results;
	},
};

/**
 * Everything the handlers need from the app. The store and the writer are not
 * here: they are the app's own (`getCotConfigStore`, `getCotWriter`), because
 * a chain has one head and a second writer would fork it.
 */
export interface CotExportHandlerDependencies {
	/** The name the person gave an agent, for the failure notice. */
	getAgentName: (agentId: string) => string | undefined;
	/**
	 * Whether `window` is one the person works in: a main or a secondary app
	 * window, and no helper window that loads the same page.
	 */
	isAppWindow: (window: BrowserWindow) => boolean;
	/**
	 * Where the count of the person's changes is kept outside the data folder
	 * (`createCotStateKeyringAnchor`). It is what makes a saved state that was
	 * deleted, or put back from an older copy, something the person is told of.
	 */
	anchor: AnchorStore;
}

/**
 * Registers the channels, each behind the sender check, and starts telling
 * the person when a log fails. Call it once, after the app's `ready` event:
 * Electron refuses a second handler for a channel, and the store it reads
 * needs the OS key store.
 *
 * The loop is what keeps the check in front of every handler: a channel
 * cannot be registered here without it.
 */
export function registerCotExportHandlers(deps: CotExportHandlerDependencies): void {
	isAppWindow = deps.isAppWindow;
	for (const name of Object.keys(HANDLERS) as CotExportChannelName[]) {
		const handler = HANDLERS[name];
		// The second lock: the web bridge answers for a marked channel as it
		// does for one nobody registered, and never reaches the handler.
		markDesktopOnlyChannel(COT_EXPORT_CHANNELS[name]);
		ipcMain.handle(COT_EXPORT_CHANNELS[name], async (event, ...args: unknown[]) => {
			assertDesktopSender(event);
			return handler(...args);
		});
	}
	setCotFailureListener(createCotFailureNotifier(deps.getAgentName));
	setCotStateAnchor(deps.anchor);
	stateProblemNotice = null;
	// A file that could not be read is known at once. One that is missing, or
	// an older copy, is known only once the anchor was read.
	notifyCotStateProblem();
	if (pendingAnchorCheck !== null) clearTimeout(pendingAnchorCheck);
	pendingAnchorCheck = setTimeout(() => {
		pendingAnchorCheck = null;
		try {
			getCotConfigStore().checkStateAnchor();
		} catch {
			// The store could not be made. There is nothing to compare.
		}
		notifyCotStateProblem();
	}, COT_STATE_ANCHOR_CHECK_DELAY_MS);
	// A check that is still waiting must not keep the app from quitting.
	pendingAnchorCheck.unref?.();
}
