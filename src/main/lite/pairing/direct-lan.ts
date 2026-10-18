import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { lanInterface, lanIPv4, lanOrigin, LAN_PORT, sameLanSubnet } from '../lan';
import { MdnsAdvertiser } from '../discovery/advertiser';
import { PairingHost } from './host';
import type { PairedDevices } from './paired-devices';
import type { DirectAccessState, TailnetListener } from './direct-tailnet';
import { atomicWriteFile, createKeyedWriteQueue } from '../../utils/atomic-json-store';
import { assertSerializedJsonIsSafe } from '../../../shared/jsonUtils';

interface Consent {
	version: 1;
	enabled: boolean;
	instanceId: string;
	name: string;
	address: string;
	netmask: string;
}
/** Persistent host consent for one existing private interface; never provisions network settings. */
export class DirectLanHost {
	state: DirectAccessState & { interfaceAddress?: string } = {
		enabled: false,
		ready: false,
		checking: false,
		message: 'Direct LAN access is off.',
	};
	advertising = false;
	private consent?: Consent;
	private currentHost?: PairingHost;
	private stopListener?: () => Promise<void>;
	private advertiser = new MdnsAdvertiser();
	private advertisementError?: string;
	private timer?: NodeJS.Timeout;
	private revision = 0;
	private pending?: Promise<void>;
	private controls = createKeyedWriteQueue();
	private initialized = false;
	private readonly file: string;
	/** Associate consent with this Maestro host and defer listener creation until activation. */
	constructor(
		directory: string,
		private devices: PairedDevices,
		private instanceId: string,
		private name: string,
		private listen?: TailnetListener,
		private onRequest?: (host: PairingHost, id: string) => void,
		private canActivate: () => boolean = () => true
	) {
		this.file = path.join(directory, 'lite-lan-access.json');
	}
	/** Require the saved address, interface name and netmask to still identify the consented network. */
	private currentInterface() {
		const consent = this.consent;
		const selected = consent && lanInterface(consent.address);
		return selected && selected.name === consent.name && selected.netmask === consent.netmask
			? selected
			: undefined;
	}
	/** Expose pairing only while consent, listener readiness and the current interface all remain valid. */
	get host(): PairingHost | undefined {
		return this.state.enabled && this.state.ready && this.canActivate() && this.currentInterface()
			? this.currentHost
			: undefined;
	}
	/** Restore this host's consent once, then periodically revalidate its interface without renewing consent. */
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
				if (text.length > 4096) throw new Error('Saved LAN access is invalid. Review access.');
				const value = JSON.parse(text) as Consent;
				if (
					value.version !== 1 ||
					typeof value.enabled !== 'boolean' ||
					value.instanceId !== this.instanceId ||
					typeof value.name !== 'string' ||
					!value.name ||
					!lanIPv4(value.address) ||
					!sameLanSubnet(value.address, value)
				)
					throw new Error('Saved LAN access belongs to another host or is invalid.');
				this.consent = value;
				this.state.enabled = value.enabled;
				this.state.interfaceAddress = value.address;
				if (value.enabled) await this.refresh();
			}
		} catch (error) {
			this.state.message =
				error instanceof Error ? error.message : 'LAN access could not be restored.';
		}
		this.timer = setInterval(() => {
			if (this.state.enabled) void this.refresh();
		}, 15000);
		this.timer.unref();
	}
	/** Atomically persist private consent before replacing the in-memory binding. */
	private async save(consent: Consent): Promise<void> {
		await mkdir(path.dirname(this.file), { recursive: true });
		const text = JSON.stringify(consent);
		assertSerializedJsonIsSafe(text, this.file);
		await atomicWriteFile(this.file, text, { mode: 0o600 });
		this.consent = consent;
	}
	/** Advertise identity and origin without secrets; discovery failures preserve access and ignore superseded hosts. */
	private advertise(address: string, host: PairingHost): void {
		this.advertisementError = undefined;
		this.advertising = true;
		this.advertiser.start(address, this.instanceId, this.name, this.state.origin!, (message) => {
			if (this.currentHost !== host) return;
			this.advertising = false;
			this.advertisementError = message;
			this.state.message = message + '. LAN access remains enabled at ' + this.state.origin + '.';
		});
	}
	/** Coalesce checks, open only the consented interface, and close access when its binding becomes invalid. */
	async refresh(): Promise<void> {
		if (this.pending) return this.pending;
		if (!this.state.enabled) return;
		this.state.checking = true;
		const revision = this.revision;
		const operation = (async () => {
			try {
				if (!this.canActivate())
					throw new Error('Disable direct Tailscale or HTTPS access before enabling LAN access.');
				const selected = this.currentInterface();
				if (!selected)
					throw new Error(
						'The selected LAN interface or network changed. Disable and review LAN access.'
					);
				this.state.origin = lanOrigin('http://' + selected.address + ':' + LAN_PORT);
				if (!this.currentHost) {
					if (!this.listen)
						throw new Error('The private Maestro listener is not available. Restart the host.');
					this.stopListener = await this.listen(selected.address);
					if (revision !== this.revision) {
						await this.stopListener();
						this.stopListener = undefined;
						return;
					}
					const host = await PairingHost.create(
						this.name,
						this.instanceId,
						[this.state.origin],
						Date.now,
						true,
						this.devices,
						(authority, remote, local) => {
							const current = this.currentInterface();
							return (
								!!current &&
								this.state.enabled &&
								this.state.ready &&
								this.canActivate() &&
								authority === current.address + ':' + LAN_PORT &&
								local?.replace(/^::ffff:/, '') === current.address &&
								sameLanSubnet(remote?.replace(/^::ffff:/, ''), current)
							);
						}
					);
					if (revision !== this.revision) {
						host.dispose();
						await this.stopListener?.();
						this.stopListener = undefined;
						return;
					}
					if (!this.currentInterface()) {
						host.dispose();
						throw new Error(
							'The selected LAN interface or network changed. Disable and review LAN access.'
						);
					}
					host.onRequest((id) => this.onRequest?.(host, id));
					this.currentHost = host;
				}
				if (!this.advertising) this.advertise(selected.address, this.currentHost!);
				this.state.ready = true;
				this.state.message = this.advertisementError
					? this.advertisementError + '. LAN access remains enabled at ' + this.state.origin + '.'
					: 'Direct LAN access is enabled on the selected network. New devices pair once; closing setup does not stop access.';
			} catch (error) {
				if (revision !== this.revision) return;
				this.state.ready = false;
				this.state.origin = undefined;
				this.currentHost?.dispose();
				this.currentHost = undefined;
				this.advertiser.stop();
				this.advertising = false;
				await this.stopListener?.();
				this.stopListener = undefined;
				this.state.message =
					error instanceof Error ? error.message : 'LAN access is unavailable. Access is closed.';
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
	/** Persist explicit consent before activation; changing an active interface requires disabling it first. */
	async enable(consent: boolean, address: string): Promise<void> {
		if (consent !== true) throw new Error('Review and explicitly allow direct LAN access first.');
		const revision = this.revision;
		await this.controls.enqueue(this.file, async () => {
			if (revision !== this.revision) throw new Error('LAN access request was cancelled.');
			if (!this.canActivate())
				throw new Error('Disable direct Tailscale or HTTPS access before enabling LAN access.');
			if (this.state.enabled) {
				if (address !== this.consent?.address)
					throw new Error('Disable LAN access before choosing another interface.');
				await this.refresh();
				return;
			}
			const selected = lanInterface(address);
			if (!selected) throw new Error('Choose an eligible private LAN interface.');
			const previous = this.consent;
			const next: Consent = { version: 1, enabled: true, instanceId: this.instanceId, ...selected };
			await this.save(next);
			if (revision !== this.revision) {
				await this.save(previous ?? { ...next, enabled: false });
				throw new Error('LAN access request was cancelled.');
			}
			this.state.enabled = true;
			this.state.interfaceAddress = address;
			await this.refresh();
		});
	}
	/** Immediately revoke admissions and supersede pending activation before asynchronous listener cleanup. */
	private invalidate(): void {
		this.revision++;
		this.state.ready = false;
		this.currentHost?.dispose();
		this.currentHost = undefined;
		this.advertiser.stop();
		this.advertising = false;
	}
	/** Revoke access immediately, drain pending work and persist disabled consent while retaining paired devices. */
	async disable(): Promise<void> {
		this.state.enabled = false;
		this.invalidate();
		await this.controls.enqueue(this.file, async () => {
			await this.pending;
			await this.stopListener?.();
			this.stopListener = undefined;
			if (this.consent) await this.save({ ...this.consent, enabled: false });
			this.state.origin = undefined;
			this.state.message = 'Direct LAN access is off. Remembered devices were not changed.';
		});
	}
	/** Stop checks and listeners during shutdown while preserving consent for the next host startup. */
	async close(): Promise<void> {
		this.invalidate();
		clearInterval(this.timer);
		this.timer = undefined;
		await this.controls.enqueue(this.file, async () => {
			await this.pending;
			await this.stopListener?.();
			this.stopListener = undefined;
		});
	}
}
