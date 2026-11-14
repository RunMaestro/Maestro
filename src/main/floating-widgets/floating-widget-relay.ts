/**
 * Floating widget relay - the bridge between the window that OWNS a widget's
 * live state (its "authority") and the windows that show or drive it. See
 * `Plans/floating-widgets.md`, section 1.
 *
 * - State flows out of the authority: it publishes a snapshot, main keeps the
 *   latest one per widget and forwards it to every other live window.
 * - Commands flow into the authority: any window sends one, main forwards it.
 *   When the authority is the widget's own window (`spec.authority: 'widget'`)
 *   and that window does not exist or has not mounted yet, main creates it
 *   (without showing it) and holds the commands until it says it is ready.
 *
 * The core (`createFloatingWidgetRelay` minus `init()`) never touches
 * `ipcMain`, so the tests drive it directly.
 */

import { ipcMain, type BrowserWindow } from 'electron';
import {
	FLOATING_WIDGET_SPECS,
	isFloatingWidgetId,
	sanitizeFloatingWidgetOverflow,
	type FloatingWidgetBounds,
	type FloatingWidgetId,
} from '../../shared/floatingWidgets';
import { logger } from '../utils/logger';
import { isWebContentsAvailable } from '../utils/safe-send';
import type { FloatingWidgetController } from './floating-widget-window';

const LOG_CONTEXT = 'FloatingWidgets';

/** The most commands held for one widget whose window is not ready yet. */
export const MAX_QUEUED_COMMANDS = 100;

/** Main to renderer: the latest state of a widget, `(id, state)`. */
export const FLOATING_WIDGET_STATE_CHANNEL = 'floatingWidgets:state';
/** Both ways: a command for a widget's authority, `(id, command)`. */
export const FLOATING_WIDGET_COMMAND_CHANNEL = 'floatingWidgets:command';

export interface FloatingWidgetRelayDeps {
	controllers: Record<FloatingWidgetId, FloatingWidgetController>;
	/** The window that owns a widget's state and takes its commands, or null when there is none. */
	getAuthorityWindow(id: FloatingWidgetId): BrowserWindow | null;
	/** Every window a state snapshot may reach (app windows and widget windows). */
	getAllWindows(): BrowserWindow[];
	/** Refuse stale show/hide requests when an app-owned widget changes authority. */
	canControlVisibility?(id: FloatingWidgetId, senderId: number): boolean;
	/** Drop a previous voice owner's trailing snapshot during an authority handoff. */
	canPublishState?(id: FloatingWidgetId, senderId: number): boolean;
}

/** What happened to one command. */
export type FloatingWidgetCommandOutcome = 'sent' | 'queued' | 'dropped';

export interface FloatingWidgetRelay {
	/** Register the IPC handlers. Call once. */
	init(): void;
	/** Remember a widget's latest state and send it to every live window except the sender. */
	publishState(id: FloatingWidgetId, state: unknown, senderId?: number): void;
	/** The latest published state, or null when none was published. */
	getState(id: FloatingWidgetId): unknown;
	/** Forward a command to the widget's authority, creating and waiting for it when needed. */
	sendCommand(id: FloatingWidgetId, command: unknown): FloatingWidgetCommandOutcome;
	/** A widget window says it mounted and subscribed. Delivers its held commands in order. */
	markReady(id: FloatingWidgetId, senderId: number): void;
	/** How many commands wait for the widget's window. */
	pendingCommandCount(id: FloatingWidgetId): number;
}

/**
 * Append to a capped queue, dropping the oldest items to make room. Returns how
 * many items were dropped.
 */
export function enqueueBounded<T>(queue: T[], item: T, cap: number): number {
	queue.push(item);
	const overflow = Math.max(0, queue.length - cap);
	if (overflow > 0) queue.splice(0, overflow);
	return overflow;
}

/**
 * The windows a state snapshot goes to: every live one except the sender.
 * `senderId` is the sender's webContents id.
 */
export function stateRecipients(
	windows: ReadonlyArray<BrowserWindow | null | undefined>,
	senderId: number | undefined
): BrowserWindow[] {
	return windows.filter(
		(win): win is BrowserWindow =>
			isWebContentsAvailable(win) && (senderId === undefined || win.webContents.id !== senderId)
	);
}

/** The id from an IPC argument, or an error naming it. */
export function requireFloatingWidgetId(value: unknown): FloatingWidgetId {
	if (!isFloatingWidgetId(value)) {
		throw new Error(`Unknown floating widget: ${String(value)}`);
	}
	return value;
}

function sendTo(
	win: BrowserWindow | null | undefined,
	channel: string,
	...args: unknown[]
): boolean {
	if (!isWebContentsAvailable(win)) return false;
	try {
		win.webContents.send(channel, ...args);
		return true;
	} catch (error) {
		// The renderer went away between the check and the send (window closing,
		// GPU crash). Same treatment as safeSend: expected, not worth a report.
		logger.debug(`Failed to send ${channel}`, LOG_CONTEXT, { error: String(error) });
		return false;
	}
}

