/**
 * useOsPlatform hook
 *
 * Provides platform detection via the OS API. Caches result to avoid repeated IPC calls.
 */

import { useEffect, useState } from 'react';

let cachedPlatform: string | null = null;

/**
 * Hook to get the current platform asynchronously
 * Returns 'darwin' on macOS, 'win32' on Windows, 'linux' on Linux
 * Returns 'unknown' on first render, then updates when the API call completes
 */
export function useOsPlatform(): string {
	const [platform, setPlatform] = useState<string>(() => {
		// If we have a cached result, use it immediately
		return cachedPlatform || 'unknown';
	});

	useEffect(() => {
		// If already cached, no need to call IPC again
		if (cachedPlatform) {
			return;
		}

		// If API not available (e.g., in tests), use a default
		if (typeof window === 'undefined' || !window.maestro?.os?.getPlatform) {
			setPlatform('unknown');
			return;
		}

		let isMounted = true;

		(async () => {
			try {
				const result = await window.maestro.os.getPlatform();
				if (isMounted) {
					cachedPlatform = result;
					setPlatform(result);
				}
			} catch (error) {
				// Fallback if IPC call fails
				console.error('Failed to get platform:', error);
				if (isMounted) {
					setPlatform('unknown');
				}
			}
		})();

		return () => {
			isMounted = false;
		};
	}, []);

	return platform;
}
