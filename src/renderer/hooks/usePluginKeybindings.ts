/**
 * usePluginKeybindings - binds contributed plugin keybindings to their plugin
 * commands.
 *
 * `KeybindingContribution`s are parsed + aggregated by the host, but until now
 * nothing listened for the chord. This hook closes that loop: it reads the
 * aggregated keybindings (via usePluginContributions, which refreshes on
 * `plugins.onChanged`), installs a single window `keydown` listener, and on a
 * chord match invokes the bound plugin command (`<pluginId>/<command>`) through
 * the broker.
 *
 * Conflict policy - plugin keybindings must never clobber the app's own
 * shortcuts:
 *   - while an input/textarea/select/contentEditable element is focused, skip
 *     bare (unmodified) chords so typing is never hijacked, but still let
 *     chords carrying Alt or Ctrl/Cmd through - nobody types with those held,
 *     and the composer textarea is Maestro's resting focus state, so an
 *     unconditional skip would leave every contributed chord inert by default.
 *     Shift alone does NOT count as a modifier here (Shift+letter is typing);
 *   - skip if the event was already handled (`defaultPrevented`), so an app
 *     shortcut that ran first wins. The app's central handler
 *     (useMainKeyboardHandler) binds a bubble-phase `window` keydown too, so
 *     this hook must be MOUNTED AFTER it (App calls usePluginKeybindings() right
 *     after useMainKeyboardHandler()) for same-target listener order to let the
 *     app win on a real conflict;
 *   - only `preventDefault()` once a plugin chord actually matches.
 *
 * Self-contained (no props) so App mounts it with a single call. When the
 * plugins Encore flag is off the contributions read yields empty buckets, so the
 * listener simply matches nothing.
 */

import { useEffect, useRef } from 'react';
import { usePluginContributions } from './usePluginContributions';
import type { KeybindingContribution } from '../../shared/plugins/contributions';

/** A keybinding chord reduced to matchable modifier flags + main key. */
interface ParsedChord {
	/** Ctrl (win/linux) or Cmd (mac) - matched as `e.metaKey || e.ctrlKey`. */
	meta: boolean;
	shift: boolean;
	alt: boolean;
	/** Lowercased non-modifier key (e.g. "p", "f9", "arrowleft"). */
	key: string;
	pluginId: string;
	command: string;
}

const META_TOKENS: Record<string, true> = {
	ctrl: true,
	control: true,
	cmd: true,
	command: true,
	meta: true,
};
const ALT_TOKENS: Record<string, true> = { alt: true, option: true };

/**
 * Parse a "Ctrl+Shift+P"-style chord into matchable flags + key. Treats Ctrl and
 * Cmd as the same "meta" modifier, mirroring the app's own convention
 * (useKeyboardShortcutHelpers). Returns null when the chord carries no concrete
 * (non-modifier) key.
 */
function parseChord(kb: KeybindingContribution): ParsedChord | null {
	let meta = false;
	let shift = false;
	let alt = false;
	let key = '';
	for (const raw of kb.key.split('+')) {
		const token = raw.trim();
		if (!token) continue;
		const lower = token.toLowerCase();
		if (META_TOKENS[lower]) meta = true;
		else if (lower === 'shift') shift = true;
		else if (ALT_TOKENS[lower]) alt = true;
		else key = lower;
	}
	if (!key) return null;
	return { meta, shift, alt, key, pluginId: kb.pluginId, command: kb.command };
}

/** Does the keyboard event satisfy the parsed chord? */
function matches(e: KeyboardEvent, chord: ParsedChord): boolean {
	if ((e.metaKey || e.ctrlKey) !== chord.meta) return false;
	if (e.shiftKey !== chord.shift) return false;
	if (e.altKey !== chord.alt) return false;
	if (e.key.toLowerCase() === chord.key) return true;
	// When Alt is held the layout may rewrite e.key (macOS Alt+p = π); fall back
	// to the physical key, kept symmetric with useKeyboardShortcutHelpers.
	if (e.altKey && e.code) {
		const codeKey = e.code
			.replace(/^Key/, '')
			.replace(/^Digit/, '')
			.toLowerCase();
		return codeKey === chord.key;
	}
	return false;
}

