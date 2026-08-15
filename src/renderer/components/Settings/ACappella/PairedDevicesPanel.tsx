/**
 * Paired Devices: which phones may hold this computer's microphone, and how they
 * get here.
 *
 * The panel is arranged around the four questions a person actually has:
 *
 *   - **How do I add one?** A QR code with a live pairing status, and an
 *     approval step on THIS screen. The approval is not a formality: a pairing
 *     code is short enough to be read over a shoulder, so knowing it buys a row
 *     in a dialog and nothing else.
 *   - **What is connected, and how?** Each device shows its name, platform, last
 *     connection, live state, and the ICE candidate type that actually won, in
 *     plain words: LAN, through NAT, or relayed. "Relayed" is the one that costs
 *     latency and somebody's bandwidth, so it is said rather than hidden.
 *   - **How do I stop one?** Revoke, per device, effective on a LIVE connection.
 *     Plus one control that drops everything at once.
 *   - **Why will this not connect from outside?** The reach line and the tunnel
 *     note, stated as facts. The Cloudflare quick tunnel that serves the browser
 *     interface cannot carry this audio, and a user who does not know that will
 *     blame the wrong thing every time.
 */

import { useCallback, useState } from 'react';
import { Check, Radio, Smartphone, Trash2, Wifi, X } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';

import type { DeviceCandidateType } from '../../../../shared/acappella/device-protocol';
import { formatRelativeTime } from '../../../../shared/formatters';
import type { Theme } from '../../../types';
import { ToggleSwitch } from '../../ui/ToggleSwitch';
import { SettingsSectionHeading } from '../SettingsSectionHeading';
import { SectionCard } from '../tabs/DisplayTab/components/SectionCard';
import { usePairedDevices, type DeviceStatus } from './usePairedDevices';

export interface PairedDevicesPanelProps {
	theme: Theme;
	/** Mirror of the A Cappella Encore flag. */
	enabled: boolean;
}

/**
 * The one sentence about what a paired device can do.
 *
 * Written out rather than implied, because "paired" is a word that hides a
 * capability: this is a device that can open a microphone on this machine and
 * put words in front of your agents.
 */
const CAPABILITY_STATEMENT =
	'A paired device can hold this computer’s microphone, hear replies in your configured voice, ' +
	'and dispatch spoken prompts to your agents. It cannot read your files or change your settings.';

const CANDIDATE_LABELS: Record<DeviceCandidateType, string> = {
	lan: 'Direct (LAN or overlay)',
	stun: 'Direct (through NAT)',
	relay: 'Relayed (TURN)',
	unknown: 'Not connected',
};

