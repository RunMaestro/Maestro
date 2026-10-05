import { execFile } from 'node:child_process';
import { TAILNET_PORT, tailnetIPv4 } from '../tailnet-origin';
import { candidate, displayName, type Candidate, type SourceState } from './types';
import { tailscaleExecutable } from './tailscale-command';

export type StatusReader = (signal: AbortSignal) => Promise<string>;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_HOSTS = 32;
const MAX_PORTS = 4;

class TailscaleDiscoveryError extends Error {
	constructor(
		public readonly status: SourceState['status'],
		message: string,
		public readonly code?: string
	) {
		super(message);
		this.name = 'TailscaleDiscoveryError';
	}
}

function commandError(error: unknown, stderr: string, signal: AbortSignal): Error {
	if (signal.aborted) return new TailscaleDiscoveryError('stopped', 'Tailscale discovery stopped');
	const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
	const message = error instanceof Error ? error.message : '';
	// Inspect only to classify; never expose daemon output, paths or credentials.
	const diagnostic = stderr + '\n' + message;
	if (
		code === 'EACCES' ||
		code === 'EPERM' ||
		/permission denied|access denied|access is denied|forbidden|unauthorized|operation not permitted/i.test(
			diagnostic
		)
	)
		return new TailscaleDiscoveryError(
			'permission-denied',
			'Existing Tailscale client access is denied'
		);
	if (code === 'ENOENT')
		return new TailscaleDiscoveryError('unavailable', 'Tailscale is not installed.', 'ENOENT');
	if (
		/unknown (?:command|subcommand)|unrecognized (?:command|subcommand)|flag provided but not defined/i.test(
			diagnostic
		)
	)
		return new TailscaleDiscoveryError(
			'unavailable',
			'Tailscale service discovery is unavailable; use an invitation or manual connection'
		);
	if (
		/not logged in|logged out|needslogin|login required|not running|failed to connect to local|cannot connect|connection refused|no netmap/i.test(
			diagnostic
		)
	)
		return new TailscaleDiscoveryError(
			'offline',
			'Existing Tailscale client is offline or requires login'
		);
	return new TailscaleDiscoveryError(
		'unavailable',
		'Tailscale service discovery could not complete; use an invitation or manual connection'
	);
}

/** Existing CLI owns platform-specific daemon IPC/auth; no configuration or credential reads. */
function readCommand(args: string[], signal: AbortSignal): Promise<string> {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	try {
		execFile(
			tailscaleExecutable(),
			args,
			{ signal, timeout: 5000, maxBuffer: MAX_BYTES, windowsHide: true },
			(error, stdout, stderr) => {
				if (error) reject(commandError(error, stderr, signal));
				else if (signal.aborted) reject(commandError(undefined, '', signal));
				else resolve(stdout);
			}
		);
	} catch (error) {
		reject(commandError(error, '', signal));
	}
	return promise;
}

export const readTailscaleStatus: StatusReader = (signal) =>
	readCommand(['status', '--json'], signal);
/** Named Services must already be advertised and administratively approved. */
export const readTailscaleServices: StatusReader = (signal) =>
	readCommand(['service', 'list', '--json'], signal);

function parseJson(json: string): unknown {
	if (Buffer.byteLength(json) > MAX_BYTES)
		throw new TailscaleDiscoveryError('unavailable', 'Tailscale discovery metadata is too large');
	try {
		return JSON.parse(json);
	} catch {
		throw new TailscaleDiscoveryError(
			'unavailable',
			'Tailscale discovery metadata is incompatible'
		);
	}
}

