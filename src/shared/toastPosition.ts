/**
 * Toast position presets - which window corner the toast stack is pinned to.
 *
 * The stack always grows AWAY from its corner: a bottom corner stacks upward, a
 * top corner stacks downward, and the newest toast sits nearest the corner in
 * both cases. Kept in shared/ beside `toastWidth.ts` so the settings store, the
 * Settings panel, and the Toast component share one type, validator, and label
 * set without duplication.
 */

export const TOAST_POSITIONS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const;

export type ToastPosition = (typeof TOAST_POSITIONS)[number];

/** Maestro's historical placement, and the default for new installs. */
export const DEFAULT_TOAST_POSITION: ToastPosition = 'bottom-right';

export const isToastPosition = (value: unknown): value is ToastPosition =>
	typeof value === 'string' && TOAST_POSITIONS.includes(value as ToastPosition);

/**
 * Display name for each preset. Single source of truth so the Settings toggle
 * group and the preview toast fired when the setting changes never drift apart.
 */
export const TOAST_POSITION_LABELS: Record<ToastPosition, string> = {
	'top-left': 'Top Left',
	'top-right': 'Top Right',
	'bottom-left': 'Bottom Left',
	'bottom-right': 'Bottom Right',
};

export const isTopToastPosition = (position: ToastPosition): boolean =>
	position === 'top-left' || position === 'top-right';

export const isLeftToastPosition = (position: ToastPosition): boolean =>
	position === 'top-left' || position === 'bottom-left';

/**
 * The side bar a 'dynamic' width toast matches: the one on the toast's side.
 * A left-corner toast sized to the Right Bar would spill past the Left Bar
 * column it sits over, so each side tracks its own panel.
 */
export const toastSidePanel = (
	position: ToastPosition,
	widths: { leftSidebarWidth: number; rightPanelWidth: number }
): { width: number; name: 'Left Bar' | 'Right Bar' } =>
	isLeftToastPosition(position)
		? { width: widths.leftSidebarWidth, name: 'Left Bar' }
		: { width: widths.rightPanelWidth, name: 'Right Bar' };

/**
 * Distance (px) a top-anchored stack sits below the window top. The custom
 * title bar is `h-10` (40px) and holds the macOS traffic lights on the left, so
 * a toast pinned any higher would cover the window controls. The extra 8px
 * matches the gap between stacked toasts.
 */
export const TOAST_TOP_OFFSET = 48;

/**
 * Distance (px) a bottom-anchored stack sits above the window bottom when
 * nothing needs to be cleared. Matches the gap between stacked toasts.
 */
export const TOAST_BOTTOM_OFFSET = 8;

/** Gap (px) between stacked toasts. */
export const TOAST_STACK_GAP = 8;

/** One-line description for the preview toast fired when the position changes. */
export const describeToastPosition = (position: ToastPosition): string =>
	isTopToastPosition(position)
		? `Toasts now appear in the ${TOAST_POSITION_LABELS[position].toLowerCase()} corner and stack downward.`
		: `Toasts now appear in the ${TOAST_POSITION_LABELS[position].toLowerCase()} corner and stack upward.`;
