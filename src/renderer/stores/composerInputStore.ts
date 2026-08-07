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
 *  - `aiValue`: the active AI tab's draft. Flushed to `tab.inputValue` on
 *    blur / submit / tab-switch (owned by useInputHandlers).
 *  - `terminalValue`: the active session's terminal command draft. Flushed to
 *    `session.terminalDraftInput` on blur / session-switch.
 *
 * This store holds only the *active* surface's live text; per-tab and
 * per-session persistence still lives on the session model, exactly as before.
 */

import { create } from 'zustand';

type Updater = string | ((prev: string) => string);

const resolve = (next: Updater, prev: string): string =>
	typeof next === 'function' ? next(prev) : next;

interface ComposerInputState {
	/** Live AI prompt draft for the active tab. */
	aiValue: string;
	/** Live terminal command draft for the active session. */
	terminalValue: string;
	/**
	 * Whether the active AI tab's composer is in command mode (`!`), where the
	 * draft is a shell command rather than a message for the agent.
	 *
	 * Lives here, beside the text it qualifies, because the two must be read and
	 * flushed together: the same string means "run this in a shell" or "say this
	 * to the agent" depending on this flag, so any path that persists one has to
	 * persist the other. Mirrored to `AITab.commandMode` on the same blur /
	 * submit / tab-switch beats as `aiValue` -> `tab.inputValue`.
	 */
	aiCommandMode: boolean;
	setAiValue: (value: Updater) => void;
	setTerminalValue: (value: Updater) => void;
	setAiCommandMode: (commandMode: boolean) => void;
}

export const useComposerInputStore = create<ComposerInputState>()((set) => ({
	aiValue: '',
	terminalValue: '',
	aiCommandMode: false,
	setAiValue: (value) => set((s) => ({ aiValue: resolve(value, s.aiValue) })),
	setTerminalValue: (value) => set((s) => ({ terminalValue: resolve(value, s.terminalValue) })),
	setAiCommandMode: (commandMode) => set({ aiCommandMode: commandMode }),
}));

/** Selector: the live AI draft. */
export const selectAiComposerValue = (s: ComposerInputState): string => s.aiValue;

/** Selector: the live terminal draft. */
export const selectTerminalComposerValue = (s: ComposerInputState): string => s.terminalValue;

/** Selector: whether the AI composer is in command mode. */
export const selectAiCommandMode = (s: ComposerInputState): boolean => s.aiCommandMode;
