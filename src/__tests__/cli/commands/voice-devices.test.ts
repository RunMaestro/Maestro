/**
 * @file voice-devices.test.ts
 * @description Tests for `maestro-cli voice devices`: a device is named by id,
 * id prefix or name and resolved against the app's own list, a write the CLI
 * cannot undo asks first (and a script must pass --yes), and the connection
 * test prints the probe whole and exits non-zero when gathering failed.
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';

vi.mock('../../../cli/services/maestro-client', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../cli/services/maestro-client')>()),
	withMaestroClient: vi.fn(),
}));

vi.mock('../../../cli/utils/confirm', () => ({
	canPrompt: vi.fn(() => false),
	confirmOnTerminal: vi.fn(),
}));

import {
	describeVoiceDevice,
	describeVoiceDiscovery,
	voiceDevicesDisconnect,
	voiceDevicesDiscovery,
	voiceDevicesForget,
	voiceDevicesList,
	voiceDevicesRename,
	voiceDevicesRevoke,
	voiceDevicesRevokeAll,
	voiceDevicesTestConnection,
} from '../../../cli/commands/voice-devices';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import { canPrompt, confirmOnTerminal } from '../../../cli/utils/confirm';
import { ExitCode } from '../../../cli/exit-codes';
import type {
	VoiceControlReply,
	VoiceControlRequest,
	VoiceDeviceView,
} from '../../../shared/acappella/voice-control';

function device(overrides: Partial<VoiceDeviceView> = {}): VoiceDeviceView {
	return {
		id: 'dev-aaa111',
		name: 'Pat iPhone',
		platform: 'ios',
		createdAt: 1,
		lastConnectedAt: null,
		lastCandidateType: 'unknown',
		revokedAt: null,
		online: false,
		holdsFloor: false,
		...overrides,
	};
}

const DEVICES = [device(), device({ id: 'dev-bbb222', name: 'Tablet', online: true })];

const ok = (result: unknown): VoiceControlReply => ({ ok: true, result }) as VoiceControlReply;

/** Answer the device list from `DEVICES` and every other request from `reply`. */
function mockBridge(reply: (request: VoiceControlRequest) => VoiceControlReply = () => ok({})) {
	const sent: VoiceControlRequest[] = [];
	vi.mocked(withMaestroClient).mockImplementation(async (action) =>
		action({
			sendCommand: vi.fn().mockImplementation((payload: { request: VoiceControlRequest }) => {
				sent.push(payload.request);
				const answer =
					payload.request.action === 'devices'
						? ok({ devices: DEVICES, discovery: { state: 'disabled' } })
						: reply(payload.request);
				return Promise.resolve({ success: true, reply: answer });
			}),
		} as never)
	);
	return sent;
}

