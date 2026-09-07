/**
 * Zero-config LAN discovery: a Bonjour `_maestro._tcp` advert so a phone on the
 * same network finds this desktop without anybody typing an IP address.
 *
 * Three things this module is careful about.
 *
 * **It is optional in both directions.** The advert is a convenience, not the
 * connection. Every path it shortcuts is reachable by scanning the QR code,
 * which carries the host candidates and the port directly, or by typing a host
 * name. So an environment with no mDNS responder available degrades to "manual
 * entry", which is a slightly worse first-run experience rather than a broken
 * feature. `{@link DiscoveryService.status}` says which of those you are in, out
 * loud, because a user who cannot see their Mac in a list needs to know whether
 * to fix their network or just type an address.
 *
 * **It is off-switchable, and the switch is real.** Broadcasting the machine
 * name and a port to every device on a network is a disclosure. Some people are
 * on networks where they do not want to make it. Turning it off stops the advert
 * entirely rather than hiding it from a UI.
 *
 * **It advertises no secret.** The TXT record carries the app version, the
 * protocol version, and the pairing fingerprint. It does NOT carry the server
 * token or a pairing code: an advert is readable by everything on the network,
 * so anything in it is public by construction.
 *
 * The mDNS responder itself arrives through {@link MdnsResponderFactory}. The
 * default loader tries the optional `bonjour-service` package and reports its
 * absence rather than failing: a pure-JavaScript multicast responder is not a
 * dependency worth forcing on every Maestro install for a feature most users
 * will never turn on.
 */

import { DEVICE_PROTOCOL_VERSION } from '../../../shared/acappella/device-protocol';
import { logger } from '../../utils/logger';

const LOG_CONTEXT = 'ACappella';

/** The service type a Maestro desktop advertises itself under. */
export const MAESTRO_SERVICE_TYPE = 'maestro';
export const MAESTRO_SERVICE_PROTOCOL = 'tcp';

/** The full name, as it appears on the wire and in every discovery tool. */
export const MAESTRO_SERVICE_FQDN = `_${MAESTRO_SERVICE_TYPE}._${MAESTRO_SERVICE_PROTOCOL}`;

/** What goes in the TXT record. Public by construction: an advert is readable by all. */
export interface DiscoveryTxtRecord {
	/** Maestro's version, so a device can say what it found. */
	version: string;
	/** The A Cappella device protocol version, so an old client fails early. */
	proto: string;
	/** The pairing fingerprint, so the user can confirm they found the right Mac. */
	fingerprint: string;
	/** Human name of this desktop. */
	host: string;
}

/** The one verb an mDNS library has to provide for this to work. */
export interface MdnsAdvertisement {
	stop(): void | Promise<void>;
}

export interface MdnsResponder {
	publish(options: {
		name: string;
		type: string;
		protocol: 'tcp' | 'udp';
		port: number;
		txt: Record<string, string>;
	}): MdnsAdvertisement;
	destroy?(): void | Promise<void>;
}

export type MdnsResponderFactory = () => Promise<MdnsResponder | null>;

export type DiscoveryStatus =
	/** Off by user choice. */
	| { state: 'disabled' }
	/** Advertising right now. */
	| { state: 'advertising'; name: string; port: number }
	/**
	 * No responder is available on this machine, so nothing is being advertised.
	 * The QR code and manual host entry still work; this is the sentence that says
	 * so instead of leaving a user staring at an empty device list.
	 */
	| { state: 'unavailable'; reason: string }
	/** The responder was there and publishing failed anyway. */
	| { state: 'error'; message: string };

export interface DiscoveryServiceOptions {
	/** The port the signaling WebSocket is served on. */
	getPort: () => number | null;
	/** Display name of this desktop. */
	getName: () => string;
	getAppVersion: () => string;
	/** The pairing fingerprint, so a discovered host can be verified. */
	getFingerprint: () => string;
	/** Injectable for tests, and for anyone who wants a different responder. */
	createResponder?: MdnsResponderFactory;
}

/**
 * The default loader.
 *
 * A non-literal specifier so the bundler leaves the import alone and so a build
 * without the optional package still type-checks. Its absence is a reported
 * status, never a throw: this runs during app startup, and a missing optional
 * discovery library must not be able to stop Maestro from booting.
 */