export function PairedDevicesPanel({ theme, enabled }: PairedDevicesPanelProps) {
	const devices = usePairedDevices(enabled);
	const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);

	const commitRename = useCallback(async () => {
		if (!renaming) return;
		const { id, value } = renaming;
		setRenaming(null);
		await devices.rename(id, value);
	}, [devices, renaming]);

	const ice = devices.ice;

	return (
		<>
			<SettingsSectionHeading icon={Smartphone}>Paired Devices</SettingsSectionHeading>

			{/* -- Add a device ------------------------------------------------ */}
			<div data-setting-id="encore-a-cappella-paired-devices">
				<SectionCard theme={theme}>
					<div>
						<div className="font-medium text-sm" style={{ color: theme.colors.textMain }}>
							Add a device
						</div>
						<p className="text-xs opacity-70 mt-0.5">{CAPABILITY_STATEMENT}</p>
					</div>

					{!devices.pairing && (
						<button
							type="button"
							disabled={!enabled}
							onClick={() => void devices.startPairing()}
							className="px-2 py-1 rounded border text-xs disabled:opacity-50 self-start"
							style={{ borderColor: theme.colors.accent, color: theme.colors.textMain }}
						>
							Show pairing code
						</button>
					)}

					{devices.pairing && (
						<div className="flex gap-4 items-start">
							<div className="p-2 rounded" style={{ backgroundColor: 'white' }}>
								<QRCodeSVG
									value={JSON.stringify(devices.pairing)}
									size={148}
									bgColor="#FFFFFF"
									fgColor="#000000"
									aria-label="A Cappella pairing QR code"
								/>
							</div>
							<div className="min-w-0 space-y-1">
								<div
									className="text-lg font-mono tracking-widest"
									style={{ color: theme.colors.textMain }}
								>
									{devices.pairing.code}
								</div>
								<p className="text-xs opacity-70">
									Fingerprint {devices.pairing.fingerprint}. The device shows the same one - if it
									does not match, do not approve it.
								</p>
								<p className="text-xs opacity-70">
									Reachable at {devices.pairing.hosts.join(', ') || 'this computer'} on port{' '}
									{devices.pairing.port}.
								</p>
								<button
									type="button"
									onClick={() => void devices.cancelPairing()}
									className="px-2 py-1 rounded border text-xs"
									style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
								>
									Cancel
								</button>
							</div>
						</div>
					)}

					{devices.request && (
						<div
							className="rounded border p-2 space-y-1"
							style={{ borderColor: theme.colors.accent }}
						>
							<div className="text-sm" style={{ color: theme.colors.textMain }}>
								{devices.request.name} wants to pair
							</div>
							<p className="text-xs opacity-70">
								{devices.request.platform}
								{devices.request.remoteAddress ? ` from ${devices.request.remoteAddress}` : ''}.
								Only approve this if it is the device in your hand.
							</p>
							<div className="flex gap-2">
								<button
									type="button"
									onClick={() => void devices.approve(devices.request!.requestId)}
									className="px-2 py-1 rounded border text-xs flex items-center gap-1"
									style={{ borderColor: theme.colors.accent, color: theme.colors.textMain }}
								>
									<Check size={12} /> Approve
								</button>
								<button
									type="button"
									onClick={() => void devices.deny(devices.request!.requestId)}
									className="px-2 py-1 rounded border text-xs flex items-center gap-1"
									style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
								>
									<X size={12} /> Deny
								</button>
							</div>
						</div>
					)}

					<div className="flex items-start justify-between gap-3">
						<div className="min-w-0">
							<div className="text-sm" style={{ color: theme.colors.textMain }}>
								Advertise on the local network
							</div>
							<p className="text-xs opacity-70">
								{describeDiscovery(devices)} Turning this off does not stop pairing: the QR code and
								manual entry still work.
							</p>
						</div>
						<ToggleSwitch
							theme={theme}
							checked={devices.discovery?.state === 'advertising'}
							disabled={!enabled}
							ariaLabel="Advertise on the local network"
							onChange={(checked) => void devices.setDiscovery(checked)}
						/>
					</div>
				</SectionCard>
			</div>

			{/* -- The device list --------------------------------------------- */}
			<div data-setting-id="encore-a-cappella-device-list">
				<SectionCard theme={theme}>
					<div className="flex items-start justify-between gap-3">
						<div className="font-medium text-sm" style={{ color: theme.colors.textMain }}>
							Devices
						</div>
						{devices.devices.length > 0 && (
							<div className="flex gap-2">
								<button
									type="button"
									onClick={() => void devices.disconnectAll()}
									className="px-2 py-1 rounded border text-xs"
									style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
								>
									Disconnect all
								</button>
								<button
									type="button"
									onClick={() => void devices.revokeAll()}
									className="px-2 py-1 rounded border text-xs"
									style={{ borderColor: theme.colors.error, color: theme.colors.error }}
								>
									Revoke all
								</button>
							</div>
						)}
					</div>

					{devices.devices.length === 0 && (
						<p className="text-xs opacity-70">
							{devices.loaded ? 'No devices are paired with this computer.' : 'Loading devices...'}
						</p>
					)}

					{devices.devices.map((device) => (
						<div key={device.id} className="flex items-start justify-between gap-3">
							<div className="min-w-0">
								{renaming?.id === device.id ? (
									<input
										type="text"
										autoFocus
										aria-label={`Rename ${device.name}`}
										value={renaming.value}
										onChange={(event) => setRenaming({ id: device.id, value: event.target.value })}
										onBlur={() => void commitRename()}
										onKeyDown={(event) => {
											if (event.key === 'Enter') void commitRename();
											if (event.key === 'Escape') setRenaming(null);
										}}
										className="px-2 py-1 rounded border text-sm"
										style={{
											borderColor: theme.colors.border,
											backgroundColor: theme.colors.bgMain,
											color: theme.colors.textMain,
										}}
									/>
								) : (
									<div className="text-sm truncate" style={{ color: theme.colors.textMain }}>
										{device.name}
										{device.holdsFloor && (
											<span className="ml-2 text-xs" style={{ color: theme.colors.accent }}>
												holding the microphone
											</span>
										)}
									</div>
								)}
								<p className="text-xs opacity-70">{describeDevice(device)}</p>
							</div>
							<div className="flex gap-2 shrink-0">
								<button
									type="button"
									onClick={() => setRenaming({ id: device.id, value: device.name })}
									className="px-2 py-1 rounded border text-xs"
									style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
								>
									Rename
								</button>
								{device.revokedAt === null ? (
									<button
										type="button"
										onClick={() => void devices.revoke(device.id)}
										className="px-2 py-1 rounded border text-xs"
										style={{ borderColor: theme.colors.error, color: theme.colors.error }}
									>
										Revoke
									</button>
								) : (
									<button
										type="button"
										aria-label={`Forget ${device.name}`}
										onClick={() => void devices.forget(device.id)}
										className="px-2 py-1 rounded border text-xs flex items-center gap-1"
										style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
									>
										<Trash2 size={12} /> Forget
									</button>
								)}
							</div>
						</div>
					))}
				</SectionCard>
			</div>

			{/* -- Connection ---------------------------------------------------- */}
			<div data-setting-id="encore-a-cappella-connection">
				<SectionCard theme={theme}>
					<div>
						<div
							className="font-medium text-sm flex items-center gap-1.5"
							style={{ color: theme.colors.textMain }}
						>
							<Wifi size={13} /> Connection
						</div>
						<p className="text-xs opacity-70 mt-0.5">{devices.reach}</p>
						<p className="text-xs opacity-70 mt-1">{devices.tunnelNote}</p>
					</div>

					{ice && (
						<>
							<label className="block text-xs opacity-70" htmlFor="acappella-stun-urls">
								STUN servers, one per line
							</label>
							<textarea
								id="acappella-stun-urls"
								rows={2}
								value={ice.stunUrls.join('\n')}
								disabled={!enabled}
								onChange={(event) =>
									void devices.updateIce({
										stunUrls: event.target.value
											.split('\n')
											.map((line) => line.trim())
											.filter(Boolean),
									})
								}
								className="w-full px-2 py-1.5 rounded border text-xs font-mono disabled:opacity-50"
								style={{
									borderColor: theme.colors.border,
									backgroundColor: theme.colors.bgMain,
									color: theme.colors.textMain,
								}}
							/>
							<p className="text-xs opacity-70">
								A STUN server is told the address of whatever connects to it, and it never carries
								audio. Clearing this box is a supported choice: it limits you to this network and
								any overlay network.
							</p>

							<div className="flex items-start justify-between gap-3">
								<div className="min-w-0">
									<div className="text-sm" style={{ color: theme.colors.textMain }}>
										TURN relay
									</div>
									<p className="text-xs opacity-70">
										A phone on cellular sits behind carrier-grade NAT, which no amount of STUN can
										punch through. Voice on a walk genuinely needs a relay, and somebody has to run
										it and pay for its bandwidth.
									</p>
								</div>
								<ToggleSwitch
									theme={theme}
									checked={ice.turn.enabled}
									disabled={!enabled}
									ariaLabel="TURN relay"
									onChange={(checked) =>
										void devices.updateIce({ turn: { ...ice.turn, enabled: checked } })
									}
								/>
							</div>

							<input
								type="text"
								aria-label="TURN server URL"
								placeholder="turns:turn.example.com:5349"
								value={ice.turn.url}
								disabled={!enabled}
								onChange={(event) =>
									void devices.updateIce({ turn: { ...ice.turn, url: event.target.value } })
								}
								className="w-full px-2 py-1.5 rounded border text-xs font-mono disabled:opacity-50"
								style={{
									borderColor: theme.colors.border,
									backgroundColor: theme.colors.bgMain,
									color: theme.colors.textMain,
								}}
							/>
							<div className="flex gap-2">
								<input
									type="text"
									aria-label="TURN username"
									placeholder="username"
									value={ice.turn.username}
									disabled={!enabled}
									onChange={(event) =>
										void devices.updateIce({ turn: { ...ice.turn, username: event.target.value } })
									}
									className="flex-1 px-2 py-1.5 rounded border text-xs disabled:opacity-50"
									style={{
										borderColor: theme.colors.border,
										backgroundColor: theme.colors.bgMain,
										color: theme.colors.textMain,
									}}
								/>
								<input
									type="password"
									aria-label="TURN credential"
									placeholder="credential"
									value={ice.turn.credential}
									disabled={!enabled}
									onChange={(event) =>
										void devices.updateIce({
											turn: { ...ice.turn, credential: event.target.value },
										})
									}
									className="flex-1 px-2 py-1.5 rounded border text-xs disabled:opacity-50"
									style={{
										borderColor: theme.colors.border,
										backgroundColor: theme.colors.bgMain,
										color: theme.colors.textMain,
									}}
								/>
							</div>

							<div className="flex items-center gap-2">
								<button
									type="button"
									disabled={!enabled || devices.testing}
									onClick={() => void devices.testConnection()}
									className="px-2 py-1 rounded border text-xs disabled:opacity-50 flex items-center gap-1"
									style={{ borderColor: theme.colors.accent, color: theme.colors.textMain }}
								>
									<Radio size={12} /> {devices.testing ? 'Testing...' : 'Test connection'}
								</button>
								<span className="text-xs opacity-70">{describeProbe(devices)}</span>
							</div>
						</>
					)}
				</SectionCard>
			</div>
		</>
	);
}

