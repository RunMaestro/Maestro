export const NOTIFICATION_COLORS = ['green', 'yellow', 'orange', 'red', 'theme'] as const;

export type NotificationColor = (typeof NOTIFICATION_COLORS)[number];

export const NOTIFICATION_VARIANT_COLORS = {
	success: 'green',
	info: 'theme',
	warning: 'yellow',
	error: 'red',
} as const satisfies Readonly<Record<string, NotificationColor>>;

export type NotificationVariant = keyof typeof NOTIFICATION_VARIANT_COLORS;

export type NotificationColorResolution =
	{ ok: true; color: NotificationColor } | { ok: false; source: 'color' | 'alias' };

export function resolveNotificationColor(
	color: string | undefined,
	alias: string | undefined,
	aliases: Readonly<Record<string, NotificationColor>> = NOTIFICATION_VARIANT_COLORS
): NotificationColorResolution {
	if (color !== undefined) {
		return NOTIFICATION_COLORS.includes(color as NotificationColor)
			? { ok: true, color: color as NotificationColor }
			: { ok: false, source: 'color' };
	}

	if (alias !== undefined) {
		const resolved = aliases[alias];
		return resolved === undefined ? { ok: false, source: 'alias' } : { ok: true, color: resolved };
	}

	return { ok: true, color: 'theme' };
}
/**
 * Parses an optional external notification duration in the caller's own unit.
 * A result of null means the supplied value is non-finite or non-positive;
 * callers retain unit conversion and maximum-specific error text.
 */
export function parseNotificationTimeout(value: unknown): number | null | undefined {
	if (value === undefined) return undefined;
	const timeout = Number(value);
	return Number.isFinite(timeout) && timeout > 0 ? timeout : null;
}

export function isNotificationTimeoutWithinLimit(timeout: number, maximum: number): boolean {
	return timeout <= maximum;
}
