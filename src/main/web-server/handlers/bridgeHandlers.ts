/**
 * IPC Bridge - generic Web↔Main mirror of Electron's window.maestro.*
 *
 * Lets an owner-operator invoke the explicitly reviewed remote IPC inventory
 * and receive its workload events. Host administration and trusted renderer
 * request/reply channels never cross this boundary.
 *
 * Wire format:
 *   client→server  { type: 'bridge.invoke', requestId, channel, args }
 *   server→client  { type: 'bridge.response', requestId, ok, result|error }
 *   server→client  { type: 'bridge.event',    channel, args }
 *
 * Events are allowlisted before fanout; clients filter permitted events via
 * their own ipcRenderer.on.
 */

import { ipcMain } from 'electron';
import { logger } from '../../utils/logger';
import type { WebClient } from '../types';
import type { BroadcastService } from '../services';
import { runAsActingUser } from '../auth/acting-user';
import { isDesktopOnlyChannel } from '../../ipc/desktop-only-channels';
import { bridgeGuardViolation } from './bridgePathGuard';
import {
	isRemoteMethodAllowed,
	isRemoteEventAllowed,
	remoteDeniedChannelError,
	isRemoteSecretField,
	isRemoteSettingReadable,
	isRemoteSettingWritable,
	sanitizeRemoteConfiguration,
	sanitizeRemoteResult,
} from './bridgeDenyList';

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
 * A channel under a denied prefix is never fanned out either: a browser that
 * may not invoke `computerHistory:*` must not receive its pushes.
 */
export function broadcastBridgeEvent(channel: string, args: unknown[]): void {
	if (!broadcastSink || !isRemoteEventAllowed(channel) || isDesktopOnlyChannel(channel)) return;
	try {
		broadcastSink(
			channel,
			channel === 'sessions:lifecycleSync' ? (sanitizeRemoteConfiguration(args) as unknown[]) : args
		);
	} catch (err) {
		logger.warn(`bridge fanout failed: ${(err as Error).message}`, LOG_CONTEXT);
	}
}

/**
 * Handle a bridge.invoke message - dispatch to the registered ipcMain handler
 * and send a bridge.response back to the originating client.
 */
