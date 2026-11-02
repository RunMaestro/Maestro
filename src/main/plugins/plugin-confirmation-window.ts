/** Dedicated, host-owned confirmation. Plugin HTML and main SPA cannot confirm. */
import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { ConsentNonceRegistry, type ConsentSender } from './consent-minter';
import { PluginAuthorityError, assertPluginAuthority, pluginRequest } from './plugin-authority';
import type { PluginJson } from '../../shared/plugins/primitives';

export interface PluginConfirmationOffer {
	kind: 'secret' | 'record';
	pluginId: string;
	key: string;
	summary: string;
	value: PluginJson;
}
export interface PluginConfirmation {
	confirm<T>(
		offer: PluginConfirmationOffer,
		signal: AbortSignal,
		check: () => void,
		commit: (password?: string) => T,
		prepare: () => Promise<void>
	): Promise<T>;
}
interface Surface {
	window: BrowserWindow;
	sender?: ConsentSender;
	lastActivation: number;
	confirm(event: IpcMainInvokeEvent, request: unknown): Promise<unknown>;
	offer(event: IpcMainInvokeEvent): Promise<unknown>;
	cancel(): void;
}

export class PluginConfirmationWindows implements PluginConfirmation {
	private readonly nonces = new ConsentNonceRegistry({ ttlMs: 120000 });
	private readonly surfaces = new Set<Surface>();
	constructor(private readonly dir: string) {
		ipcMain.handle('plugin-confirmation:offer', async (event) => {
			try {
				const surface = [...this.surfaces].find((s) => s.window.webContents === event.sender);
				return (await surface?.offer(event)) ?? null;
			} catch {
				return null;
			}
		});
		ipcMain.handle('plugin-confirmation:call', async (event, request: unknown) => {
			try {
				const s = [...this.surfaces].find((s) => s.window.webContents === event.sender);
				if (!s) throw new PluginAuthorityError('PLUGIN_DENIED');
				return await s.confirm(event, request);
			} catch {
				return { ok: false, error: 'PLUGIN_DENIED' };
			}
		});
	}

