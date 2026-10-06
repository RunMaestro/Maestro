import {
	BrowserWindow,
	ipcMain,
	webContents,
	session,
	type WebContents,
	type NativeImage,
	type IpcMainInvokeEvent,
} from 'electron';
import type {
	BrowserRelayTarget,
	BrowserRelayViewport,
	BrowserRelayFrame,
	BrowserRelayInput,
} from '../../shared/browserRelay';
import type {
	BrowserPageState,
	BrowserPageEvent,
	BrowserPageAction,
} from '../../shared/browserPage';
import { isAllowedBrowserTabPartition } from '../../shared/browserTabPartition';
import {
	attachBrowserPageSecurity,
	isAllowedBrowserTabUrl,
} from '../app-lifecycle/guest-webview-security';
const browserPageWindows = new WeakSet<BrowserWindow>();

/** Browser workload windows are not additional owning Maestro application windows. */
export function isHostBrowserPageWindow(window: BrowserWindow): boolean {
	return browserPageWindows.has(window);
}

interface Page {
	target: BrowserRelayTarget;
	window: BrowserWindow | null;
	guest: WebContents;
	owner: BrowserWindow;
	partition: string;
	initialUrl: string;
	viewport: BrowserRelayViewport;
	nativeSize: BrowserRelayViewport | null;
	ready: boolean;
	favicon: string | null;
	nativeViews: Map<string, boolean>;
	remoteActive: boolean;
	remoteRetained: boolean;
	image: NativeImage | null;
	encodedJPEG: string | null;
	inputQueue: Promise<void>;
	waiters: Set<{
		resolve: (image: NativeImage) => void;
		reject: (error: Error) => void;
		timer: ReturnType<typeof setTimeout>;
	}>;
}

function key(target: BrowserRelayTarget): string {
	if (
		!target ||
		typeof target.sessionId !== 'string' ||
		!target.sessionId ||
		typeof target.tabId !== 'string' ||
		!target.tabId
	)
		throw new Error('Invalid registered browser tab target');
	return JSON.stringify([target.sessionId, target.tabId]);
}
function viewport(value: BrowserRelayViewport): void {
	if (
		!value ||
		!Number.isInteger(value.width) ||
		!Number.isInteger(value.height) ||
		value.width < 1 ||
		value.height < 1 ||
		value.width > 2560 ||
		value.height > 1600
	)
		throw new Error('Invalid browser viewport');
}

/** The single page for a host tab. Presentations and relay leases never create independent workloads. */
export class HostBrowserPages {
	private pages = new Map<string, Page>();
	private opening = new Map<string, Promise<Page>>();
	private watchedOwners = new Set<BrowserWindow>();
	constructor(
		private deps: {
			resolve: (target: BrowserRelayTarget) => Promise<{
				owner: BrowserWindow;
				partition: string;
				url: string;
				webContentsId?: number;
			}>;
			getOwner: (sessionId: string) => BrowserWindow | null;
			input: (
				guest: WebContents,
				input: BrowserRelayInput,
				bounds?: BrowserRelayViewport
			) => Promise<void>;
		}
	) {}
	private watchOwner(owner: BrowserWindow): void {
		if (this.watchedOwners.has(owner)) return;
		this.watchedOwners.add(owner);
		owner.prependOnceListener('closed', () => {
			this.watchedOwners.delete(owner);
			for (const page of this.pages.values()) {
				if (page.owner !== owner) continue;
				const next = this.deps.getOwner(page.target.sessionId);
				if (next && next !== owner && !next.isDestroyed() && !next.webContents.isDestroyed())
					this.bindOwner(page, next);
				else if (!page.guest.isDestroyed()) page.window?.destroy();
			}
		});
	}
	private bindOwner(page: Page, owner: BrowserWindow): void {
		if (page.owner === owner) return;
		page.owner = owner;
		page.nativeViews.clear();
		this.watchOwner(owner);
		this.updatePainting(page);
	}

