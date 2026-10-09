import { app, BrowserWindow, clipboard, ipcMain, shell, dialog } from 'electron';
import path from 'node:path';
import QRCode from 'qrcode';
import { PairedDevices } from './paired-devices';
import { PairingHost } from './host';
import { DirectTailnetHost, type TailnetListener } from './direct-tailnet';
import { MdnsAdvertiser } from '../discovery/advertiser';
import { availableLanInterfaces } from '../discovery/interfaces';
import { issueInvitation, parseInvitation } from '../discovery/invitation';
import { httpsOrigin } from '../discovery/types';
import { tailscaleApplication, tailscaleInstallUrl } from '../discovery/tailscale-command';
import { GRANT_TTL } from './protocol';
import { hostPairingPage } from './host-ui';
export interface HostPairingOptions {
	name: string;
	appVersion: string;
	endpoints: () => string[];
	/** Existing all-interface listener port; undefined when the backend is loopback-only. */
	backendPort?: () => number | undefined;
	listenTailnet?: TailnetListener;
	parent?: () => BrowserWindow | null;
}
/** Host-only consent and code display. Remote content never receives this local capability. */
export class HostPairingWindow {
	private currentHost?: PairingHost;
	private window?: BrowserWindow;
	private direct?: DirectTailnetHost;
	private devices = new PairedDevices(app.getPath('userData'));
	private advertiser = new MdnsAdvertiser();
	private advertising = false;
	private expiry?: NodeJS.Timeout;
	private expiresAt?: number;
	private revision = 0;
	private busy = false;
	private error?: string;
	private origin?: string;
	private knownOrigin = false;
	private endpoints?: () => string[];
	private invitation?: { text: string; qr: string; expiresAt: number };
	private updateStatus?: { status: string; message: string };
	private parent?: BrowserWindow;
	private context?: { instanceId: string; options: HostPairingOptions };
	private focusRequestId?: string;
	private requestQueue: Array<{ host: PairingHost; id: string }> = [];
	private prompting = false;
	private activePrompt?: { host: PairingHost; id: string; abort: AbortController };
	private readonly incomingRequest = (host: PairingHost, id: string): void => {
		if (this.activePrompt?.host === host && this.activePrompt.id === id) return;
		if (!this.requestQueue.some((entry) => entry.host === host && entry.id === id))
			this.requestQueue.push({ host, id });
		void this.showNextRequest();
	};
	private async showNextRequest(): Promise<void> {
		if (this.prompting) return;
		this.prompting = true;
		try {
			while (this.requestQueue.length) {
				const { host, id } = this.requestQueue.shift()!;
				const context = this.context;
				const parent = context?.options.parent?.() ?? this.parent;
				const current = () =>
					this.host === host
						? host
								.localRequests()
								.find((row) => row.requestId === id && row.state === 'awaiting-host')
						: undefined;
				const request = current();
				if (!context || !parent || parent.isDestroyed() || !request) continue;
				const abort = new AbortController();
				this.activePrompt = { host, id, abort };
				const watch = setInterval(() => {
					if (!current() || parent.isDestroyed()) abort.abort();
				}, 250);
				const expires = setTimeout(
					() => abort.abort(),
					Math.max(0, request.expiresAt - Date.now())
				);
				try {
					if (parent.isMinimized()) parent.restore();
					parent.show();
					parent.focus();
					const answer = await dialog.showMessageBox(parent, {
						type: 'question',
						title: 'Pairing request',
						message: request.clientName + ' wants to connect to this computer',
						detail:
							"If you started this on that device, choose Show code and type the code there. You'll approve access in a separate step.\n\nThe name comes from the device itself. If you didn't start this, choose Decline.",
						buttons: ['Decline', 'Show code'],
						defaultId: 0,
						cancelId: 0,
						noLink: true,
						signal: abort.signal,
					});
					if (abort.signal.aborted || !current()) continue;
					if (answer.response !== 1) {
						await host.revoke(id);
						continue;
					}
					host.approvePin(id);
					this.focusRequestId = id;
					await this.open(parent, context.instanceId, context.options);
				} catch (error) {
					this.error =
						error instanceof Error
							? error.message
							: 'Pairing prompt could not be shown. Review requests on the host.';
				} finally {
					clearInterval(watch);
					clearTimeout(expires);
					this.activePrompt = undefined;
				}
			}
		} finally {
			this.prompting = false;
		}
	}

