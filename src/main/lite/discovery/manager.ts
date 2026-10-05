import { MdnsBrowser } from './mdns';
import { availableLanInterfaces } from './interfaces';
import { parseInvitation } from './invitation';
import {
	readTailscaleStatus,
	readTailscaleServices,
	tailscaleCandidates,
	tailscalePeerDiscovery,
	type StatusReader,
} from './tailscale';
import { probeService, type ServiceProbe } from './probe';
import type {
	Candidate,
	DiscoveryAdapter,
	DiscoveryConfig,
	DiscoverySource,
	DiscoveryState,
	SourceState,
} from './types';

interface DiscoveryDependencies {
	lan?: (address: string) => DiscoveryAdapter;
	interfaces?: typeof availableLanInterfaces;
	status?: StatusReader;
	services?: StatusReader;
	probe?: ServiceProbe;
	now?: () => number;
}
interface Search {
	abort: AbortController;
	queue: Candidate[];
	pending: Set<string>;
	active: number;
	cache: Map<string, { result: Candidate; until: number }>;
}
const probeKey = (row: Candidate) => row.endpoint + '|' + (row.identityHint ?? '');
const invitationState: SourceState = {
	status: 'invitation-required',
	message:
		'Internet / Cloudflare hosts require an invitation from the host. There is no public tunnel directory.',
};

