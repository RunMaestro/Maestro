import { useState, useEffect, useCallback, useRef } from 'react';

// ============================================================================
// Prediction Types
// ============================================================================

export interface UsagePrediction {
	/** Linear estimate: remaining tokens / current burn rate */
	linearTimeToLimitMs: number | null;
	/** Weighted estimate using recent window patterns */
	weightedTimeToLimitMs: number | null;
	/** P90 tokens per window (90th percentile of recent windows) */
	p90TokensPerWindow: number;
	/** Average tokens per window */
	avgTokensPerWindow: number;
	/** Confidence: 'low' (<5 windows), 'medium' (5-15), 'high' (>15) */
	confidence: 'low' | 'medium' | 'high';
	/** Predicted number of windows remaining before limit (at P90 rate) */
	windowsRemainingP90: number | null;
}

// ============================================================================
// Rate Metrics Types
// ============================================================================

export interface RateMetrics {
	tokensPerHour: number;
	tokensPerDay: number;
	tokensPerWeek: number;
	dailyDelta: number;
	weeklyDelta: number;
	trend: 'up' | 'stable' | 'down';
}

// ============================================================================
// Metrics Types
// ============================================================================

export interface AccountUsageMetrics {
	accountId: string;
	totalTokens: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheCreationTokens: number;
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
	prediction: UsagePrediction;
	rateMetrics: RateMetrics;
}

const DEFAULT_INTERVAL_MS = 30_000;
const URGENT_INTERVAL_MS = 5_000;
const URGENT_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

const EMPTY_RATE_METRICS: RateMetrics = {
	tokensPerHour: 0,
	tokensPerDay: 0,
	tokensPerWeek: 0,
	dailyDelta: 0,
	weeklyDelta: 0,
	trend: 'stable',
};

// ============================================================================
// P90 Prediction Calculator
// ============================================================================

/**
 * Calculate P90-weighted prediction from billing window history.
 * Uses exponential weighting so recent windows count more than older ones.
 *
 * Inspired by Claude-Code-Usage-Monitor's P90 approach but adapted for
 * Maestro's multi-account context.
 */
export function calculatePrediction(
	windowHistory: Array<{ totalTokens: number; windowStart: number; windowEnd: number }>,
	currentWindowTokens: number,
	limitTokens: number,
	windowMs: number,
): UsagePrediction {
	const windowCount = windowHistory.length;
	const confidence = windowCount < 5 ? 'low' : windowCount < 15 ? 'medium' : 'high';

	if (windowCount === 0) {
		return {
			linearTimeToLimitMs: null,
			weightedTimeToLimitMs: null,
			p90TokensPerWindow: 0,
			avgTokensPerWindow: 0,
			confidence,
			windowsRemainingP90: null,
		};
	}

	// Extract token totals per window
	const totals = windowHistory.map(w => w.totalTokens);

	// Calculate average
	const avgTokensPerWindow = totals.reduce((a, b) => a + b, 0) / totals.length;

	// Calculate P90 (90th percentile)
	const sorted = [...totals].sort((a, b) => a - b);
	const p90Index = Math.floor(sorted.length * 0.9);
	const p90TokensPerWindow = sorted[Math.min(p90Index, sorted.length - 1)];

	// Weighted average: exponential decay, most recent windows weighted highest
	// Weight = 0.85^(age), so most recent window = 1.0, one back = 0.85, etc.
	const DECAY = 0.85;
	let weightedSum = 0;
	let weightTotal = 0;
	for (let i = 0; i < totals.length; i++) {
		const age = totals.length - 1 - i; // 0 = most recent
		const weight = Math.pow(DECAY, age);
		weightedSum += totals[i] * weight;
		weightTotal += weight;
	}
	const weightedAvg = weightedSum / weightTotal;

	// Predictions (only if limit is configured)
	let linearTimeToLimitMs: number | null = null;
	let weightedTimeToLimitMs: number | null = null;
	let windowsRemainingP90: number | null = null;

	if (limitTokens > 0) {
		const remaining = Math.max(0, limitTokens - currentWindowTokens);

		// Linear: remaining / (average tokens per window) * window duration
		if (avgTokensPerWindow > 0) {
			const windowsRemaining = remaining / avgTokensPerWindow;
			linearTimeToLimitMs = windowsRemaining * windowMs;
		}

		// Weighted: use weighted average for more responsive prediction
		if (weightedAvg > 0) {
			const windowsRemaining = remaining / weightedAvg;
			weightedTimeToLimitMs = windowsRemaining * windowMs;
		}

		// P90: conservative estimate
		if (p90TokensPerWindow > 0) {
			windowsRemainingP90 = remaining / p90TokensPerWindow;
		}
	}

	return {
		linearTimeToLimitMs,
		weightedTimeToLimitMs,
		p90TokensPerWindow,
		avgTokensPerWindow,
		confidence,
		windowsRemainingP90,
	};
}

// ============================================================================
// Rate Metrics Calculator
// ============================================================================

/**
 * Calculate rate metrics from window history for trend display.
 * Provides tokens/hr, tokens/day, tokens/week with period-over-period deltas.
 */
