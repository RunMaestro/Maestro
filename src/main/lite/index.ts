import { DiscoveryController, type DiscoveredConnection } from './discovery/controller';
import { ADMISSION_HEADER, CONNECT_PATH } from './pairing/protocol';
import { DeviceCredentials } from './device-credentials';
import {
	app,
	BrowserWindow,
	WebContentsView,
	session,
	ipcMain,
	Menu,
	dialog,
	shell,
} from 'electron';
import type { Session, Event, DownloadItem, WebContents } from 'electron';
import path from 'path';
import { randomUUID } from 'crypto';
import { mkdirSync } from 'fs';
import { LiteProfiles, normalizeRemoteUrl, hostPartition } from './profiles';
import type { LiteProfile } from './profiles';
import { openTunnel } from './tunnel';
import { openTailnetRelay } from './tailnet-relay';
import { validateHandshake, HostConnectionError } from './handshake';
import { connectionPage } from './ui';
import { parseSshConfig } from '../utils/ssh-config-parser';
import { startLiteControlServer } from './control-server';
import { resolveLiteDataDirectory } from '../../shared/lite-control';
import type { LiteControlOptions, LiteControlState } from '../../shared/lite-control';

export async function startLite(): Promise<void> {
	// Separate startup preferences from full-mode data without opening any backend stores.
	const dataFlag = process.argv.indexOf('--lite-user-data');
	const explicitData = dataFlag < 0 ? undefined : process.argv[dataFlag + 1];
	if (dataFlag >= 0 && (!explicitData || explicitData.startsWith('--')))
		throw new Error('--lite-user-data requires a directory.');
	const liteData = resolveLiteDataDirectory(explicitData, app.getPath('userData'));
	app.setName('Maestro Lite');
	mkdirSync(liteData, { recursive: true });
	app.setPath('userData', liteData);
	app.setPath('sessionData', liteData);
	if (!app.requestSingleInstanceLock()) {
		app.quit();
		return;
	}
	await app.whenReady();
	const profiles = new LiteProfiles(app.getPath('userData'));
	const deviceCredentials = new DeviceCredentials(app.getPath('userData'));
	let loadError: string | undefined;
	try {
		await profiles.load();
	} catch (error) {
		loadError = `Cannot load saved profiles: ${String(error)}`;
	}
	const aliases = parseSshConfig().hosts.map((host) => host.host);
	const window = new BrowserWindow({
		width: 1280,
		height: 900,
		minWidth: 900,
		minHeight: 650,
		title: 'Maestro Lite',
		webPreferences: {
			preload: path.join(__dirname, 'preload.js'),
			nodeIntegration: false,
			contextIsolation: true,
			sandbox: true,
			webviewTag: false,
		},
	});
	let view: WebContentsView | undefined;
	let tunnel: { stop(): Promise<void> } | undefined;
	let tunnelClosing: Promise<void> = Promise.resolve();
	let transportOpening: Promise<void> = Promise.resolve();
	let abort: AbortController | undefined;
	let selected: string | undefined;
	let connectionVersion = 0;
	let picker = true;
	let commandsVisible = false;
	let status = 'Disconnected';
	let error = loadError;
	let poll: NodeJS.Timeout | undefined;
	let hostName = '';
	let busyPoll = false;
	let controlServer: { close(): Promise<void> } | undefined;
	let discovered: DiscoveredConnection | undefined;
	let discoveredSession: Session | undefined;
	const discovery = new DiscoveryController(
		publish,
		() => profiles.list(),
		(connection) => {
			discovered = connection;
			discoveredSession = session.fromPartition('maestro-lite-discovered-' + randomUUID());
			void connect(connection.profile.id);
		},
		(reason) => {
			if (selected === discovered?.profile.id) selected = undefined;
			discovered = undefined;
			discoveredSession = undefined;
			fail(
				reason === 'network-changed'
					? 'Your network changed. Check Tailscale, then choose the host again.'
					: reason === 'pairing-failed'
						? 'Pairing could not finish. Choose the host to try again.'
						: 'The connection closed. Choose the host to reconnect.'
			);
		},
		deviceCredentials
	);
	function getState(): LiteControlState {
		return {
			status,
			error,
			selected,
			picker,
			commandsVisible,
			canReturn: !!view,
			profiles: profiles.list(),
			discoveryPairing: discovery.snapshot(),
			aliases,
		};
	}
	const localUrl = `data:text/html;charset=utf-8,${encodeURIComponent(connectionPage)}`;
	function publish(): void {
		if (!window.isDestroyed()) window.webContents.send('lite:state', getState());
		if (view) {
			view.setVisible(!picker);
			const [width, height] = window.getContentSize();
			view.setBounds({ x: 0, y: 72, width, height: Math.max(0, height - 72) });
		}
	}
	app.on('second-instance', () => {
		picker = true;
		commandsVisible = false;
		publish();
		window.show();
		window.focus();
	});
	function removeView(): void {
		if (!view) return;
		window.contentView.removeChildView(view);
		view.webContents.close();
		view = undefined;
	}
	function disconnect(): Promise<void> {
		connectionVersion++;
		abort?.abort();
		abort = undefined;
		clearInterval(poll);
		poll = undefined;
		removeView();
		if (tunnel) tunnelClosing = tunnel.stop();
		tunnel = undefined;
		picker = true;
		commandsVisible = false;
		hostName = '';
		status = 'Disconnected. Work on the host keeps running.';
		error = undefined;
		publish();
		return Promise.all([tunnelClosing, transportOpening]).then(() => {});
	}
	function fail(message: string): void {
		disconnect();
		status = 'Connection failed';
		error = message;
		publish();
	}
	function makeView(
		browserSession: Session,
		base: URL,
		allowDesktop: boolean,
		authenticatedNavigation?: () => void
	): WebContentsView {
		const remote = new WebContentsView({
			webPreferences: {
				session: browserSession,
				sandbox: true,
				nodeIntegration: false,
				contextIsolation: true,
				webviewTag: false,
			},
		});
		const permitted = (url: string) => {
			try {
				const candidate = new URL(url);
				return (
					candidate.origin === base.origin &&
					(candidate.pathname === base.pathname ||
						candidate.pathname.startsWith(`${base.pathname}/`))
				);
			} catch {
				return false;
			}
		};
		remote.webContents.on('will-navigate', (event, url) => {
			if (!permitted(url)) {
				event.preventDefault();
				return;
			}
			if (!allowDesktop && new URL(url).pathname === `${base.pathname}/desktop`) {
				event.preventDefault();
				authenticatedNavigation?.();
			}
		});
		remote.webContents.on('will-redirect', (event, url) => {
			if (!permitted(url)) event.preventDefault();
			else if (!allowDesktop && new URL(url).pathname === `${base.pathname}/desktop`) {
				event.preventDefault();
				authenticatedNavigation?.();
			}
		});
		remote.webContents.on('will-frame-navigate', (event) => {
			if (
				!event.isMainFrame &&
				!permitted(event.url) &&
				!event.url.startsWith(`blob:${base.origin}/`)
			)
				event.preventDefault();
		});
		remote.webContents.setWindowOpenHandler(({ url }) => {
			try {
				const candidate = new URL(url);
				if (
					candidate.protocol === 'https:' &&
					candidate.origin !== base.origin &&
					!candidate.username &&
					!candidate.password
				)
					void dialog
						.showMessageBox(window, {
							type: 'question',
							message: `Open external link in your browser?`,
							detail: candidate.toString(),
							buttons: ['Cancel', 'Open'],
							defaultId: 0,
							cancelId: 0,
						})
						.then(({ response }) => {
							if (response === 1) void shell.openExternal(candidate.toString());
						});
			} catch {
				/* Invalid links never leave the sandbox. */
			}
			return { action: 'deny' };
		});
		remote.webContents.on('will-attach-webview', (event) => event.preventDefault());
		remote.webContents.on('before-input-event', (event, input) => shortcuts(event, input));
		browserSession.setPermissionRequestHandler((_contents, _permission, callback) =>
			callback(false)
		);
		browserSession.setPermissionCheckHandler(() => false);
		const download = (event: Event, item: DownloadItem, contents: WebContents) => {
			if (contents !== remote.webContents) return;
			if (!permitted(item.getURL()) && !item.getURL().startsWith(`blob:${base.origin}/`)) {
				event.preventDefault();
				return;
			}
			item.setSaveDialogOptions({
				title: 'Download from Maestro host',
				defaultPath: item.getFilename(),
			});
		};
		browserSession.on('will-download', download);
		remote.webContents.once('destroyed', () =>
			browserSession.removeListener('will-download', download)
		);
		return remote;
	}
	async function handshake(
		browserSession: Session,
		base: URL,
		signal: AbortSignal
	): Promise<unknown | undefined> {
		const response = await browserSession.fetch(`${base}/api/lite/handshake`, {
			signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
			credentials: 'include',
			redirect: 'error',
			headers: { 'Cache-Control': 'no-store' },
		});
		if (response.status === 401) return undefined;
		if (!response.ok)
			throw new HostConnectionError(
				base.pathname === CONNECT_PATH
					? `Host refused this device (HTTP ${response.status}). If it was revoked, forget this pairing and request a new code.`
					: `Host handshake failed (HTTP ${response.status}). Verify Remote Control URL/token and host compatibility.`
			);
		if (!response.headers.get('content-type')?.includes('application/json'))
			throw new HostConnectionError(
				base.pathname === CONNECT_PATH
					? 'Host did not return a Lite handshake. Keep full Maestro open and update both devices to matching versions.'
					: 'Host did not return a Lite handshake. Verify the URL and upgrade the host.'
			);
		return response.json();
	}
	async function connect(id: string, initialState?: () => void): Promise<void> {
		const closing = disconnect();
		const version = connectionVersion;
		await closing;
		if (version !== connectionVersion || window.isDestroyed()) {
			initialState?.();
			return;
		}
		selected = id;
		const controller = new AbortController();
		abort = controller;
		const signal = controller.signal;
		try {
			const selectedDiscovery = discovered?.profile.id === id ? discovered : undefined;
			let profile = selectedDiscovery?.profile ?? profiles.get(id);

			// The partition already isolates profile + host; keep view state across app restarts.
			const clientId = encodeURIComponent(profile.id);
			status = `Connecting · ${profile.name}`;
			publish();
			let base = normalizeRemoteUrl(profile.url, profile.transport);
			if (profile.transport === 'tailscale') {
				if (!selectedDiscovery)
					throw new HostConnectionError('Select and pair the discovered Tailscale host first.');
				const opening = openTailnetRelay(
					base,
					selectedDiscovery.credential,
					signal,
					selectedDiscovery.peerId!
				);
				transportOpening = opening.then(
					() => {},
					() => {}
				);
				const result = await opening;
				if (signal.aborted) {
					await result.tunnel.stop();
					return;
				}
				tunnel = result.tunnel;
				base = result.url;
			} else if (profile.transport === 'ssh') {
				const opening = openTunnel(
					profile.ssh!,
					base,
					signal,
					(message) => {
						if (abort === controller) fail(message);
					},
					profile.localPort
				);
				transportOpening = opening.then(
					() => {},
					() => {}
				);
				const result = await opening;
				if (signal.aborted) {
					await result.tunnel.stop();
					return;
				}
				tunnel = result.tunnel;
				base = result.url;
			}
			const authentication = selectedDiscovery
				? discoveredSession!
				: session.fromPartition('maestro-lite-auth-' + randomUUID());
			if (profile.transport === 'tailscale') await authentication.setProxy({ mode: 'direct' });
			if (selectedDiscovery)
				authentication.webRequest.onBeforeSendHeaders((details, callback) => {
					const url = new URL(details.url);
					const sameOrigin =
						url.host === base.host &&
						(url.protocol === base.protocol ||
							url.protocol === (base.protocol === 'https:' ? 'wss:' : 'ws:'));
					const inside =
						url.pathname === base.pathname || url.pathname.startsWith(base.pathname + '/');
					const headers = { ...details.requestHeaders };
					for (const key of Object.keys(headers))
						if (key.toLowerCase() === ADMISSION_HEADER) delete headers[key];
					if (sameOrigin && inside) {
						if (signal.aborted || discovered !== selectedDiscovery) {
							callback({ cancel: true });
							return;
						}
						headers[ADMISSION_HEADER] = selectedDiscovery.credential;
					}
					callback({ requestHeaders: headers });
				});
			let raw = await handshake(authentication, base, signal);
			if (raw === undefined) {
				if (selectedDiscovery)
					throw new HostConnectionError(
						'Device authorization was revoked. Forget this pairing, select the host and pair again.'
					);
				status = `Sign in to ${profile.name} below`;
				picker = false;
				publish();
				let checking = false;
				const login = Promise.withResolvers<unknown>();
				const check = async () => {
					if (checking || signal.aborted) return;
					checking = true;
					try {
						const response = await handshake(authentication, base, signal);
						if (response !== undefined) login.resolve(response);
					} catch (cause) {
						login.reject(cause);
					} finally {
						checking = false;
					}
				};
				view = makeView(authentication, base, false, () => void check());
				window.contentView.addChildView(view);
				publish();
				view.webContents.on('did-finish-load', () => void check());
				const next = `${base.pathname}/desktop?lite=1&liteClientId=${clientId}`;
				const timer = setInterval(() => void check(), 1500);
				const canceled = () => login.reject(new Error('Connection canceled.'));
				signal.addEventListener('abort', canceled, { once: true });
				if (signal.aborted) canceled();
				try {
					const loaded = view.webContents
						.loadURL(`${base}/login?next=${encodeURIComponent(next)}`)
						.then(() => initialState?.());
					const [, authenticated] = await Promise.all([loaded, login.promise]);
					raw = authenticated;
				} finally {
					clearInterval(timer);
					signal.removeEventListener('abort', canceled);
				}
			}
			if (signal.aborted) return;
			const host = validateHandshake(raw, profile, !!selectedDiscovery);
			const localPort = profile.transport === 'ssh' ? Number(base.port) : undefined;
			if (
				!selectedDiscovery &&
				(profile.instanceId !== host.instanceId || profile.localPort !== localPort)
			) {
				profile = { ...profile, instanceId: host.instanceId, localPort };
				await profiles.save(profile);
			}
			const isolated = selectedDiscovery
				? authentication
				: session.fromPartition(hostPartition(profile.id, host.instanceId));
			// Never restore authentication into an endpoint before identity validation, even on port reuse.
			for (const cookie of isolated === authentication
				? []
				: await authentication.cookies.get({
						url: `${base}/api/lite/handshake`,
					})) {
				await isolated.cookies.set({
					url: `${base}/api/lite/handshake`,
					name: cookie.name,
					value: cookie.value,
					path: cookie.path,
					secure: cookie.secure,
					httpOnly: cookie.httpOnly,
					sameSite: cookie.sameSite,
					...(cookie.session ? {} : { expirationDate: cookie.expirationDate }),
				});
			}
			validateHandshake(await handshake(isolated, base, signal), profile, !!selectedDiscovery);
			// Native Lite is online-only: migrate PWA workers without clearing host cookies or drafts.
			await isolated.clearStorageData({ storages: ['serviceworkers', 'cachestorage'] });
			if (signal.aborted) return;
			removeView();
			view = makeView(isolated, base, true);
			window.contentView.addChildView(view);
			hostName =
				host.hostName === profile.name ? host.hostName : `${host.hostName} (${profile.name})`;
			picker = false;
			status = `Opening Maestro on ${hostName}`;
			error = undefined;
			publish();
			await view.webContents.loadURL(`${base}/desktop?lite=1&liteClientId=${clientId}`);
			initialState?.();
			let count = 0;
			poll = setInterval(() => {
				if (busyPoll || signal.aborted || !view) return;
				busyPoll = true;
				const current = view;
				void (async () => {
					try {
						if (++count % 5 === 0) {
							const response = await handshake(isolated, base, signal);

							if (response === undefined)
								throw new HostConnectionError(
									'Host login expired or was revoked. Reconnect and authenticate again.'
								);
							validateHandshake(response, profile, !!selectedDiscovery);
						}
						const bridge = await current.webContents.executeJavaScript(
							'window.__MAESTRO_BRIDGE_STATE__ || "connecting"'
						);
						if (!signal.aborted) {
							status = `${String(bridge)} · ${hostName}`;
							error = undefined;
							publish();
						}
					} catch (cause) {
						if (!signal.aborted) {
							if (cause instanceof HostConnectionError) fail(cause.message);
							else {
								status = `Reconnecting · ${hostName}. Check your last message before sending it again.`;
								error = String(cause);
								publish();
							}
						}
					} finally {
						busyPoll = false;
					}
				})();
			}, 1000);
		} catch (cause) {
			if (!signal.aborted)
				fail(
					cause instanceof HostConnectionError
						? cause.message
						: `Could not connect. Check that the host is awake, Maestro Remote Control is enabled, and the connection details are correct. Then try Connect again.\n\nDetails: ${cause instanceof Error ? cause.message : String(cause)}`
				);
		} finally {
			initialState?.();
		}
	}
	async function control(
		name: string,
		payload?: unknown,
		options: LiteControlOptions = {}
	): Promise<{ state: LiteControlState; profile?: LiteProfile }> {
		const cli = options.source === 'cli';
		if (cli && ['remove', 'trust', 'close'].includes(name) && !options.confirmed)
			throw new Error(`${name} requires explicit confirmation.`);
		switch (name) {
			case 'discovery-start':
			case 'discovery-import':
			case 'discovery-stop':
			case 'discovery-status':
			case 'network-changed':
			case 'pair-request':
			case 'pair-submit':
			case 'pair-read':
			case 'pair-cancel':
			case 'pair-forget':
				await discovery.control(name, payload);
				return { state: getState() };
			case 'discover':
				picker = true;
				commandsVisible = false;
				publish();
				window.webContents.send('lite:discover');
				return { state: getState() };
			case 'status':
			case 'list':
				return { state: getState() };
			case 'read':
				return { state: getState(), profile: profiles.get(String(payload)) };
			case 'ready':
				publish();
				break;
			case 'connections':
				picker = true;
				commandsVisible = false;
				publish();
				window.webContents.focus();
				break;
			case 'commands':
				picker = true;
				commandsVisible = true;
				publish();
				window.webContents.focus();
				window.webContents.send('lite:commands');
				break;
			case 'dismiss':
				commandsVisible = false;
				if (view) {
					picker = false;
					publish();
					view.webContents.focus();
					break;
				}
				picker = true;
				publish();
				break;
			case 'close':
				commandsVisible = false;
				if (cli) {
					if (!options.afterResponse)
						throw new Error('CLI close requires an acknowledged control response.');
					options.afterResponse(() => window.close());
				} else window.close();
				return { state: { ...getState(), closing: true } };
			case 'disconnect':
				await discovery.control('pair-cancel', undefined);
				await disconnect();
				break;
			case 'connect':
			case 'reconnect': {
				const id = name === 'connect' ? String(payload) : selected;
				if (discovered && id !== discovered.profile.id)
					await discovery.control('pair-cancel', undefined);
				if (!id) {
					if (cli) throw new Error('Select a host before reconnecting.');
					picker = true;
					publish();
					break;
				}
				if (cli) {
					const initial = Promise.withResolvers<void>();
					void connect(id, initial.resolve);
					await initial.promise;
					if (error) throw new Error(error);
				} else await connect(id);
				break;
			}
			case 'save': {
				const profile = payload as LiteProfile;
				const previous = profiles.list().find((entry) => entry.id === profile.id);
				if (selected === profile.id) await disconnect();
				await profiles.save({
					...profile,
					instanceId: previous?.instanceId,
					localPort: previous?.localPort,
				});
				publish();
				return { state: getState(), profile: profiles.get(profile.id) };
			}
			case 'remove': {
				const id = String(payload);
				profiles.get(id);
				const response = cli
					? 1
					: (
							await dialog.showMessageBox(window, {
								message: 'Delete saved host connection?',
								detail: 'This removes only local connection preferences, not host work.',
								buttons: ['Cancel', 'Delete'],
								cancelId: 0,
								defaultId: 0,
							})
						).response;
				if (response === 1) {
					if (selected === id) await disconnect();
					await profiles.remove(id);
					publish();
				}
				break;
			}
			case 'trust': {
				const profile = { ...profiles.get(String(payload)) };
				const response = cli
					? 1
					: (
							await dialog.showMessageBox(window, {
								type: 'warning',
								message: 'Forget previously validated host identity?',
								detail:
									'Verify the changed host out of band first. Its previous cookies, drafts, and storage will not transfer to another identity.',
								buttons: ['Cancel', 'Forget identity'],
								cancelId: 0,
								defaultId: 0,
							})
						).response;
				if (response === 1) {
					await disconnect();
					delete profile.instanceId;
					await profiles.save(profile);
					publish();
				}
				break;
			}
			default:
				throw new Error('Unknown Lite control action.');
		}
		return { state: getState() };
	}
	function shortcuts(event: Electron.Event, input: Electron.Input): void {
		if (input.type !== 'keyDown') return;
		if ((input.control || input.meta) && input.shift && input.key.toLowerCase() === 'd') {
			event.preventDefault();
			void control('discover');
		}
		if ((input.control || input.meta) && input.shift && input.key.toLowerCase() === 'l') {
			event.preventDefault();
			void control('connections');
		}
		if ((input.control || input.meta) && input.shift && input.key.toLowerCase() === 'r') {
			event.preventDefault();
			void control('reconnect');
		}
		if ((input.control || input.meta) && input.shift && input.key.toLowerCase() === 'p') {
			event.preventDefault();
			void control('commands');
		}
	}
	ipcMain.handle('lite:connection-update', async (event, action: string) => {
		if (
			event.sender !== window.webContents ||
			event.senderFrame !== window.webContents.mainFrame ||
			event.sender.getURL() !== localUrl
		)
			throw new Error('Updates require the trusted local connection window.');
		if (action === 'install') {
			const answer = await dialog.showMessageBox(window, {
				type: 'warning',
				buttons: ['Cancel', 'Restart and install'],
				defaultId: 0,
				cancelId: 0,
				message: 'Restart this Lite client to install?',
				detail: 'This disconnects Lite. Work on the remote host is not stopped or updated.',
			});
			if (answer.response !== 1)
				return {
					status: 'downloaded',
					message: 'Restart cancelled. Your update remains downloaded.',
				};
			await disconnect();
			discovery.close();
			await controlServer?.close();
			controlServer = undefined;
		}
		const { connectionUpdateAction } = await import('../auto-updater');
		return connectionUpdateAction(action);
	});
	ipcMain.handle('lite:control', (event, name: string, payload: unknown) => {
		if (
			event.sender !== window.webContents ||
			event.senderFrame !== window.webContents.mainFrame ||
			event.sender.getURL() !== localUrl
		)
			throw new Error('Lite controls are available only to the trusted local connection window.');
		return control(name, payload);
	});
	window.webContents.on('will-navigate', (event) => event.preventDefault());
	window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
	window.webContents.on('before-input-event', (event, input) => shortcuts(event, input));
	window.on('resize', publish);
	window.on('closed', () => {
		discovery.close();
		abort?.abort();
		clearInterval(poll);
		tunnel?.stop();
		view?.webContents.close();
		ipcMain.removeHandler('lite:control');
		ipcMain.removeHandler('lite:connection-update');
		app.quit();
	});
	let stoppingControl: Promise<void> | undefined;
	app.on('before-quit', (event) => {
		abort?.abort();
		tunnel?.stop();
		if (controlServer) {
			event.preventDefault();
			stoppingControl ??= controlServer.close().finally(() => {
				controlServer = undefined;
				app.quit();
			});
		}
	});
	Menu.setApplicationMenu(
		Menu.buildFromTemplate([
			...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
			{
				label: 'Connection',
				submenu: [
					{
						label: 'Discover hosts',
						accelerator: 'CmdOrCtrl+Shift+D',
						click: () => void control('discover'),
					},
					{
						label: 'Connections',
						accelerator: 'CmdOrCtrl+Shift+L',
						click: () => void control('connections'),
					},
					{
						label: 'Connection Commands',
						accelerator: 'CmdOrCtrl+Shift+P',
						click: () => void control('commands'),
					},
					{
						label: 'Reconnect',
						accelerator: 'CmdOrCtrl+Shift+R',
						click: () => void control('reconnect'),
					},
					{ label: 'Disconnect', click: () => void control('disconnect') },
					{ label: 'Close Lite', accelerator: 'CmdOrCtrl+W', click: () => void control('close') },
				],
			},
			{ role: 'editMenu' },
			{ role: 'viewMenu' },
		])
	);
	controlServer = await startLiteControlServer(app.getPath('userData'), control);
	await window.loadURL(localUrl);
}
