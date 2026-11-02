/**
 * Preload API for Dataview (`window.maestro.dataview`, D2, DV-7).
 *
 * Mirrors the `dataview:*` channels in `src/main/ipc/handlers/dataview.ts`. Results arrive in wire form;
 * run them through `reviveDataviewResult()` / `reviveDataviewInlineResult()` (`src/shared/dataview`) to
 * get Dataview values back. The web-desktop bridge forwards the DQL channels and the change push (DV-14);
 * `jsSnapshot`, `readInRoot`, `jsRoot`, `jsRunOnce`, and the trust calls are DataviewJS, which is desktop
 * only.
 */

import { ipcRenderer } from 'electron';
import type {
	DataviewChangeEvent,
	DataviewIndexStatus,
	DataviewInlineQueryRequest,
	DataviewInlineResult,
	DataviewJsRoot,
	DataviewJsRootRequest,
	DataviewJsSnapshotRequest,
	DataviewQueryRequest,
	DataviewQueryResponse,
	DataviewReadInRootRequest,
	DataviewReadInRootResponse,
	DataviewRebuildRequest,
	DataviewResult,
	DataviewStatusRequest,
	DataviewTrustRequest,
	DataviewTrustResponse,
} from '../../shared/dataview/types';
import type { SandboxSnapshotPayload } from '../../shared/dataview/sandboxProtocol';

/** Creates the Dataview API object for contextBridge exposure. */
export function createDataviewApi() {
	return {
		/** Run one `dataview` block with `this` bound to the note at `request.filePath`. */
		query: (request: DataviewQueryRequest): Promise<DataviewQueryResponse<DataviewResult>> =>
			ipcRenderer.invoke('dataview:query', request),
		/** Evaluate one inline `` `= expr` ``. */
		queryInline: (
			request: DataviewInlineQueryRequest
		): Promise<DataviewQueryResponse<DataviewInlineResult>> =>
			ipcRenderer.invoke('dataview:queryInline', request),
		/** The named open root, or every open root. Never opens one. */
		status: (request?: DataviewStatusRequest): Promise<DataviewIndexStatus[]> =>
			ipcRenderer.invoke('dataview:status', request ?? {}),
		/** Drop a root's cache and index it again; resolves once the full scan has finished. */
		rebuild: (request: DataviewRebuildRequest): Promise<DataviewIndexStatus> =>
			ipcRenderer.invoke('dataview:rebuild', request),
		/** The index snapshot a DataviewJS run reads, as JSON text for the guest (D4). Refused unless DataviewJS is on and the root trusted. */
		jsSnapshot: (
			request: DataviewJsSnapshotRequest
		): Promise<DataviewQueryResponse<SandboxSnapshotPayload>> =>
			ipcRenderer.invoke('dataview:jsSnapshot', request),
		/** Read a text file inside the note's vault root for a DataviewJS script (`dv.io.load`, D4). */
		readInRoot: (request: DataviewReadInRootRequest): Promise<DataviewReadInRootResponse> =>
			ipcRenderer.invoke('dataview:readInRoot', request),
		/** The vault root of a note with a `dataviewjs` block, as the trust list compares it (D3). */
		jsRoot: (request: DataviewJsRootRequest): Promise<DataviewJsRoot> =>
			ipcRenderer.invoke('dataview:jsRoot', request),
		/** "Run once": let main answer DataviewJS in the note's vault for this app session (D3). */
		jsRunOnce: (request: DataviewJsRootRequest): Promise<DataviewJsRoot> =>
			ipcRenderer.invoke('dataview:jsRunOnce', request),
		/** The trusted vault roots (`dataviewJsTrustedRoots`), cleaned. */
		trustedRoots: (): Promise<string[]> => ipcRenderer.invoke('dataview:trustedRoots'),
		/** Trust a vault root: its DataviewJS blocks run without asking (D3). */
		trust: (request: DataviewTrustRequest): Promise<DataviewTrustResponse> =>
			ipcRenderer.invoke('dataview:trust', request),
		/** Stop trusting a vault root, and revoke its "Run once" grants. */
		untrust: (request: DataviewTrustRequest): Promise<DataviewTrustResponse> =>
			ipcRenderer.invoke('dataview:untrust', request),
		/** Fires when an open index changes (DV-7). Returns the unsubscribe function. */
		onChanged: (handler: (event: DataviewChangeEvent) => void): (() => void) => {
			const wrapped = (_event: Electron.IpcRendererEvent, change: DataviewChangeEvent) =>
				handler(change);
			ipcRenderer.on('dataview:changed', wrapped);
			return () => {
				ipcRenderer.removeListener('dataview:changed', wrapped);
			};
		},
	};
}

export type DataviewApi = ReturnType<typeof createDataviewApi>;