/** One line per device: platform, live state, how it connected, when it last did. */
function describeDevice(device: DeviceStatus): string {
	if (device.revokedAt !== null) {
		return `${device.platform} - revoked ${formatRelativeTime(device.revokedAt)}`;
	}
	const parts = [device.platform];
	parts.push(device.online ? 'connected' : 'not connected');
	const candidate = device.quality?.candidateType ?? device.lastCandidateType;
	if (device.online || candidate !== 'unknown') parts.push(CANDIDATE_LABELS[candidate]);
	if (device.quality?.rttMs !== null && device.quality?.rttMs !== undefined) {
		parts.push(`${device.quality.rttMs} ms round trip`);
	}
	if (device.lastConnectedAt) parts.push(`last seen ${formatRelativeTime(device.lastConnectedAt)}`);
	return parts.join(' - ');
}

function describeDiscovery(devices: ReturnType<typeof usePairedDevices>): string {
	const discovery = devices.discovery;
	if (!discovery) return devices.manualHint;
	switch (discovery.state) {
		case 'advertising':
			return `Visible as "${discovery.name}" on port ${discovery.port}.`;
		case 'unavailable':
			return discovery.reason;
		case 'error':
			return `The advert failed: ${discovery.message}`;
		default:
			return `Not advertising. ${devices.manualHint}`;
	}
}

/** The Test Connection verdict, said in terms of what will actually work. */
function describeProbe(devices: ReturnType<typeof usePairedDevices>): string {
	const probe = devices.probe;
	if (devices.testing) return 'Gathering candidates...';
	if (!probe) return 'Checks whether STUN answers and whether your TURN credentials work.';
	if (probe.error) return probe.error;
	if (probe.relay) return 'TURN works. Cellular and hostile networks will connect.';
	if (probe.stun) return 'STUN works. Most home networks will connect; cellular will not.';
	if (probe.host) return 'Local addresses only. This network and overlay networks will connect.';
	return 'No candidates were gathered. Check the server addresses.';
}