describe('voice devices commands', () => {
	let logSpy: MockInstance;
	let errorSpy: MockInstance;

	const printed = () => logSpy.mock.calls.map(([line]) => String(line)).join('\n');
	const errors = () => errorSpy.mock.calls.map(([line]) => String(line)).join('\n');
	const json = () => JSON.parse(String(logSpy.mock.calls[0][0]));

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(canPrompt).mockReturnValue(false);
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
		errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
			throw new Error(`exit:${code}`);
		}) as never);
	});

	it('describes a device by what it is doing now', () => {
		expect(describeVoiceDevice(device())).toContain('Pat iPhone (ios): offline, never connected');
		expect(describeVoiceDevice(device({ online: true, holdsFloor: true }))).toContain(
			'online, holds the microphone'
		);
		expect(describeVoiceDevice(device({ revokedAt: 5, online: true }))).toContain('revoked');
	});

	it('describes LAN discovery in every state', () => {
		expect(describeVoiceDiscovery(null)).toContain('not started');
		expect(describeVoiceDiscovery({ state: 'disabled' })).toBe('off');
		expect(describeVoiceDiscovery({ state: 'advertising', name: 'Desk', port: 4000 })).toBe(
			'advertising as "Desk" on port 4000'
		);
		expect(describeVoiceDiscovery({ state: 'unavailable', reason: 'no mDNS' })).toContain(
			'no mDNS'
		);
	});

	it('lists the devices and LAN discovery', async () => {
		const sent = mockBridge();
		await voiceDevicesList({});

		expect(sent).toEqual([{ action: 'devices' }]);
		expect(printed()).toContain('dev-aaa111  Pat iPhone');
		expect(printed()).toContain('LAN discovery: off');
	});

	it('renames a device named by a prefix of its id', async () => {
		const sent = mockBridge(() => ok({ deviceId: 'dev-bbb222', name: 'Kitchen Tablet' }));
		await voiceDevicesRename('dev-bbb', ' Kitchen Tablet ', { json: true });

		expect(sent[1]).toEqual({
			action: 'rename-device',
			deviceId: 'dev-bbb222',
			name: 'Kitchen Tablet',
		});
		expect(json()).toMatchObject({ success: true, previousName: 'Tablet' });
	});

	it('resolves a device by its name, whatever the case', async () => {
		const sent = mockBridge(() => ok({ deviceId: 'dev-aaa111' }));
		await voiceDevicesRevoke('pat iphone', { yes: true });
		expect(sent[1]).toEqual({ action: 'revoke-device', deviceId: 'dev-aaa111' });
	});

	it('refuses a name that matches nothing, and a prefix that matches two', async () => {
		const sent = mockBridge();

		await expect(voiceDevicesRevoke('laptop', { yes: true })).rejects.toThrow(
			`exit:${ExitCode.InvalidUsage}`
		);
		await expect(voiceDevicesRevoke('dev-', { yes: true })).rejects.toThrow(
			`exit:${ExitCode.InvalidUsage}`
		);
		expect(errors()).toContain('matches 2 paired devices');
		// Only the list was read. Nothing was revoked.
		expect(sent.every((request) => request.action === 'devices')).toBe(true);
	});

	it('will not revoke from a script that did not pass --yes', async () => {
		const sent = mockBridge();

		await expect(voiceDevicesRevoke('dev-aaa111', {})).rejects.toThrow(
			`exit:${ExitCode.InvalidUsage}`
		);
		await expect(voiceDevicesForget('dev-aaa111', {})).rejects.toThrow(
			`exit:${ExitCode.InvalidUsage}`
		);
		await expect(voiceDevicesRevokeAll({})).rejects.toThrow(`exit:${ExitCode.InvalidUsage}`);

		expect(errors()).toContain('Pass --yes to confirm');
		expect(confirmOnTerminal).not.toHaveBeenCalled();
		expect(sent.every((request) => request.action === 'devices')).toBe(true);
	});

	it('asks at a terminal, and a "no" writes nothing', async () => {
		vi.mocked(canPrompt).mockReturnValue(true);
		vi.mocked(confirmOnTerminal).mockResolvedValue(false);
		const sent = mockBridge();

		await expect(voiceDevicesRevokeAll({})).rejects.toThrow('exit:1');

		expect(confirmOnTerminal).toHaveBeenCalledTimes(1);
		expect(sent).toEqual([]);
	});

	it('revokes every device once confirmed', async () => {
		vi.mocked(canPrompt).mockReturnValue(true);
		vi.mocked(confirmOnTerminal).mockResolvedValue(true);
		const sent = mockBridge(() => ok({ revoked: 2 }));

		await voiceDevicesRevokeAll({});

		expect(sent).toEqual([{ action: 'revoke-all-devices' }]);
		expect(printed()).toContain('Revoked 2 devices.');
	});

	it('forgets a device, and disconnects every device without a prompt', async () => {
		const sent = mockBridge((request) =>
			request.action === 'forget-device' ? ok({ deviceId: 'dev-aaa111' }) : ok({})
		);
		await voiceDevicesForget('dev-aaa111', { yes: true });
		await voiceDevicesDisconnect({});

		expect(sent.map((request) => request.action)).toEqual([
			'devices',
			'forget-device',
			'disconnect-devices',
		]);
	});

	it('switches LAN discovery on and off, and refuses any other word', async () => {
		const sent = mockBridge(() =>
			ok({ discovery: { state: 'advertising', name: 'Desk', port: 4000 } })
		);
		await voiceDevicesDiscovery('on', {});
		await voiceDevicesDiscovery('off', {});

		expect(sent).toEqual([
			{ action: 'discovery', enabled: true },
			{ action: 'discovery', enabled: false },
		]);
		await expect(voiceDevicesDiscovery('maybe', {})).rejects.toThrow(
			`exit:${ExitCode.InvalidUsage}`
		);
	});

	it('prints which paths a device could reach this machine on', async () => {
		mockBridge(() => ok({ host: true, stun: true, relay: false, best: 'stun' }));
		await voiceDevicesTestConnection({});

		expect(printed()).toContain('Local network: yes');
		expect(printed()).toContain('TURN relay: no');
		expect(printed()).toContain('Best path: Direct (through NAT)');
	});

	it('prints the probe whole and exits non-zero when gathering failed', async () => {
		mockBridge(() =>
			ok({ host: false, stun: false, relay: false, best: 'unknown', error: 'No network.' })
		);

		await expect(voiceDevicesTestConnection({ json: true })).rejects.toThrow('exit:1');
		expect(json()).toEqual({
			success: false,
			host: false,
			stun: false,
			relay: false,
			best: 'unknown',
			error: 'No network.',
		});
		expect(logSpy).toHaveBeenCalledTimes(1);
	});
});
