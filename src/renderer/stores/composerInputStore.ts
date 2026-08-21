/**
 * Live composer draft text (the main input textarea).
 *
 * WHY THIS EXISTS - keyboard performance:
 * The AI prompt / terminal command draft used to live in `useState` inside
 * `useInputHandlers`, which runs in `MaestroConsoleInner` (App.tsx). Every
 * keystroke called that setter and re-rendered the entire app tree, which is
 * the keyboard lag users felt (characters appearing slower than typed).
 *
 * Moving the draft here lets the single leaf that displays it (`InputArea`,
 * already `React.memo`) subscribe directly, while everything else reads the
 * current value non-reactively via `getState()`. App no longer re-renders per
 * keystroke. See CLAUDE-PERFORMANCE.md -> "React State Bail-out".
 *
 * Two slices, mirroring the previous dual `useState`:
 *  - `aiValue`: the active AI tab's draft. Written back to `tab.inputValue` on
 *    a short typing timer, and immediately on blur / submit / tab-switch (see
 *    useInputSync). The timer is what makes this slot safe to hold text in:
 *    it is a single global slot, so anything that skipped those three flush
 *    points used to lose what the user typed.
 *  - `terminalValue`: the active session's terminal command draft. Flushed to
 *    `session.terminalDraftInput` on blur / session-switch.
 *
 * This store holds only the *active* surface's live text; per-tab and
 * per-session persistence still lives on the session model, exactly as before.
 */

import { create } from 'zustand';
import type { ComposerCommandMode } from '../utils/shellCommandInput';

type Updater = string | ((prev: string) => string);

const resolve = (next: Updater, prev: string): string =>
	typeof next === 'function' ? next(prev) : next;

interface ComposerInputState {
	/** Live AI prompt draft for the active tab. */
	aiValue: string;
	/** Live terminal command draft for the active session. */
	terminalValue: string;
	/**
	 * Which rung of the bang ladder the active AI tab's composer is on: `'off'`
	 * (a message for the agent), `'shell'` (a literal command line), or `'ai'`
	 * (a description the model turns into a command line).
	 *
	 * Lives here, beside the text it qualifies, because the two must be read and
	 * flushed together: the same string means "run this in a shell", "ask the
	 * model for a command", or "say this to the agent" depending on this value,
	 * so any path that persists one has to persist the other. Mirrored to
	 * `AITab.commandMode` on the same blur / submit / tab-switch beats as
	 * `aiValue` -> `tab.inputValue`.
	 */
	aiCommandMode: ComposerCommandMode;
	setAiValue: (value: Updater) => void;
	setTerminalValue: (value: Updater) => void;
	setAiCommandMode: (commandMode: ComposerCommandMode) => void;
}

export const useComposerInputStore = create<ComposerInputState>()((set) => ({
	aiValue: '',
	terminalValue: '',
	aiCommandMode: 'off',
	setAiValue: (value) => set((s) => ({ aiValue: resolve(value, s.aiValue) })),
	setTerminalValue: (value) => set((s) => ({ terminalValue: resolve(value, s.terminalValue) })),
	setAiCommandMode: (commandMode) => set({ aiCommandMode: commandMode }),
}));

/** Selector: the live AI draft. */
export const selectAiComposerValue = (s: ComposerInputState): string => s.aiValue;

/** Selector: the live terminal draft. */
export const selectTerminalComposerValue = (s: ComposerInputState): string => s.terminalValue;

/** Selector: which rung of the bang ladder the AI composer is on. */
export const selectAiCommandMode = (s: ComposerInputState): ComposerCommandMode => s.aiCommandMode;

/** Selector: true while the AI composer holds a literal shell command line. */
export const selectIsShellCommandMode = (s: ComposerInputState): boolean =>
	s.aiCommandMode === 'shell';

/** Selector: true while the AI composer holds an AI command request. */
export const selectIsAiCommandMode = (s: ComposerInputState): boolean => s.aiCommandMode === 'ai';
