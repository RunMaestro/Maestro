/**
 * IPC Bridge - generic Web↔Main mirror of Electron's window.maestro.*
 *
 * Lets a web client invoke any registered ipcMain handler and receive every
 * webContents.send push the desktop renderer would have received. This is the
 * core of the "remote-control desktop UI in a browser tab" path.
 *
 * Wire format:
 *   client→server  { type: 'bridge.invoke', requestId, channel, args }
 *   server→client  { type: 'bridge.response', requestId, ok, result|error }
 *   server→client  { type: 'bridge.event',    channel, args }
 *
 * No per-channel subscription tracking yet - every webContents.send is fanned
 * out to all WS clients as bridge.event. Clients filter via their own ipcRenderer.on.
 */

import { ipcMain } from 'electron';
import { logger } from '../../utils/logger';
import type { WebClient } from '../types';
import type { BroadcastService } from '../services';

const LOG_CONTEXT = 'WebServer:Bridge';

interface InvokeMessage {
	type: 'bridge.invoke';
	requestId: string | number;
	channel: string;
	args?: unknown[];
}

interface IpcMainInternal {
	_invokeHandlers?: Map<string, (event: unknown, ...args: unknown[]) => unknown>;
}

interface BridgeFakeEvent {
	senderFrame: null;
	frameId: number;
	processId: number;
	type: 'bridge';
}

const FAKE_EVENT: BridgeFakeEvent = {
	senderFrame: null,
	frameId: -1,
	processId: -1,
	type: 'bridge',
};

let broadcastSink: ((channel: string, args: unknown[]) => void) | null = null;

/**
 * Wire the bridge's main→renderer fanout to the live BroadcastService.
 * Once installed, `broadcastBridgeEvent(channel, args)` (called from
 * `safeSend` in `utils/safe-send.ts`) will reach every connected web-desktop
 * client as a `bridge.event` frame.
 *
 * The earlier implementation monkey-patched `WebContents.prototype.send` to
 * intercept main→renderer pushes implicitly. That broke when the Electron
 * `mainWindow` wasn't yet attached (or was destroyed) - `safeSend` gates
 * every call on the window's existence, so the patched prototype never
 * fired and web-desktop clients silently missed every push. Routing the
 * fanout explicitly from `safeSend` removes that race.
 */
export function installWebContentsBridgeHook(broadcastService: BroadcastService): void {
	broadcastSink = (channel, args) => {
		broadcastService.broadcastToAll({
			type: 'bridge.event',
			channel,
			args,
			timestamp: Date.now(),
		});
	};
	logger.info('Bridge event fanout installed', LOG_CONTEXT);
}

/**
 * Tear down the bridge fanout. Clears `broadcastSink` so a defunct
 * `BroadcastService` isn't called after the Encore Feature is toggled off
 * or the server is stopped.
 */
export function uninstallWebContentsBridgeHook(): void {
	if (broadcastSink) {
		broadcastSink = null;
		logger.info('Bridge event fanout removed', LOG_CONTEXT);
	}
}

/**
 * Fan out a main→renderer event to every connected web-desktop client.
 * Called from `safeSend` so every IPC push goes through the bridge,
 * regardless of whether the Electron renderer is currently alive.
 *
 * No-op when the Encore Feature is off (`broadcastSink === null`) or when
 * no web-desktop clients are connected (handled inside the sink itself).
 */
export function broadcastBridgeEvent(channel: string, args: unknown[]): void {
	if (!broadcastSink) return;
	try {
		broadcastSink(channel, args);
	} catch (err) {
		logger.warn(`bridge fanout failed: ${(err as Error).message}`, LOG_CONTEXT);
	}
}

/**
 * Handle a bridge.invoke message - dispatch to the registered ipcMain handler
 * and send a bridge.response back to the originating client.
 */
export async function handleBridgeInvoke(
	client: WebClient,
	message: InvokeMessage,
	send: (client: WebClient, payload: object) => void
): Promise<void> {
	const requestId = message.requestId;
	const channel = message.channel;
	const args = Array.isArray(message.args) ? message.args : [];

	if (typeof channel !== 'string' || !channel) {
		send(client, {
			type: 'bridge.response',
			requestId,
			ok: false,
			error: 'bridge.invoke requires a channel string',
		});
		return;
	}

	const handlers = (ipcMain as unknown as IpcMainInternal)._invokeHandlers;
	const handler = handlers?.get(channel);
	if (!handler) {
		send(client, {
			type: 'bridge.response',
			requestId,
			ok: false,
			error: `No ipcMain handler registered for channel "${channel}"`,
		});
		return;
	}

	try {
		const result = await handler(FAKE_EVENT, ...args);
		send(client, {
			type: 'bridge.response',
			requestId,
			ok: true,
			result,
		});
	} catch (err) {
		const error = err instanceof Error ? err.message : String(err);
		send(client, {
			type: 'bridge.response',
			requestId,
			ok: false,
			error,
		});
	}
}

export function isBridgeInvokeMessage(message: { type: string }): message is InvokeMessage {
	return message.type === 'bridge.invoke';
}
