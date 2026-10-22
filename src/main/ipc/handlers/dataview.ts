/**
 * Dataview IPC (`dataview:*`, D2, DV-7, DV-14).
 *
 * Thin pass-throughs to the one DataviewService: each handler body is a service request method, and the
 * CLI's WS verbs call the same methods. Main resolves the agent's cwd and SSH remote from its id, so a
 * request never names a host. The DQL channels are on the web bridge's allowlist
 * (`src/main/web-server/handlers/bridgeDenyList.ts`), so the browser build runs DQL too; the DataviewJS
 * channels (`jsSnapshot`, `readInRoot`, `jsRoot`, `jsRunOnce`) and the trust channels (`trustedRoots`,
 * `trust`, `untrust`) are not, since DataviewJS is desktop only (DV-14). The CLI edits trust over its own
 * WS verb, which calls the same service methods.
 *
 * Gate (D3): the service's request methods refuse while the `dataview` Encore Feature is off, with the
 * readable `encoreDisabledMessage('dataview')` text, so these handlers and the WS bridge refuse alike
 * and no root opens.
 *
 * `dataview:changed` goes out through the all-windows `safeSend`, which also reaches bridge clients:
 * File Preview can sit in a secondary window.
 */

import { ipcMain } from 'electron';
import { withIpcErrorLogging } from '../../utils/ipcHandler';
import { getDataviewService } from '../../dataview/dataview-service';
import { setDataviewJsServingCheck } from '../../dataview/guest-host';
import type { SafeSendFn } from '../../utils/safe-send';
import type {
	DataviewInlineQueryRequest,
	DataviewJsRootRequest,
	DataviewJsSnapshotRequest,
	DataviewQueryRequest,
	DataviewReadInRootRequest,
	DataviewRebuildRequest,
	DataviewStatusRequest,
	DataviewTrustRequest,
} from '../../../shared/dataview';

const LOG_CONTEXT = '[Dataview]';

export interface DataviewHandlerDependencies {
	safeSend: SafeSendFn;
}

function opts(operation: string) {
	return { context: LOG_CONTEXT, operation };
}

export function registerDataviewHandlers(deps: DataviewHandlerDependencies): void {
	const service = getDataviewService();

	ipcMain.handle(
		'dataview:query',
		withIpcErrorLogging(opts('query'), async (request: DataviewQueryRequest) =>
			service.query(request)
		)
	);
	ipcMain.handle(
		'dataview:queryInline',
		withIpcErrorLogging(opts('queryInline'), async (request: DataviewInlineQueryRequest) =>
			service.queryInline(request)
		)
	);
	ipcMain.handle(
		'dataview:status',
		withIpcErrorLogging(opts('status'), async (request?: DataviewStatusRequest) =>
			service.indexStatus(request ?? {})
		)
	);
	ipcMain.handle(
		'dataview:rebuild',
		withIpcErrorLogging(opts('rebuild'), async (request: DataviewRebuildRequest) =>
			service.rebuildIndex(request)
		)
	);
	// DataviewJS (D4): desktop only, so neither channel is on the web bridge's allowlist. The service
	// refuses both unless DataviewJS is on and the root trusted, and re-checks every path in main.
	ipcMain.handle(
		'dataview:jsSnapshot',
		withIpcErrorLogging(opts('jsSnapshot'), async (request: DataviewJsSnapshotRequest) =>
			service.jsSnapshot(request)
		)
	);
	ipcMain.handle(
		'dataview:readInRoot',
		withIpcErrorLogging(opts('readInRoot'), async (request: DataviewReadInRootRequest) =>
			service.readInRoot(request)
		)
	);

	// The trust gate (D3, DV-12): a block's root and its "Run once" grant, then the trust list the settings
	// UI and a block's "Always trust this vault" edit (the CLI reaches the same methods over WS).
	ipcMain.handle(
		'dataview:jsRoot',
		withIpcErrorLogging(opts('jsRoot'), async (request: DataviewJsRootRequest) =>
			service.jsRoot(request)
		)
	);
	ipcMain.handle(
		'dataview:jsRunOnce',
		withIpcErrorLogging(opts('jsRunOnce'), async (request: DataviewJsRootRequest) =>
			service.grantJsRunOnce(request)
		)
	);
	ipcMain.handle(
		'dataview:trustedRoots',
		withIpcErrorLogging(opts('trustedRoots'), async () => service.trustedRootList())
	);
	ipcMain.handle(
		'dataview:trust',
		withIpcErrorLogging(opts('trust'), async (request: DataviewTrustRequest) =>
			service.trustRoot(request)
		)
	);
	ipcMain.handle(
		'dataview:untrust',
		withIpcErrorLogging(opts('untrust'), async (request: DataviewTrustRequest) =>
			service.untrustRoot(request)
		)
	);

	// The guest host serves and attaches DataviewJS guests only while this says yes (default deny).
	setDataviewJsServingCheck(() => service.jsServing());

	// DV-7: every open index's changes, to every window and bridge client.
	service.onChange((event) => deps.safeSend('dataview:changed', event));

	// A trust edit is a settings write main made itself, which the settings file watcher ignores, so tell
	// every window to reload settings: the open settings list and every `dataviewjs` block follow it.
	service.onTrustedRootsChange(() => deps.safeSend('settings:externalChange'));
}
