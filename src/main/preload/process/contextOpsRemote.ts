import { ipcRenderer } from 'electron';
import type { TabContextOpRequest, TabContextOpResult } from '../../../shared/tabContextOps';

type TabContextOpListener = (request: TabContextOpRequest, responseChannel: string) => void;

/** Subscribe to one context-operation channel; returns the unsubscribe. */
function subscribe(channel: string, callback: TabContextOpListener): () => void {
	const handler = (_: unknown, request: TabContextOpRequest, responseChannel: string) =>
		callback(request, responseChannel);
	ipcRenderer.on(channel, handler);
	return () => ipcRenderer.removeListener(channel, handler);
}

/**
 * The AI tab overlay menu's context items reached remotely (`maestro-cli tab
 * compact|merge|transfer`). Each request carries an optional source `tabId`
 * (and, for merge, `targetTabId`); the renderer defaults both to the active
 * AI tab and answers on the per-call response channel with a
 * `TabContextOpResult`.
 */
export function createContextOpsRemoteApi() {
	return {
		/** Context: Merge Into. */
		onRemoteMergeContext: (callback: TabContextOpListener): (() => void) =>
			subscribe('remote:mergeContext', callback),

		sendRemoteMergeContextResponse: (responseChannel: string, result: TabContextOpResult): void => {
			ipcRenderer.send(responseChannel, result);
		},

		/** Context: Send to Agent. */
		onRemoteTransferContext: (callback: TabContextOpListener): (() => void) =>
			subscribe('remote:transferContext', callback),

		sendRemoteTransferContextResponse: (
			responseChannel: string,
			result: TabContextOpResult
		): void => {
			ipcRenderer.send(responseChannel, result);
		},

		/** Context: Compact. */
		onRemoteSummarizeContext: (callback: TabContextOpListener): (() => void) =>
			subscribe('remote:summarizeContext', callback),

		sendRemoteSummarizeContextResponse: (
			responseChannel: string,
			result: TabContextOpResult
		): void => {
			ipcRenderer.send(responseChannel, result);
		},
	};
}
