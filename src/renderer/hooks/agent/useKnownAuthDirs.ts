import { useEffect, useState } from 'react';
import { EMPTY_KNOWN_AUTH_DIRS, type KnownAuthDirs } from '../../../shared/authPaths';

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((dir) => typeof dir === 'string');
}

/**
 * The bridge payload as a complete `KnownAuthDirs`, or `null` when it is
 * malformed. `grokHomes` is optional on the wire (a payload without it offers
 * no Grok suggestions) so the picker never reads an absent list.
 */
function toKnownAuthDirs(value: unknown): KnownAuthDirs | null {
	if (!value || typeof value !== 'object') return null;
	if (!('claudeConfigDirs' in value) || !('codexHomes' in value)) return null;
	if (!isStringArray(value.claudeConfigDirs) || !isStringArray(value.codexHomes)) return null;
	const grokHomes = 'grokHomes' in value ? value.grokHomes : [];
	if (!isStringArray(grokHomes)) return null;
	return { claudeConfigDirs: value.claudeConfigDirs, codexHomes: value.codexHomes, grokHomes };
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
				const known = toKnownAuthDirs(dirs);
				if (!cancelled && known) {
					setKnownAuthDirs(known);
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