/** Is focus on a text-entry surface where a bare chord must not be intercepted? */
function isEditableTarget(target: EventTarget | null): boolean {
	const el = target as HTMLElement | null;
	if (!el || typeof el.tagName !== 'string') return false;
	const tag = el.tagName;
	return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
}

/**
 * Install the window keydown listener that dispatches contributed plugin
 * keybindings. Call once, near the top of the App tree, after
 * useMainKeyboardHandler().
 */
/**
 * Native editing and navigation chords a plugin must never claim while the user
 * is typing, even though they carry a hard modifier.
 *
 * Narrowing the input-focus skip to bare keys (AA1) made contributed chords
 * usable from the composer, but it also handed plugins every Ctrl/Cmd and Alt
 * combination the app itself does not bind - including undo, select-all, and
 * word-wise motion. Since a match calls `preventDefault()`, a plugin binding
 * `Ctrl+Z` would silently break undo mid-edit. The browser owns these; keep
 * them off the table.
 *
 * Matched on `e.key`, lower-cased, so layout-independent. Shift is ignored:
 * `Ctrl+Shift+Z` is redo and must be reserved for the same reason as `Ctrl+Z`.
 */
function isReservedEditingChord(e: KeyboardEvent): boolean {
	const key = e.key.toLowerCase();
	if (e.ctrlKey || e.metaKey) {
		// Clipboard, undo/redo, select-all, and the common text-entry verbs.
		if (['a', 'c', 'v', 'x', 'z', 'y', 'backspace', 'delete', 'insert'].includes(key)) return true;
		// Word-wise and document-wise motion.
		if (['arrowleft', 'arrowright', 'arrowup', 'arrowdown', 'home', 'end'].includes(key)) {
			return true;
		}
	}
	if (e.altKey) {
		// Word-wise motion and delete on macOS, and the Linux/Windows equivalents.
		if (['arrowleft', 'arrowright', 'backspace', 'delete'].includes(key)) return true;
	}
	return false;
}

export function usePluginKeybindings(): void {
	const { keybindings } = usePluginContributions();

	// Hold the current parsed chords in a ref so the listener (bound once) always
	// sees the latest set without re-installing on every contributions refresh.
	const chordsRef = useRef<ParsedChord[]>([]);
	useEffect(() => {
		chordsRef.current = keybindings
			.map(parseChord)
			.filter((chord): chord is ParsedChord => chord !== null);
	}, [keybindings]);

	useEffect(() => {
		const plugins = window.maestro?.plugins;
		if (!plugins) return;

		const onKeyDown = (e: KeyboardEvent): void => {
			// An app shortcut that ran first already claimed this event.
			if (e.defaultPrevented) return;
			// Never hijack typing: while a text surface has focus only chords that
			// carry Alt or Ctrl/Cmd may fire. Shift alone is typing, not a chord.
			// Reserved native editing chords are excluded even then - see
			// isReservedEditingChord. (AA1 review)
			const hasHardModifier = e.altKey || e.ctrlKey || e.metaKey;
			// AltGr is text entry, not a chord. On the Windows/Linux layouts that
			// have it (German, Polish, Brazilian and friends) the browser reports
			// AltGr as ctrlKey AND altKey, so `AltGr+Q` - which types `@` on a
			// German keyboard - looks exactly like a `Ctrl+Alt+Q` plugin chord and
			// would be swallowed by the preventDefault below. getModifierState is
			// the only way to tell the two apart. (Review of PR #1354)
			const isAltGraph = e.getModifierState?.('AltGraph') === true;
			if (
				isEditableTarget(e.target) &&
				(isAltGraph || !hasHardModifier || isReservedEditingChord(e))
			) {
				return;
			}
			for (const chord of chordsRef.current) {
				if (!matches(e, chord)) continue;
				e.preventDefault();
				void plugins.invokeCommand(`${chord.pluginId}/${chord.command}`).catch(() => undefined);
				return;
			}
		};

		window.addEventListener('keydown', onKeyDown);
		return () => window.removeEventListener('keydown', onKeyDown);
	}, []);
}
