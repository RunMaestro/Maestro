/**
 * Shared formatting utilities for displaying numbers, sizes, times, and tokens.
 * These pure functions are used by both renderer (desktop) and web (mobile) code.
 *
 * Functions:
 * - getActiveLocale: Get current locale from i18n (auto-detected)
 * - formatSize: File sizes (B, KB, MB, GB, TB)
 * - formatNumber: Large numbers with k/M/B suffixes
 * - formatTokens: Token counts with K/M/B suffixes (~prefix)
 * - formatTokensCompact: Token counts without ~prefix
 * - formatRelativeTime: Locale-aware relative timestamps ("5 minutes ago", "hace 5 minutos")
 * - formatActiveTime: Duration display (1D, 2H 30M, <1M)
 * - formatElapsedTime: Precise elapsed time (1h 10m, 30s, 500ms)
 * - formatElapsedTimeColon: Timer-style elapsed time (mm:ss or hh:mm:ss)
 * - formatCost: USD currency display ($1.23, <$0.01)
 * - estimateTokenCount: Estimate token count from text (~4 chars/token)
 * - truncatePath: Truncate file paths for display (.../<parent>/<current>)
 * - truncateCommand: Truncate command text for display with ellipsis
 */

import i18n from './i18n/config';

/**
 * Get the currently active locale from i18n, falling back to 'en'.
 * Used by locale-aware formatters to auto-detect the user's language.
 *
 * @param override - Optional locale override; if provided, returned as-is
 * @returns BCP 47 locale string (e.g., 'en', 'es', 'fr')
 */
export function getActiveLocale(override?: string): string {
	if (override) return override;
	try {
		return i18n?.language || 'en';
	} catch {
		return 'en';
	}
}

/**
 * Get a localized time unit label using i18n translations.
 * Falls back to a hardcoded English template if i18n is not initialized.
 *
 * @param key - Translation key under 'common:time.' (e.g., 'seconds_short')
 * @param count - The numeric value to interpolate
 * @param fallback - English fallback template with {{count}} placeholder
 * @param locale - Optional BCP 47 locale override
 * @returns Formatted time unit string (e.g., "5s", "10m")
 */
function getTimeUnitLabel(key: string, count: number, fallback: string, locale?: string): string {
	try {
		if (typeof i18n?.t === 'function') {
			const opts: Record<string, unknown> = { count };
			if (locale) opts.lng = locale;
			const fullKey = `common:time.${key}`;
			// Dynamic key constructed at runtime; cast to bypass strict typed-key checking
			const result = (i18n.t as (key: string, options?: Record<string, unknown>) => string)(
				fullKey,
				opts
			);
			if (result && result !== fullKey) return result;
		}
	} catch {
		// i18n not initialized, use fallback
	}
	return fallback.replace('{{count}}', String(count));
}

/**
 * Format a file size in bytes to a locale-aware human-readable string.
 * Automatically scales to appropriate unit (B, KB, MB, GB, TB).
 * Uses Intl.NumberFormat for locale-aware number formatting (e.g., "1.5 MB" in English, "1,5 MB" in French).
 * Unit suffixes are kept as international standards (B, KB, MB, GB, TB).
 *
 * @param bytes - The size in bytes
 * @param locale - Optional BCP 47 locale override (auto-detected from i18n if omitted)
 * @returns Formatted string (e.g., "1.5 MB", "1,5 MB")
 */
export function formatSize(bytes: number, locale?: string): string {
	const activeLocale = getActiveLocale(locale);
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	let unitIndex = 0;
	let value = bytes;

	while (value >= 1024 && unitIndex < units.length - 1) {
		value /= 1024;
		unitIndex++;
	}

	if (unitIndex === 0) {
		// Bytes are always integers, no decimal formatting needed
		return `${bytes} ${units[0]}`;
	}

	const formatted = new Intl.NumberFormat(activeLocale, {
		minimumFractionDigits: 1,
		maximumFractionDigits: 1,
	}).format(value);

	return `${formatted} ${units[unitIndex]}`;
}

/**
 * Format a large number with k/M/B suffixes for compact display.
 *
 * @param num - The number to format
 * @returns Formatted string (e.g., "1.5k", "2.3M", "1.0B")
 */
export function formatNumber(num: number): string {
	if (num < 1000) return num.toFixed(1);
	if (num < 1000000) return `${(num / 1000).toFixed(1)}k`;
	if (num < 1000000000) return `${(num / 1000000).toFixed(1)}M`;
	return `${(num / 1000000000).toFixed(1)}B`;
}

/**
 * Format a token count with locale-aware compact notation for display.
 * Uses approximate (~) prefix for larger numbers.
 * Uses Intl.NumberFormat with compact notation for locale-appropriate suffixes
 * (e.g., "~1K" in English, "~1 mil" in Spanish).
 *
 * @param tokens - The token count
 * @param locale - Optional BCP 47 locale override (auto-detected from i18n if omitted)
 * @returns Formatted string (e.g., "500", "~1K", "~2M", "~1B")
 */
