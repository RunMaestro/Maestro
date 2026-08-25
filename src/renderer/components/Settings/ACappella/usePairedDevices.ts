/**
 * State for the paired-devices panel: the device list, the pairing window, and
 * the ICE configuration.
 *
 * Everything here is a view of main-process state rather than a copy of it. The
 * device list, the pairing request, and the connection quality all change
 * without the panel doing anything - a phone connects, a peer renegotiates, a
 * revocation lands - so the panel subscribes and repaints instead of caching. A
 * settings pane that showed a device as connected because that was true when it
 * opened would be lying at exactly the moment somebody is trying to revoke it.
 *
 * The ICE settings are the exception: they are the user's own configuration and
 * live in the same `acappella` blob everything else does, read-modify-written
 * whole for the reason spelled out in `useVoiceControls.ts`.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import type { IceProbeResult } from '../../../../shared/acappella/webrtc-host';

/** Settings key holding everything A Cappella persists. Mirrors the main-side constant. */
const ACAPPELLA_SETTINGS_KEY = 'acappella';

type DeviceApi = NonNullable<Window['maestro']>['voice']['devices'];
export type DeviceStatus = Awaited<ReturnType<DeviceApi['list']>>[number];
export type PairingPayload = NonNullable<Awaited<ReturnType<DeviceApi['startPairing']>>>;
export type PairingRequest = NonNullable<
	Awaited<ReturnType<DeviceApi['pairingStatus']>>['request']
>;
export type DiscoveryStatus = NonNullable<
	Awaited<ReturnType<DeviceApi['pairingStatus']>>['discovery']
>;
export type IceSettings = Awaited<ReturnType<DeviceApi['iceSettings']>>['settings'];

export interface PairedDevices {
	devices: DeviceStatus[];
	/** The open pairing window, or null when nobody is pairing. */
	pairing: PairingPayload | null;
	/** A device waiting for a human to approve it. */
	request: PairingRequest | null;
	discovery: DiscoveryStatus | null;
	manualHint: string;
	ice: IceSettings | null;
	/** One sentence about what this ICE configuration can actually reach. */
	reach: string;
	/** Why the Cloudflare tunnel is not the media path. Copy, not a warning. */
	tunnelNote: string;
	/** The last Test Connection verdict, or null before one has been run. */
	probe: IceProbeResult | null;
	testing: boolean;
	loaded: boolean;

	startPairing: () => Promise<void>;
	cancelPairing: () => Promise<void>;
	approve: (requestId: string, name?: string) => Promise<void>;
	deny: (requestId: string) => Promise<void>;
	rename: (deviceId: string, name: string) => Promise<void>;
	revoke: (deviceId: string) => Promise<void>;
	forget: (deviceId: string) => Promise<void>;
	revokeAll: () => Promise<void>;
	disconnectAll: () => Promise<void>;
	setDiscovery: (enabled: boolean) => Promise<void>;
	updateIce: (patch: Partial<IceSettings>) => Promise<void>;
	testConnection: () => Promise<void>;
}

interface StoredBlob {
	ice?: unknown;
	[key: string]: unknown;
}

