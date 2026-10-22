declare module 'dns-packet' {
	export interface Record {
		name: string;
		type: string;
		ttl?: number;
		flush?: boolean;
		data: unknown;
	}
	export interface Packet {
		type?: string;
		flags?: number;
		questions?: { name: string; type: string }[];
		answers?: Record[];
		additionals?: Record[];
		authorities?: Record[];
	}
	export function encode(packet: Packet): Buffer;
	export function decode(packet: Uint8Array): Packet;
}