export class DiscoveryManager {
	private adapters: DiscoveryAdapter[] = [];
	private timer?: NodeJS.Timeout;
	private rows = new Map<string, Candidate[]>();
	private search?: Search;
	private config: DiscoveryConfig = {};
	private state: DiscoveryState = {
		running: false,
		generation: 0,
		candidates: [],
		errors: [],
		sources: {},
	};
	private readonly lan: (address: string) => DiscoveryAdapter;
	private readonly interfaces: typeof availableLanInterfaces;
	private readonly status: StatusReader;
	private readonly services: StatusReader;
	private readonly probe: ServiceProbe;
	private readonly now: () => number;
	constructor(
		private changed: () => void,
		private networkChanged: () => void,
		dependencies: DiscoveryDependencies = {}
	) {
		this.lan = dependencies.lan ?? ((address) => new MdnsBrowser(address));
		this.interfaces = dependencies.interfaces ?? availableLanInterfaces;
		this.status = dependencies.status ?? readTailscaleStatus;
		this.services = dependencies.services ?? readTailscaleServices;
		this.probe = dependencies.probe ?? probeService;
		this.now = dependencies.now ?? Date.now;
	}
	snapshot(): DiscoveryState {
		const groups = new Map<string, Candidate>();
		for (const rows of this.rows.values())
			for (const hint of rows) {
				if (hint.expiresAt <= this.now()) continue;
				const result = this.search?.cache.get(probeKey(hint))?.result;
				if (hint.requiresManifest && !result?.version) continue;
				const row = result
					? { ...result, source: hint.source, expiresAt: hint.expiresAt }
					: { ...hint };
				const key = row.availability === 'ready' ? 'host:' + row.id : 'endpoint:' + row.endpoint;
				const previous = groups.get(key);
				if (previous)
					previous.sources = [...new Set([...(previous.sources ?? [previous.source]), row.source])];
				else groups.set(key, { ...row, key, sources: [row.source] });
			}
		return {
			...this.state,
			errors: [...this.state.errors],
			sources: { ...this.state.sources },
			candidates: [...groups.values()].sort(
				(a, b) =>
					Number(b.availability === 'ready') - Number(a.availability === 'ready') ||
					a.name.localeCompare(b.name)
			),
		};
	}
	select(key: string, generation: number): Candidate {
		const row = this.snapshot().candidates.find((c) => c.key === key);
		if (
			!this.state.running ||
			generation !== this.state.generation ||
			!row ||
			row.availability !== 'ready'
		)
			throw new Error('Host is stale, unavailable or incompatible; refresh discovery');
		return { ...row };
	}
	private publish(search: Search, bucket: string, rows: Candidate[]): void {
		if (search !== this.search) return;
		this.rows.set(bucket, rows.slice(0, 128));
		this.schedule(search);
		this.changed();
	}
	private schedule(search: Search): void {
		if (search !== this.search) return;
		const now = this.now();
		for (const [key, entry] of search.cache) if (entry.until <= now) search.cache.delete(key);
		for (const rows of this.rows.values())
			for (const row of rows) {
				const key = probeKey(row);
				if (
					row.expiresAt <= now ||
					row.availability === 'peer-offline' ||
					search.cache.has(key) ||
					search.pending.has(key) ||
					search.pending.size >= 128
				)
					continue;
				search.pending.add(key);
				search.queue.push(row);
			}
		this.drain(search);
	}
	private drain(search: Search): void {
		while (search === this.search && search.active < 4 && search.queue.length) {
			const row = search.queue.shift()!;
			const key = probeKey(row);
			if (
				row.expiresAt <= this.now() ||
				![...this.rows.values()].some((rows) => rows.some((entry) => probeKey(entry) === key))
			) {
				search.pending.delete(key);
				continue;
			}
			search.active++;
			void this.probe(row, search.abort.signal)
				.catch(() => ({
					...row,
					availability: 'unreachable' as const,
					detail: 'The advertised service could not be reached securely.',
				}))
				.then((result) => {
					if (search === this.search) {
						search.cache.set(key, { result, until: this.now() + 20000 });
						this.changed();
					}
				})
				.finally(() => {
					search.active--;
					search.pending.delete(key);
					this.drain(search);
				});
		}
	}
	async start(config: DiscoveryConfig = {}): Promise<void> {
		if (
			Object.keys(config).some(
				(key) => !['lan', 'tailscale', 'tailscalePeers', 'interfaceAddress'].includes(key)
			)
		)
			throw new Error('Unsupported discovery option; use a host invitation instead of a registry');
		if (
			(config.lan !== undefined && typeof config.lan !== 'boolean') ||
			(config.tailscale !== undefined && typeof config.tailscale !== 'boolean') ||
			(config.tailscalePeers !== undefined && typeof config.tailscalePeers !== 'boolean') ||
			(config.interfaceAddress !== undefined && typeof config.interfaceAddress !== 'string')
		)
			throw new Error('Invalid discovery options');
		this.stop();
		this.config = { ...config };
		const search: Search = {
			abort: new AbortController(),
			queue: [],
			pending: new Set(),
			active: 0,
			cache: new Map(),
		};
		this.search = search;
		this.state.running = true;
		this.state.errors = [];
		this.state.sources = { cloudflare: invitationState };
		const setSource = (source: DiscoverySource, value: SourceState) => {
			if (search === this.search) {
				this.state.sources[source] = value;
				this.changed();
			}
		};
		let interfaces: { name: string; address: string }[] = [];
		try {
			interfaces =
				config.lan === false
					? []
					: config.interfaceAddress
						? [{ name: 'Selected interface', address: config.interfaceAddress }]
						: this.interfaces();
		} catch {
			setSource('lan', {
				status: 'permission-denied',
				message: 'Local interfaces could not be read. No permissions were changed.',
			});
		}
		const fingerprint = interfaces
			.map((item) => item.address)
			.sort()
			.join(',');
		if (config.lan === false)
			setSource('lan', {
				status: 'stopped',
				message: 'Local network discovery is disabled for this search.',
			});
		else if (!interfaces.length && !this.state.sources.lan)
			setSource('lan', {
				status: 'offline',
				message:
					'No active IPv4 local network interface. Connect to a local network or use an invitation.',
			});
		else if (interfaces.length)
			setSource('lan', {
				status: 'searching',
				message: 'Looking for Maestro advertisements on your active local networks.',
			});
		const interfaceStates = new Map<string, SourceState>();
		const updateLan = (address: string, value: SourceState) => {
			if (search !== this.search) return;
			interfaceStates.set(address, value);
			const values = [...interfaceStates.values()];
			const usable =
				values.find((item) => item.status === 'ready') ??
				values.find((item) => item.status === 'empty');
			setSource('lan', usable ?? values[0]);
		};
		const starts = interfaces.map(async ({ address }) => {
			try {
				const adapter = this.lan(address);
				this.adapters.push(adapter);
				await adapter.start(
					(rows) => {
						this.publish(search, 'lan:' + address, rows);
						updateLan(address, {
							status: rows.length ? 'ready' : 'empty',
							message: rows.length
								? 'Maestro advertisements found; checking secure service compatibility.'
								: 'No Maestro advertisements yet. Enable attended Lite pairing on the full host.',
						});
					},
					(message) => {
						this.publish(search, 'lan:' + address, []);
						updateLan(address, {
							status: /denied|EACCES|EPERM/i.test(message) ? 'permission-denied' : 'unavailable',
							message,
						});
					}
				);
			} catch (error) {
				updateLan(address, {
					status:
						error instanceof Error && /permission denied|EACCES|EPERM/i.test(error.message)
							? 'permission-denied'
							: 'unavailable',
					message:
						error instanceof Error
							? error.message
							: 'Local discovery unavailable; permissions were not changed.',
				});
			}
		});
		let refreshing = false;
		let peerTailnet: string | undefined;
		let peerScopeChecked = false;
		const refreshTailscale = async () => {
			if (config.tailscale === false) {
				setSource('tailscale', {
					status: 'stopped',
					message: 'Tailscale discovery is disabled for this search.',
				});
				return;
			}
			if (refreshing) return;
			refreshing = true;
			setSource('tailscale', {
				status: 'searching',
				message:
					config.tailscalePeers === true
						? 'Checking consented Tailscale peers directly'
						: 'Reading advertised Maestro Services from your existing Tailscale client',
			});
			try {
				const status = await this.status(search.abort.signal);
				if (search !== this.search) return;
				tailscaleCandidates(status, '[]', this.now());
				let peers: Candidate[] = [];
				if (config.tailscalePeers === true) {
					const discovery = tailscalePeerDiscovery(status, this.now());
					if (peerScopeChecked && discovery.tailnet !== peerTailnet) {
						void this.start({ ...config, tailscalePeers: false });
						return;
					}
					peerTailnet = discovery.tailnet;
					peerScopeChecked = true;
					peers = discovery.candidates;
				}
				// Peer discovery is independent of named-Service support/administration.
				this.publish(search, 'tailscale-peers', peers);
				let advertised: Candidate[] = [];
				let serviceState: SourceState | undefined;
				try {
					const services = await this.services(search.abort.signal);
					if (search !== this.search) return;
					advertised = tailscaleCandidates(status, services, this.now());
				} catch (error) {
					if (search !== this.search) return;
					const failure = error as { status?: SourceState['status']; message?: string };
					serviceState = {
						status: failure.status ?? 'unavailable',
						message: failure.status
							? (failure.message ?? 'Named Services unavailable')
							: 'Named Services unavailable',
					};
				}
				this.publish(search, 'tailscale', advertised);
				setSource(
					'tailscale',
					config.tailscalePeers === true
						? {
								status:
									peers.length || advertised.length ? 'ready' : (serviceState?.status ?? 'empty'),
								message: `Checking ${peers.length} eligible peers on the direct Maestro port; only verified Maestro manifests appear. No Serve, advertising or certificate setup is required.${serviceState ? ' Optional named Services unavailable; direct checks continue.' : ''}`,
							}
						: (serviceState ?? {
								status: advertised.length ? 'ready' : 'empty',
								message: advertised.length
									? 'Advertised Maestro Services found; checking HTTPS compatibility.'
									: 'No advertised Maestro Services. Use Check Tailscale peers to allow fixed HTTPS checks without a named Service.',
							})
				);
			} catch (error) {
				this.publish(search, 'tailscale', []);
				this.publish(search, 'tailscale-peers', []);
				const failure = error as { status?: SourceState['status']; message?: string };
				setSource('tailscale', {
					status: failure.status ?? 'unavailable',
					message:
						failure.message ??
						'Tailscale service discovery unavailable. Use a host invitation or manual connection.',
				});
			} finally {
				refreshing = false;
			}
		};
		let ticks = 0;
		this.timer = setInterval(() => {
			if (search !== this.search) return;
			this.schedule(search);
			this.changed();
			if (++ticks % 30 !== 0) return;
			if (config.lan !== false && !config.interfaceAddress) {
				try {
					if (
						this.interfaces()
							.map((item) => item.address)
							.sort()
							.join(',') !== fingerprint
					) {
						void this.start({ ...this.config, tailscalePeers: false });
						return;
					}
				} catch {
					/* Preserve working adapters; do not infer a network change. */
				}
			}
			void refreshTailscale();
		}, 1000);
		this.changed();
		await Promise.all([...starts, refreshTailscale()]);
	}
	async importInvitation(text: string): Promise<void> {
		const row = parseInvitation(text, this.now());
		if (!this.search) await this.start(this.config);
		if (!this.search) throw new Error('Discovery stopped before invitation import');
		this.publish(this.search, 'invitation:' + row.endpoint, [row]);
		this.state.sources.cloudflare = {
			status: 'ready',
			message:
				'Host invitation imported as an expiring location hint. Checking HTTPS; PIN and normal login remain separate.',
		};
		this.changed();
	}
	stop(): void {
		this.state.generation++;
		this.state.running = false;
		this.search?.abort.abort();
		this.search = undefined;
		for (const adapter of this.adapters) adapter.stop();
		this.adapters = [];
		clearInterval(this.timer);
		this.rows.clear();
		this.state.sources = {
			lan: { status: 'stopped', message: 'Local discovery stopped.' },
			tailscale: { status: 'stopped', message: 'Tailscale discovery stopped.' },
			cloudflare: invitationState,
		};
		this.networkChanged();
		this.changed();
	}
}
