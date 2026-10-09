import { DiscoveryManager } from './manager';
import type { DiscoveryConfig, Candidate } from './types';
import { PairingClient } from '../pairing/client';
import { pairingTransport } from '../pairing/transport';
import type { LiteProfile } from '../profiles';
import type { DeviceCredentials } from '../device-credentials';
import type { DiscoveryPairingState } from '../../../shared/lite-discovery';
import { tailnetDestination } from '../tailnet';
import { hostname } from 'node:os';
export interface DiscoveredConnection {
	profile: LiteProfile;
	capabilities: readonly string[];
	credential: string;
	peerId?: string;
}
export class DiscoveryController {
	readonly discovery: DiscoveryManager;
	private client?: PairingClient;
	private timer?: ReturnType<typeof setInterval>;
	private polling = false;
	private revision = 0;
	private delivered = false;
	private selected?: Candidate;
	private lastError?: string;
	constructor(
		private changed: () => void,
		private profiles: () => LiteProfile[],
		private connect: (connection: DiscoveredConnection) => void,
		private revoked: (reason: string) => void,
		private credentials: DeviceCredentials
	) {
		this.discovery = new DiscoveryManager(changed, () => {
			void this.cancel('network-changed');
		});
	}
	snapshot(): DiscoveryPairingState {
		return {
			discovery: this.discovery.snapshot(),
			pairing: this.delivered
				? { phase: 'connected', instanceId: this.selected?.id }
				: this.lastError
					? { phase: 'cancelled', error: this.lastError }
					: (this.client?.snapshot() ?? { phase: 'idle' }),
		};
	}
	private deliver(row: Candidate, credential: string): void {
		if (!row.connection) throw new Error('No compatible host connection.');
		this.delivered = true;
		this.connect({
			profile: {
				id: 'discovered-' + this.revision,
				name: row.name,
				transport: row.endpoint.startsWith('http:') ? 'tailscale' : 'https',
				url: row.endpoint + row.connection.path,
				instanceId: row.id,
			},
			credential,
			peerId: row.peerId,
			capabilities: row.connection.capabilities,
		});
	}
	async control(action: string, payload: unknown): Promise<void> {
		if (action === 'discovery-start') {
			if (!payload || typeof payload !== 'object')
				throw new Error('Discovery configuration required');
			await this.discovery.start(payload as DiscoveryConfig);
		} else if (action === 'discovery-import') {
			if (typeof payload !== 'string') throw new Error('Host invitation required');
			await this.discovery.importInvitation(payload);
		} else if (action === 'discovery-stop' || action === 'network-changed') this.discovery.stop();
		else if (action === 'pair-forget') {
			const row = this.selected;
			await this.cancel();
			if (row) await this.credentials.forget(row.endpoint);
			this.client = undefined;
		} else if (action === 'pair-request') {
			const p = payload as { key: string; generation: number; name: string };
			const row = this.discovery.select(p.key, p.generation);
			await this.cancel();
			this.lastError = undefined;
			this.client = undefined;
			this.selected = row;
			const revision = ++this.revision;
			const saved = this.profiles().filter(
				(profile) =>
					(profile.transport === 'https' || profile.transport === 'tailscale') &&
					new URL(profile.url).origin === row.endpoint &&
					profile.instanceId
			);
			const identities = new Set(saved.map((profile) => profile.instanceId));
			if (identities.size > 1 || (saved[0]?.instanceId && saved[0].instanceId !== row.id))
				throw new Error(
					'Saved host identity differs from discovered host. Verify its identity before pairing.'
				);
			if (row.endpoint.startsWith('http:')) {
				const target = await tailnetDestination(row.endpoint, AbortSignal.timeout(5000));
				if (target.peerId !== row.peerId)
					throw new Error('Tailscale node identity changed. Refresh and verify this host.');
			}
			const credential = await this.credentials.get(row.id, row.endpoint, row.peerId);
			if (revision !== this.revision) return;
			if (credential) {
				this.deliver(row, credential);
				this.changed();
				return;
			}
			const computerName =
				hostname()
					.replace(/[\x00-\x1f\x7f]/g, '')
					.trim()
					.slice(0, 64) || 'Maestro Lite';
			const client = new PairingClient(pairingTransport(row), row, computerName);
			this.client = client;
			try {
				await client.begin(saved[0]?.instanceId ?? row.id);
			} finally {
				this.changed();
			}
			if (revision !== this.revision) {
				await client.cancel();
				return;
			}
			this.timer = setInterval(() => {
				void this.poll();
			}, 1000);
		} else if (action === 'pair-submit') {
			if (!this.client || typeof payload !== 'string')
				throw new Error('Active request and PIN required');
			await this.client.submit(payload);
		} else if (action === 'pair-read') {
			if (!this.client) throw new Error('No pairing proof');
			await this.client.read();
		} else if (action === 'pair-cancel') await this.cancel();
		else if (action !== 'discovery-status') throw new Error('Unknown discovery action');
		this.changed();
	}
	private async poll(): Promise<void> {
		if (this.polling || !this.client) return;
		this.polling = true;
		const client = this.client,
			revision = this.revision,
			row = this.selected;
		try {
			await client.poll();
			if (this.client !== client || !row || client.snapshot().phase !== 'paired') return;
			const metadata = await client.read();
			if (this.client !== client || revision !== this.revision) return;
			if (metadata.instanceId !== row.id || metadata.connection.path !== row.connection?.path)
				throw new Error('Host identity or connection changed');
			const credential = client.connectionAdmission();
			await this.credentials.save(row.id, row.endpoint, credential, row.peerId);
			if (this.client !== client || revision !== this.revision) {
				await this.credentials.forget(row.endpoint, credential);
				await client.cancel();
				return;
			}
			clearInterval(this.timer);
			this.client = undefined;
			this.deliver(row, credential);
		} catch (error) {
			if (this.client === client) {
				await this.cancel('pairing-failed');
				this.lastError = error instanceof Error ? error.message : 'Pairing failed.';
			}
		} finally {
			this.polling = false;
			this.changed();
		}
	}
	private async cancel(reason = 'cancelled'): Promise<void> {
		this.revision++;
		clearInterval(this.timer);
		if (this.delivered) {
			this.delivered = false;
			this.revoked(reason);
		}
		await this.client?.cancel(reason);
		this.changed();
	}
	close(): void {
		this.discovery.stop();
		clearInterval(this.timer);
	}
}
