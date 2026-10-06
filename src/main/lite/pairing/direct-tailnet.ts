import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readTailnet, type TailnetState } from '../tailnet';
import { TAILNET_PORT } from '../tailnet-origin';
import { PairingHost } from './host';
import type { PairedDevices } from './paired-devices';
import { createKeyedWriteQueue } from '../../utils/atomic-json-store';

interface Consent {
	version: 1;
	enabled: boolean;
	instanceId: string;
	device: string;
	tailnet: string;
	address: string;
}
export interface DirectAccessState {
	enabled: boolean;
	ready: boolean;
	checking: boolean;
	message: string;
	origin?: string;
}
export type TailnetListener = (address: string) => Promise<() => Promise<void>>;
/** Owns application consent and a tailnet-only listener. Never reads/writes Serve, ACLs or certificates. */
export class DirectTailnetHost {
	state: DirectAccessState = {
		enabled: false,
		ready: false,
		checking: true,
		message: 'Direct Tailscale access is off.',
	};
	private consent?: Consent;
	private snapshot?: TailnetState;
	private currentHost?: PairingHost;
	private stopListener?: () => Promise<void>;
	private timer?: NodeJS.Timeout;
	private revision = 0;
	private pending?: Promise<void>;
	private controls = createKeyedWriteQueue();
	private initialized = false;
	private readonly file: string;
	constructor(
		directory: string,
		private devices: PairedDevices,
		private instanceId: string,
		private name: string,
		private backendPort: () => number | undefined,
		private listen?: TailnetListener,
		private onRequest?: (host: PairingHost, id: string) => void
	) {
		this.file = path.join(directory, 'lite-tailnet-access.json');
	}
	get host(): PairingHost | undefined {
		return this.state.enabled &&
			this.state.ready &&
			this.snapshot &&
			Date.now() - this.snapshot.checkedAt < 45000
			? this.currentHost
			: undefined;
	}
	async initialize(): Promise<void> {
		if (this.initialized) return;
		this.initialized = true;
		try {
			let text: string | undefined;
			try {
				text = await readFile(this.file, 'utf8');
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
			}
			if (text) {
				if (text.length > 4096) throw new Error('Saved direct access is invalid. Review access.');
				const value = JSON.parse(text) as Consent;
				if (
					value.version !== 1 ||
					typeof value.enabled !== 'boolean' ||
					value.instanceId !== this.instanceId ||
					![value.device, value.tailnet, value.address].every((v) => typeof v === 'string' && !!v)
				)
					throw new Error('Saved direct access belongs to another host or is invalid.');
				this.consent = value;
				this.state.enabled = value.enabled;
				if (value.enabled) await this.refresh();
			}
		} catch (error) {
			this.state.message = error instanceof Error ? error.message : 'Access could not be restored.';
		}
		this.timer = setInterval(() => {
			if (this.state.enabled) void this.refresh();
		}, 15000);
		this.timer.unref();
	}
	private async save(consent: Consent): Promise<void> {
		await mkdir(path.dirname(this.file), { recursive: true });
		await writeFile(this.file + '.tmp', JSON.stringify(consent), { mode: 0o600 });
		await rename(this.file + '.tmp', this.file);
		this.consent = consent;
	}
	async refresh(): Promise<void> {
		if (this.pending) return this.pending;
		this.state.checking = true;
		const revision = this.revision;
		const operation = (async () => {
			try {
				const state = await readTailnet(new AbortController().signal);
				if (revision !== this.revision) return;
				if (
					this.state.enabled &&
					this.consent &&
					(state.device !== this.consent.device ||
						state.tailnet !== this.consent.tailnet ||
						state.address !== this.consent.address)
				)
					throw new Error(
						'Tailscale device or network changed. Disable and review direct access; no network configuration was changed.'
					);
				this.snapshot = state;
				this.state.origin = 'http://' + state.address + ':' + TAILNET_PORT;
				if (this.state.enabled) await this.activate(revision);
				this.state.message = this.state.enabled
					? 'Direct Tailscale access is enabled. New devices pair once; closing setup does not stop access.'
					: 'Tailscale is connected. Enable direct access to let Lite discover and request pairing.';
			} catch (error) {
				if (revision !== this.revision) return;
				this.state.ready = false;
				this.snapshot = undefined;
				this.state.origin = undefined;
				this.currentHost?.dispose();
				this.currentHost = undefined;
				await this.stopListener?.();
				this.stopListener = undefined;
				this.state.message =
					error instanceof Error ? error.message : 'Tailscale is unavailable. Access is closed.';
			}
		})();
		this.pending = operation;
		try {
			await operation;
		} finally {
			if (this.pending === operation) {
				this.pending = undefined;
				this.state.checking = false;
			}
		}
	}
	private async activate(revision: number): Promise<void> {
		if (this.currentHost) {
			this.state.ready = true;
			return;
		}
		if (this.backendPort() !== TAILNET_PORT) {
			if (!this.listen)
				throw new Error('The private Maestro listener is not available. Restart the host.');
			this.stopListener = await this.listen(this.snapshot!.address);
		}
		const host = await PairingHost.create(
			this.name,
			this.instanceId,
			[this.state.origin!],
			Date.now,
			true,
			this.devices,
			(authority, remote, local) => {
				const state = this.snapshot;
				const normalized = (address?: string) => address?.replace(/^::ffff:/, '');
				return (
					!!state &&
					this.state.enabled &&
					this.state.ready &&
					Date.now() - state.checkedAt < 45000 &&
					authority === state.address + ':' + TAILNET_PORT &&
					normalized(local) === state.address &&
					state.peers.has(normalized(remote) ?? '')
				);
			}
		);
		if (revision !== this.revision) {
			host.dispose();
			await this.stopListener?.();
			this.stopListener = undefined;
			return;
		}
		host.onRequest((id) => this.onRequest?.(host, id));
		this.currentHost = host;
		this.state.ready = true;
	}
	async enable(consent: boolean): Promise<void> {
		if (consent !== true)
			throw new Error('Review and explicitly allow direct Tailscale access first.');
		const revision = this.revision;
		await this.controls.enqueue(this.file, async () => {
			if (revision !== this.revision) throw new Error('Direct access request was cancelled.');
			if (this.state.enabled && this.state.ready) return;
			await this.refresh();
			if (revision !== this.revision) throw new Error('Direct access request was cancelled.');
			if (!this.snapshot || Date.now() - this.snapshot.checkedAt >= 45000)
				throw new Error(this.state.message);
			const state = this.snapshot;
			await this.save({
				version: 1,
				enabled: true,
				instanceId: this.instanceId,
				device: state.device,
				tailnet: state.tailnet,
				address: state.address,
			});
			if (revision !== this.revision) throw new Error('Direct access request was cancelled.');
			this.state.enabled = true;
			await this.refresh();
		});
	}
	async disable(): Promise<void> {
		this.state.enabled = false;
		this.state.ready = false;
		this.revision++;
		this.currentHost?.dispose();
		this.currentHost = undefined;
		// Invalidate immediately, then wait for an older consent write before saving the revocation.
		await this.controls.enqueue(this.file, async () => {
			await this.pending;
			await this.stopListener?.();
			this.stopListener = undefined;
			if (this.consent) await this.save({ ...this.consent, enabled: false });
			this.state.message =
				'Direct Tailscale access is off. Tailscale routes, policy and remembered devices were not changed.';
		});
	}
	async close(): Promise<void> {
		this.revision++;
		clearInterval(this.timer);
		this.timer = undefined;
		this.state.ready = false;
		this.currentHost?.dispose();
		this.currentHost = undefined;
		await this.controls.enqueue(this.file, async () => {
			await this.pending;
			await this.stopListener?.();
			this.stopListener = undefined;
		});
	}
}