function record(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hostname(value: unknown): string | undefined {
	if (typeof value !== 'string' || value.length > 254) return undefined;
	const name = value.replace(/\.$/, '').toLowerCase();
	const labels = name.split('.');
	if (
		labels.length < 2 ||
		labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
	)
		return undefined;
	if (labels.every((label) => /^\d+$/.test(label))) return undefined;
	return name;
}

function runningStatus(json: string): Record<string, unknown> {
	const status = parseJson(json);
	if (!record(status))
		throw new TailscaleDiscoveryError('unavailable', 'Tailscale status metadata is incompatible');
	if (status.BackendState !== 'Running')
		throw new TailscaleDiscoveryError(
			'offline',
			'Existing Tailscale client is offline or requires login'
		);
	return status;
}
function tailnetSuffix(status: Record<string, unknown>): string | undefined {
	const value = record(status.CurrentTailnet) ? status.CurrentTailnet.MagicDNSSuffix : undefined;
	const suffix = value === undefined || value === '' ? undefined : hostname(value);
	if (value !== undefined && value !== '' && !suffix)
		throw new TailscaleDiscoveryError('unavailable', 'Tailscale DNS metadata is incompatible');
	return suffix;
}

export function tailscaleCandidates(
	statusJson: string,
	servicesJson: string,
	now = Date.now()
): Candidate[] {
	const status = runningStatus(statusJson);
	const services = parseJson(servicesJson);
	if (!Array.isArray(services))
		throw new TailscaleDiscoveryError(
			'unavailable',
			'Tailscale named service metadata is incompatible'
		);
	const suffix = tailnetSuffix(status);
	const rows: Candidate[] = [];
	const hosts = new Map<string, Set<number>>();
	for (const service of services) {
		if (
			!record(service) ||
			typeof service.Name !== 'string' ||
			!/^svc:maestro(?:-[a-z0-9](?:[a-z0-9-]{0,54}[a-z0-9])?)?$/.test(service.Name)
		)
			continue;
		const host = hostname(service.Hostname);
		if (!host || (suffix && host !== service.Name.slice(4) + '.' + suffix)) continue;
		if (!Array.isArray(service.Ports)) continue;
		let ports = hosts.get(host);
		if (!ports) {
			if (hosts.size >= MAX_HOSTS) continue;
			ports = new Set<number>();
			hosts.set(host, ports);
		}
		let name = service.Name.slice(4);
		try {
			name = displayName(service.DisplayName);
		} catch {
			/* Bounded service name is the fallback. */
		}
		for (const advertised of service.Ports) {
			if (ports.size >= MAX_PORTS) break;
			if (typeof advertised !== 'string' || !/^tcp:[1-9][0-9]{0,4}$/.test(advertised)) continue;
			const port = Number(advertised.slice(4));
			if (port > 65535 || ports.has(port)) continue;
			ports.add(port);
			const row = candidate(
				service.Name.slice(4),
				name,
				'https://' + host + ':' + port,
				'tailscale',
				now + 60000
			);
			row.identityHint = undefined;
			rows.push(row);
		}
	}
	return rows;
}

/** Peers are location hints, never Maestro advertisements or authenticated identities. */
export function tailscalePeerDiscovery(
	statusJson: string,
	now = Date.now()
): { tailnet?: string; candidates: Candidate[] } {
	const status = runningStatus(statusJson);
	const suffix = tailnetSuffix(status);
	if (!suffix || !suffix.endsWith('.ts.net') || !record(status.Peer))
		return { tailnet: suffix, candidates: [] };
	const self = record(status.Self) ? status.Self : undefined;
	const rows: Candidate[] = [];
	const hosts = new Set<string>();
	for (const peer of Object.values(status.Peer)) {
		if (rows.length >= MAX_HOSTS) break;
		if (
			!record(peer) ||
			peer.Online !== true ||
			peer.Expired === true ||
			peer.InNetworkMap === false ||
			typeof peer.ID !== 'string' ||
			!/^[a-zA-Z0-9_-]{1,80}$/.test(peer.ID) ||
			peer.ID === self?.ID
		)
			continue;
		const host = hostname(peer.DNSName);
		if (
			!host ||
			host === hostname(self?.DNSName) ||
			!host.endsWith('.' + suffix) ||
			host.slice(0, -suffix.length - 1).includes('.') ||
			hosts.has(host)
		)
			continue;
		const address = Array.isArray(peer.TailscaleIPs)
			? peer.TailscaleIPs.find(tailnetIPv4)
			: undefined;
		if (!address) continue;
		hosts.add(host);
		const row = candidate(
			'peer-' + peer.ID,
			host.split('.')[0],
			'http://' + address + ':' + TAILNET_PORT,
			'tailscale',
			now + 60000
		);
		row.identityHint = undefined;
		row.peerId = peer.ID;
		row.requiresManifest = true;
		rows.push(row);
	}
	return { tailnet: suffix, candidates: rows };
}
