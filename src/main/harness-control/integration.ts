import type { BrowserWindow } from 'electron';
import type { EventEmitter } from 'events';
import { InteractionBroker } from './InteractionBroker';
import {
	broadcastBridgeEventToSessionSubscribers,
	isBridgeSessionOwner,
} from '../web-server/handlers/bridgeHandlers';
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

interface HarnessInteractionOwner {
	webContentsId?: number;
	bridgeClientId?: string;
}

let dependencies: HarnessControlIntegrationDependencies | null = null;
let initialized = false;

function canonicalSessionId(sessionId: string): string {
	return sessionId.replace(/-ai(?:-.+)?$/, '');
}

function ownerWindow(sessionId: string): BrowserWindow | null {
	const canonical = canonicalSessionId(sessionId);
	if (dependencies?.getWindowForSession) {
		return dependencies.getWindowForSession(canonical);
	}
	return dependencies?.getMainWindow() ?? null;
}

function isOwner(sessionId: string, owner: HarnessInteractionOwner): boolean {
	if (owner.bridgeClientId !== undefined) {
		return isBridgeSessionOwner(owner.bridgeClientId, canonicalSessionId(sessionId));
	}
	if (owner.webContentsId === undefined) return false;
	const win = ownerWindow(sessionId);
	return (
		!!win &&
		!win.isDestroyed() &&
		!win.webContents.isDestroyed() &&
		win.webContents.id === owner.webContentsId
	);
}

function sendToOwner(
	sessionId: string,
	channel: string,
	payload: HarnessInteractionRequest | HarnessInteractionSettledEvent
): boolean {
	let delivered = false;
	const win = ownerWindow(sessionId);
	if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
		try {
			win.webContents.send(channel, payload);
			delivered = true;
		} catch {
			// A browser subscriber can still receive the request below.
		}
	}
	return (
		broadcastBridgeEventToSessionSubscribers(channel, [payload], canonicalSessionId(sessionId)) ||
		delivered
	);
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

/** Resolve a response only when its desktop window or browser client owns the request. */
export function resolveHarnessInteractionResponse(
	raw: unknown,
	owner?: HarnessInteractionOwner
): HarnessInteractionResolveResult {
	if (owner !== undefined && raw && typeof raw === 'object' && 'requestId' in raw) {
		const requestId = raw.requestId;
		const pending = harnessInteractionBroker
			.pendingRequests()
			.find((request) => request.requestId === requestId);
		if (!pending || !isOwner(pending.sessionId, owner)) return 'not-found';
	}
	return harnessInteractionBroker.resolve(raw);
}

/** List pending requests visible to this owner; omitted owner is main-process-only access. */
export function pendingHarnessInteractions(
	owner?: HarnessInteractionOwner
): HarnessInteractionRequest[] {
	if (owner === undefined) return harnessInteractionBroker.pendingRequests();
	return harnessInteractionBroker
		.pendingRequests()
		.filter((request) => isOwner(request.sessionId, owner));
}
