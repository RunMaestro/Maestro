/**
 * Local network address watcher for the Electron main process.
 *
 * Why this exists: the web server binds `0.0.0.0`, so it keeps serving after
 * the machine moves between networks - but the URL and QR code we show the
 * user are built from the LAN IP detected once at `start()`. Roam from home
 * WiFi to a hotspot and the panel still advertises the old subnet, so the
 * phone that scans the QR can never reach the app. Until now the only fix was
 * toggling Live off and on.
 *
 * Detection is a poll of `os.networkInterfaces()` rather than an OS event,
 * because Electron's main process has no network-change signal (Chromium's
 * NetworkChangeNotifier only reaches renderers, and `navigator.onLine` says
 * nothing about *which* address we got). The poll compares a cheap fingerprint
 * of the non-internal IPv4 addresses; only when that string moves do we pay
 * for the real route lookup in `getLocalIpAddress()`.
 *
 * `check()` is also called on `powerMonitor` resume: a laptop that woke up on
 * a different network should be correct before the user looks at the panel,
 * not up to one poll interval later.
 */

import type { MainLogLevel } from '../../shared/logger-types';
import { getIpv4InterfaceFingerprint, getLocalIpAddress } from './networkUtils';

/**
 * Poll cadence. Short enough that walking between networks fixes itself before
 * the user reaches for the QR code, cheap enough to ignore: the tick is one
 * `getifaddrs()` and a string compare, and the expensive route lookup only
 * runs when the fingerprint actually moved.
 */
export const NETWORK_ADDRESS_POLL_INTERVAL_MS = 5_000;

export interface NetworkAddressChange {
	previousAddress: string;
	address: string;
}

export interface NetworkAddressWatcher {
	start(): void;
	stop(): void;
	/**
	 * Run one detection pass now instead of waiting for the next tick. Resolves
	 * with the change, or `null` when the addresses did not move.
	 */
	check(): Promise<NetworkAddressChange | null>;
	/** Address the watcher last resolved. */
	currentAddress(): string;
}

export interface NetworkAddressWatcherOptions {
	/** Address the owner already resolved, so the first tick is not a false change. */
	initialAddress: string;
	onChange?: (change: NetworkAddressChange) => void;
	onLog?: (level: MainLogLevel, message: string) => void;
	intervalMs?: number;
	/** Test seam: overrides the interface fingerprint lookup. */
	readFingerprint?: () => string;
	/** Test seam: overrides the routed-address lookup. */
	resolveAddress?: () => Promise<string>;
}

export function createNetworkAddressWatcher(
	options: NetworkAddressWatcherOptions
): NetworkAddressWatcher {
	const {
		initialAddress,
		onChange,
		onLog,
		intervalMs = NETWORK_ADDRESS_POLL_INTERVAL_MS,
		readFingerprint = getIpv4InterfaceFingerprint,
		resolveAddress = getLocalIpAddress,
	} = options;

	let address = initialAddress;
	let fingerprint = readFingerprint();
	let timer: ReturnType<typeof setInterval> | null = null;
	// The route lookup is async, so a slow resolve plus a fast tick could run
	// two passes at once and report the changes out of order.
	let inFlight: Promise<NetworkAddressChange | null> | null = null;

	async function runCheck(): Promise<NetworkAddressChange | null> {
		const nextFingerprint = readFingerprint();
		if (nextFingerprint === fingerprint) return null;

		// Adopt the fingerprint before resolving: an interface that flaps back
		// mid-lookup should be caught by the next tick, not skipped because we
		// still hold the pre-flap value.
		fingerprint = nextFingerprint;

		let resolved: string;
		try {
			resolved = await resolveAddress();
		} catch (err) {
			// A transient failure (no route at all mid-switch) is expected while
			// the interface settles. Re-arm by dropping the fingerprint so the
			// next tick retries instead of treating this state as current.
			fingerprint = '';
			onLog?.('warn', `[Network] Failed to resolve local address after interface change: ${err}`);
			return null;
		}

		if (resolved === address) return null;

		const previousAddress = address;
		address = resolved;

		const change: NetworkAddressChange = { previousAddress, address: resolved };
		onLog?.('info', `[Network] Local address changed: ${previousAddress} -> ${resolved}`);
		onChange?.(change);
		return change;
	}

	function check(): Promise<NetworkAddressChange | null> {
		if (inFlight) return inFlight;
		inFlight = runCheck().finally(() => {
			inFlight = null;
		});
		return inFlight;
	}

	return {
		start() {
			if (timer) return;
			timer = setInterval(() => void check(), intervalMs);
			// Never hold the process open for an address poll.
			timer.unref?.();
		},

		stop() {
			if (timer) {
				clearInterval(timer);
				timer = null;
			}
		},

		check,
		currentAddress: () => address,
	};
}
