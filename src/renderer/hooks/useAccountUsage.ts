import { useState, useEffect, useCallback, useRef } from 'react';

export interface AccountUsageMetrics {
	accountId: string;
	totalTokens: number;
	limitTokens: number;
	usagePercent: number | null;
	costUsd: number;
	queryCount: number;
	windowStart: number;
	windowEnd: number;
	timeRemainingMs: number;
	burnRatePerHour: number;
	estimatedTimeToLimitMs: number | null; // null if no limit or burn rate is 0
	status: string;
}

const DEFAULT_INTERVAL_MS = 30_000;
const URGENT_INTERVAL_MS = 5_000;
const URGENT_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Hook that provides real-time per-account usage metrics.
 * Fetches on mount, subscribes to real-time updates, and recalculates
 * derived metrics (burn rate, time to limit) every 30 seconds.
 * Switches to 5-second updates when any account is within 5 minutes of reset.
 */
export function useAccountUsage(): {
	metrics: Record<string, AccountUsageMetrics>;
	loading: boolean;
	refresh: () => void;
} {
	const [metrics, setMetrics] = useState<Record<string, AccountUsageMetrics>>({});
	const [loading, setLoading] = useState(true);
	const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
	const currentIntervalMs = useRef(DEFAULT_INTERVAL_MS);

	const calculateDerivedMetrics = useCallback((raw: {
		accountId: string;
		totalTokens: number;
		limitTokens: number;
		usagePercent: number | null;
		costUsd: number;
		queryCount: number;
		windowStart: number;
		windowEnd: number;
		status: string;
	}): AccountUsageMetrics => {
		const now = Date.now();
		const timeRemainingMs = Math.max(0, raw.windowEnd - now);
		const elapsedMs = Math.max(1, now - raw.windowStart); // avoid divide by zero
		const elapsedHours = elapsedMs / (1000 * 60 * 60);

		// Burn rate: tokens consumed per hour in this window
		const burnRatePerHour = raw.totalTokens / elapsedHours;

		// Estimated time to hit limit (null if no limit configured)
		let estimatedTimeToLimitMs: number | null = null;
		if (raw.limitTokens > 0 && burnRatePerHour > 0) {
			const remainingTokens = Math.max(0, raw.limitTokens - raw.totalTokens);
			const hoursToLimit = remainingTokens / burnRatePerHour;
			estimatedTimeToLimitMs = hoursToLimit * 60 * 60 * 1000;
		}

		return {
			...raw,
			timeRemainingMs,
			burnRatePerHour,
			estimatedTimeToLimitMs,
		};
	}, []);

	const recalculate = useCallback(() => {
		setMetrics(prev => {
			const updated: Record<string, AccountUsageMetrics> = {};
			for (const [id, m] of Object.entries(prev)) {
				updated[id] = calculateDerivedMetrics(m);
			}

			// Adaptive interval: switch to 5s when any account is near reset
			const hasUrgentCountdown = Object.values(updated).some(
				m => m.timeRemainingMs > 0 && m.timeRemainingMs < URGENT_THRESHOLD_MS
			);
			const targetInterval = hasUrgentCountdown ? URGENT_INTERVAL_MS : DEFAULT_INTERVAL_MS;
			if (targetInterval !== currentIntervalMs.current && intervalRef.current) {
				clearInterval(intervalRef.current);
				currentIntervalMs.current = targetInterval;
				intervalRef.current = setInterval(recalculate, targetInterval);
			}

			return updated;
		});
	}, [calculateDerivedMetrics]);

	const fetchUsage = useCallback(async () => {
		try {
			const allUsage = await window.maestro.accounts.getAllUsage();
			if (!allUsage || typeof allUsage !== 'object') return;

			const newMetrics: Record<string, AccountUsageMetrics> = {};
			for (const [accountId, usage] of Object.entries(allUsage as Record<string, any>)) {
				newMetrics[accountId] = calculateDerivedMetrics({
					accountId,
					totalTokens: usage.totalTokens || 0,
					limitTokens: usage.account?.tokenLimitPerWindow || 0,
					usagePercent: usage.usagePercent ?? null,
					costUsd: usage.costUsd || 0,
					queryCount: usage.queryCount || 0,
					windowStart: usage.windowStart || Date.now(),
					windowEnd: usage.windowEnd || Date.now(),
					status: usage.account?.status || 'active',
				});
			}
			setMetrics(newMetrics);
			setLoading(false);
		} catch {
			setLoading(false);
		}
	}, [calculateDerivedMetrics]);

	useEffect(() => {
		fetchUsage();

		// Subscribe to real-time usage updates
		const unsub = window.maestro.accounts.onUsageUpdate((data) => {
			const accountId = data.accountId;
			if (!accountId) return;

			setMetrics(prev => ({
				...prev,
				[accountId]: calculateDerivedMetrics({
					accountId,
					totalTokens: data.totalTokens || 0,
					limitTokens: data.limitTokens || 0,
					usagePercent: data.usagePercent ?? null,
					costUsd: data.costUsd || 0,
					queryCount: data.queryCount || 0,
					windowStart: data.windowStart || Date.now(),
					windowEnd: data.windowEnd || Date.now(),
					status: prev[accountId]?.status || 'active',
				}),
			}));
		});

		// Recalculate derived metrics periodically
		currentIntervalMs.current = DEFAULT_INTERVAL_MS;
		intervalRef.current = setInterval(recalculate, DEFAULT_INTERVAL_MS);

		return () => {
			unsub();
			if (intervalRef.current) clearInterval(intervalRef.current);
		};
	}, [fetchUsage, calculateDerivedMetrics, recalculate]);

	return { metrics, loading, refresh: fetchUsage };
}

/**
 * Format milliseconds into a human-readable time string.
 * Examples: "2h 34m", "45m", "4m 32s", "< 1m", "—" (if 0 or negative)
 */
export function formatTimeRemaining(ms: number): string {
	if (ms <= 0) return '—';
	const hours = Math.floor(ms / (1000 * 60 * 60));
	const minutes = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60));
	if (hours > 0) return `${hours}h ${minutes}m`;
	if (minutes >= 5) return `${minutes}m`;
	// Under 5 minutes: show seconds for precision
	const seconds = Math.floor((ms % (1000 * 60)) / 1000);
	if (minutes > 0) return `${minutes}m ${seconds}s`;
	return '< 1m';
}

/**
 * Format token count with K/M suffix.
 * Examples: "142K", "1.2M", "856"
 */
export function formatTokenCount(tokens: number): string {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
	if (tokens >= 10_000) return `${Math.round(tokens / 1_000)}K`;
	if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
	return String(tokens);
}
