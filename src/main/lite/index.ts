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
import type { LiteProfile } from '../../shared/lite-control';
import { openTunnel } from './tunnel';
import { openTailnetRelay, openLanRelay } from './tailnet-relay';
import { validateHandshake, HostConnectionError } from './handshake';
import { connectionPage } from './ui';
import { parseSshConfig } from '../utils/ssh-config-parser';
import { startLiteControlServer } from './control-server';
import { LiteLastConnections } from './last-connection';
import { resolveLiteDataDirectory } from '../../shared/lite-control';
import type { LiteControlOptions, LiteControlState } from '../../shared/lite-control';

/** Start an isolated attachment runtime without full Maestro backends, keeping remote content sandboxed. */
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
	const lastConnections = new LiteLastConnections(app.getPath('userData'));
	let loadError: string | undefined;
	try {
		await profiles.load();
		await lastConnections.load();
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
	let recoveryTimer: NodeJS.Timeout | undefined;
	let recoveryResetTimer: NodeJS.Timeout | undefined;
	let recoveryAttempt = 0;
	let recovery: LiteControlState['recovery'];
	let autoRecover = false;
	let directRecovery = false;
	let rendererNeedsReload = false;
	let rendererFailures: number[] = [];
	let controlServer: { close(): Promise<void> } | undefined;
	let discovered: DiscoveredConnection | undefined;
	let lastDiscovered: Pick<DiscoveredConnection, 'profile' | 'peerId'> | undefined;
	let discoveredSession: Session | undefined;
	const discovery = new DiscoveryController(
		publish,
		() => profiles.list(),
		(connection) => {
			const previous = lastDiscovered;
			const sameVerifiedHost =
				!!previous &&
				previous?.profile.instanceId === connection.profile.instanceId &&
				previous.profile.url === connection.profile.url &&
				previous.profile.transport === connection.profile.transport &&
				previous.peerId === connection.peerId;
			const next = {
				...connection,
				profile: {
					...connection.profile,
					...(previous && sameVerifiedHost
						? { id: previous.profile.id, localPort: previous.profile.localPort }
						: {}),
				},
			};
			discovered = next;
			lastDiscovered = next;
			if (!sameVerifiedHost || !discoveredSession)
				discoveredSession = session.fromPartition('maestro-lite-discovered-' + randomUUID());
			const automatic = directRecovery;
			void connect(
				next.profile.id,
				undefined,
				automatic && !!view && !rendererNeedsReload,
				automatic
			);
		},
		(reason) => {
			discovered = undefined;
			recover(
				reason === 'network-changed'
					? 'Your network changed. Waiting to verify the same host again.'
					: reason === 'pairing-failed'
						? 'Pairing could not finish. Choose the host to try again.'
						: 'The connection closed. Waiting to reconnect.'
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
			recovery,
			profiles: profiles.list(),
			discoveryPairing: discovery.snapshot(),
			aliases,
		};
	}
	const localUrl = `data:text/html;charset=utf-8,${encodeURIComponent(connectionPage)}`;
	function publish(): void {
		if (window.isDestroyed()) return;
		window.webContents.send('lite:state', getState());
		if (view && !view.webContents.isDestroyed()) {
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
	function teardown(preserveView = false): Promise<void> {
		connectionVersion++;
		clearTimeout(recoveryResetTimer);
		abort?.abort();
		abort = undefined;
		clearInterval(poll);
		poll = undefined;
		if (!preserveView) removeView();
		if (tunnel) tunnelClosing = tunnel.stop();
		tunnel = undefined;
		picker = preserveView && view ? false : true;
		commandsVisible = false;
		if (!preserveView) hostName = '';
		publish();
		return Promise.all([tunnelClosing, transportOpening]).then(() => {});
	}
	function disconnect(): Promise<void> {
		autoRecover = false;
		clearTimeout(recoveryTimer);
		recoveryTimer = undefined;
		recoveryAttempt = 0;
		recovery = undefined;
		const closing = teardown();
		status = 'Disconnected. Work on the host keeps running.';
		error = undefined;
		publish();
		return Promise.all([closing, lastConnections.disable().catch(() => {})]).then(() => {});
	}
	function fail(message: string): void {
		autoRecover = false;
		void lastConnections.disable().catch(() => {});
		clearTimeout(recoveryTimer);
		recoveryTimer = undefined;
		recovery = undefined;
		void teardown();
		status = 'Connection failed';
		error = message;
		publish();
	}
	function recover(cause: unknown, renderer = false): void {
		if (!autoRecover || !selected || window.isDestroyed()) return;
		const message = cause instanceof Error ? cause.message : String(cause);
		if (renderer) {
			rendererNeedsReload = true;
			const now = Date.now();
			rendererFailures = [...rendererFailures.filter((time) => now - time < 60000), now];
			if (rendererFailures.length > 3) {
				fail('The host view crashed repeatedly. Reconnect to try again.');
				return;
			}
		}
		clearInterval(poll);
		poll = undefined;
		if (recoveryTimer) return;
		const ceiling = Math.min(30000, 1000 * 2 ** recoveryAttempt);
		const delay = Math.floor(Math.random() * (ceiling + 1));
		recoveryAttempt++;
		recovery = { attempt: recoveryAttempt, nextRetryAt: Date.now() + delay };
		status = `Reconnecting · ${hostName || 'selected host'}`;
		error = message;
		publish();
		recoveryTimer = setTimeout(() => {
			recoveryTimer = undefined;
			void attemptRecovery();
		}, delay);
	}
	async function attemptRecovery(): Promise<void> {
		const id = selected;
		if (!autoRecover || !id) return;
		if (id.startsWith('discovered-') && discovered?.profile.id !== id) {
			const previous = lastDiscovered;
			if (!previous) {
				fail('Select and pair the discovered private host first.');
				return;
			}
			const snapshot = discovery.snapshot().discovery;
			const origin = new URL(previous.profile.url).origin;
			const row = snapshot.candidates.find(
				(candidate) =>
					candidate.id === previous.profile.instanceId &&
					candidate.endpoint === origin &&
					candidate.availability === 'ready'
			);
			if (!row) {
				recover('Waiting for the same verified host to reappear.');
				return;
			}
			directRecovery = true;
			try {
				await discovery.control('pair-request', {
					key: row.key,
					generation: snapshot.generation,
					name: row.name,
				});
			} catch (cause) {
				const message = cause instanceof Error ? cause.message : String(cause);
				if (/identity|pair again|incompatible/i.test(message)) fail(message);
				else recover(cause);
			} finally {
				directRecovery = false;
			}
			return;
		}
		const preserveView = !!view && !rendererNeedsReload;
		rendererNeedsReload = false;
		await connect(id, undefined, preserveView, true);
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
		browserSession.setPermissionRequestHandler((_contents, _permission, callback) =>
			callback(false)
		);
		browserSession.setPermissionCheckHandler(() => false);
		let unresponsiveTimer: NodeJS.Timeout | undefined;
		remote.webContents.on('render-process-gone', (_event, details) => {
			if (poll && details.reason !== 'clean-exit')
				recover(new Error(`Host view ended (${details.reason}).`), true);
		});
		remote.webContents.on(
			'did-fail-load',
			(_event, errorCode, description, _validatedURL, isMainFrame) => {
				if (poll && isMainFrame && errorCode !== -3)
					recover(new Error(`Host view failed to load: ${description} (${errorCode}).`), true);
			}
		);
		remote.webContents.on('unresponsive', () => {
			clearTimeout(unresponsiveTimer);
			unresponsiveTimer = setTimeout(() => {
				if (poll) recover(new Error('Host view is not responding.'), true);
			}, 15000);
		});
		remote.webContents.on('responsive', () => clearTimeout(unresponsiveTimer));
		remote.webContents.once('destroyed', () => clearTimeout(unresponsiveTimer));
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
	async function loadView(contents: WebContents, url: string, signal: AbortSignal): Promise<void> {
		const interrupted = Promise.withResolvers<never>();
		const cancel = () => interrupted.reject(new Error('Connection canceled.'));
		const timer = setTimeout(
			() => interrupted.reject(new Error('Host view load timed out.')),
			15000
		);
		signal.addEventListener('abort', cancel, { once: true });
		try {
			if (signal.aborted) cancel();
			await Promise.race([contents.loadURL(url), interrupted.promise]);
		} finally {
			clearTimeout(timer);
			signal.removeEventListener('abort', cancel);
		}
	}
	async function handshake(
		browserSession: Session,
		base: URL,
		signal: AbortSignal
	): Promise<unknown | undefined> {
		const deadline = Promise.withResolvers<never>();
		const timer = setTimeout(() => deadline.reject(new Error('Host handshake timed out.')), 10000);
		let response: Response;
		try {
			response = await Promise.race([
				browserSession.fetch(`${base}/api/lite/handshake`, {
					signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
					credentials: 'include',
					redirect: 'error',
					headers: { 'Cache-Control': 'no-store' },
				}),
				deadline.promise,
			]);
		} finally {
			clearTimeout(timer);
		}
		if (response.status === 401) return undefined;
		if (response.status === 502 || response.status === 503 || response.status === 504)
			throw new Error('Host handshake temporarily unavailable (HTTP ' + response.status + ').');
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
	/** Drain the previous transport, cancel superseded attempts and validate host trust before showing remote content. */
	async function connect(
		id: string,
		initialState?: () => void,
		preserveView = false,
		automatic = false
	): Promise<void> {
		clearTimeout(recoveryTimer);
		autoRecover = true;
		recoveryTimer = undefined;
		if (!automatic) {
			recoveryAttempt = 0;
			rendererFailures = [];
		}
		const retainedView = view;
		const retainView = preserveView && !!retainedView;
		const closing = teardown(retainView);
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
			let profile: LiteProfile;
			try {
				profile = selectedDiscovery?.profile ?? profiles.get(id);
			} catch (cause) {
				throw new HostConnectionError(cause instanceof Error ? cause.message : String(cause));
			}
			const clientId = encodeURIComponent(profile.id);
			status = `${automatic ? 'Reconnecting transport' : 'Opening transport'} · ${profile.name}`;
			publish();
			let base = normalizeRemoteUrl(profile.url, profile.transport);
			if (profile.transport === 'tailscale' || profile.transport === 'lan') {
				if (!selectedDiscovery)
					throw new HostConnectionError('Select and pair the discovered private host first.');
				const opening =
					profile.transport === 'lan'
						? openLanRelay(
								base,
								selectedDiscovery.credential,
								signal,
								profile.localPort,
								!retainView
							)
						: openTailnetRelay(
								base,
								selectedDiscovery.credential,
								signal,
								selectedDiscovery.peerId!,
								profile.localPort,
								!retainView
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
					(cause) => {
						if (abort === controller) recover(cause);
					},
					profile.localPort,
					!retainView
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
			status = `Validating host · ${profile.name}`;
			publish();
			const authentication = selectedDiscovery
				? discoveredSession!
				: session.fromPartition('maestro-lite-auth-' + randomUUID());
			if (profile.transport === 'tailscale' || profile.transport === 'lan')
				await authentication.setProxy({ mode: 'direct' });
			status = `Checking authorization · ${profile.name}`;
			publish();
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
						if (signal.aborted || discovered?.credential !== selectedDiscovery.credential) {
							callback({ cancel: true });
							return;
						}
						headers[ADMISSION_HEADER] = selectedDiscovery.credential;
					}
					callback({ requestHeaders: headers });
				});
			status = `Reading host state · ${profile.name}`;
			publish();
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
					const loaded = loadView(
						view.webContents,
						`${base}/login?next=${encodeURIComponent(next)}`,
						signal
					).then(() => initialState?.());
					const [, authenticated] = await Promise.all([loaded, login.promise]);
					raw = authenticated;
				} finally {
					clearInterval(timer);
					signal.removeEventListener('abort', canceled);
				}
			}
			if (signal.aborted) return;
			const host = validateHandshake(raw, profile, !!selectedDiscovery);
			const localPort = ['ssh', 'tailscale', 'lan'].includes(profile.transport)
				? Number(base.port)
				: undefined;
			if (
				!selectedDiscovery &&
				(profile.instanceId !== host.instanceId || profile.localPort !== localPort)
			) {
				profile = { ...profile, instanceId: host.instanceId, localPort };
				await profiles.save(profile);
			}
			if (signal.aborted) return;
			if (selectedDiscovery && profile.localPort !== localPort) {
				profile = { ...profile, localPort };
				discovered = { ...selectedDiscovery, profile };
				void lastConnections.remember(profile, signal).catch(() => {});
			}
			if (selectedDiscovery) lastDiscovered = { ...selectedDiscovery, profile };
			if (
				!id.startsWith('discovered-') ||
				profile.transport === 'lan' ||
				profile.transport === 'tailscale'
			)
				await lastConnections.remember(profile, signal).catch(() => {});
			if (signal.aborted) return;
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
			if (isolated !== authentication)
				validateHandshake(await handshake(isolated, base, signal), profile, !!selectedDiscovery);
			// Native Lite is online-only: migrate PWA workers without clearing host cookies or drafts.
			await isolated.clearStorageData({ storages: ['serviceworkers', 'cachestorage'] });
			if (signal.aborted) return;
			const reuseView =
				retainView &&
				retainedView === view &&
				(profile.transport === 'ssh' || !!selectedDiscovery) &&
				!view.webContents.isDestroyed() &&
				new URL(view.webContents.getURL()).origin === base.origin;
			if (!reuseView) {
				removeView();
				view = makeView(isolated, base, true);
				window.contentView.addChildView(view);
			}
			hostName =
				host.hostName === profile.name ? host.hostName : `${host.hostName} (${profile.name})`;
			picker = false;
			status = `Opening Maestro on ${hostName}`;
			error = undefined;
			recovery = undefined;
			rendererNeedsReload = false;
			recoveryResetTimer = setTimeout(() => {
				recoveryAttempt = 0;
				rendererFailures = [];
			}, 30000);
			publish();
			if (!reuseView)
				await loadView(
					view!.webContents,
					`${base}/desktop?lite=1&liteClientId=${clientId}`,
					signal
				);
			initialState?.();
			let count = 0;
			poll = setInterval(() => {
				if (busyPoll || signal.aborted || !view) return;
				busyPoll = true;
				const current = view;
				void (async () => {
					try {
						if (++count % 5 === 0) {
							try {
								const response = await handshake(isolated, base, signal);
								if (response === undefined)
									throw new HostConnectionError(
										'Host login expired or was revoked. Reconnect and authenticate again.'
									);
								validateHandshake(response, profile, !!selectedDiscovery);
							} catch (cause) {
								if (cause instanceof HostConnectionError && !cause.retryable) throw cause;
								// A failed health read does not determine the live bridge state.
							}
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
							if (cause instanceof HostConnectionError && !cause.retryable) fail(cause.message);
							else if (cause instanceof HostConnectionError) recover(cause);
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
			if (!signal.aborted) {
				if (cause instanceof HostConnectionError && !cause.retryable) fail(cause.message);
				else recover(cause);
			}
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
				if (name === 'pair-forget') {
					autoRecover = false;
					clearTimeout(recoveryTimer);
					await lastConnections.disable().catch(() => {});
					lastDiscovered = undefined;
					discoveredSession = undefined;
				}
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
				if (name === 'reconnect' && id.startsWith('discovered-') && discovered?.profile.id !== id) {
					autoRecover = true;
					clearTimeout(recoveryTimer);
					recoveryTimer = undefined;
					await attemptRecovery();
				} else if (cli) {
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
		autoRecover = false;
		clearTimeout(recoveryTimer);
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
		autoRecover = false;
		clearTimeout(recoveryTimer);
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
	const restore = lastConnections.get();
	if (restore?.enabled) {
		const { profile } = restore;
		if (profile.transport === 'lan' || profile.transport === 'tailscale') {
			selected = profile.id;
			lastDiscovered = { profile };
			autoRecover = true;
			hostName = profile.name;
			await discovery.control('discovery-start', {
				lan: profile.transport === 'lan',
				tailscale: profile.transport === 'tailscale',
				tailscalePeers: profile.transport === 'tailscale',
			});
			await attemptRecovery();
		} else if (profiles.list().some((candidate) => candidate.id === profile.id)) {
			await connect(profile.id, undefined, false, true);
		}
	}
}
