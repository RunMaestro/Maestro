import { ipcRenderer } from 'electron';
import type { CadenzaPayload } from '../../../shared/cadenza-types';
import type { MovementPayload, MovementStateSnapshot } from '../../../shared/movement-types';
import type {
	ConcertoDesignerAction,
	ConcertoDesignerActionResult,
	ConcertoDesignerFrameSnapshot,
	ConcertoHtmlSurface,
} from '../../../shared/concerto-html';

export function createCadenzaMovementRemoteApi() {
	return {
		/**
		 * Subscribe to remote cadenza-view operations (open/update/close) from
		 * the CLI/web interface. Cadenzas are small agent-opened panels that
		 * display or track work.
		 */
		onRemoteCadenza: (callback: (params: CadenzaPayload) => void): (() => void) => {
			const handler = (_: unknown, params: CadenzaPayload) => callback(params);
			ipcRenderer.on('remote:cadenza', handler);
			return () => ipcRenderer.removeListener('remote:cadenza', handler);
		},

		/**
		 * Subscribe to a cadenza "flash" pulse (from a chat "point" chip). The main
		 * process routes it to whichever renderer holds the cadenza - the HUD window,
		 * or the in-app fallback layer - so the card pulses even though cadenzas
		 * normally live in the separate HUD renderer.
		 */
		onRemoteCadenzaFlash: (callback: (id: string) => void): (() => void) => {
			const handler = (_: unknown, id: string) => callback(id);
			ipcRenderer.on('remote:cadenzaFlash', handler);
			return () => ipcRenderer.removeListener('remote:cadenzaFlash', handler);
		},

		/**
		 * Subscribe to the "stash all cadenzas" toggle. Cadenzas normally live in
		 * the HUD window, but the hotkey and command palette that flip the stash
		 * are in the main window, so main forwards the new value here.
		 */
		onRemoteCadenzaHidden: (callback: (hidden: boolean) => void): (() => void) => {
			const handler = (_: unknown, hidden: boolean) => callback(hidden);
			ipcRenderer.on('remote:cadenzaHidden', handler);
			return () => ipcRenderer.removeListener('remote:cadenzaHidden', handler);
		},

		/**
		 * Subscribe to remote movement operations and Concerto progress reports from
		 * the CLI/web interface. The renderer applies window mutations to the movement
		 * store and routes progress reports to the creation pipeline.
		 */
		onRemoteMovement: (
			callback: (params: MovementPayload, responseChannel?: string) => void
		): (() => void) => {
			const handler = (_: unknown, params: MovementPayload, responseChannel?: string) =>
				callback(params, responseChannel);
			ipcRenderer.on('remote:movement', handler);
			return () => ipcRenderer.removeListener('remote:movement', handler);
		},

		/** Ack a movement mutation after the renderer has committed it. */
		sendMovementAppliedResponse: (responseChannel: string, applied: boolean): void => {
			ipcRenderer.send(responseChannel, applied);
		},

		/** Release an isolated HTML document after its owning UI view is closed. */
		releaseConcertoHtmlDocument: (surface: ConcertoHtmlSurface, id: string): void => {
			ipcRenderer.send('concerto-html:release', surface, id);
		},

		/** Restore a recently closed isolated document before recreating its view. */
		restoreConcertoHtmlDocument: (
			surface: ConcertoHtmlSurface,
			id: string,
			html: string
		): Promise<number> => ipcRenderer.invoke('concerto-html:restore', surface, id, html),

		/**
		 * Subscribe to `movement state` reads: the main process sends a request with a
		 * response channel; the renderer replies via sendMovementStateResponse with the
		 * current movement snapshot (so an agent can compose around what's there).
		 */
		onRequestMovementState: (callback: (responseChannel: string) => void): (() => void) => {
			const handler = (_: unknown, responseChannel: string) => callback(responseChannel);
			ipcRenderer.on('remote:getMovementState', handler);
			return () => ipcRenderer.removeListener('remote:getMovementState', handler);
		},

		/** Reply to a `movement state` read with the current snapshot. */
		sendMovementStateResponse: (
			responseChannel: string,
			snapshot: MovementStateSnapshot | null
		): void => {
			ipcRenderer.send(responseChannel, snapshot);
		},

		/** Ask the renderer for a live HTML Movement frame's crop and diagnostics. */
		onRequestMovementDesignerInspection: (
			callback: (id: string, expectedRevision: number, responseChannel: string) => void
		): (() => void) => {
			const handler = (_: unknown, id: string, expectedRevision: number, responseChannel: string) =>
				callback(id, expectedRevision, responseChannel);
			ipcRenderer.on('remote:getMovementDesignerInspection', handler);
			return () => ipcRenderer.removeListener('remote:getMovementDesignerInspection', handler);
		},

		/** Reply with frame geometry and runtime diagnostics for screenshot capture. */
		sendMovementDesignerInspectionResponse: (
			responseChannel: string,
			snapshot: ConcertoDesignerFrameSnapshot | null
		): void => {
			ipcRenderer.send(responseChannel, snapshot);
		},

		/** Ask the sandboxed HTML Movement to perform a selector-scoped action. */
		onRequestMovementDesignerInteraction: (
			callback: (
				id: string,
				action: ConcertoDesignerAction,
				expectedRevision: number,
				responseChannel: string
			) => void
		): (() => void) => {
			const handler = (
				_: unknown,
				id: string,
				action: ConcertoDesignerAction,
				expectedRevision: number,
				responseChannel: string
			) => callback(id, action, expectedRevision, responseChannel);
			ipcRenderer.on('remote:interactMovementDesigner', handler);
			return () => ipcRenderer.removeListener('remote:interactMovementDesigner', handler);
		},

		/** Reply with the outcome of a sandboxed designer action. */
		sendMovementDesignerInteractionResponse: (
			responseChannel: string,
			result: ConcertoDesignerActionResult
		): void => {
			ipcRenderer.send(responseChannel, result);
		},

		/**
		 * Signal that the cadenza HUD window's renderer has mounted and
		 * subscribed to `remote:cadenza`. The main process buffers the cadenza
		 * that triggered the (lazy) HUD creation until this fires, then flushes it -
		 * otherwise the very first cadenza is dropped before the listener exists.
		 */
		notifyCadenzaHudReady: (): void => {
			ipcRenderer.send('cadenza-hud:ready');
		},

		/**
		 * Ask main to flash (pulse) a cadenza by id - used by the chat "point" chip.
		 * Main routes it to whichever renderer holds the cadenza (HUD window, or the
		 * in-app fallback layer), respecting the Concerto gate.
		 */
		flashCadenza: (id: string): void => {
			ipcRenderer.send('cadenza:flash', id);
		},

		/**
		 * Show or stash every cadenza at once. The main renderer flips its own
		 * store directly; this tells main to mirror the change into the HUD window,
		 * which is where cadenzas actually render whenever it is up.
		 */
		setCadenzasHidden: (hidden: boolean): void => {
			ipcRenderer.send('cadenza:set-hidden', hidden);
		},

		/**
		 * Report the cadenza cards' hit regions (in HUD-window content
		 * coordinates) so the main process can poll the cursor against them and
		 * toggle click-through. Cross-platform by design: renderer mouse-move
		 * forwarding (`setIgnoreMouseEvents` `forward`) is unsupported on Linux.
		 */
		setCadenzaHudCardRects: (
			rects: Array<{ x: number; y: number; width: number; height: number }>
		): void => {
			ipcRenderer.send('cadenza-hud:card-rects', rects);
		},

		/**
		 * Expand a file cadenza from the HUD window into the owning agent's File
		 * Preview tab in the main window. The HUD is a separate window, so it can't
		 * dispatch the in-app `maestro:openFileTab` event directly; the main process
		 * forwards this to the main renderer (and raises it - a deliberate "take me
		 * to Maestro" action, unlike ordinary card interaction).
		 */
		openCadenzaFileTab: (sessionId: string, filePath: string): void => {
			ipcRenderer.send('cadenza-hud:open-file', sessionId, filePath);
		},

		/**
		 * Reply to the owning agent from a `decision` cadenza: the chosen option's
		 * value is injected as a live prompt into that agent's session (the same
		 * path `maestro-cli dispatch` uses), so the agent's next turn sees the
		 * choice. Does not raise Maestro - the decision is made in place.
		 */
		sendCadenzaDecision: (sessionId: string, message: string): void => {
			ipcRenderer.send('cadenza-hud:decision', sessionId, message);
		},
	};
}
