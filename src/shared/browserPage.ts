import type { BrowserRelayTarget, BrowserRelayViewport, BrowserRelayAction } from './browserRelay';
/** Canonical host browser tab data shared by native and remote presentations. */
export interface BrowserTab {
	id: string;
	url: string;
	title: string;
	customTitle?: string;
	createdAt: number;
	partition?: string;
	canGoBack: boolean;
	canGoForward: boolean;
	isLoading: boolean;
	favicon?: string | null;
	hiddenFromAgent?: boolean;
	ephemeral?: boolean;
	webContentsId?: number;
	/** Runtime only: this tab was opened remotely without a mounted native guest. */
	remotePage?: boolean;
}
export interface BrowserTabCreationOptions {
	url?: string;
	title?: string;
	ephemeral?: boolean;
}

export interface BrowserTabCreateRequest {
	requestId: string;
	sessionId: string;
	options: BrowserTabCreationOptions;
}

export interface BrowserPageState extends BrowserRelayViewport {
	offscreen?: boolean;
	url: string;
	title: string;
	canGoBack: boolean;
	canGoForward: boolean;
	isLoading: boolean;
	webContentsId: number;
	ready: boolean;
	favicon?: string | null;
}

export interface BrowserPageEvent {
	target: BrowserRelayTarget;
	type: string;
	state: BrowserPageState;
	details?: Record<string, unknown>;
}

export type BrowserPageAction =
	| BrowserRelayAction
	| { kind: 'css'; css: string }
	| { kind: 'snapshot' }
	| { kind: 'stopFind'; action: 'clearSelection' | 'keepSelection' | 'activateSelection' }
	| { kind: 'paste' | 'copy' | 'cut' | 'selectAll' };
