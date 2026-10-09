export interface BrowserRelayTarget {
	sessionId: string;
	tabId: string;
}

export interface BrowserRelayViewport {
	width: number;
	height: number;
}

/** Split relay text at the host's UTF-16 limit without breaking surrogate pairs. */
export function* chunkBrowserRelayText(text: string): Generator<string> {
	for (let start = 0; start < text.length; ) {
		let end = Math.min(start + 16_384, text.length);
		if (
			end < text.length &&
			text.charCodeAt(end - 1) >= 0xd800 &&
			text.charCodeAt(end - 1) <= 0xdbff &&
			text.charCodeAt(end) >= 0xdc00 &&
			text.charCodeAt(end) <= 0xdfff
		)
			end--;
		yield text.slice(start, end);
		start = end;
	}
}

export type BrowserRelayInput =
	| {
			type: 'mouseDown' | 'mouseUp' | 'mouseMove';
			x: number;
			y: number;
			button?: 'left' | 'middle' | 'right';
			buttons?: number;
			clickCount?: number;
			modifiers?: string[];
	  }
	| {
			type: 'mouseWheel';
			x: number;
			y: number;
			deltaX: number;
			deltaY: number;
			modifiers?: string[];
	  }
	| { type: 'keyDown' | 'keyUp' | 'char'; keyCode: string; modifiers?: string[] }
	| { type: 'text'; text: string };

export type BrowserRelayAction =
	| { kind: 'navigate'; url: string }
	| { kind: 'back' | 'forward' | 'reload' | 'stop' | 'clearData' | 'selection' | 'deleteSelection' }
	| { kind: 'extract'; format: 'text' | 'innerText' | 'html' }
	| { kind: 'eval'; code: string }
	| { kind: 'find'; text: string; forward?: boolean; findNext?: boolean };

export interface BrowserRelayFrame {
	dataUrl: string;
	width: number;
	height: number;
	url: string;
	title: string;
	canGoBack: boolean;
	canGoForward: boolean;
	isLoading: boolean;
}

/** Private host-renderer request; never broadcast to remote clients. */
export interface BrowserRelayRequest extends BrowserRelayTarget {
	requestId: string;
	kind: 'resolve' | 'frame' | 'action' | 'release';
	viewport?: BrowserRelayViewport;
	action?: BrowserRelayAction;
}

export interface BrowserRelayHostResult {
	ok: boolean;
	error?: string;
	target?: BrowserRelayTarget;
	initialUrl?: string;
	webContentsId?: number;
	ownerWebContentsId?: number;
	partition?: string;
	frame?: BrowserRelayFrame;
	state?: Omit<BrowserRelayFrame, 'dataUrl'>;
	value?: unknown;
}