export function usePairedDevices(enabled: boolean): PairedDevices {
	const [devices, setDevices] = useState<DeviceStatus[]>([]);
	const [pairing, setPairing] = useState<PairingPayload | null>(null);
	const [request, setRequest] = useState<PairingRequest | null>(null);
	const [discovery, setDiscovery] = useState<DiscoveryStatus | null>(null);
	const [manualHint, setManualHint] = useState('');
	const [ice, setIce] = useState<IceSettings | null>(null);
	const [reach, setReach] = useState('');
	const [tunnelNote, setTunnelNote] = useState('');
	const [probe, setProbe] = useState<IceProbeResult | null>(null);
	const [testing, setTesting] = useState(false);
	const [loaded, setLoaded] = useState(false);

	const api = window.maestro?.voice?.devices;

	const refreshDevices = useCallback(async () => {
		if (!api) return;
		setDevices(await api.list().catch(() => []));
	}, [api]);

	const refreshPairing = useCallback(async () => {
		if (!api) return;
		const status = await api.pairingStatus().catch(() => null);
		if (!status) return;
		setPairing(status.payload);
		setRequest(status.request);
		setDiscovery(status.discovery);
		setManualHint(status.manualHint);
	}, [api]);

	const refreshIce = useCallback(async () => {
		if (!api) return;
		const result = await api.iceSettings().catch(() => null);
		if (!result) return;
		setIce(result.settings);
		setReach(result.reach);
		setTunnelNote(result.tunnelNote);
		if (result.discovery) setDiscovery(result.discovery);
	}, [api]);

	useEffect(() => {
		let cancelled = false;
		void (async () => {
			await Promise.all([refreshDevices(), refreshPairing(), refreshIce()]);
			if (!cancelled) setLoaded(true);
		})();
		return () => {
			cancelled = true;
		};
	}, [refreshDevices, refreshIce, refreshPairing, enabled]);

	// A device connecting, a peer renegotiating, and a revocation landing all
	// change this list without the panel asking, so it follows the broadcast
	// rather than polling.
	useEffect(() => {
		if (!api) return;
		const stopDevices = api.onChanged(() => void refreshDevices());
		const stopRequests = api.onPairingRequest((next) => {
			setRequest(next);
			void refreshPairing();
		});
		return () => {
			stopDevices();
			stopRequests();
		};
	}, [api, refreshDevices, refreshPairing]);

	// A pairing code expires on its own, so the panel has to notice rather than
	// leaving a dead QR code on screen for somebody to photograph.
	useEffect(() => {
		if (!pairing) return;
		const remaining = pairing.expiresAt - Date.now();
		if (remaining <= 0) {
			setPairing(null);
			return;
		}
		const timer = setTimeout(() => void refreshPairing(), remaining + 100);
		return () => clearTimeout(timer);
	}, [pairing, refreshPairing]);

	const persistIce = useCallback(async (next: IceSettings) => {
		const stored = ((await window.maestro.settings.get(ACAPPELLA_SETTINGS_KEY)) ??
			{}) as StoredBlob;
		await window.maestro.settings.set(ACAPPELLA_SETTINGS_KEY, { ...stored, ice: next });
	}, []);

	const actions = useMemo(
		() => ({
			startPairing: async () => {
				if (!api) return;
				setPairing(await api.startPairing().catch(() => null));
				await refreshPairing();
			},
			cancelPairing: async () => {
				await api?.cancelPairing().catch(() => undefined);
				setPairing(null);
				setRequest(null);
			},
			approve: async (requestId: string, name?: string) => {
				await api?.approve(requestId, name).catch(() => false);
				setRequest(null);
				setPairing(null);
				await refreshDevices();
			},
			deny: async (requestId: string) => {
				await api?.deny(requestId).catch(() => undefined);
				setRequest(null);
				setPairing(null);
			},
			rename: async (deviceId: string, name: string) => {
				await api?.rename(deviceId, name).catch(() => false);
				await refreshDevices();
			},
			revoke: async (deviceId: string) => {
				await api?.revoke(deviceId).catch(() => false);
				await refreshDevices();
			},
			forget: async (deviceId: string) => {
				await api?.forget(deviceId).catch(() => false);
				await refreshDevices();
			},
			revokeAll: async () => {
				await api?.revokeAll().catch(() => 0);
				await refreshDevices();
			},
			disconnectAll: async () => {
				await api?.disconnectAll().catch(() => undefined);
				await refreshDevices();
			},
			setDiscovery: async (value: boolean) => {
				const status = await api?.setDiscovery(value).catch(() => null);
				if (status) setDiscovery(status);
			},
		}),
		[api, refreshDevices, refreshPairing]
	);

	const updateIce = useCallback(
		async (patch: Partial<IceSettings>) => {
			if (!ice) return;
			const next = { ...ice, ...patch };
			setIce(next);
			await persistIce(next);
			await refreshIce();
		},
		[ice, persistIce, refreshIce]
	);

	const testConnection = useCallback(async () => {
		if (!api) return;
		setTesting(true);
		setProbe(null);
		try {
			setProbe(await api.testConnection());
		} finally {
			setTesting(false);
		}
	}, [api]);

	return {
		devices,
		pairing,
		request,
		discovery,
		manualHint,
		ice,
		reach,
		tunnelNote,
		probe,
		testing,
		loaded,
		...actions,
		updateIce,
		testConnection,
	};
}
