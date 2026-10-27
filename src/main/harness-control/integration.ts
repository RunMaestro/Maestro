import type { BrowserWindow } from 'electron';
import type { EventEmitter } from 'events';
import { InteractionBroker } from './InteractionBroker';
import type {
	HarnessInteractionRequest,
	HarnessInteractionResolveResult,
	HarnessInteractionSettledEvent,
} from '../../shared/harness-control/types';

export const HARNESS_INTERACTION_REQUEST_CHANNEL = 'process:harness-interaction-request';
export const HARNESS_INTERACTION_SETTLED_CHANNEL = 'process:harness-interaction-settled';

export interface HarnessControlIntegrationDependencies {
	getMainWindow: () => BrowserWindow | null;
	getWindowForSession?: (sessionId: string) => BrowserWindow | null;
}

let dependencies: HarnessControlIntegrationDependencies | null = null;
let initialized = false;

function ownerWindow(sessionId: string): BrowserWindow | null {
	const canonicalSessionId = sessionId.replace(/-ai(?:-.+)?$/, '');
	if (dependencies?.getWindowForSession) {
		return dependencies.getWindowForSession(canonicalSessionId);
	}
	return dependencies?.getMainWindow() ?? null;
}

function isOwner(sessionId: string, webContentsId: number): boolean {
	const win = ownerWindow(sessionId);
	return (
		!!win &&
		!win.isDestroyed() &&
		!win.webContents.isDestroyed() &&
		win.webContents.id === webContentsId
	);
}

function sendToOwner(
	sessionId: string,
	channel: string,
	payload: HarnessInteractionRequest | HarnessInteractionSettledEvent
): boolean {
	const win = ownerWindow(sessionId);
	if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return false;
	try {
		win.webContents.send(channel, payload);
		return true;
	} catch {
		return false;
	}
}

export const harnessInteractionBroker = new InteractionBroker({
	onRequest: (request) =>
		sendToOwner(request.sessionId, HARNESS_INTERACTION_REQUEST_CHANNEL, request),
	onSettled: (event) => {
		sendToOwner(event.sessionId, HARNESS_INTERACTION_SETTLED_CHANNEL, event);
	},
});

/** Bind owner-window routing and process-exit cancellation once per main process. */
export function initHarnessControl(
	deps: HarnessControlIntegrationDependencies,
	processManager: EventEmitter | null
): void {
	dependencies = deps;
	if (initialized) return;
	initialized = true;
	processManager?.on?.('exit', (sessionId: string) => {
		harnessInteractionBroker.closeSession(sessionId);
	});
}

export function resolveHarnessInteractionResponse(
	raw: unknown,
	ownerWebContentsId?: number
): HarnessInteractionResolveResult {
	if (ownerWebContentsId !== undefined && raw && typeof raw === 'object' && 'requestId' in raw) {
		const requestId = raw.requestId;
		const pending = harnessInteractionBroker
			.pendingRequests()
			.find((request) => request.requestId === requestId);
		if (!pending || !isOwner(pending.sessionId, ownerWebContentsId)) return 'not-found';
	}
	return harnessInteractionBroker.resolve(raw);
}

export function pendingHarnessInteractions(
	ownerWebContentsId?: number
): HarnessInteractionRequest[] {
	if (ownerWebContentsId === undefined) return harnessInteractionBroker.pendingRequests();
	return harnessInteractionBroker
		.pendingRequests()
		.filter((request) => isOwner(request.sessionId, ownerWebContentsId));
}