	private state(page: Page): BrowserPageState {
		const guest = page.guest;
		return {
			offscreen: !!page.window,
			...page.viewport,
			url: guest.getURL() || page.initialUrl,
			title: guest.getTitle(),
			canGoBack: guest.navigationHistory.canGoBack(),
			canGoForward: guest.navigationHistory.canGoForward(),
			isLoading: guest.isLoading(),
			webContentsId: guest.id,
			ready: page.ready,
			favicon: page.favicon,
		};
	}
	private publish(page: Page, type: string, details?: Record<string, unknown>): void {
		if (page.guest.isDestroyed()) return;
		const currentOwner = this.deps.getOwner(page.target.sessionId);
		if (currentOwner && !currentOwner.isDestroyed()) this.bindOwner(page, currentOwner);
		if (!page.owner.isDestroyed() && !page.owner.webContents.isDestroyed())
			page.owner.webContents.send('browser:pageEvent', {
				target: page.target,
				type,
				state: this.state(page),
				details,
			} satisfies BrowserPageEvent);
	}
	private nativeActive(page: Page): boolean {
		for (const active of page.nativeViews.values()) if (active) return true;
		return false;
	}
	private painting(page: Page): boolean {
		return page.remoteActive || this.nativeActive(page);
	}
	private updatePainting(page: Page): void {
		if (!page.window) return;
		const guest = page.guest;
		if (this.painting(page)) {
			guest.startPainting();
			guest.invalidate();
		} else {
			guest.stopPainting();
			page.image = null;
		}
	}
	private resize(page: Page, size: BrowserRelayViewport): void {
		viewport(size);
		if (!page.window) return;
		if (page.viewport.width === size.width && page.viewport.height === size.height) return;
		page.viewport = { ...size };
		page.image = null;
		page.window.setContentSize(size.width, size.height);
		if (this.painting(page)) page.guest.invalidate();
	}
	private async ensure(target: BrowserRelayTarget, size: BrowserRelayViewport): Promise<Page> {
		const id = key(target);
		viewport(size);
		const current = this.pages.get(id);
		if (current && !current.guest.isDestroyed()) return current;
		const pending = this.opening.get(id);
		if (pending) return pending;
		const creation = (async () => {
			const resolved = await this.deps.resolve(target);
			if (
				!isAllowedBrowserTabPartition(resolved.partition) ||
				!isAllowedBrowserTabUrl(resolved.url)
			)
				throw new Error('Host browser tab has an invalid partition or URL');
			if (resolved.owner.isDestroyed() || resolved.owner.webContents.isDestroyed())
				throw new Error('Host browser owner closed while opening the tab');
			const nativeGuest =
				resolved.webContentsId === undefined ? null : webContents.fromId(resolved.webContentsId);
			if (
				resolved.webContentsId !== undefined &&
				(!nativeGuest ||
					nativeGuest.isDestroyed() ||
					nativeGuest.getType() !== 'webview' ||
					nativeGuest.hostWebContents !== resolved.owner.webContents ||
					nativeGuest.session !== session.fromPartition(resolved.partition))
			)
				throw new Error('Native browser guest does not belong to the registered host tab');
			const window = nativeGuest
				? null
				: new BrowserWindow({
						show: false,
						frame: false,
						useContentSize: true,
						width: size.width,
						height: size.height,
						webPreferences: {
							partition: resolved.partition,
							offscreen: true,
							backgroundThrottling: false,
							nodeIntegration: false,
							nodeIntegrationInSubFrames: false,
							contextIsolation: true,
							sandbox: true,
							webSecurity: true,
							allowRunningInsecureContent: false,
						},
					});
			if (window) browserPageWindows.add(window);
			const guest = nativeGuest ?? window!.webContents;
			const page: Page = {
				target: { ...target },
				owner: resolved.owner,
				partition: resolved.partition,
				initialUrl: resolved.url,
				window,
				guest,
				viewport: { ...size },
				nativeSize: null,
				ready: !!nativeGuest && !nativeGuest.isLoading(),
				favicon: null,
				nativeViews: new Map(),
				remoteActive: false,
				remoteRetained: false,
				image: null,
				encodedJPEG: null,
				inputQueue: Promise.resolve(),
				waiters: new Set(),
			};
			this.watchOwner(resolved.owner);
			this.pages.set(id, page);
			if (window) {
				guest.setFrameRate(8);
				guest.session.setPermissionRequestHandler((_contents, _permission, callback) =>
					callback(false)
				);
				guest.session.setPermissionCheckHandler(() => false);
				attachBrowserPageSecurity(guest, resolved.owner, () => page.owner);
				guest.on('paint', (_event, _dirty, image) => {
					// Offscreen startup can emit an empty image before the first usable frame.
					if (image.isEmpty()) return;
					page.image = image;
					page.encodedJPEG = null;
					for (const waiter of page.waiters) {
						clearTimeout(waiter.timer);
						waiter.resolve(image);
					}
					page.waiters.clear();
				});
			}
			guest.on('dom-ready', () => {
				page.ready = true;
				this.publish(page, 'dom-ready');
			});
			guest.on('did-start-navigation', (_event, url, _inPlace, isMainFrame) => {
				if (isMainFrame) page.ready = false;
				this.publish(page, 'did-start-navigation', { url, isMainFrame });
			});
			guest.on('did-navigate', (_event, url) => this.publish(page, 'did-navigate', { url }));
			guest.on('did-navigate-in-page', (_event, url, isMainFrame) =>
				this.publish(page, 'did-navigate-in-page', { url, isMainFrame })
			);
			guest.on('page-title-updated', (_event, title) =>
				this.publish(page, 'page-title-updated', { title })
			);
			guest.on('page-favicon-updated', (_event, favicons) => {
				page.favicon = favicons[0] ?? null;
				this.publish(page, 'page-favicon-updated', { favicons });
			});
			guest.on('found-in-page', (_event, result) =>
				this.publish(page, 'found-in-page', { result })
			);
			guest.on('console-message', (event) =>
				this.publish(page, 'console-message', { message: event.message })
			);
			guest.on('did-start-loading', () => this.publish(page, 'did-start-loading'));
			guest.on('did-stop-loading', () => this.publish(page, 'did-stop-loading'));
			guest.on('did-finish-load', () => this.publish(page, 'did-finish-load'));
			guest.once('destroyed', () => {
				if (this.pages.get(id) === page) this.pages.delete(id);
				for (const waiter of page.waiters) {
					clearTimeout(waiter.timer);
					waiter.reject(new Error('Host browser tab closed'));
				}
				page.waiters.clear();
			});
			if (window) {
				guest.stopPainting();
				void guest.loadURL(resolved.url).catch((error: Error) =>
					this.publish(page, 'did-fail-load', {
						validatedURL: resolved.url,
						errorDescription: error.message,
						isMainFrame: true,
					})
				);
			}
			this.publish(page, 'page-opened');
			return page;
		})();
		this.opening.set(id, creation);
		try {
			return await creation;
		} finally {
			this.opening.delete(id);
		}
	}
	private existing(target: BrowserRelayTarget): Page {
		const page = this.pages.get(key(target));
		if (!page || page.guest.isDestroyed())
			throw new Error('Registered host browser tab is unavailable');
		return page;
	}
	private owned(event: { sender: WebContents }, target: BrowserRelayTarget): Page {
		const page = this.existing(target);
		const owner = this.deps.getOwner(target.sessionId) ?? page.owner;
		if (owner.isDestroyed() || event.sender !== owner.webContents)
			throw new Error('Browser tab belongs to another host window');
		this.bindOwner(page, owner);
		return page;
	}
	private image(page: Page): Promise<NativeImage> {
		if (!page.window)
			return page.guest.capturePage(undefined, { stayHidden: true, stayAwake: true });
		if (page.image) return Promise.resolve(page.image);
		return new Promise((resolve, reject) => {
			const waiter = {
				resolve,
				reject,
				timer: setTimeout(() => {
					page.waiters.delete(waiter);
					reject(new Error('Host browser did not paint a frame'));
				}, 5000),
			};
			page.waiters.add(waiter);
			page.guest.invalidate();
		});
	}
	async resolveRemote(
		target: BrowserRelayTarget,
		size: BrowserRelayViewport
	): Promise<BrowserPageState> {
		const page = await this.ensure(target, size);
		page.remoteActive = true;
		page.remoteRetained = true;
		if (!this.nativeActive(page)) this.resize(page, size);
		this.updatePainting(page);
		return this.state(page);
	}
	releaseRemote(target: BrowserRelayTarget): void {
		const page = this.pages.get(key(target));
		if (!page || page.guest.isDestroyed()) return;
		page.remoteActive = false;
		this.updatePainting(page);
	}
	async frame(target: BrowserRelayTarget, size: BrowserRelayViewport): Promise<BrowserRelayFrame> {
		// A native guest follows the desktop keep-alive policy. If it was unmounted,
		// an attached remote view can reopen this still-registered tab offscreen.
		const page = await this.ensure(target, size);
		if (!this.nativeActive(page)) this.resize(page, size);
		let image = await this.image(page);
		if (!page.window) {
			if (image.isEmpty()) throw new Error('Native browser did not paint a frame');
			page.nativeSize = image.getSize();
			const scale = Math.min(1, 2560 / page.nativeSize.width, 1600 / page.nativeSize.height);
			if (scale < 1)
				image = image.resize({
					width: Math.max(1, Math.floor(page.nativeSize.width * scale)),
					height: Math.max(1, Math.floor(page.nativeSize.height * scale)),
				});
			page.viewport = image.getSize();
			page.encodedJPEG = null;
		}
		page.encodedJPEG ??= 'data:image/jpeg;base64,' + image.toJPEG(75).toString('base64');
		return { ...this.state(page), dataUrl: page.encodedJPEG };
	}
	async input(
		target: BrowserRelayTarget,
		input: BrowserRelayInput,
		assertActive?: () => void
	): Promise<void> {
		const page = this.existing(target);
		const pending = page.inputQueue.then(() => {
			assertActive?.();
			// Native windows retain their real viewport. The relay frame may be
			// downscaled, so map pointer and wheel locations back to native pixels.
			const mapped =
				page.nativeSize && input && 'x' in input
					? {
							...input,
							x: Math.round((input.x * page.nativeSize.width) / page.viewport.width),
							y: Math.round((input.y * page.nativeSize.height) / page.viewport.height),
						}
					: input;
			return this.deps.input(page.guest, mapped, page.nativeSize ?? undefined);
		});
		page.inputQueue = pending.catch(() => {});
		return pending;
	}
	async action(target: BrowserRelayTarget, action: BrowserPageAction): Promise<unknown> {
		const page = this.existing(target),
			guest = page.guest;
		switch (action.kind) {
			case 'navigate':
				if (!isAllowedBrowserTabUrl(action.url))
					throw new Error('Browser navigation URL is not allowed');
				page.initialUrl = action.url;
				void guest.loadURL(action.url).catch((error: Error) =>
					this.publish(page, 'did-fail-load', {
						validatedURL: action.url,
						errorDescription: error.message,
						isMainFrame: true,
					})
				);
				return action.url;
			case 'back':
				if (guest.navigationHistory.canGoBack()) guest.navigationHistory.goBack();
				return;
			case 'forward':
				if (guest.navigationHistory.canGoForward()) guest.navigationHistory.goForward();
				return;
			case 'reload':
				guest.reload();
				return;
			case 'stop':
				guest.stop();
				return;
			case 'selection':
				return guest.executeJavaScript(`(() => {
				const active = document.activeElement;
				if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
					if (active instanceof HTMLInputElement && active.type === 'password') return '';
					if (active.selectionStart !== null && active.selectionEnd !== null) return active.value.slice(active.selectionStart, active.selectionEnd);
				}
				return window.getSelection()?.toString() || '';
			})()`);
			case 'deleteSelection':
				return guest.executeJavaScript("document.execCommand('delete')", true);
			case 'eval':
				return guest.executeJavaScript(action.code);
			case 'css':
				return guest.insertCSS(action.css);
			case 'extract':
				return guest.executeJavaScript(
					action.format === 'html'
						? 'document.documentElement?.outerHTML || ""'
						: action.format === 'innerText'
							? 'document.documentElement?.innerText || ""'
							: 'document.body?.innerText || ""'
				);
			case 'find':
				if (action.text)
					return guest.findInPage(action.text, {
						forward: action.forward,
						findNext: action.findNext,
					});
				guest.stopFindInPage('clearSelection');
				return;
			case 'stopFind':
				guest.stopFindInPage(action.action);
				return;
			case 'paste':
				guest.paste();
				return;
			case 'copy':
				guest.copy();
				return;
			case 'cut':
				guest.cut();
				return;
			case 'selectAll':
				guest.selectAll();
				return;
			case 'clearData':
				await guest.session.clearStorageData();
				await guest.session.clearCache();
				guest.reload();
				return;
			case 'snapshot': {
				if (!page.window) return (await this.image(page)).toDataURL();
				guest.startPainting();
				guest.invalidate();
				page.image = null;
				try {
					return (await this.image(page)).toDataURL();
				} finally {
					if (!this.painting(page)) {
						guest.stopPainting();
						page.image = null;
					}
				}
			}
		}
	}
	registerNativeHandlers(): void {
		ipcMain.handle(
			'browser:pageOpen',
			async (
				event: IpcMainInvokeEvent,
				target: BrowserRelayTarget,
				viewId: string,
				size: BrowserRelayViewport
			) => {
				const owner = this.deps.getOwner(target.sessionId);
				if (!owner || owner.isDestroyed() || event.sender !== owner.webContents)
					throw new Error('Only the owning host window may open a browser page');
				if (typeof viewId !== 'string' || !viewId)
					throw new Error('Invalid native browser presentation');
				const page = await this.ensure(target, size);
				if (!page.window) throw new Error('A native webview already presents this browser tab');
				page.owner = owner;
				page.nativeViews.set(viewId, false);
				return this.state(page);
			}
		);
		ipcMain.handle(
			'browser:pageFrame',
			async (
				event: IpcMainInvokeEvent,
				target: BrowserRelayTarget,
				viewId: string,
				size: BrowserRelayViewport
			) => {
				const page = this.owned(event, target);
				if (!page.nativeViews.has(viewId)) throw new Error('Native browser presentation closed');
				page.nativeViews.set(viewId, true);
				this.resize(page, size);
				this.updatePainting(page);
				return this.frame(target, page.viewport);
			}
		);
		ipcMain.handle(
			'browser:pageSuspend',
			(event: IpcMainInvokeEvent, target: BrowserRelayTarget, viewId: string) => {
				const page = this.owned(event, target);
				page.nativeViews.set(viewId, false);
				this.updatePainting(page);
			}
		);
		ipcMain.handle(
			'browser:pageRelease',
			(event: IpcMainInvokeEvent, target: BrowserRelayTarget, viewId: string) => {
				const page = this.owned(event, target);
				page.nativeViews.delete(viewId);
				this.updatePainting(page);
				if (!page.nativeViews.size && !page.remoteRetained) page.window?.destroy();
			}
		);
		ipcMain.handle('browser:pageClose', (event: IpcMainInvokeEvent, target: BrowserRelayTarget) => {
			const page = this.owned(event, target);
			page.window?.destroy();
		});
		ipcMain.handle(
			'browser:pageAction',
			(event: IpcMainInvokeEvent, target: BrowserRelayTarget, action: BrowserPageAction) => {
				this.owned(event, target);
				return this.action(target, action);
			}
		);
		ipcMain.handle(
			'browser:pageInput',
			(event: IpcMainInvokeEvent, target: BrowserRelayTarget, input: BrowserRelayInput) => {
				this.owned(event, target);
				return this.input(target, input);
			}
		);
		ipcMain.on(
			'browser:pageFind',
			(
				event,
				target: BrowserRelayTarget,
				text: string,
				options: { forward?: boolean; findNext?: boolean; matchCase?: boolean }
			) => {
				try {
					event.returnValue = {
						ok: true,
						id: this.owned(event, target).guest.findInPage(text, options),
					};
				} catch (error) {
					event.returnValue = {
						ok: false,
						error: error instanceof Error ? error.message : String(error),
					};
				}
			}
		);
	}
}