export async function handleBridgeInvoke<TClient extends Pick<WebClient, 'id' | 'user' | 'cli'>>(
	client: TClient,
	message: InvokeMessage,
	send: (client: TClient, payload: object) => void
): Promise<void> {
	const requestId = message.requestId;
	const channel = message.channel;
	let args = Array.isArray(message.args) ? message.args : [];
	const event = { ...FAKE_EVENT, clientId: client.id };

	if (typeof channel !== 'string' || !channel) {
		send(client, {
			type: 'bridge.response',
			requestId,
			ok: false,
			error: 'bridge.invoke requires a channel string',
		});
		return;
	}

	// Default deny, including any subsequently registered host-only channel.
	if (
		!isRemoteMethodAllowed(channel) ||
		(client.cli &&
			[
				'pianola:resolve-decision',
				'pianola:review-suggestion',
				'pianola:apply-suggestion',
			].includes(channel)) ||
		(channel === 'settings:set' && !isRemoteSettingWritable(args[0])) ||
		(channel === 'agents:setConfigValue' &&
			(typeof args[1] !== 'string' || /[.\[\]]/.test(args[1]) || isRemoteSecretField(args[1])))
	) {
		logger.warn(`Refused bridge channel "${channel}" from ${client.id}`, LOG_CONTEXT);
		send(client, {
			type: 'bridge.response',
			requestId,
			ok: false,
			error: remoteDeniedChannelError(channel),
		});
		return;
	}

	// Argument guard for web clients, before EITHER dispatch path (invoke or
	// the ipcMain.emit fallback below): no Computer History files or CLI
	// secret through generic handlers like `fs:readFile`, and no toggling the
	// Computer History flag. maestro-cli (`client.cli`) is exempt. See
	// bridgePathGuard.ts.
	if (!client.cli) {
		const violation = bridgeGuardViolation(channel, args);
		if (violation) {
			logger.warn(`Refused bridge call "${channel}" from ${client.id}: ${violation}`, LOG_CONTEXT);
			send(client, { type: 'bridge.response', requestId, ok: false, error: violation });
			return;
		}
	}

	// A desktop-only channel is answered as if nobody had registered it: no
	// handler is looked up and no listener is run, so the reply below is the one
	// an unknown channel gets. See ipc/desktop-only-channels.ts.
	const desktopOnly = isDesktopOnlyChannel(channel);
	if (
		(channel === 'settings:get' && !isRemoteSettingReadable(args[0])) ||
		(channel === 'agents:getConfigValue' &&
			(typeof args[1] !== 'string' || /[.\[\]]/.test(args[1]) || isRemoteSecretField(args[1])))
	) {
		send(client, { type: 'bridge.response', requestId, ok: true, result: undefined });
		return;
	}
	const handlers = (ipcMain as unknown as IpcMainInternal)._invokeHandlers;
	const handler = desktopOnly ? undefined : handlers?.get(channel);
	if (!handler) {
		// Electron has TWO renderer→main directions and the bridge carries both
		// over this one frame. `ipcRenderer.invoke` pairs with `ipcMain.handle`
		// (an entry in `_invokeHandlers`, above); `ipcRenderer.send` is
		// fire-and-forget and pairs with `ipcMain.on`, which is an ordinary
		// EventEmitter listener and appears nowhere in that map.
		//
		// The web shim routes BOTH through `bridge.invoke`, because a WebSocket
		// has no second channel to send on. So before this, every `send`-based
		// API was a silent no-op on web-desktop: the server answered "No ipcMain
		// handler registered", and the shim's `send` wrapper - fire-and-forget by
		// contract, so it cannot throw at the caller - logged it to the console
		// and swallowed it. `tabs:aiTabClosed` is the one that bites in practice
		// (closing a tab from a browser left its armed dispatch callbacks armed),
		// but the failure is per-DIRECTION, not per-channel: any `send` API added
		// later is born broken on the web the same way.
		//
		// Emitting is the honest equivalent of what `ipcRenderer.send` does, and
		// it grants no new authority: this same function already dispatches every
		// registered invoke handler to an authenticated client, so a `send`
		// listener is strictly less reachable than what is already exposed.
		if (!desktopOnly && ipcMain.listenerCount(channel) > 0) {
			try {
				// Same acting-user context as the invoke path below: a `send`-style
				// API mutates state too, and a turn started through one has to be
				// attributed to the account that asked for it.
				runAsActingUser(client.user, () => ipcMain.emit(channel, event, ...args));
				send(client, { type: 'bridge.response', requestId, ok: true, result: undefined });
			} catch (err) {
				const error = err instanceof Error ? err.message : String(err);
				send(client, { type: 'bridge.response', requestId, ok: false, error });
			}
			return;
		}
		send(client, {
			type: 'bridge.response',
			requestId,
			ok: false,
			error: `No ipcMain handler registered for channel "${channel}"`,
		});
		return;
	}

	try {
		// The handler runs INSIDE the acting-user context, not beside it: the
		// context has to be established before the call so every await the
		// handler performs still reads the same account from `getActingUser()`.
		// `client.user` is undefined for maestro-cli (admitted by its secret) and
		// for every client when the gate is off, which reads as "the desktop".
		if (channel === 'process:spawn') {
			const config = args[0];
			if (!config || typeof config !== 'object' || Array.isArray(config) || args.length !== 1)
				throw new Error('Invalid remote spawn configuration');
			// Admission to the generic bridge proves no human origin for this turn.
			// Override caller claims before the native handler can mint its proof.
			args = [{ ...config, querySource: 'auto' }];
		}
		if (channel === 'agents:setConfig') {
			const incoming = args[1];
			if (
				!incoming ||
				typeof incoming !== 'object' ||
				Array.isArray(incoming) ||
				JSON.stringify(incoming) !== JSON.stringify(sanitizeRemoteConfiguration(incoming))
			) {
				throw new Error('Provider credentials must be managed on the host');
			}
			const getConfig = handlers?.get('agents:getConfig');
			if (!getConfig) throw new Error('Host agent configuration is unavailable');
			const existing = (await getConfig(event, args[0])) as Record<string, unknown>;
			args = [args[0], { ...existing, ...incoming }];
		}
		const result = await runAsActingUser(client.user, () => handler(event, ...args));
		send(client, {
			type: 'bridge.response',
			requestId,
			ok: true,
			result: sanitizeRemoteResult(channel, result),
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
