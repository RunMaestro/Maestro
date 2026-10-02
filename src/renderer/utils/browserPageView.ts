import type {
	BrowserRelayTarget,
	BrowserRelayViewport,
	BrowserRelayInput,
} from '../../shared/browserRelay';
import type { BrowserPageState, BrowserPageAction } from '../../shared/browserPage';

/** Existing native browser controls operate on this presentation of a main-owned page. */
export interface HostBrowserPageElement extends HTMLDivElement {
	src: string;
	canGoBack(): boolean;
	canGoForward(): boolean;
	goBack(): void;
	goForward(): void;
	reload(): void;
	stop(): void;
	getURL(): string;
	getTitle(): string;
	isLoading(): boolean;
	getWebContentsId(): number | undefined;
	executeJavaScript(code: string): Promise<unknown>;
	insertCSS(css: string): Promise<string>;
	findInPage(
		text: string,
		options?: { forward?: boolean; findNext?: boolean; matchCase?: boolean }
	): number;
	stopFindInPage(action: 'clearSelection' | 'keepSelection' | 'activateSelection'): void;
	capturePage(): Promise<{ toDataURL(): string }>;
	setActive(active: boolean): void;
	dispose(): void;
}

export function createHostBrowserPageView(
	target: BrowserRelayTarget,
	initialUrl: string,
	background: string
): HostBrowserPageElement {
	const api = window.maestro.browserSession;
	const viewId = crypto.randomUUID();
	const root = document.createElement('div');
	root.style.cssText =
		'position:relative;display:flex;width:100%;height:100%;min-height:0;overflow:hidden;outline:none';
	root.style.backgroundColor = background;
	root.tabIndex = 0;
	root.dataset.maestroBrowserTab = target.tabId;
	root.setAttribute('role', 'application');
	root.setAttribute('aria-label', 'Host browser page');
	const image = document.createElement('img');
	image.alt = 'Host browser page';
	image.draggable = false;
	image.style.cssText = 'width:100%;height:100%;pointer-events:none;object-fit:fill';
	root.append(image);
	const keyboard = document.createElement('textarea');
	keyboard.tabIndex = -1;
	keyboard.setAttribute('aria-label', 'Host browser keyboard input');
	keyboard.style.cssText = 'position:absolute;width:1px;height:1px;opacity:0;left:0;top:0';
	root.append(keyboard);
	let state: BrowserPageState | null = null,
		url = initialUrl,
		active = false,
		disposed = false,
		generation = 0;
	let dimensions: BrowserRelayViewport = { width: 1024, height: 768 };
	let timer: ReturnType<typeof setTimeout> | undefined;
	let queue: Promise<unknown> = Promise.resolve();
	const dispatch = (type: string, details?: Record<string, unknown>) => {
		const event = new Event(type);
		Object.assign(event, details);
		root.dispatchEvent(event);
	};
	const failure = (error: unknown) => {
		if (!disposed)
			dispatch('did-fail-load', {
				validatedURL: url,
				errorDescription: error instanceof Error ? error.message : String(error),
				isMainFrame: true,
			});
	};
	const update = (next: BrowserPageState) => {
		state = next;
		url = next.url;
		root.dataset.maestroBrowserReady = String(next.ready);
	};
	const unsubscribe = api.onPageEvent((event) => {
		if (
			disposed ||
			event.target.sessionId !== target.sessionId ||
			event.target.tabId !== target.tabId
		)
			return;
		update(event.state);
		dispatch(event.type, event.details);
	});
	const opening = api.pageOpen(target, viewId, dimensions).then((next) => {
		if (disposed) return;
		update(next);
		if (next.ready) dispatch('dom-ready');
	});
	void opening.catch(failure);
	const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
		const pending = queue
			.catch(() => {})
			.then(() => opening)
			.then(() => {
				if (disposed) throw new Error('Browser presentation closed');
				return operation();
			});
		queue = pending;
		return pending;
	};
	const action = (value: BrowserPageAction) => enqueue(() => api.pageAction(target, value));
	const send = (value: BrowserRelayInput) => {
		void enqueue(() => api.pageInput(target, value)).catch(failure);
	};
	function measure(): BrowserRelayViewport {
		const bounds = root.getBoundingClientRect();
		return {
			width: Math.min(2560, Math.max(1, Math.round(bounds.width))),
			height: Math.min(1600, Math.max(1, Math.round(bounds.height))),
		};
	}
	async function pump(current: number): Promise<void> {
		if (disposed || !active || generation !== current) return;
		try {
			const frame = await enqueue(() => api.pageFrame(target, viewId, measure()));
			if (disposed || !active || generation !== current) return;
			const decoded = new Image();
			decoded.src = frame.dataUrl;
			await decoded.decode();
			if (disposed || !active || generation !== current) return;
			dimensions = { width: frame.width, height: frame.height };
			image.src = frame.dataUrl;
			timer = setTimeout(() => {
				void pump(current);
			}, 125);
		} catch (error) {
			failure(error);
		}
	}
	const modifiers = (event: MouseEvent | KeyboardEvent | WheelEvent): string[] =>
		[
			event.shiftKey && 'shift',
			event.ctrlKey && 'control',
			event.altKey && 'alt',
			event.metaKey && 'meta',
		].filter((value): value is string => !!value);
	const point = (event: MouseEvent): { x: number; y: number } => {
		const bounds = root.getBoundingClientRect();
		return {
			x: Math.max(
				0,
				Math.min(
					dimensions.width - 1,
					Math.round(((event.clientX - bounds.left) * dimensions.width) / Math.max(1, bounds.width))
				)
			),
			y: Math.max(
				0,
				Math.min(
					dimensions.height - 1,
					Math.round(
						((event.clientY - bounds.top) * dimensions.height) / Math.max(1, bounds.height)
					)
				)
			),
		};
	};
	const pointer = (event: PointerEvent, type: 'mouseDown' | 'mouseUp' | 'mouseMove') => {
		if (!active) return;
		if (type === 'mouseDown') {
			event.preventDefault();
			keyboard.focus();
			root.setPointerCapture(event.pointerId);
		}
		send({
			type,
			...point(event),
			button: event.button === 1 ? 'middle' : event.button === 2 ? 'right' : 'left',
			buttons: event.buttons & 7,
			clickCount: Math.min(3, Math.max(1, event.detail)),
			modifiers: modifiers(event),
		});
	};
	root.addEventListener('pointerdown', (event) => pointer(event, 'mouseDown'));
	root.addEventListener('pointerup', (event) => pointer(event, 'mouseUp'));
	root.addEventListener('pointermove', (event) => {
		if (!event.buttons || event.buttons < 8) pointer(event, 'mouseMove');
	});
	root.addEventListener('contextmenu', (event) => event.preventDefault());
	root.addEventListener(
		'wheel',
		(event) => {
			if (!active) return;
			event.preventDefault();
			event.stopPropagation();
			const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? dimensions.height : 1;
			send({
				type: 'mouseWheel',
				...point(event),
				deltaX: event.deltaX * scale,
				deltaY: event.deltaY * scale,
				modifiers: modifiers(event),
			});
		},
		{ passive: false }
	);
	const key = (event: KeyboardEvent, type: 'keyDown' | 'keyUp') => {
		if (!active || event.isComposing) return;
		if (
			(event.metaKey || event.ctrlKey || event.altKey) &&
			!['Meta', 'Control', 'Alt', 'Shift'].includes(event.key) &&
			!(!event.altKey && 'acvxz'.includes(event.key.toLowerCase()))
		)
			return;
		event.preventDefault();
		event.stopPropagation();
		send({ type, keyCode: event.key, modifiers: modifiers(event) });
		if (
			type === 'keyDown' &&
			event.key.length === 1 &&
			!event.ctrlKey &&
			!event.metaKey &&
			!event.altKey
		)
			send({ type: 'char', keyCode: event.key, modifiers: modifiers(event) });
	};
	root.addEventListener('keydown', (event) => key(event, 'keyDown'));
	root.addEventListener('keyup', (event) => key(event, 'keyUp'));
	keyboard.addEventListener('compositionend', (event) => {
		send({ type: 'text', text: event.data });
		keyboard.value = '';
	});
	keyboard.addEventListener('input', (event) => {
		if (!(event instanceof InputEvent) || !event.isComposing) {
			if (keyboard.value) send({ type: 'text', text: keyboard.value });
			keyboard.value = '';
		}
	});
	keyboard.addEventListener('paste', (event) => {
		event.preventDefault();
		void action({ kind: 'paste' }).catch(failure);
	});
	const element = Object.assign(root, {
		src: initialUrl,
		focus: (options?: FocusOptions) => keyboard.focus(options),
		canGoBack: () => state?.canGoBack ?? false,
		canGoForward: () => state?.canGoForward ?? false,
		goBack: () => {
			void action({ kind: 'back' }).catch(failure);
		},
		goForward: () => {
			void action({ kind: 'forward' }).catch(failure);
		},
		reload: () => {
			void action({ kind: 'reload' }).catch(failure);
		},
		stop: () => {
			void action({ kind: 'stop' }).catch(failure);
		},
		getURL: () => url,
		getTitle: () => state?.title ?? '',
		isLoading: () => state?.isLoading ?? true,
		getWebContentsId: () => state?.webContentsId,
		executeJavaScript: (code: string) => action({ kind: 'eval', code }),
		insertCSS: async (css: string) => {
			const result = await action({ kind: 'css', css });
			if (typeof result !== 'string') throw new Error('Host browser returned an invalid CSS key');
			return result;
		},
		findInPage: (
			text: string,
			options?: { forward?: boolean; findNext?: boolean; matchCase?: boolean }
		) => {
			if (!state) throw new Error('Host browser page is opening');
			return api.pageFind(target, text, options);
		},
		stopFindInPage: (value: 'clearSelection' | 'keepSelection' | 'activateSelection') => {
			void action({ kind: 'stopFind', action: value }).catch(failure);
		},
		capturePage: async () => {
			const result = await action({ kind: 'snapshot' });
			if (typeof result !== 'string') throw new Error('Host browser returned no screenshot');
			return { toDataURL: () => result };
		},
		setActive: (value: boolean) => {
			if (active === value || disposed) return;
			active = value;
			generation++;
			clearTimeout(timer);
			if (active) {
				void opening.then(() => pump(generation)).catch(failure);
			} else {
				keyboard.blur();
				root.blur();
				void opening.then(() => api.pageSuspend(target, viewId)).catch(failure);
			}
		},
		dispose: () => {
			if (disposed) return;
			disposed = true;
			active = false;
			generation++;
			clearTimeout(timer);
			unsubscribe();
			void opening.then(() => api.pageRelease(target, viewId)).catch(failure);
			root.remove();
		},
	});
	Object.defineProperty(element, 'src', {
		get: () => url,
		set: (value: string) => {
			if (url === value) return;
			url = value;
			root.dataset.maestroBrowserReady = 'false';
			void action({ kind: 'navigate', url: value }).catch(failure);
		},
	});
	return element;
}
