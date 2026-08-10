/**
 * Canonical z-index scale for the surfaces that live ABOVE ordinary modals.
 *
 * Everything up to and including a normal modal uses plain Tailwind classes
 * (`z-[9999]` for a modal backdrop, `z-[10000]`/`z-[10001]` for menus and
 * tooltips anchored inside one). Those numbers are fine because they only ever
 * compete with each other. The values here are different: they are the handful
 * of overlays that deliberately outrank a modal, so their relative order is a
 * product decision and must live in one place instead of being rediscovered as
 * a magic number in each component.
 *
 * Order, lowest to highest:
 *   CONFETTI      - celebration particles; decorative, sits under real UI
 *   TOAST         - notifications, visible over modals so async results aren't lost
 *   QUICK_ACTIONS - the command palette owns the screen while it is open,
 *                   including over a stack of toasts
 *   CENTER_FLASH  - momentary "I did the thing" ack; always the top-most pixel
 */
export const Z_LAYERS = {
	CONFETTI: 99998,
	TOAST: 100000,
	QUICK_ACTIONS: 100001,
	CENTER_FLASH: 100002,
} as const;
