/**
 * IPC Bridge — generic Web↔Main mirror of Electron's window.maestro.*
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
 * No per-channel subscription tracking yet — every webContents.send is fanned
 * out to all WS clients as bridge.event. Clients filter via their own ipcRenderer.on.
 */

import { ipcMain, webContents as webContentsModule } from 'electron';
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

let webContentsHookInstalled = false;
let broadcastSink: ((channel: string, args: unknown[]) => void) | null = null;

/**
 * Install (once) a monkey-patch on WebContents.prototype.send so every
 * main→renderer push event also gets broadcast over the WS bridge.
 * The original send still runs so the desktop renderer is unaffected.
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

	if (webContentsHookInstalled) return;

	const all = webContentsModule.getAllWebContents();
	const proto = all[0] ? Object.getPrototypeOf(all[0]) : (webContentsModule.prototype ?? null);
	const target = proto ?? webContentsModule.prototype;
	if (!target || typeof target.send !== 'function') {
		logger.warn(
			'Unable to locate WebContents.prototype.send — bridge.event fanout disabled',
			LOG_CONTEXT
		);
		return;
	}

	const originalSend = target.send;
	target.send = function patchedSend(channel: string, ...args: unknown[]) {
		try {
			broadcastSink?.(channel, args);
		} catch (err) {
			logger.warn(`bridge fanout failed: ${(err as Error).message}`, LOG_CONTEXT);
		}
		return originalSend.call(this, channel, ...args);
	};
	webContentsHookInstalled = true;
	logger.info('WebContents.send bridge hook installed', LOG_CONTEXT);
}

/**
 * Handle a bridge.invoke message — dispatch to the registered ipcMain handler
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