export function calculateRateMetrics(
	windowHistory: Array<{ totalTokens: number; windowStart: number; windowEnd: number }>,
	burnRatePerHour: number,
): RateMetrics {
	if (windowHistory.length === 0) {
		return { ...EMPTY_RATE_METRICS, tokensPerHour: burnRatePerHour };
	}

	// ~5 windows/day, ~34 windows/week
	const n = windowHistory.length;

	// Tokens/day: sum of last 5 windows (~24h)
	const daySlice = windowHistory.slice(Math.max(0, n - 5));
	const tokensPerDay = daySlice.reduce((s, w) => s + w.totalTokens, 0);

	// Tokens/week: sum of last 34 windows (~7 days)
	const weekSlice = windowHistory.slice(Math.max(0, n - 34));
	const tokensPerWeek = weekSlice.reduce((s, w) => s + w.totalTokens, 0);

	// Daily delta: compare last 5 vs previous 5
	const prevDaySlice = windowHistory.slice(Math.max(0, n - 10), Math.max(0, n - 5));
	const prevDayTotal = prevDaySlice.reduce((s, w) => s + w.totalTokens, 0);
	const dailyDelta = prevDayTotal > 0 ? ((tokensPerDay - prevDayTotal) / prevDayTotal) * 100 : 0;

	// Weekly delta: compare last 34 vs previous 34
	const prevWeekSlice = windowHistory.slice(Math.max(0, n - 68), Math.max(0, n - 34));
	const prevWeekTotal = prevWeekSlice.reduce((s, w) => s + w.totalTokens, 0);
	const weeklyDelta = prevWeekTotal > 0 ? ((tokensPerWeek - prevWeekTotal) / prevWeekTotal) * 100 : 0;

	// Trend: linear regression on last 20 windows
	const trendSlice = windowHistory.slice(Math.max(0, n - 20));
	let trend: 'up' | 'stable' | 'down' = 'stable';
	if (trendSlice.length >= 2) {
		const tLen = trendSlice.length;
		let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
		for (let i = 0; i < tLen; i++) {
			sumX += i;
			sumY += trendSlice[i].totalTokens;
			sumXY += i * trendSlice[i].totalTokens;
			sumX2 += i * i;
		}
		const denom = tLen * sumX2 - sumX * sumX;
		if (denom !== 0) {
			const slope = (tLen * sumXY - sumX * sumY) / denom;
			const meanY = sumY / tLen;
			const normalizedSlope = meanY > 0 ? (slope * tLen) / meanY : 0;
			if (normalizedSlope > 0.05) trend = 'up';
			else if (normalizedSlope < -0.05) trend = 'down';
		}
	}

	return {
		tokensPerHour: burnRatePerHour,
		tokensPerDay,
		tokensPerWeek,
		dailyDelta,
		weeklyDelta,
		trend,
	};
}

// ============================================================================
// Hook
// ============================================================================

/**
 * Hook that provides real-time per-account usage metrics.
 * Fetches on mount, subscribes to real-time updates, and recalculates
 * derived metrics (burn rate, time to limit) every 30 seconds.
 * Switches to 5-second updates when any account is within 5 minutes of reset.
 *
 * Also fetches billing window history once on mount for P90 prediction
 * and recalculates predictions when the current window's usage changes.
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
	const windowHistoriesRef = useRef<Record<string, Array<{ totalTokens: number; windowStart: number; windowEnd: number }>>>({});

	const calculateDerivedMetrics = useCallback((raw: {
		accountId: string;
		totalTokens: number;
		inputTokens: number;
		outputTokens: number;
		cacheReadTokens: number;
		cacheCreationTokens: number;
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

		// P90 prediction from window history
		const prediction = calculatePrediction(
			windowHistoriesRef.current[raw.accountId] || [],
			raw.totalTokens,
			raw.limitTokens,
			raw.windowEnd - raw.windowStart,
		);

		// Rate metrics from window history
		const rateMetrics = calculateRateMetrics(
			windowHistoriesRef.current[raw.accountId] || [],
			burnRatePerHour,
		);

		return {
			...raw,
			timeRemainingMs,
			burnRatePerHour,
			estimatedTimeToLimitMs,
			prediction,
			rateMetrics,
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
					inputTokens: usage.inputTokens || 0,
					outputTokens: usage.outputTokens || 0,
					cacheReadTokens: usage.cacheReadTokens || 0,
					cacheCreationTokens: usage.cacheCreationTokens || 0,
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
		} catch (err) {
			console.warn('[useAccountUsage] Failed to fetch usage data:', err);
			setLoading(false);
		}
	}, [calculateDerivedMetrics]);

	// Load window histories once on mount for P90 predictions
	useEffect(() => {
		async function loadHistories() {
			try {
				const accounts = await window.maestro.accounts.list();
				const histories: Record<string, Array<{ totalTokens: number; windowStart: number; windowEnd: number }>> = {};
				for (const account of (accounts || []) as Array<{ id: string }>) {
					try {
						const history = await window.maestro.accounts.getWindowHistory(account.id, 68) as Array<{
							inputTokens: number; outputTokens: number;
							cacheReadTokens: number; cacheCreationTokens: number;
							windowStart: number; windowEnd: number;
						}>;
						histories[account.id] = history.map(w => ({
							totalTokens: w.inputTokens + w.outputTokens + w.cacheReadTokens + w.cacheCreationTokens,
							windowStart: w.windowStart,
							windowEnd: w.windowEnd,
						}));
					} catch (err) { console.warn(`[useAccountUsage] Failed to load history for account ${account.id}:`, err); }
				}
				windowHistoriesRef.current = histories;
			} catch (err) { console.warn('[useAccountUsage] Failed to load window histories:', err); }
		}
		loadHistories();
	}, []);

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
					inputTokens: data.inputTokens || 0,
					outputTokens: data.outputTokens || 0,
					cacheReadTokens: data.cacheReadTokens || 0,
					cacheCreationTokens: data.cacheCreationTokens || 0,
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