export const loadOptionalBonjour: MdnsResponderFactory = async () => {
	const specifier = 'bonjour-service';
	try {
		const mod = (await import(/* @vite-ignore */ specifier)) as {
			Bonjour?: new () => MdnsResponder;
			default?: new () => MdnsResponder;
		};
		const Ctor = mod.Bonjour ?? mod.default;
		if (!Ctor) return null;
		return new Ctor();
	} catch {
		return null;
	}
};

export class DiscoveryService {
	private readonly options: DiscoveryServiceOptions;
	private responder: MdnsResponder | null = null;
	private advertisement: MdnsAdvertisement | null = null;
	private state: DiscoveryStatus = { state: 'disabled' };
	/** Serialises start/stop so a fast toggle cannot leave two adverts running. */
	private queue: Promise<void> = Promise.resolve();

	constructor(options: DiscoveryServiceOptions) {
		this.options = options;
	}

	get status(): DiscoveryStatus {
		return this.state;
	}

	/**
	 * Publish the advert. Idempotent: a second call with the advert already up
	 * republishes it, which is what a port change needs.
	 */
	start(): Promise<void> {
		return this.enqueue(async () => {
			await this.stopInternal();

			const port = this.options.getPort();
			if (!port) {
				this.state = {
					state: 'unavailable',
					reason: 'The Maestro web server is not running, so there is no port to advertise.',
				};
				return;
			}

			const factory = this.options.createResponder ?? loadOptionalBonjour;
			this.responder = await factory();
			if (!this.responder) {
				this.state = {
					state: 'unavailable',
					reason:
						'No mDNS responder is available in this build, so Maestro is not advertising itself. ' +
						'Scan the pairing QR code, or enter the address of this computer on the device instead.',
				};
				return;
			}

			const name = this.options.getName();
			const txt: DiscoveryTxtRecord = {
				version: this.options.getAppVersion(),
				proto: String(DEVICE_PROTOCOL_VERSION),
				fingerprint: this.options.getFingerprint(),
				host: name,
			};

			try {
				this.advertisement = this.responder.publish({
					name,
					type: MAESTRO_SERVICE_TYPE,
					protocol: MAESTRO_SERVICE_PROTOCOL,
					port,
					txt: { ...txt },
				});
				this.state = { state: 'advertising', name, port };
				logger.info(
					`Advertising ${MAESTRO_SERVICE_FQDN} as '${name}' on port ${port}`,
					LOG_CONTEXT
				);
			} catch (error) {
				this.state = { state: 'error', message: (error as Error).message };
				logger.warn(`Bonjour advert failed: ${(error as Error).message}`, LOG_CONTEXT);
			}
		});
	}

	/** Take the advert down. Safe when nothing is up. */
	stop(): Promise<void> {
		return this.enqueue(async () => {
			await this.stopInternal();
			this.state = { state: 'disabled' };
		});
	}

	private async stopInternal(): Promise<void> {
		try {
			await this.advertisement?.stop();
			await this.responder?.destroy?.();
		} catch (error) {
			// A responder that will not shut down cleanly is not a reason to keep the
			// caller waiting or to fail a settings toggle.
			logger.warn(`Bonjour teardown failed: ${(error as Error).message}`, LOG_CONTEXT);
		}
		this.advertisement = null;
		this.responder = null;
	}

	private enqueue(action: () => Promise<void>): Promise<void> {
		const next = this.queue.then(action).catch((error: Error) => {
			this.state = { state: 'error', message: error.message };
		});
		this.queue = next;
		return next;
	}
}

/**
 * The address a user types when discovery is unavailable or switched off.
 *
 * Returned as a list because a machine on WiFi and an overlay network has more
 * than one right answer, and the phone knows which network it is on better than
 * the desktop does.
 */
export function manualEntryHint(hosts: string[], port: number | null): string {
	if (!port) return 'Start the Maestro web server to pair a device manually.';
	if (hosts.length === 0)
		return `Enter the address of this computer and port ${port} on the device.`;
	return `Enter ${hosts.map((host) => `${host}:${port}`).join(' or ')} on the device.`;
}
