/**
 * usePairingCheck - Hook to check for stored pairing credentials on app startup
 *
 * On cold start, if SecureStore has no 'maestro.pairing.active' credential,
 * navigates immediately to /pair (the QR scanner). If credentials exist,
 * allows the app to proceed normally.
 *
 * Part of M3 Mobile Expo App implementation (decision 6A QR pairing).
 */

import { useEffect, useState } from 'react';
import { useRouter, useSegments } from 'expo-router';
import { hasCredentials } from '@/lib/credentials';

export type PairingState = 'checking' | 'paired' | 'unpaired';

/**
 * Hook that checks for pairing credentials on mount and redirects to /pair if missing.
 * Returns the current pairing state so the UI can show a loading state while checking.
 */
export function usePairingCheck(): PairingState {
	const [state, setState] = useState<PairingState>('checking');
	const router = useRouter();
	const segments = useSegments();

	useEffect(() => {
		let mounted = true;

		async function checkPairing() {
			try {
				const hasCreds = await hasCredentials();

				if (!mounted) return;

				if (hasCreds) {
					setState('paired');
				} else {
					setState('unpaired');
					// Only redirect if we're not already on the pair screen
					const isOnPairScreen = segments[0] === 'pair';
					if (!isOnPairScreen) {
						// Use replace to ensure pair screen can't be navigated back from
						router.replace('/pair');
					}
				}
			} catch (error) {
				console.error('[usePairingCheck] Error checking credentials:', error);
				// On error, assume unpaired and navigate to pair screen
				if (mounted) {
					setState('unpaired');
					const isOnPairScreen = segments[0] === 'pair';
					if (!isOnPairScreen) {
						router.replace('/pair');
					}
				}
			}
		}

		checkPairing();

		return () => {
			mounted = false;
		};
	}, [router, segments]);

	return state;
}
