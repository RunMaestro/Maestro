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
	/**
	 * Which tab `aiValue` belongs to, or `null` when the text is not (yet) owned
	 * by any tab.
	 *
	 * WHY THIS EXISTS - draft bleed: attribution used to be inferred from a
	 * ref-mirror of "whatever tab is active right now", which is a different
	 * question. An agent is allowed to have zero AI tabs (a file tab open, every
	 * AI tab closed) and `activeSessionId` can name an agent whose session object
	 * has not landed yet - in both windows the composer is still on screen and
	 * typeable, and the inferred attribution pointed at the LAST AI tab of the
	 * PREVIOUS agent. Text typed there was flushed onto a stranger's tab.
	 *
	 * Stamping the owner beside the text makes the answer travel with the text:
	 * a flush goes to the tab the draft was loaded for (or adopted by), never to
	 * whatever is active when the write lands. `null` means "typed with no tab to
	 * put it in" - it is parked, not attributed, and the next tab to become
	 * active adopts it rather than the text being lost or misfiled.
	 */
	aiValueTabId: string | null;
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
	/**
	 * Put a tab's draft in the composer and stamp that tab as its owner, in one
	 * write. Text, mode and owner are a triple: the same string is a message, a
	 * shell command or a request for one depending on the mode, and it belongs to
	 * exactly one tab - so nothing may observe a state where they disagree.
	 *
	 * Pass `tabId: null` to park text that no tab owns yet.
	 */
	loadAiDraft: (tabId: string | null, value: string, commandMode: ComposerCommandMode) => void;
	/**
	 * Claim unowned composer text for a tab, leaving the text untouched. Used
	 * when a tab materializes under text the user already typed.
	 */
	adoptAiDraft: (tabId: string) => void;
}

export const useComposerInputStore = create<ComposerInputState>()((set) => ({
	aiValue: '',
	aiValueTabId: null,
	terminalValue: '',
	aiCommandMode: 'off',
	setAiValue: (value) => set((s) => ({ aiValue: resolve(value, s.aiValue) })),
	setTerminalValue: (value) => set((s) => ({ terminalValue: resolve(value, s.terminalValue) })),
	setAiCommandMode: (commandMode) => set({ aiCommandMode: commandMode }),
	loadAiDraft: (tabId, value, commandMode) =>
		set({ aiValue: value, aiValueTabId: tabId, aiCommandMode: commandMode }),
	adoptAiDraft: (tabId) => set({ aiValueTabId: tabId }),
}));

/** Selector: the live AI draft. */
export const selectAiComposerValue = (s: ComposerInputState): string => s.aiValue;

/** Selector: the tab the live AI draft belongs to, if any. */
export const selectAiComposerTabId = (s: ComposerInputState): string | null => s.aiValueTabId;

/** Selector: the live terminal draft. */
export const selectTerminalComposerValue = (s: ComposerInputState): string => s.terminalValue;

/** Selector: which rung of the bang ladder the AI composer is on. */
export const selectAiCommandMode = (s: ComposerInputState): ComposerCommandMode => s.aiCommandMode;

/** Selector: true while the AI composer holds a literal shell command line. */
export const selectIsShellCommandMode = (s: ComposerInputState): boolean =>
	s.aiCommandMode === 'shell';

/** Selector: true while the AI composer holds an AI command request. */
export const selectIsAiCommandMode = (s: ComposerInputState): boolean => s.aiCommandMode === 'ai';
