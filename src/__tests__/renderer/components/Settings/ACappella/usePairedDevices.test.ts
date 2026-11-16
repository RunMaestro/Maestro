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
						settings: { mode: 'lan', stunServers: [], turnServers: [] },
						reach: 'LAN only',
						tunnelNote: '',
						discovery: null,
					}),
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
});