	async confirm<T>(
		offer: PluginConfirmationOffer,
		signal: AbortSignal,
		check: () => void,
		commit: (password?: string) => T,
		prepare: () => Promise<void>
	): Promise<T> {
		await prepare();
		assertPluginAuthority(check);
		if (signal.aborted) return Promise.reject(new PluginAuthorityError('PLUGIN_CANCELED'));
		if (this.surfaces.size >= 8) return Promise.reject(new PluginAuthorityError('PLUGIN_LIMIT'));
		const nonce = this.nonces.issue(offer.pluginId, []);
		const expectedUrl = pathToFileURL(path.join(this.dir, 'plugin-confirmation.html')).href;
		const window = new BrowserWindow({
			width: 640,
			height: 680,
			show: false,
			autoHideMenuBar: true,
			title: 'Plugin confirmation',
			webPreferences: {
				preload: path.join(this.dir, 'plugin-confirmation-preload.js'),
				contextIsolation: true,
				sandbox: true,
				nodeIntegration: false,
			},
		});
		window.setMenu(null);
		window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
		window.webContents.on('will-navigate', (event) => event.preventDefault());
		window.webContents.on('will-attach-webview', (event) => event.preventDefault());
		return new Promise<T>((resolve, reject) => {
			let settled = false;
			const finish = (error?: unknown, result?: T) => {
				if (settled) return;
				settled = true;
				this.nonces.consume(nonce, offer.pluginId, []);
				this.surfaces.delete(surface);
				signal.removeEventListener('abort', cancel);
				clearTimeout(timer);
				if (!window.isDestroyed()) window.close();
				if (error) reject(error);
				else resolve(result!);
			};
			const cancel = () => finish(new PluginAuthorityError('PLUGIN_CANCELED'));
			const timer = setTimeout(cancel, 120000);
			timer.unref();
			const surface: Surface = {
				window,
				lastActivation: -Infinity,
				cancel,
				offer: async (event) => {
					if (
						settled ||
						signal.aborted ||
						window.isDestroyed() ||
						event.sender !== window.webContents ||
						event.senderFrame !== window.webContents.mainFrame ||
						event.senderFrame.url !== expectedUrl
					)
						throw new PluginAuthorityError('PLUGIN_DENIED');
					await prepare();
					if (
						settled ||
						signal.aborted ||
						window.isDestroyed() ||
						event.senderFrame !== window.webContents.mainFrame ||
						event.senderFrame.url !== expectedUrl
					)
						throw new PluginAuthorityError('PLUGIN_DENIED');
					assertPluginAuthority(check);
					if (settled || signal.aborted) throw new PluginAuthorityError('PLUGIN_CANCELED');
					return { ...offer, nonce };
				},
				confirm: async (event, request) => {
					const p = pluginRequest(
						request,
						['nonce', 'approved'],
						offer.kind === 'secret' ? ['password'] : []
					);
					const sender = surface.sender;
					if (
						!sender ||
						settled ||
						event.sender !== window.webContents ||
						event.senderFrame !== window.webContents.mainFrame ||
						event.senderFrame.routingId !== sender.frameId ||
						event.senderFrame.url !== sender.url ||
						!sender.url.startsWith('file:') ||
						!window.isFocused() ||
						performance.now() - surface.lastActivation > 1000 ||
						typeof p.nonce !== 'string' ||
						p.nonce !== nonce
					)
						throw new PluginAuthorityError('PLUGIN_DENIED');
					const activation = surface.lastActivation;
					surface.lastActivation = -Infinity;
					if (!this.nonces.consume(p.nonce, offer.pluginId, []))
						throw new PluginAuthorityError('PLUGIN_DENIED');
					if (p.approved !== true) {
						cancel();
						return { ok: true };
					}
					try {
						await prepare();
						if (!window.isFocused() || performance.now() - activation > 1000)
							throw new PluginAuthorityError('PLUGIN_DENIED');
						if (
							settled ||
							signal.aborted ||
							window.isDestroyed() ||
							event.senderFrame !== window.webContents.mainFrame ||
							event.senderFrame.url !== expectedUrl
						)
							throw new PluginAuthorityError('PLUGIN_DENIED');
						assertPluginAuthority(check);
						if (signal.aborted) throw new PluginAuthorityError('PLUGIN_CANCELED');
						const result = commit(
							offer.kind === 'secret' && typeof p.password === 'string' ? p.password : undefined
						);
						finish(undefined, result);
						return { ok: true };
					} catch (error) {
						finish(error);
						return { ok: false, error: 'PLUGIN_DENIED' };
					}
				},
			};
			this.surfaces.add(surface);
			window.webContents.on('before-input-event', (_e, input) => {
				if (input.type === 'keyDown' && ['Enter', ' '].includes(input.key))
					surface.lastActivation = performance.now();
			});
			window.webContents.on('before-mouse-event', (_e, input) => {
				if (input.type === 'mouseUp' && input.button === 'left')
					surface.lastActivation = performance.now();
			});
			window.once('closed', cancel);
			signal.addEventListener('abort', cancel, { once: true });
			void window
				.loadFile(path.join(this.dir, 'plugin-confirmation.html'))
				.then(async () => {
					await prepare();
					if (
						settled ||
						signal.aborted ||
						window.isDestroyed() ||
						window.webContents.mainFrame.url !== expectedUrl
					)
						throw new PluginAuthorityError('PLUGIN_DENIED');
					assertPluginAuthority(check);
					if (signal.aborted || settled) {
						cancel();
						return;
					}
					const frame = window.webContents.mainFrame;
					surface.sender = {
						webContentsId: window.webContents.id,
						frameId: frame.routingId,
						url: frame.url,
					};
					window.show();
				})
				.catch(() => finish(new PluginAuthorityError('PLUGIN_UNAVAILABLE')));
		});
	}
}
