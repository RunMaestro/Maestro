/**
 * @file usePairedDevices.test.ts
 * @description Tests that usePairedDevices refreshes pairing state and clears an
 * active pairing code when onPairingRequest(null) arrives.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor, cleanup } from '@testing-library/react';

import {
	usePairedDevices,
	type PairingPayload,
	type PairingRequest,
} from '../../../../../renderer/components/Settings/ACappella/usePairedDevices';

describe('usePairedDevices', () => {
	const activePayload: PairingPayload = {
		kind: 'maestro-acappella',
		v: 1,
		hosts: ['192.168.1.10'],
		port: 9999,
		token: 'server-token',
		code: 'BCDFGH',
		expiresAt: Date.now() + 120_000,
		fingerprint: 'ABCD-1234',
	};

	let requestListener: ((request: PairingRequest | null) => void) | null = null;
	let pairingStatusMock: ReturnType<typeof vi.fn>;
	let originalMaestro: typeof window.maestro;

	beforeEach(() => {
		requestListener = null;
		originalMaestro = window.maestro;
		pairingStatusMock = vi
			.fn()
			.mockResolvedValueOnce({
				payload: activePayload,
				request: null,
				discovery: null,
				manualHint: '',
			})
			.mockResolvedValueOnce({
				payload: null,
				request: null,
				discovery: null,
				manualHint: '',
			});

		window.maestro = {
			...originalMaestro,
			voice: {
				devices: {
					list: vi.fn().mockResolvedValue([]),
					pairingStatus: pairingStatusMock,
					iceSettings: vi.fn().mockResolvedValue({
						settings: {
							stunUrls: [],
							turn: {
								enabled: false,
								url: '',
								username: '',
								credentialConfigured: false,
								keyringAvailable: true,
								legacyPlaintextFallback: false,
							},
							hostCandidates: true,
							forceRelay: false,
						},
						reach: 'LAN only',
						tunnelNote: '',
						discovery: null,
					}),
					updateIceSettings: vi.fn().mockResolvedValue({
						stunUrls: [],
						turn: {
							enabled: true,
							url: 'turns:relay.example.com:5349',
							username: '',
							credentialConfigured: false,
							keyringAvailable: true,
							legacyPlaintextFallback: false,
						},
						hostCandidates: true,
						forceRelay: false,
					}),
					setTurnCredential: vi.fn().mockResolvedValue({ ok: true }),
					clearTurnCredential: vi.fn().mockResolvedValue({ ok: true }),
					onChanged: vi.fn().mockReturnValue(() => {}),
					onPairingRequest: vi.fn((handler: (request: PairingRequest | null) => void) => {
						requestListener = handler;
						return () => {
							requestListener = null;
						};
					}),
				},
			},
		} as unknown as typeof window.maestro;
	});

	afterEach(() => {
		cleanup();
		window.maestro = originalMaestro;
		vi.restoreAllMocks();
	});

	it('clears the active pairing code when onPairingRequest(null) fires', async () => {
		const { result } = renderHook(() => usePairedDevices(true));

		await waitFor(() => {
			expect(result.current.loaded).toBe(true);
		});
		expect(result.current.pairing).toEqual(activePayload);
		expect(requestListener).not.toBeNull();

		await act(async () => {
			requestListener?.(null);
		});

		await waitFor(() => {
			expect(result.current.pairing).toBeNull();
		});
		expect(pairingStatusMock).toHaveBeenCalledTimes(2);
	});

	it('routes ICE updates and TURN credential changes through dedicated IPC channels', async () => {
		const settingsSetSpy = vi.fn();
		(window.maestro as unknown as Record<string, unknown>).settings = {
			get: vi.fn(),
			set: settingsSetSpy,
		};

		const { result } = renderHook(() => usePairedDevices(true));
		await waitFor(() => {
			expect(result.current.loaded).toBe(true);
		});

		await act(async () => {
			await result.current.updateIce({
				turn: {
					enabled: true,
					url: 'turns:relay.example.com:5349',
					username: 'u1',
					credentialConfigured: false,
					keyringAvailable: true,
					legacyPlaintextFallback: false,
				},
			});
			await result.current.setTurnCredential('turn-secret');
			await result.current.clearTurnCredential();
		});

		expect(settingsSetSpy).not.toHaveBeenCalled();
		expect(window.maestro.voice.devices.updateIceSettings).toHaveBeenCalledTimes(1);
		expect(window.maestro.voice.devices.setTurnCredential).toHaveBeenCalledWith('turn-secret');
		expect(window.maestro.voice.devices.clearTurnCredential).toHaveBeenCalledTimes(1);
	});
});
