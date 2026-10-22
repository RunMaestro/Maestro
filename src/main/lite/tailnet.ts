import { networkInterfaces } from 'node:os';
import { readTailscaleStatus } from './discovery/tailscale';
import { directTailnetOrigin, tailnetIPv4, TAILNET_PORT } from './tailnet-origin';

export interface TailnetState {
	device: string;
	address: string;
	tailnet: string;
	peers: Set<string>;
	peerIds: Map<string, string>;
	checkedAt: number;
}
/** Read the local authenticated daemon, never a remote manifest, to authorize a destination/interface. */
export function parseTailnetState(text: string): TailnetState {
	if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new Error('Tailscale status is too large.');
	const status = JSON.parse(text);
	const self = status?.Self,
		suffix = status?.CurrentTailnet?.MagicDNSSuffix;
	const address = self?.TailscaleIPs?.find(tailnetIPv4);
	if (
		status?.BackendState !== 'Running' ||
		self?.Online === false ||
		self?.Expired === true ||
		typeof self?.ID !== 'string' ||
		!self.ID ||
		typeof suffix !== 'string' ||
		!suffix.endsWith('.ts.net') ||
		!address
	)
		throw new Error('Open Tailscale and connect this device before enabling Maestro access.');
	const peers = new Set<string>([address]);
	const peerIds = new Map<string, string>([[address, self.ID]]);
	for (const peer of Object.values(status.Peer ?? {}) as Array<any>) {
		if (
			!peer ||
			peer.Online !== true ||
			peer.Expired === true ||
			peer.InNetworkMap === false ||
			typeof peer.ID !== 'string' ||
			!peer.ID ||
			typeof peer.DNSName !== 'string' ||
			!peer.DNSName.replace(/\.$/, '').endsWith('.' + suffix)
		)
			continue;
		for (const ip of peer.TailscaleIPs ?? [])
			if (tailnetIPv4(ip)) {
				peers.add(ip);
				peerIds.set(ip, peer.ID);
			}
	}
	return { device: self.ID, address, tailnet: suffix, peers, peerIds, checkedAt: Date.now() };
}
export async function readTailnet(signal: AbortSignal): Promise<TailnetState> {
	const state = parseTailnetState(await readTailscaleStatus(signal));
	if (
		!Object.values(networkInterfaces())
			.flat()
			.some((row) => row?.address === state.address)
	)
		throw new Error(
			'The Tailscale interface is unavailable. No ordinary-network fallback is allowed.'
		);
	return state;
}
export async function tailnetDestination(
	origin: string,
	signal: AbortSignal
): Promise<{
	hostname: string;
	port: number;
	localAddress: string;
	device: string;
	tailnet: string;
	peerId: string;
}> {
	const url = new URL(directTailnetOrigin(origin));
	const state = await readTailnet(signal);
	if (!state.peers.has(url.hostname))
		throw new Error('This host is not an online peer in the current Tailscale network.');
	return {
		hostname: url.hostname,
		port: TAILNET_PORT,
		localAddress: state.address,
		device: state.device,
		tailnet: state.tailnet,
		peerId: state.peerIds.get(url.hostname)!,
	};
}
