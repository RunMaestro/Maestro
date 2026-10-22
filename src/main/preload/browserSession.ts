import { ipcRenderer } from 'electron';
import type {
	BrowserRelayTarget,
	BrowserRelayViewport,
	BrowserRelayFrame,
	BrowserRelayInput,
	BrowserRelayAction,
	BrowserRelayRequest,
	BrowserRelayHostResult,
} from '../../shared/browserRelay';
import type {
	BrowserPageState,
	BrowserPageEvent,
	BrowserPageAction,
	BrowserTabCreationOptions,
	BrowserTabCreateRequest,
} from '../../shared/browserPage';
import type { BrowserTab } from '../../shared/browserPage';

export interface BrowserSessionApi {
	createTab: (sessionId: string, options?: BrowserTabCreationOptions) => Promise<BrowserTab>;
	onCreateTabRequest: (callback: (request: BrowserTabCreateRequest) => void) => () => void;
	clearSessionData: (partition: string) => Promise<{ ok: boolean; error?: string }>;
	relayOpen: (target: BrowserRelayTarget, viewport: BrowserRelayViewport) => Promise<string>;
	relayFrame: (leaseId: string, viewport: BrowserRelayViewport) => Promise<BrowserRelayFrame>;
	relayInput: (leaseId: string, input: BrowserRelayInput) => Promise<void>;
	relayAction: (leaseId: string, action: BrowserRelayAction) => Promise<unknown>;
	relayClose: (leaseId: string) => Promise<void>;
	relayReady: (ready: boolean) => Promise<void>;
	onRelayRequest: (callback: (request: BrowserRelayRequest) => void) => () => void;
	relayRespond: (requestId: string, result: BrowserRelayHostResult) => void;
	pageOpen: (
		target: BrowserRelayTarget,
		viewId: string,
		viewport: BrowserRelayViewport
	) => Promise<BrowserPageState>;
	pageFrame: (
		target: BrowserRelayTarget,
		viewId: string,
		viewport: BrowserRelayViewport
	) => Promise<BrowserRelayFrame>;
	pageAction: (target: BrowserRelayTarget, action: BrowserPageAction) => Promise<unknown>;
	pageInput: (target: BrowserRelayTarget, input: BrowserRelayInput) => Promise<void>;
	pageFind: (
		target: BrowserRelayTarget,
		text: string,
		options?: { forward?: boolean; findNext?: boolean; matchCase?: boolean }
	) => number;
	pageSuspend: (target: BrowserRelayTarget, viewId: string) => Promise<void>;
	pageRelease: (target: BrowserRelayTarget, viewId: string) => Promise<void>;
	pageClose: (target: BrowserRelayTarget) => Promise<void>;
	onPageEvent: (callback: (event: BrowserPageEvent) => void) => () => void;
}

export function createBrowserSessionApi(): BrowserSessionApi {
	return {
		createTab: (sessionId, options = {}) =>
			ipcRenderer.invoke('browser:createTab', sessionId, options),
		onCreateTabRequest: (callback) => {
			const listener = (_event: unknown, request: BrowserTabCreateRequest) => callback(request);
			ipcRenderer.on('browser:createTabRequest', listener);
			return () => ipcRenderer.removeListener('browser:createTabRequest', listener);
		},
		clearSessionData: (partition) => ipcRenderer.invoke('browser:clearSessionData', partition),
		relayOpen: (target, viewport) => ipcRenderer.invoke('browser:relayOpen', target, viewport),
		relayFrame: (leaseId, viewport) => ipcRenderer.invoke('browser:relayFrame', leaseId, viewport),
		relayInput: (leaseId, input) => ipcRenderer.invoke('browser:relayInput', leaseId, input),
		relayAction: (leaseId, action) => ipcRenderer.invoke('browser:relayAction', leaseId, action),
		relayClose: (leaseId) => ipcRenderer.invoke('browser:relayClose', leaseId),
		relayReady: (ready) => ipcRenderer.invoke('browser:relayReady', ready),
		onRelayRequest: (callback) => {
			const listener = (_event: unknown, request: BrowserRelayRequest) => callback(request);
			ipcRenderer.on('browser:relayRequest', listener);
			return () => ipcRenderer.removeListener('browser:relayRequest', listener);
		},
		relayRespond: (requestId, result) =>
			ipcRenderer.send('browser:relayResponse', requestId, result),
		pageOpen: (target, viewId, viewport) =>
			ipcRenderer.invoke('browser:pageOpen', target, viewId, viewport),
		pageFrame: (target, viewId, viewport) =>
			ipcRenderer.invoke('browser:pageFrame', target, viewId, viewport),
		pageAction: (target, action) => ipcRenderer.invoke('browser:pageAction', target, action),
		pageInput: (target, input) => ipcRenderer.invoke('browser:pageInput', target, input),
		pageFind: (target, text, options) => {
			const result = ipcRenderer.sendSync('browser:pageFind', target, text, options);
			if (!result.ok) throw new Error(result.error);
			return result.id;
		},
		pageSuspend: (target, viewId) => ipcRenderer.invoke('browser:pageSuspend', target, viewId),
		pageRelease: (target, viewId) => ipcRenderer.invoke('browser:pageRelease', target, viewId),
		pageClose: (target) => ipcRenderer.invoke('browser:pageClose', target),
		onPageEvent: (callback) => {
			const listener = (_event: unknown, event: BrowserPageEvent) => callback(event);
			ipcRenderer.on('browser:pageEvent', listener);
			return () => ipcRenderer.removeListener('browser:pageEvent', listener);
		},
	};
}