export function formatTokens(tokens: number, locale?: string): string {
	if (tokens < 1000) return tokens.toString();
	const activeLocale = getActiveLocale(locale);
	const formatted = new Intl.NumberFormat(activeLocale, {
		notation: 'compact',
		maximumFractionDigits: 0,
	}).format(tokens);
	return `~${formatted}`;
}

/**
 * Format a token count compactly without the approximate prefix.
 * Useful for precise token displays.
 * Uses Intl.NumberFormat with compact notation for locale-aware formatting
 * (e.g., "1.5K" in English, "1,5 mil" in Spanish).
 *
 * @param tokens - The token count
 * @param locale - Optional BCP 47 locale override (auto-detected from i18n if omitted)
 * @returns Formatted string (e.g., "500", "1.5K", "2.3M", "5.8B")
 */
export function formatTokensCompact(tokens: number, locale?: string): string {
	if (tokens < 1000) return tokens.toString();
	const activeLocale = getActiveLocale(locale);
	return new Intl.NumberFormat(activeLocale, {
		notation: 'compact',
		minimumFractionDigits: 1,
		maximumFractionDigits: 1,
	}).format(tokens);
}

/**
 * Format a date/timestamp as locale-aware relative time.
 * Uses Intl.RelativeTimeFormat for localized output (e.g., "5 minutes ago" in English,
 * "hace 5 minutos" in Spanish, "5 分钟前" in Chinese).
 *
 * Thresholds: <1m → "now", <1h → minutes, <24h → hours, <7d → days, ≥7d → formatted date.
 *
 * @param dateOrTimestamp - Either a Date object, timestamp in milliseconds, or ISO date string
 * @param locale - Optional BCP 47 locale override (auto-detected from i18n if omitted)
 * @returns Locale-aware relative time string
 */
export function formatRelativeTime(
	dateOrTimestamp: Date | number | string,
	locale?: string
): string {
	let timestamp: number;

	if (typeof dateOrTimestamp === 'number') {
		timestamp = dateOrTimestamp;
	} else if (typeof dateOrTimestamp === 'string') {
		timestamp = new Date(dateOrTimestamp).getTime();
	} else {
		timestamp = dateOrTimestamp.getTime();
	}

	const activeLocale = getActiveLocale(locale);
	const now = Date.now();
	const diffMs = now - timestamp;
	const diffMins = Math.floor(diffMs / 60000);
	const diffHours = Math.floor(diffMins / 60);
	const diffDays = Math.floor(diffHours / 24);

	const rtf = new Intl.RelativeTimeFormat(activeLocale, { numeric: 'auto' });

	if (diffMins < 1) return rtf.format(0, 'second');
	if (diffMins < 60) return rtf.format(-diffMins, 'minute');
	if (diffHours < 24) return rtf.format(-diffHours, 'hour');
	if (diffDays < 7) return rtf.format(-diffDays, 'day');
	// Show locale-aware date format (e.g., "Dec 3" in English) for older dates
	return new Intl.DateTimeFormat(activeLocale, { month: 'short', day: 'numeric' }).format(
		new Date(timestamp)
	);
}

/**
 * Format duration in milliseconds as locale-aware compact display string.
 * Uses uppercase units (D, H, M) for consistency in English;
 * other locales use translated abbreviations via i18n.
 *
 * @param ms - Duration in milliseconds
 * @param locale - Optional BCP 47 locale override (auto-detected from i18n if omitted)
 * @returns Formatted string (e.g., "1D", "2H 30M", "15M", "<1M")
 */
export function formatActiveTime(ms: number, locale?: string): string {
	const activeLocale = getActiveLocale(locale);
	const totalSeconds = Math.floor(ms / 1000);
	const totalMinutes = Math.floor(totalSeconds / 60);
	const totalHours = Math.floor(totalMinutes / 60);
	const totalDays = Math.floor(totalHours / 24);

	if (totalDays > 0) {
		return getTimeUnitLabel('days_compact', totalDays, '{{count}}D', activeLocale);
	} else if (totalHours > 0) {
		const remainingMinutes = totalMinutes % 60;
		if (remainingMinutes > 0) {
			const h = getTimeUnitLabel('hours_compact', totalHours, '{{count}}H', activeLocale);
			const m = getTimeUnitLabel('minutes_compact', remainingMinutes, '{{count}}M', activeLocale);
			return `${h} ${m}`;
		}
		return getTimeUnitLabel('hours_compact', totalHours, '{{count}}H', activeLocale);
	} else if (totalMinutes > 0) {
		return getTimeUnitLabel('minutes_compact', totalMinutes, '{{count}}M', activeLocale);
	} else {
		return getTimeUnitLabel('less_than_minute', 0, '<1M', activeLocale);
	}
}

/**
 * Format elapsed time in milliseconds as locale-aware precise human-readable format.
 * Shows milliseconds for sub-second, seconds for <1m, minutes+seconds for <1h,
 * and hours+minutes for longer durations.
 *
 * @param ms - Duration in milliseconds
 * @param locale - Optional BCP 47 locale override (auto-detected from i18n if omitted)
 * @returns Formatted string (e.g., "500ms", "30s", "5m 12s", "1h 10m")
 */