export function createFloatingWidgetRelay(deps: FloatingWidgetRelayDeps): FloatingWidgetRelay {
	const latestState = new Map<FloatingWidgetId, unknown>();
	const pending = new Map<FloatingWidgetId, unknown[]>();
	let initialized = false;

	function queueFor(id: FloatingWidgetId): unknown[] {
		let queue = pending.get(id);
		if (!queue) {
			queue = [];
			pending.set(id, queue);
		}
		return queue;
	}

	function publishState(id: FloatingWidgetId, state: unknown, senderId?: number): void {
		latestState.set(id, state);
		for (const win of stateRecipients(deps.getAllWindows(), senderId)) {
			sendTo(win, FLOATING_WIDGET_STATE_CHANNEL, id, state);
		}
	}

	function sendCommand(id: FloatingWidgetId, command: unknown): FloatingWidgetCommandOutcome {
		const controller = deps.controllers[id];
		if (FLOATING_WIDGET_SPECS[id].authority === 'widget' && !controller.isReady()) {
			if (!controller.ensureCreated()) {
				logger.warn(`Dropped a command for ${id}: its window cannot be created`, LOG_CONTEXT);
				return 'dropped';
			}
			const dropped = enqueueBounded(queueFor(id), command, MAX_QUEUED_COMMANDS);
			if (dropped > 0) {
				logger.warn(
					`Dropped ${dropped} oldest queued command(s) for ${id}: its window is not ready`,
					LOG_CONTEXT,
					{ cap: MAX_QUEUED_COMMANDS }
				);
			}
			return 'queued';
		}
		if (!sendTo(deps.getAuthorityWindow(id), FLOATING_WIDGET_COMMAND_CHANNEL, id, command)) {
			logger.warn(`Dropped a command for ${id}: no live authority window`, LOG_CONTEXT);
			return 'dropped';
		}
		return 'sent';
	}

	function markReady(id: FloatingWidgetId, senderId: number): void {
		const controller = deps.controllers[id];
		const win = controller.getWindow();
		// Only the widget's own window can say it is ready; anything else would
		// release the held commands into a window that is not listening.
		if (!isWebContentsAvailable(win) || win.webContents.id !== senderId) {
			logger.warn(`Ignored a ready signal for ${id} from another window`, LOG_CONTEXT);
			return;
		}
		controller.markReady();
		const queue = pending.get(id);
		if (!queue?.length) return;
		pending.delete(id);
		for (const command of queue) {
			sendTo(win, FLOATING_WIDGET_COMMAND_CHANNEL, id, command);
		}
	}

	function init(): void {
		if (initialized) return;
		initialized = true;

		const controllerFor = (id: unknown) => deps.controllers[requireFloatingWidgetId(id)];

		ipcMain.handle('floatingWidgets:show', (event, id: unknown) => {
			const widgetId = requireFloatingWidgetId(id);
			const controller = controllerFor(widgetId);
			if (deps.canControlVisibility?.(widgetId, event.sender.id) === false)
				return controller.isVisible();
			controller.show();
			return controller.isVisible();
		});
		ipcMain.handle('floatingWidgets:hide', (event, id: unknown) => {
			const widgetId = requireFloatingWidgetId(id);
			const controller = controllerFor(widgetId);
			if (deps.canControlVisibility?.(widgetId, event.sender.id) === false)
				return controller.isVisible();
			controller.hide();
			return controller.isVisible();
		});
		ipcMain.handle('floatingWidgets:toggle', (event, id: unknown) => {
			const widgetId = requireFloatingWidgetId(id);
			const controller = controllerFor(widgetId);
			if (deps.canControlVisibility?.(widgetId, event.sender.id) === false)
				return controller.isVisible();
			controller.toggle();
			return controller.isVisible();
		});
		ipcMain.handle('floatingWidgets:isVisible', (_event, id: unknown) =>
			controllerFor(id).isVisible()
		);
		ipcMain.handle('floatingWidgets:getBounds', (_event, id: unknown) =>
			controllerFor(id).getBounds()
		);
		ipcMain.handle('floatingWidgets:setBounds', (_event, id: unknown, bounds: unknown) => {
			const controller = controllerFor(id);
			if (!bounds || typeof bounds !== 'object') {
				throw new Error('Floating widget bounds must be an object');
			}
			return controller.setBounds(bounds as FloatingWidgetBounds);
		});
		ipcMain.handle('floatingWidgets:setOverflow', (_event, id: unknown, need: unknown) =>
			controllerFor(id).setOverflow(sanitizeFloatingWidgetOverflow(need))
		);
		ipcMain.handle(
			'floatingWidgets:getState',
			(_event, id: unknown) => latestState.get(requireFloatingWidgetId(id)) ?? null
		);

		ipcMain.on('floatingWidgets:publishState', (event, id: unknown, state: unknown) => {
			if (!isFloatingWidgetId(id)) {
				logger.warn(`Ignored state for an unknown floating widget: ${String(id)}`, LOG_CONTEXT);
				return;
			}
			if (deps.canPublishState?.(id, event.sender.id) === false) return;
			publishState(id, state, event.sender.id);
		});
		ipcMain.on(FLOATING_WIDGET_COMMAND_CHANNEL, (_event, id: unknown, command: unknown) => {
			if (!isFloatingWidgetId(id)) {
				logger.warn(`Ignored a command for an unknown floating widget: ${String(id)}`, LOG_CONTEXT);
				return;
			}
			sendCommand(id, command);
		});
		ipcMain.on('floatingWidgets:ready', (event, id: unknown) => {
			if (!isFloatingWidgetId(id)) {
				logger.warn(`Ignored ready for an unknown floating widget: ${String(id)}`, LOG_CONTEXT);
				return;
			}
			markReady(id, event.sender.id);
		});
	}

	return {
		init,
		publishState,
		getState: (id) => latestState.get(id) ?? null,
		sendCommand,
		markReady,
		pendingCommandCount: (id) => pending.get(id)?.length ?? 0,
	};
}
