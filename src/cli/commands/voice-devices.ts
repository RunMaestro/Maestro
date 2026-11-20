// `maestro-cli voice devices ...` - Settings > Voice > Paired Devices.
//
// List, rename, revoke, forget, disconnect, the LAN discovery switch and the
// connection test, each through the transport function the panel's button
// calls. Listing and every way of cutting a device loose work with voice
// switched off, as they do in the panel: turning the feature off is exactly
// when someone wants to revoke a phone.
//
// Pairing is not here, and that is deliberate. Approving a device is the one
// step that stops a six-character code from being enough to hold somebody's
// microphone, and it is a decision for the person at the desktop. An agent
// that could approve its own pairing request would remove the step.

import { CANDIDATE_TYPE_LABELS } from '../../shared/acappella/device-protocol';
import type { VoiceDeviceView, VoiceDiscoveryView } from '../../shared/acappella/voice-control';
import { formatRelativeTime } from '../../shared/formatters';
import { ExitCode, exitWith } from '../exit-codes';
import { formatSuccess } from '../output/formatter';
import { failCommand } from '../services/session-command';
import { sendVoiceControl } from '../services/voice-control';
import { canPrompt, confirmOnTerminal } from '../utils/confirm';
import { parseCliBool } from '../utils/parse';

interface JsonOption {
	json?: boolean;
}

interface ConfirmOption extends JsonOption {
	yes?: boolean;
}

/** An ICE probe gathers candidates against real servers; a dead TURN server takes a while to say so. */
const CONNECTION_TEST_TIMEOUT_MS = 60_000;

function printJson(value: Record<string, unknown>): void {
	console.log(JSON.stringify({ success: true, ...value }));
}

/** LAN discovery as one sentence. */
export function describeVoiceDiscovery(discovery: VoiceDiscoveryView | null): string {
	if (!discovery) return 'not started (the voice transport has not been built yet)';
	switch (discovery.state) {
		case 'disabled':
			return 'off';
		case 'advertising':
			return `advertising as "${discovery.name}" on port ${discovery.port}`;
		case 'unavailable':
			return `unavailable: ${discovery.reason}`;
		case 'error':
			return `failed: ${discovery.message}`;
	}
}

/** One device as a line a person reads. */
export function describeVoiceDevice(device: VoiceDeviceView): string {
	const state = device.revokedAt
		? 'revoked'
		: device.holdsFloor
			? 'online, holds the microphone'
			: device.online
				? 'online'
				: 'offline';
	const path =
		CANDIDATE_TYPE_LABELS[device.lastCandidateType as keyof typeof CANDIDATE_TYPE_LABELS] ??
		device.lastCandidateType;
	const seen = device.lastConnectedAt
		? `last connected ${formatRelativeTime(device.lastConnectedAt)} (${path})`
		: 'never connected';
	return `${device.id}  ${device.name} (${device.platform}): ${state}, ${seen}`;
}

/** Resolve a device by id, unique id prefix, or exact name, against the app's list. */
async function resolveDevice(ref: string, json: boolean | undefined): Promise<VoiceDeviceView> {
	const wanted = ref.trim();
	const { devices } = await sendVoiceControl({ action: 'devices' }, json);
	const exact = devices.find((device) => device.id === wanted);
	if (exact) return exact;
	const matches = devices.filter(
		(device) => device.id.startsWith(wanted) || device.name.toLowerCase() === wanted.toLowerCase()
	);
	if (matches.length === 1) return matches[0];
	failCommand(
		matches.length > 1
			? `"${ref}" matches ${matches.length} paired devices. Use the full id from "maestro-cli voice devices list".`
			: `No paired device matches "${ref}". See "maestro-cli voice devices list".`,
		json,
		ExitCode.InvalidUsage
	);
}

/** Ask before a write the CLI cannot undo. A script passes `--yes`. */
async function confirmOrFail(question: string, options: ConfirmOption): Promise<void> {
	if (options.yes) return;
	if (!canPrompt() || options.json) {
		failCommand(`${question} Pass --yes to confirm.`, options.json, ExitCode.InvalidUsage);
	}
	if (!(await confirmOnTerminal(question))) failCommand('Cancelled.', options.json);
}

/** `voice devices list` - every paired device, its connection, and LAN discovery. */
export async function voiceDevicesList(options: JsonOption): Promise<void> {
	const result = await sendVoiceControl({ action: 'devices' }, options.json);
	if (options.json) {
		printJson({ ...result });
		return;
	}
	if (result.devices.length === 0) console.log('No devices are paired.');
	for (const device of result.devices) console.log(describeVoiceDevice(device));
	console.log(`LAN discovery: ${describeVoiceDiscovery(result.discovery)}`);
}