export function formatElapsedTime(ms: number, locale?: string): string {
	const activeLocale = getActiveLocale(locale);
	if (ms < 1000) return getTimeUnitLabel('milliseconds_short', ms, '{{count}}ms', activeLocale);
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return getTimeUnitLabel('seconds_short', seconds, '{{count}}s', activeLocale);
	const minutes = Math.floor(seconds / 60);
	const remainingSeconds = seconds % 60;
	if (minutes < 60) {
		const m = getTimeUnitLabel('minutes_short', minutes, '{{count}}m', activeLocale);
		const s = getTimeUnitLabel('seconds_short', remainingSeconds, '{{count}}s', activeLocale);
		return `${m} ${s}`;
	}
	const hours = Math.floor(minutes / 60);
	const remainingMinutes = minutes % 60;
	const h = getTimeUnitLabel('hours_short', hours, '{{count}}h', activeLocale);
	const mLabel = getTimeUnitLabel('minutes_short', remainingMinutes, '{{count}}m', activeLocale);
	return `${h} ${mLabel}`;
}

/**
 * Format cost as locale-aware USD currency display.
 * Uses Intl.NumberFormat for locale-appropriate currency formatting
 * (e.g., "$1.23" in English, "1,23 $US" in French, "US$1.23" in Chinese).
 * Shows a "less than minimum" indicator for very small amounts.
 *
 * @param cost - The cost in USD
 * @param locale - Optional BCP 47 locale override (auto-detected from i18n if omitted)
 * @returns Formatted string (e.g., "$1.23", "<$0.01", "$0.00")
 */
export function formatCost(cost: number, locale?: string): string {
	const activeLocale = getActiveLocale(locale);

	const formatter = new Intl.NumberFormat(activeLocale, {
		style: 'currency',
		currency: 'USD',
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	});

	if (cost === 0) return formatter.format(0);

	if (cost > 0 && cost < 0.01) {
		// Prepend '<' to the locale-formatted minimum amount
		return '<' + formatter.format(0.01);
	}

	return formatter.format(cost);
}

/**
 * Format a number as a locale-aware percentage string.
 * Uses Intl.NumberFormat with `style: 'percent'` for correct symbol placement
 * (e.g., "50%" in English, "50 %" in French, "50%" in Chinese).
 *
 * @param value - The percentage as an integer 0–100 (will be divided by 100 internally)
 * @param locale - Optional BCP 47 locale override (auto-detected from i18n if omitted)
 * @returns Formatted percentage string (e.g., "50%", "50 %")
 */
export function formatPercent(value: number, locale?: string): string {
	const activeLocale = getActiveLocale(locale);
	return new Intl.NumberFormat(activeLocale, {
		style: 'percent',
		maximumFractionDigits: 0,
	}).format(value / 100);
}

/**
 * Estimate token count from text using rough approximation.
 * Uses ~4 characters per token for English text, which is a common heuristic.
 *
 * @param text - The text to estimate tokens for
 * @returns Estimated token count
 */
export function estimateTokenCount(text: string): number {
	if (!text) return 0;
	return Math.ceil(text.length / 4);
}

/**
 * Format elapsed time in seconds as timer-style display (mm:ss or hh:mm:ss).
 * Useful for live countdown/timer displays.
 *
 * @param seconds - Duration in seconds
 * @returns Formatted string (e.g., "5:12", "1:30:45")
 */
export function formatElapsedTimeColon(seconds: number): string {
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	const secs = seconds % 60;

	if (hours > 0) {
		return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
	}
	return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Truncate a file path for display, preserving the most relevant parts.
 * Shows ".../<parent>/<current>" format for long paths.
 *
 * @param path - The file path to truncate
 * @param maxLength - Maximum length of the returned string (default: 35)
 * @returns Truncated path string (e.g., ".../parent/current")
 */
export function truncatePath(path: string, maxLength: number = 35): string {
	if (!path) return '';
	if (path.length <= maxLength) return path;

	// Detect path separator (Windows vs Unix)
	const separator = path.includes('\\') ? '\\' : '/';
	const parts = path.split(/[/\\]/).filter(Boolean);

	if (parts.length === 0) return path;

	// Show the last two parts with ellipsis
	if (parts.length === 1) {
		return `...${path.slice(-maxLength + 3)}`;
	}

	const lastTwo = parts.slice(-2).join(separator);
	if (lastTwo.length > maxLength - 4) {
		return `...${separator}${parts[parts.length - 1].slice(-(maxLength - 5))}`;
	}

	return `...${separator}${lastTwo}`;
}

/**
 * Truncate command text for display.
 * Replaces newlines with spaces, trims whitespace, and adds ellipsis if truncated.
 *
 * @param command - The command text to truncate
 * @param maxLength - Maximum length of the returned string (default: 40)
 * @returns Truncated command string (e.g., "npm run build --...")
 */
export function truncateCommand(command: string, maxLength: number = 40): string {
	// Replace newlines with spaces for single-line display
	const singleLine = command.replace(/\n/g, ' ').trim();
	if (singleLine.length <= maxLength) return singleLine;
	return singleLine.slice(0, maxLength - 1) + '…';
}
