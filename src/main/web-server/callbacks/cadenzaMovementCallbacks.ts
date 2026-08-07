import { randomUUID } from 'crypto';
import { ipcMain, type BrowserWindow } from 'electron';
import type { WebServer } from '../WebServer';
import type { WebServerFactoryDependencies } from '../web-server-factory';
import { logger } from '../../utils/logger';
import { isWebContentsAvailable } from '../../utils/safe-send';
import type { MovementStateSnapshot } from '../../../shared/movement-types';
import type {
	ConcertoDesignerAction,
	ConcertoDesignerActionResult,
	ConcertoDesignerFrameSnapshot,
	MovementDesignerInspection,
} from '../../../shared/concerto-html';
import {
	applyCadenzaHtmlPayload,
	applyMovementHtmlPayload,
	getConcertoHtmlDocumentRevision,
} from '../../concerto-html';

/**
 * One request/reply round-trip with a renderer over IPC: mint a fresh response
 * channel, send it on `requestChannel`, and resolve with the renderer's reply
 * (mapped by `parse`) or `fallback` if it doesn't answer within `timeoutMs`.
 * Extracts the hand-rolled once-listener + timeout dance used by several
 * `remote:*` reads. Caller must have already confirmed the window's webContents.
 */
function requestFromRenderer<T>(
	win: BrowserWindow,
	requestChannel: string,
	options: { fallback: T; parse?: (raw: unknown) => T; timeoutMs?: number; args?: unknown[] }
): Promise<T> {
	const { fallback, parse = (raw) => raw as T, timeoutMs = 3000, args = [] } = options;
	return new Promise<T>((resolve) => {
		const responseChannel = `${requestChannel}:response:${randomUUID()}`;
		let settled = false;
		const finish = (value: T) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeoutId);
			ipcMain.removeListener(responseChannel, onReply);
			resolve(value);
		};
		const onReply = (_event: Electron.IpcMainEvent, raw: unknown) => finish(parse(raw));
		const timeoutId = setTimeout(() => finish(fallback), timeoutMs);
		ipcMain.once(responseChannel, onReply);
		win.webContents.send(requestChannel, ...args, responseChannel);
	});
}

