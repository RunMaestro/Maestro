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
 *   VOICE_HUD     - the floating voice HUD; hidden while a blocking modal is
 *                   open, under everything below
 *   VOICE_HUD_TOOLTIP - hover help for the HUD's own controls, which a plain
 *                   tooltip (z 10000) would draw behind the HUD
 *   DICTATION_INDICATOR - the "Dictating" pill; over modals because a text box
 *                   inside one can be dictated into, and a microphone that is
 *                   recording must never be hidden behind the surface using it
 *   CONFETTI      - celebration particles; decorative, sits under real UI
 *   TOAST         - notifications, visible over modals so async results aren't lost
 *   QUICK_ACTIONS - the command palette owns the screen while it is open,
 *                   including over a stack of toasts
 *   CENTER_FLASH  - momentary "I did the thing" ack; always the top-most pixel
 */
export const Z_LAYERS = {
	VOICE_HUD: 90000,
	VOICE_HUD_TOOLTIP: 90001,
	DICTATION_INDICATOR: 90002,
	CONFETTI: 99998,
	TOAST: 100000,
	QUICK_ACTIONS: 100001,
	CENTER_FLASH: 100002,
} as const;