	async initialize(instanceId: string, options: HostPairingOptions): Promise<void> {
		this.context = { instanceId, options };
		await this.devices.load();
		this.endpoints = options.endpoints;
		this.direct ??= new DirectTailnetHost(
			app.getPath('userData'),
			this.devices,
			instanceId,
			options.name,
			() => options.backendPort?.(),
			options.listenTailnet,
			this.incomingRequest
		);
		await this.direct.initialize();
	}
	get host(): PairingHost | undefined {
		if (this.direct?.state.enabled) return this.direct.host;
		if (
			this.knownOrigin &&
			this.origin &&
			!this.endpoints?.().map(httpsOrigin).includes(this.origin)
		) {
			this.stop();
			this.error = 'The published HTTPS endpoint changed. Review it before sharing again.';
		}
		return this.currentHost;
	}
	private stopTemporary(): void {
		this.revision++;
		clearTimeout(this.expiry);
		this.expiresAt = undefined;
		this.currentHost?.dispose();
		this.currentHost = undefined;
		this.origin = undefined;
		this.invitation = undefined;
		this.knownOrigin = false;
		this.advertiser.stop();
		this.advertising = false;
	}
	stop(): void {
		this.stopTemporary();
	}
	async open(
		parent: BrowserWindow,
		instanceId: string,
		options: HostPairingOptions
	): Promise<void> {
		this.parent = parent;
		if (this.window && !this.window.isDestroyed()) {
			this.window.show();
			this.window.focus();
			return;
		}
		await this.initialize(instanceId, options);
		const window = new BrowserWindow({
			parent,
			title: 'Connect another device',
			width: 760,
			height: 800,
			minWidth: 540,
			minHeight: 500,
			webPreferences: {
				preload: path.join(__dirname, 'host-preload.js'),
				contextIsolation: true,
				sandbox: true,
				nodeIntegration: false,
			},
		});
		this.window = window;
		const localUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(hostPairingPage);
		const channel = 'litePairing:local';
		ipcMain.handle(
			channel,
			async (
				event,
				action: string,
				payload: {
					name?: string;
					endpoint?: string;
					interfaceAddress?: string;
					id?: string;
					consent?: boolean;
					lan?: boolean;
					advanced?: boolean;
				} = {}
			) => {
				if (
					event.sender !== window.webContents ||
					event.senderFrame !== window.webContents.mainFrame ||
					event.senderFrame.url !== localUrl
				)
					throw new Error('Host-local pairing controls only');
				if (this.expiresAt && this.expiresAt <= Date.now()) this.stopTemporary();
				if (this.invitation && this.invitation.expiresAt <= Date.now()) this.invitation = undefined;
				const endpoints = options.endpoints().map(httpsOrigin);
				if (action !== 'state') this.error = undefined;
				if (action === 'inspect') await this.direct!.refresh();
				else if (action === 'enable-direct') {
					if (this.busy) throw new Error('An access operation is already in progress.');
					if (payload.consent !== true) throw new Error('Explicit host consent is required.');
					this.busy = true;
					try {
						this.stopTemporary();
						await this.direct!.enable(true);
					} finally {
						this.busy = false;
					}
				} else if (action === 'disable-direct') {
					await this.direct!.disable();
				} else if (action === 'open-tailscale') {
					const application = tailscaleApplication();
					if (application) {
						const error = await shell.openPath(application);
						if (error) throw new Error('Tailscale could not be opened.');
					} else await shell.openExternal(tailscaleInstallUrl());
				} else if (action === 'enable') {
					if (this.direct!.state.enabled)
						throw new Error(
							'Disable direct Tailscale access before choosing a different connection.'
						);
					if (this.busy) throw new Error('Pairing setup in progress');
					if (payload.consent !== true) throw new Error('Explicit host consent required');
					const origin = httpsOrigin(payload.endpoint);
					if (!payload.advanced && !endpoints.includes(origin))
						throw new Error(
							'Choose a detected HTTPS endpoint or explicitly provide one in Advanced.'
						);
					const selected = payload.lan
						? availableLanInterfaces().find((i) => i.address === payload.interfaceAddress)
						: undefined;
					if (payload.lan && !selected) throw new Error('Choose an eligible LAN interface');
					this.busy = true;
					this.stopTemporary();
					const revision = this.revision;
					try {
						const host = await PairingHost.create(
							payload.name ?? options.name,
							instanceId,
							[origin],
							Date.now,
							false,
							this.devices
						);
						if (revision !== this.revision || window.isDestroyed()) {
							host.dispose();
							throw new Error('Pairing cancelled');
						}
						host.onRequest((id) => this.incomingRequest(host, id));
						this.currentHost = host;
						this.origin = origin;
						this.knownOrigin = endpoints.includes(origin);
						if (selected) {
							this.advertising = true;
							this.advertiser.start(
								selected.address,
								instanceId,
								payload.name ?? options.name,
								origin,
								(message) => {
									if (this.currentHost === host) {
										this.advertising = false;
										this.error = message;
									}
								}
							);
						}
						this.expiresAt = Date.now() + GRANT_TTL;
						this.expiry = setTimeout(() => this.stopTemporary(), GRANT_TTL);
					} finally {
						this.busy = false;
					}
				} else if (action === 'invite') {
					if (!this.currentHost || !this.origin)
						throw new Error('Enable the HTTPS connection first.');
					const revision = this.revision;
					const text = issueInvitation({
						id: instanceId,
						name: payload.name ?? options.name,
						endpoint: this.origin,
					});
					const qr = await QRCode.toDataURL(text, {
						errorCorrectionLevel: 'M',
						margin: 2,
						width: 320,
					});
					if (revision !== this.revision || window.isDestroyed())
						throw new Error('Pairing cancelled');
					this.invitation = { text, qr, expiresAt: parseInvitation(text).expiresAt };
				} else if (action === 'copy-invitation') {
					if (!this.currentHost || !this.invitation)
						throw new Error('Create a current invitation first');
					clipboard.writeText(this.invitation.text);
				} else if (action === 'approve') this.host?.approvePin(payload.id ?? '');
				else if (action === 'confirm') this.host?.confirm(payload.id ?? '');
				else if (action === 'revoke') await this.host?.revoke(payload.id ?? '');
				else if (action === 'revoke-device') await this.devices.revoke(payload.id ?? '');
				else if (action === 'stop') this.stopTemporary();
				else if (action === 'close') {
					window.close();
					return;
				} else if (['update-check', 'update-download', 'update-install'].includes(action)) {
					if (action === 'update-install') {
						const answer = await dialog.showMessageBox(window, {
							type: 'warning',
							buttons: ['Cancel', 'Restart and install'],
							defaultId: 0,
							cancelId: 0,
							message: 'Restart Maestro to install the update?',
							detail:
								'Running agents, terminals and automations on this computer stop, and connected devices disconnect. Other computers are not updated.',
						});
						if (answer.response !== 1) return;
					}
					const { connectionUpdateAction } = await import('../../auto-updater');
					this.updateStatus = await connectionUpdateAction(action.slice(7));
				} else if (action !== 'state') throw new Error('Unknown host pairing action');
				return {
					enabled: !!this.host,
					direct: this.direct!.state,
					advertising: this.advertising,
					requests: this.host?.localRequests() ?? [],
					devices: this.devices.list(instanceId),
					focusRequestId: this.focusRequestId,
					error: this.error,
					invitation: this.invitation,
					interfaces: availableLanInterfaces(),
					endpoints,
					name: options.name,
					expiresAt: this.expiresAt,
					updateStatus: this.updateStatus,
				};
			}
		);
		window.webContents.on('will-navigate', (event) => event.preventDefault());
		window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
		window.on('closed', () => {
			this.stopTemporary();
			this.window = undefined;
			ipcMain.removeHandler(channel);
		});
		await window.loadURL(localUrl);
		void this.direct!.refresh();
	}
	async close(): Promise<void> {
		this.activePrompt?.abort.abort();
		this.requestQueue = [];
		this.context = undefined;
		this.parent = undefined;
		this.stopTemporary();
		this.window?.close();
		await this.direct?.close();
		this.direct = undefined;
	}
}
