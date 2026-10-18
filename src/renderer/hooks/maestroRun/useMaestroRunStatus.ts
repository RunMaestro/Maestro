/**
 * Live MaestroRun status for the renderer.
 *
 * Asks main to re-inspect the launcher on mount (and whenever the Encore flag
 * flips), then follows the `maestroRun:statusChanged` push, which is how the
 * tile turns green the moment the user switches Full Disk Access on. Returns
 * null before the first answer.
 */

import { useEffect, useState } from 'react';
import { useSettingsStore } from '../../stores/settingsStore';
import type { MaestroRunStatus } from '../../../shared/maestro-run/status';

export function useMaestroRunStatus(): {
	enabled: boolean;
	status: MaestroRunStatus | null;
} {
	const enabled = useSettingsStore((s) => s.encoreFeatures.maestroRun === true);
	const [status, setStatus] = useState<MaestroRunStatus | null>(null);

	useEffect(() => {
		const api = window.maestro?.maestroRun;
		if (!api) {
			setStatus(null);
			return;
		}
		let cancelled = false;
		// A push that lands before the first read resolves is the newer answer.
		let pushed = false;
		// The release check needs the network, so it only runs for a tile that is on.
		api
			.refresh({ checkLatest: enabled })
			.then((next) => {
				if (!cancelled && !pushed) setStatus(next);
			})
			.catch(() => {
				// The service is not up yet: no status, and the body says so.
				if (!cancelled && !pushed) setStatus(null);
			});
		const unsubscribe = api.onStatusChanged((next) => {
			pushed = true;
			if (!cancelled) setStatus(next);
		});
		return () => {
			cancelled = true;
			unsubscribe();
		};
	}, [enabled]);

	return { enabled, status };
}
