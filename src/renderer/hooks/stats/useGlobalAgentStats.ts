/**
 * useGlobalAgentStats
 *
 * Loads cross-provider global agent stats (sessions, messages, tokens, cost)
 * with streaming progressive updates from the main process. Originally inlined
 * in `AboutModal`; extracted so the Usage Dashboard can drive the same data
 * into its Achievement share image.
 *
 * Pass `enabled=false` from consumers that mount eagerly but only need the
 * data when visible (e.g. modals that gate render via `isOpen` rather than
 * conditional mount). Disabling skips both the IPC call and the streaming
 * subscription, and clears any prior result so a re-enable starts fresh.
 */

import { useEffect, useState } from 'react';
import type { GlobalAgentStats } from '../../../shared/types';
import { logger } from '../../utils/logger';

export interface UseGlobalAgentStatsResult {
	globalStats: GlobalAgentStats | null;
	loading: boolean;
	isComplete: boolean;
}

export function useGlobalAgentStats(enabled = true): UseGlobalAgentStatsResult {
	const [globalStats, setGlobalStats] = useState<GlobalAgentStats | null>(null);
	const [loading, setLoading] = useState(enabled);
	const [isComplete, setIsComplete] = useState(false);

	useEffect(() => {
		if (!enabled) {
			setGlobalStats(null);
			setLoading(false);
			setIsComplete(false);
			return;
		}

		setLoading(true);
		setIsComplete(false);

		const unsubscribe = window.maestro.agentSessions.onGlobalStatsUpdate((stats) => {
			setGlobalStats(stats);
			setLoading(false);
			if (stats.isComplete) {
				setIsComplete(true);
			}
		});

		window.maestro.agentSessions
			.getGlobalStats()
			.then((stats) => {
				setGlobalStats((current) => current ?? stats);
				setLoading(false);
				if (stats.isComplete) {
					setIsComplete(true);
				}
			})
			.catch((error) => {
				logger.error('Failed to load global agent stats:', undefined, error);
				setLoading(false);
				setIsComplete(true);
			});

		return () => {
			unsubscribe();
		};
	}, [enabled]);

	return { globalStats, loading, isComplete };
}
