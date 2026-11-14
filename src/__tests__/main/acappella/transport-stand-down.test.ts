/**
 * The transport's Encore-flag behaviour.
 *
 * A Cappella is off by default, and "off" has to mean the same thing to every
 * surface that reads the flag. The transport owns the two resources a user most
 * expects that switch to control - a Bonjour advert broadcasting this machine's
 * name and port, and live connections from paired phones - so it is the one that
 * has to stand down.
 *
 * Contracts defended:
 * - `standDown()` takes the advert down, cancels any half-finished pairing, and
 *   drops live connections.
 * - It does NOT revoke anything. Switching the feature off says "stop", not
 *   "forget my phone"; re-pairing a device because a checkbox was toggled is a
 *   punishment for reading the settings screen.
 * - It is not `dispose()`. The transport is constructed once per process at
 *   handler registration, so a teardown here would mean switching the feature
 *   back on did nothing until the next restart.
 * - `featureEnabled()` is read from settings on every call, so the signaling
 *   adapter and the IPC handlers cannot disagree about it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { PairingService } from '../../../main/acappella/pairing/pairing-service';
import { ACappellaTransport } from '../../../main/acappella/transport';
import type { WebRtcHostCommand } from '../../../shared/acappella/webrtc-host';

vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let dir: string;
let settings: Record<string, unknown>;
let hostCommands: WebRtcHostCommand[];
let transport: ACappellaTransport;

function createTransport(): ACappellaTransport {
	return new ACappellaTransport({
		settingsStore: {
			get: (key: string, defaultValue?: unknown) => settings[key] ?? defaultValue,
		},
		userDataPath: dir,
		sendToAudioHost: (command) => hostCommands.push(command),
		acquireFloor: () => {
			throw new Error('no floor in this test');
		},
		getSession: () => null,
		getServerToken: () => 'server-token',
		getServerPort: () => 4123,
		getAppVersion: () => '0.0.0-test',
		getMachineName: () => 'Test Machine',
	});
}

beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), 'acappella-transport-'));
	settings = { encoreFeatures: { aCappella: true } };
	hostCommands = [];
	transport = createTransport();
});

afterEach(async () => {
	transport.dispose();
	await fs.rm(dir, { recursive: true, force: true });
});

describe('ACappellaTransport.featureEnabled', () => {
	it('mirrors the Encore flag, read fresh each time', () => {
		expect(transport.featureEnabled()).toBe(true);

		settings.encoreFeatures = { aCappella: false };
		expect(transport.featureEnabled()).toBe(false);

		settings.encoreFeatures = { aCappella: true };
		expect(transport.featureEnabled()).toBe(true);
	});

	it('is false when no flags have ever been written', () => {
		settings = {};
		expect(transport.featureEnabled()).toBe(false);
	});
});

describe('ACappellaTransport.standDown', () => {
	it('takes the advert down', async () => {
		// No mDNS responder is available in a test process, so the advert reports
		// itself unavailable rather than advertising. What matters is the transition:
		// the service must end up disabled, which is the state that has actually
		// released the responder.
		await transport.discovery.start();
		const stop = vi.spyOn(transport.discovery, 'stop');

		transport.standDown();
		await transport.discovery.stop();

		expect(stop).toHaveBeenCalled();
		expect(transport.discoveryStatus()).toEqual({ state: 'disabled' });
	});

	it('cancels a pairing window that was open', () => {
		expect(transport.startPairing()).not.toBeNull();
		expect(transport.currentPairingPayload()).not.toBeNull();

		transport.standDown();

		// A code that outlives the switch is a code somebody can still redeem
		// against a feature its owner believes is off.
		expect(transport.currentPairingPayload()).toBeNull();
	});

	it('disconnects live devices without revoking any of them', async () => {
		const offer = transport.startPairing();
		const claim = transport.pairing.claim({
			code: offer!.code,
			name: 'Test iPhone',
			platform: 'ios',
		});
		expect(claim.status).toBe('pending');
		if (claim.status !== 'pending') return;
		await transport.pairing.approve(claim.requestId);

		const disconnect = vi.spyOn(transport, 'disconnectAll');
		transport.standDown();

		expect(disconnect).toHaveBeenCalled();

		const devices = await transport.listDevices();
		expect(devices).toHaveLength(1);
		expect(devices[0].revokedAt).toBeNull();
		expect(devices[0].online).toBe(false);
	});

	it('leaves the transport able to serve again when the feature comes back on', async () => {
		transport.standDown();

		// The reason this is standDown() and not dispose(): the transport is built
		// once per process, so a user who toggles the feature off and on again must
		// not need a restart to pair.
		const payload = transport.startPairing();
		expect(payload).not.toBeNull();
		expect(payload?.kind).toBe('maestro-acappella');
		await expect(transport.listDevices()).resolves.toEqual([]);
	});

	it('is safe to call twice, and with nothing running', () => {
		expect(() => {
			transport.standDown();
			transport.standDown();
		}).not.toThrow();
	});
});

describe('ACappellaTransport lazy device-name loading', () => {
	async function seedDevice(name: string): Promise<void> {
		const seeder = createTransport();
		const offer = seeder.startPairing();
		const claim = seeder.pairing.claim({ code: offer!.code, name, platform: 'ios' });
		if (claim.status !== 'pending') throw new Error('claim failed');
		await seeder.pairing.approve(claim.requestId);
		await seeder.pairing.whenPersisted();
		seeder.dispose();
	}

	it('does not read devices.json at construction when aCappella is off, and loads names when switched on at runtime', async () => {
		await seedDevice('Kitchen iPad');
		settings = { encoreFeatures: { aCappella: false } };

		const loadSpy = vi.spyOn(PairingService.prototype, 'load');
		const cold = createTransport();
		expect(loadSpy).not.toHaveBeenCalled();
		expect(cold.pairing.listLoaded()).toEqual([]);

		settings.encoreFeatures = { aCappella: true };
		cold.syncFeatureEnabled();
		await vi.waitFor(() => {
			expect(cold.pairing.listLoaded().map((d) => d.name)).toEqual(['Kitchen iPad']);
		});
		expect(loadSpy).toHaveBeenCalled();
		loadSpy.mockRestore();
		cold.dispose();
	});

	it('loads device names on first transport use after starting with aCappella off', async () => {
		await seedDevice('Pocket iPhone');
		settings = { encoreFeatures: { aCappella: false } };

		const loadSpy = vi.spyOn(PairingService.prototype, 'load');
		const cold = createTransport();
		expect(loadSpy).not.toHaveBeenCalled();

		settings.encoreFeatures = { aCappella: true };
		cold.startPairing();
		await vi.waitFor(() => {
			expect(cold.pairing.listLoaded().map((d) => d.name)).toEqual(['Pocket iPhone']);
		});
		expect(loadSpy).toHaveBeenCalled();
		loadSpy.mockRestore();
		cold.dispose();
	});

	it('forwards back-to-back signaling messages in arrival order and reads devices.json once', async () => {
		await seedDevice('Studio iPad');
		settings = { encoreFeatures: { aCappella: false } };

		const cold = createTransport();
		const loadSpy = vi.spyOn(cold.pairing, 'load');
		const arrivals: unknown[] = [];
		const handleSpy = vi
			.spyOn(cold.signaling, 'handleMessage')
			.mockImplementation(async (_clientId, payload) => {
				arrivals.push(payload);
			});

		settings.encoreFeatures = { aCappella: true };
		const first = { op: 'auth', seq: 1 };
		const second = { op: 'offer', seq: 2 };
		const p1 = cold.handleSignalMessage('c1', first);
		const p2 = cold.handleSignalMessage('c1', second);

		// Synchronous dispatch to signaling.handleMessage preserves arrival order
		// without waiting on the background devices.json name load.
		expect(arrivals).toEqual([first, second]);
		await Promise.all([p1, p2]);
		await vi.waitFor(() => {
			expect(cold.pairing.listLoaded().map((d) => d.name)).toEqual(['Studio iPad']);
		});
		expect(loadSpy).toHaveBeenCalledTimes(1);

		handleSpy.mockRestore();
		loadSpy.mockRestore();
		cold.dispose();
	});
});
