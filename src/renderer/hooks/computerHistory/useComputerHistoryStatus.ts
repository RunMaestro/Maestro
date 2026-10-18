/**
 * Live Computer History recorder status for the renderer.
 *
 * Reads once on mount (and whenever the Encore flag flips), then follows the
 * main process's `computerHistory:statusChanged` push. Returns null while the
 * feature is off or before the first answer. Desktop-only: in a web-desktop
 * browser the channels are denied, the read rejects, and this stays null.
 */

import { useEffect, useState } from 'react';
import { useSettingsStore } from '../../stores/settingsStore';
import type { ComputerHistoryStatus } from '../../../shared/computer-history/status';

export function useComputerHistoryStatus(): {
	enabled: boolean;
	status: ComputerHistoryStatus | null;
	refresh: () => void;
} {
	const enabled = useSettingsStore((s) => s.encoreFeatures.computerHistory === true);
	const [status, setStatus] = useState<ComputerHistoryStatus | null>(null);
	const [tick, setTick] = useState(0);

	useEffect(() => {
		const api = window.maestro?.computerHistory;
		if (!enabled || !api) {
			setStatus(null);
			return;
		}
		let cancelled = false;
		// A push that lands before the first read resolves is the newer answer.
		let pushed = false;
		api
			.status()
			.then((next) => {
				if (!cancelled && !pushed) setStatus(next);
			})
			.catch(() => {
				// Denied over the web bridge, or the service is not up yet: no status.
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
	}, [enabled, tick]);

	return { enabled, status, refresh: () => setTick((n) => n + 1) };
}
