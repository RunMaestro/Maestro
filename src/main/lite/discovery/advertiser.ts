import { createSocket, type Socket } from 'node:dgram';
import { isIPv4 } from 'node:net';
import * as dns from 'dns-packet';
import { advertisement, SERVICE } from './mdns';
/** Opt-in advertisement for an already configured HTTPS endpoint. No endpoint/listener provisioning. */
export class MdnsAdvertiser {
	private socket?: Socket;
	private timers: NodeJS.Timeout[] = [];
	constructor(
		private sockets: () => Socket = () => createSocket({ type: 'udp4', reuseAddr: true })
	) {}
	start(
		address: string,
		id: string,
		name: string,
		endpoint: string,
		failed: (message: string) => void
	): void {
		if (!isIPv4(address) || address === '0.0.0.0')
			throw new Error('Choose an explicit IPv4 multicast interface');
		this.stop();
		const packet = advertisement(id, name, endpoint);
		const goodbye = advertisement(id, name, endpoint, 0);
		const records = dns.decode(packet).answers!;
		const unique = records.filter((r) => r.type !== 'PTR');
		const instance = id + '.' + SERVICE;
		const socket = this.sockets();
		this.socket = socket;
		let announced = false;
		const send = (bytes: Buffer) =>
			socket.send(bytes, 5353, '224.0.0.251', (error) => {
				if (error && this.socket === socket) {
					this.stop();
					failed('LAN advertisement failed');
				}
			});
		const later = (fn: () => void, ms: number) => {
			this.timers.push(
				setTimeout(() => {
					if (this.socket === socket) fn();
				}, ms)
			);
		};
		socket.on('error', () => {
			if (this.socket !== socket) return;
			this.stop();
			failed('LAN advertisement unavailable');
		});
		socket.on('message', (bytes) => {
			if (bytes.length > 9000 || this.socket !== socket) return;
			let received: dns.Packet;
			try {
				received = dns.decode(bytes);
			} catch {
				return;
			}
			for (const r of [...(received.answers ?? []), ...(received.authorities ?? [])]) {
				const ours = unique.find(
					(u) => u.name.toLowerCase() === r.name?.toLowerCase() && u.type === r.type
				);
				if (ours && JSON.stringify(ours.data) !== JSON.stringify(r.data)) {
					this.stop();
					failed('DNS-SD instance conflict; advertisement stopped');
					return;
				}
			}
			if (
				announced &&
				received.type === 'query' &&
				received.questions?.some((q) => [SERVICE, instance].includes(q.name.toLowerCase()))
			)
				send(packet);
		});
		this.goodbye = () => {
			if (announced) {
				try {
					socket.send(goodbye, 5353, '224.0.0.251', () => {
						try {
							socket.close();
						} catch {
							/* Closed already. */
						}
					});
					return;
				} catch {
					/* Socket unavailable. */
				}
			}
			try {
				socket.close();
			} catch {
				/* May not be bound. */
			}
		};
		try {
			socket.bind(5353, '0.0.0.0', () => {
				if (this.socket !== socket) return;
				try {
					socket.addMembership('224.0.0.251', address);
					socket.setMulticastInterface(address);
					socket.setMulticastTTL(255);
				} catch {
					this.stop();
					failed('LAN advertisement unavailable on selected interface');
					return;
				}
				const probe = dns.encode({
					type: 'query',
					questions: [{ name: instance, type: 'ANY' }],
					authorities: unique,
				});
				for (let i = 0; i < 3; i++) later(() => send(probe), 250 * i + 250);
				const announce = () => {
					announced = true;
					send(packet);
					later(announce, 60000);
				};
				later(announce, 1000);
				later(() => send(packet), 2000);
			});
		} catch {
			this.stop();
			failed('LAN advertisement unavailable on selected interface');
		}
	}
	private goodbye?: () => void;
	stop(): void {
		this.socket = undefined;
		for (const timer of this.timers) clearTimeout(timer);
		this.timers = [];
		const goodbye = this.goodbye;
		this.goodbye = undefined;
		goodbye?.();
	}
}
