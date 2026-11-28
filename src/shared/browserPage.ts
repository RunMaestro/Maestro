import type { BrowserRelayTarget, BrowserRelayViewport, BrowserRelayAction } from './browserRelay';
import type { BrowserViewportPreset } from './browserViewport';
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
	/**
	 * Design Mode is on for this tab. Sticky: it survives page loads, tab
	 * switches and restarts, and the picker overlay re-arms whenever the tab is
	 * the active surface again. Only Escape and the Design Mode toggle (toolbar
	 * button, shortcut, command palette) turn it off. Persisted.
	 */
	designMode?: boolean;
	/**
	 * The width this tab shows its page at: 'fit' (or unset) fills the tab, any
	 * other preset lays the page out at that CSS width and scales it down to fit.
	 * Chosen by the user for this tab, so it survives page loads and restarts.
	 * Persisted.
	 */
	viewportPreset?: BrowserViewportPreset;
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
