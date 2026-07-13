import { useEffect, useState } from 'react';
import { EMPTY_KNOWN_AUTH_DIRS, type KnownAuthDirs } from '../../../shared/authPaths';

function isKnownAuthDirs(value: unknown): value is KnownAuthDirs {
	if (!value || typeof value !== 'object') return false;
	if (!('claudeConfigDirs' in value) || !('codexHomes' in value)) return false;
	return (
		Array.isArray(value.claudeConfigDirs) &&
		value.claudeConfigDirs.every((dir) => typeof dir === 'string') &&
		Array.isArray(value.codexHomes) &&
		value.codexHomes.every((dir) => typeof dir === 'string')
	);
}

export function useKnownAuthDirs(enabled = true): KnownAuthDirs {
	const [knownAuthDirs, setKnownAuthDirs] = useState<KnownAuthDirs>(EMPTY_KNOWN_AUTH_DIRS);

	useEffect(() => {
		if (!enabled) {
			setKnownAuthDirs(EMPTY_KNOWN_AUTH_DIRS);
			return;
		}
		const getKnownAuthDirs = window.maestro?.agents?.getKnownAuthDirs;
		if (!getKnownAuthDirs) return;

		let cancelled = false;
		void getKnownAuthDirs()
			.then((dirs) => {
				if (!cancelled && isKnownAuthDirs(dirs)) {
					setKnownAuthDirs(dirs);
				}
			})
			.catch(() => {
				// Account suggestions are optional; manual path entry remains available.
			});
		return () => {
			cancelled = true;
		};
	}, [enabled]);

	return knownAuthDirs;
}