export function registerCadenzaMovementCallbacks(
	server: WebServer,
	deps: Pick<WebServerFactoryDependencies, 'settingsStore' | 'getMainWindow' | 'deliverCadenza'>
): void {
	const { settingsStore, getMainWindow, deliverCadenza } = deps;

	// Movement updates and designer inspections both depend on the renderer's
	// current HTML revision. Serialize them so an update cannot replace the
	// document between an inspection request and its compositor capture.
	//
	// Declared here, at this function's own call scope (one call per
	// `createWebServer()` invocation) rather than at module top level - a
	// module-level queue would leak state across separate web-server
	// instances within the same process, which would be a real behavior
	// change, not a pure move.
	let pendingMovementRendererOperation: Promise<void> | undefined;
	const enqueueMovementRendererOperation = <T>(operation: () => Promise<T>): Promise<T> => {
		const previousOperation = pendingMovementRendererOperation;
		const operationPromise = previousOperation ? previousOperation.then(operation) : operation();
		const completion = operationPromise.then(
			() => undefined,
			() => undefined
		);
		pendingMovementRendererOperation = completion;
		void completion.finally(() => {
			if (pendingMovementRendererOperation === completion) {
				pendingMovementRendererOperation = undefined;
			}
		});
		return operationPromise;
	};

	server.setCadenzaViewCallback(async (params) => {
		// Gated by the Concerto Encore feature: when off, drop the payload so the
		// opt-in feature stays fully inert (no invisible in-app store population).
		if (settingsStore.get<{ concerto?: boolean }>('encoreFeatures', {}).concerto !== true)
			return false;
		applyCadenzaHtmlPayload(params);
		// Prefer the desktop HUD window (floats over other apps). It buffers the
		// payload internally until its renderer subscribes.
		if (deliverCadenza?.(params)) return true;

		// Fall back to the in-app renderer if the HUD can't be created.
		const mainWindow = getMainWindow();
		if (!mainWindow) {
			logger.warn('no window available for cadenzaView', 'WebServer');
			return false;
		}
		if (!isWebContentsAvailable(mainWindow)) {
			logger.warn('webContents is not available for cadenzaView', 'WebServer');
			return false;
		}
		mainWindow.webContents.send('remote:cadenza', params);
		return true;
	});

	// Movement ops go to the main renderer, which applies them to the in-app
	// floating movement overlay. Gated by the Concerto Encore feature: when
	// off, drop the payload so the opt-in feature stays fully inert.
	server.setMovementViewCallback(async (params) => {
		return enqueueMovementRendererOperation(async () => {
			if (settingsStore.get<{ concerto?: boolean }>('encoreFeatures', {}).concerto !== true)
				return false;
			if (
				params.op !== 'begin' &&
				params.id &&
				params.viewType === 'html' &&
				params.body === undefined &&
				getConcertoHtmlDocumentRevision('movement', params.id) === null
			) {
				logger.warn(
					`HTML movement '${params.id}' requires a body when changing view type`,
					'WebServer'
				);
				return false;
			}
			const mainWindow = getMainWindow();
			if (!mainWindow) {
				logger.warn('mainWindow is null for movementView', 'WebServer');
				return false;
			}
			if (!isWebContentsAvailable(mainWindow)) {
				logger.warn('webContents is not available for movementView', 'WebServer');
				return false;
			}
			const routedParams = applyMovementHtmlPayload(params);
			return requestFromRenderer<boolean>(mainWindow, 'remote:movement', {
				fallback: false,
				parse: (raw) => raw === true,
				timeoutMs: 4000,
				args: [routedParams],
			});
		});
	});

	// `movement state` read: ask the renderer for the current snapshot (items +
	// size) and return it, so an agent can place items around what's there.
	server.setGetMovementStateCallback(async () => {
		if (settingsStore.get<{ concerto?: boolean }>('encoreFeatures', {}).concerto !== true)
			return null;
		const mainWindow = getMainWindow();
		if (!mainWindow || !isWebContentsAvailable(mainWindow)) return null;
		return requestFromRenderer<MovementStateSnapshot | null>(
			mainWindow,
			'remote:getMovementState',
			{
				fallback: null,
				parse: (raw) => (raw as MovementStateSnapshot) ?? null,
			}
		);
	});

	// Designer inspection asks the renderer for the exact live iframe crop,
	// then captures that region from Chromium's compositor. The PNG stays in
	// memory here and is returned to the CLI, which writes it using the agent's
	// own filesystem permissions.
	server.setGetMovementDesignerInspectionCallback(async (id) => {
		return enqueueMovementRendererOperation(async () => {
			if (settingsStore.get<{ concerto?: boolean }>('encoreFeatures', {}).concerto !== true)
				return null;
			const mainWindow = getMainWindow();
			if (!mainWindow || !isWebContentsAvailable(mainWindow)) return null;
			const expectedRevision = getConcertoHtmlDocumentRevision('movement', id);
			if (expectedRevision === null) return null;
			const frame = await requestFromRenderer<ConcertoDesignerFrameSnapshot | null>(
				mainWindow,
				'remote:getMovementDesignerInspection',
				{
					fallback: null,
					parse: (raw) => (raw as ConcertoDesignerFrameSnapshot) ?? null,
					timeoutMs: 4000,
					args: [id, expectedRevision],
				}
			);
			if (!frame) return null;
			const image = await mainWindow.webContents.capturePage({
				x: Math.max(0, Math.floor(frame.rect.x)),
				y: Math.max(0, Math.floor(frame.rect.y)),
				width: Math.max(1, Math.floor(frame.rect.width)),
				height: Math.max(1, Math.floor(frame.rect.height)),
			});
			const imageSize = image.getSize();
			const inspection: MovementDesignerInspection = {
				id,
				ready: frame.ready,
				viewport: frame.viewport,
				image: {
					width: imageSize.width,
					height: imageSize.height,
					scaleFactor:
						frame.viewport.width > 0
							? Number((imageSize.width / frame.viewport.width).toFixed(3))
							: 1,
				},
				logs: frame.logs,
				imageDataUrl: image.toDataURL(),
			};
			return inspection;
		});
	});

	server.setInteractMovementDesignerCallback(async (id: string, action: ConcertoDesignerAction) => {
		const unavailable = (message: string): ConcertoDesignerActionResult => ({
			ok: false,
			action: action.kind,
			selector: action.selector,
			message,
		});
		if (settingsStore.get<{ concerto?: boolean }>('encoreFeatures', {}).concerto !== true)
			return unavailable('Concerto is disabled');
		const mainWindow = getMainWindow();
		if (!mainWindow || !isWebContentsAvailable(mainWindow)) {
			return unavailable('Maestro renderer is unavailable');
		}
		const expectedRevision = getConcertoHtmlDocumentRevision('movement', id);
		if (expectedRevision === null) {
			return unavailable(`HTML movement '${id}' is unavailable`);
		}
		return requestFromRenderer<ConcertoDesignerActionResult>(
			mainWindow,
			'remote:interactMovementDesigner',
			{
				fallback: unavailable('Designer action timed out'),
				parse: (raw) => raw as ConcertoDesignerActionResult,
				timeoutMs: 4000,
				args: [id, action, expectedRevision],
			}
		);
	});
}
