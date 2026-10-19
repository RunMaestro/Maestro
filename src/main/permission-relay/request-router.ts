/**
 * Which window prompts the user for a relayed permission request.
 *
 * A request goes to the main window, unless its tab is popped out into a tab
 * window (Tab Windows): then that window prompts, because the user is looking
 * at the tab there and the main window's strip does not even show it. The
 * answer goes straight back to main by `requestId` (`permission:respond`), so
 * it writes no `Session` and needs no intent.
 *
 * A request shown in a tab window can be stranded there: the tab docks, or the
 * tab window closes, before the user answers. {@link PermissionRequestRouter.reroute}
 * re-delivers every request still waiting on a tab window that no longer holds
 * its tab, so the agent is never left waiting out the relay's timeout. A
 * request shown in the main window stays there: popping its tab out later does
 * not move the prompt, so one request is never shown in two windows.
 *
 * Kept free of the relay's module state so it can be tested with fakes.
 */

import type { BrowserWindow } from 'electron';
import type { PermissionRequest } from './types';

/** Result of one delivery attempt. */
export type PermissionDelivery =
	| { delivered: true; window: BrowserWindow }
	| { delivered: false; reason: string };

export interface PermissionRequestRouterDeps {
	/** The window that prompts when no tab window holds the request's tab. */
	getMainWindow: () => BrowserWindow | null;
	/** The tab window holding the request's tab, or null when it is not popped out. */
	resolveTabWindow?: (request: PermissionRequest) => BrowserWindow | null;
	/** Whether the relay still waits on this request (not answered, timed out, or cleaned up). */
	isPending: (requestId: string) => boolean;
	/** Send the request to a window's renderer. Throws when the send fails. */
	send: (window: BrowserWindow, request: PermissionRequest) => void;
}

export interface PermissionRequestRouter {
	/** Prompt for a new request in the window that shows its tab. */
	deliver: (request: PermissionRequest) => PermissionDelivery;
	/** Forget a request that was answered. */
	settle: (requestId: string) => void;
	/**
	 * Re-deliver the requests stranded in a tab window: still waiting, shown in
	 * a tab window that is gone or no longer holds the request's tab. Call it
	 * whenever a tab window's tabs change. `failed` names the stranded requests
	 * no window could take; the caller answers those so the agent is not left
	 * waiting.
	 */
	reroute: () => { moved: string[]; failed: string[] };
}

interface Delivered {
	request: PermissionRequest;
	window: BrowserWindow;
	/** True when a tab window was chosen for it (only those can be stranded). */
	viaTabWindow: boolean;
}

function isUsable(window: BrowserWindow | null): window is BrowserWindow {
	return !!window && !window.isDestroyed() && !window.webContents.isDestroyed();
}

export function createPermissionRequestRouter(
	deps: PermissionRequestRouterDeps
): PermissionRequestRouter {
	const delivered = new Map<string, Delivered>();

	const target = (
		request: PermissionRequest
	): { window: BrowserWindow | null; viaTab: boolean } => {
		const tabWindow = deps.resolveTabWindow?.(request) ?? null;
		if (isUsable(tabWindow)) return { window: tabWindow, viaTab: true };
		return { window: deps.getMainWindow(), viaTab: false };
	};

	const deliver = (request: PermissionRequest): PermissionDelivery => {
		const { window, viaTab } = target(request);
		if (!isUsable(window)) {
			delivered.delete(request.requestId);
			return { delivered: false, reason: 'no window to prompt' };
		}
		try {
			deps.send(window, request);
		} catch (error) {
			delivered.delete(request.requestId);
			return {
				delivered: false,
				reason: error instanceof Error ? error.message : String(error),
			};
		}
		delivered.set(request.requestId, { request, window, viaTabWindow: viaTab });
		return { delivered: true, window };
	};

	const reroute = (): { moved: string[]; failed: string[] } => {
		const moved: string[] = [];
		const failed: string[] = [];
		for (const [requestId, entry] of [...delivered]) {
			if (!deps.isPending(requestId)) {
				delivered.delete(requestId);
				continue;
			}
			if (!entry.viaTabWindow) continue;
			const stillHeld =
				isUsable(entry.window) && deps.resolveTabWindow?.(entry.request) === entry.window;
			if (stillHeld) continue;
			if (deliver(entry.request).delivered) moved.push(requestId);
			else failed.push(requestId);
		}
		return { moved, failed };
	};

	return {
		deliver,
		settle: (requestId) => {
			delivered.delete(requestId);
		},
		reroute,
	};
}