/** `voice devices rename <device> <name>` */
export async function voiceDevicesRename(
	device: string,
	name: string,
	options: JsonOption
): Promise<void> {
	if (!name.trim()) failCommand('name cannot be empty', options.json, ExitCode.InvalidUsage);
	const target = await resolveDevice(device, options.json);
	const result = await sendVoiceControl(
		{ action: 'rename-device', deviceId: target.id, name: name.trim() },
		options.json
	);
	if (options.json) printJson({ ...result, previousName: target.name });
	else console.log(formatSuccess(`Renamed "${target.name}" to "${result.name}".`));
}

/** `voice devices revoke <device>` - end a pairing now; the device is kept in the list as revoked. */
export async function voiceDevicesRevoke(device: string, options: ConfirmOption): Promise<void> {
	const target = await resolveDevice(device, options.json);
	await confirmOrFail(`Revoke "${target.name}"? It will have to pair again.`, options);
	const result = await sendVoiceControl(
		{ action: 'revoke-device', deviceId: target.id },
		options.json
	);
	if (options.json) printJson({ ...result, name: target.name });
	else
		console.log(
			formatSuccess(`Revoked "${target.name}". It is disconnected and cannot reconnect.`)
		);
}

/** `voice devices forget <device>` - remove a device's record altogether. */
export async function voiceDevicesForget(device: string, options: ConfirmOption): Promise<void> {
	const target = await resolveDevice(device, options.json);
	await confirmOrFail(`Forget "${target.name}"? Its record is deleted.`, options);
	const result = await sendVoiceControl(
		{ action: 'forget-device', deviceId: target.id },
		options.json
	);
	if (options.json) printJson({ ...result, name: target.name });
	else console.log(formatSuccess(`Forgot "${target.name}".`));
}

/** `voice devices revoke-all` - end every pairing now. */
export async function voiceDevicesRevokeAll(options: ConfirmOption): Promise<void> {
	await confirmOrFail('Revoke every paired device? Each will have to pair again.', options);
	const result = await sendVoiceControl({ action: 'revoke-all-devices' }, options.json);
	if (options.json) printJson({ ...result });
	else
		console.log(
			formatSuccess(`Revoked ${result.revoked} device${result.revoked === 1 ? '' : 's'}.`)
		);
}

/** `voice devices disconnect` - drop every live connection and revoke nothing. */
export async function voiceDevicesDisconnect(options: JsonOption): Promise<void> {
	await sendVoiceControl({ action: 'disconnect-devices' }, options.json);
	if (options.json) printJson({ disconnected: true });
	else console.log(formatSuccess('Disconnected every device. Their pairings are kept.'));
}

/** `voice devices discovery <on|off>` - advertise this machine on the local network, or stop. */
export async function voiceDevicesDiscovery(state: string, options: JsonOption): Promise<void> {
	let enabled: boolean;
	try {
		enabled = parseCliBool(state, 'discovery');
	} catch (error) {
		failCommand(
			error instanceof Error ? error.message : String(error),
			options.json,
			ExitCode.InvalidUsage
		);
	}
	const { discovery } = await sendVoiceControl({ action: 'discovery', enabled }, options.json);
	if (options.json) printJson({ discovery });
	else console.log(`LAN discovery: ${describeVoiceDiscovery(discovery)}`);
}

/** `voice devices test-connection` - which paths a device could reach this machine on. */
export async function voiceDevicesTestConnection(options: JsonOption): Promise<void> {
	const result = await sendVoiceControl(
		{ action: 'test-connection' },
		options.json,
		CONNECTION_TEST_TIMEOUT_MS
	);
	if (options.json) {
		// The probe is the answer whether or not it found a path, so it is printed
		// whole; `success` says whether gathering ran at all.
		console.log(JSON.stringify({ success: !result.error, ...result }));
		if (result.error) exitWith(ExitCode.GeneralError);
		return;
	}
	const mark = (ok: boolean): string => (ok ? 'yes' : 'no');
	console.log(`Local network: ${mark(result.host)}`);
	console.log(`STUN (direct, across the internet): ${mark(result.stun)}`);
	console.log(`TURN relay: ${mark(result.relay)}`);
	const best =
		CANDIDATE_TYPE_LABELS[result.best as keyof typeof CANDIDATE_TYPE_LABELS] ?? result.best;
	console.log(`Best path: ${best}`);
	if (result.error) failCommand(result.error, false);
}
