import type React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	findPartialMentionAtCursor,
	handleComposerAgentTabKey,
	handleComposerFindKey,
	handleComposerPickerKey,
	handleComposerSendKey,
	PICKER_KEYS,
	yieldKeyToIme,
} from '../../../renderer/hooks/input/composerKeyDown';
import type { AgentMentionSuggestion } from '../../../shared/maestro-lib/mentions/roster';
import { isImeComposing } from '../../../renderer/utils/ime';
import { useUIStore } from '../../../renderer/stores/uiStore';
import { OUTPUT_SEARCH_INPUT_SELECTOR } from '../../../renderer/hooks/ui/useOutputSearchLayer';

type KeyInit = {
	key: string;
	metaKey?: boolean;
	ctrlKey?: boolean;
	shiftKey?: boolean;
	altKey?: boolean;
	keyCode?: number;
	nativeEvent?: { isComposing?: boolean };
};

/** An Enter as Chromium reports it mid-composition, and as Safari reports the confirming one. */
const CHROMIUM_COMPOSING = { nativeEvent: { isComposing: true }, keyCode: 229 };
const SAFARI_CONFIRM = { nativeEvent: { isComposing: false }, keyCode: 229 };

function keyEvent(init: KeyInit) {
	const preventDefault = vi.fn();
	const stopPropagation = vi.fn();
	const event = {
		metaKey: false,
		ctrlKey: false,
		shiftKey: false,
		altKey: false,
		...init,
		preventDefault,
		stopPropagation,
	} as unknown as React.KeyboardEvent;
	return { event, preventDefault, stopPropagation };
}

function textareaRef() {
	const el = document.createElement('textarea');
	document.body.appendChild(el);
	return { current: el } as React.RefObject<HTMLTextAreaElement>;
}

describe('isImeComposing', () => {
	it('reads isComposing and keyCode 229', () => {
		expect(isImeComposing(keyEvent({ key: 'Enter', ...CHROMIUM_COMPOSING }).event)).toBe(true);
		expect(isImeComposing(keyEvent({ key: 'Enter', ...SAFARI_CONFIRM }).event)).toBe(true);
		expect(
			isImeComposing(keyEvent({ key: 'Enter', nativeEvent: { isComposing: true } }).event)
		).toBe(true);
		expect(isImeComposing(keyEvent({ key: 'Enter', keyCode: 13 }).event)).toBe(false);
		expect(isImeComposing(keyEvent({ key: 'Enter' }).event)).toBe(false);
	});

	it('supports native DOM KeyboardEvents as well', () => {
		const nativeComposing = new KeyboardEvent('keydown', { key: 'Escape' });
		Object.defineProperty(nativeComposing, 'isComposing', { value: true, configurable: true });
		expect(isImeComposing(nativeComposing)).toBe(true);

		const native229 = new KeyboardEvent('keydown', {
			key: 'Escape',
			keyCode: 229,
		} as KeyboardEventInit);
		expect(isImeComposing(native229)).toBe(true);

		const nativePlain = new KeyboardEvent('keydown', { key: 'Escape' });
		expect(isImeComposing(nativePlain)).toBe(false);
	});
});

describe('yieldKeyToIme', () => {
	it('claims a listed key mid-composition without preventDefault, in both shapes', () => {
		for (const shape of [CHROMIUM_COMPOSING, SAFARI_CONFIRM]) {
			for (const key of ['Enter', 'Tab', 'ArrowDown', 'ArrowUp']) {
				const { event, preventDefault, stopPropagation } = keyEvent({ key, ...shape });
				expect(yieldKeyToIme(event, PICKER_KEYS)).toBe(true);
				expect(preventDefault).not.toHaveBeenCalled();
				expect(stopPropagation).not.toHaveBeenCalled();
			}
		}
	});

	it('stops a composing Escape at the composer so the window does not blur it', () => {
		const { event, preventDefault, stopPropagation } = keyEvent({
			key: 'Escape',
			...CHROMIUM_COMPOSING,
		});
		expect(yieldKeyToIme(event, PICKER_KEYS)).toBe(true);
		expect(preventDefault).not.toHaveBeenCalled();
		expect(stopPropagation).toHaveBeenCalledTimes(1);
	});

	it('leaves an unlisted key and every key outside a composition alone', () => {
		const unlisted = keyEvent({ key: 'ArrowLeft', ...CHROMIUM_COMPOSING });
		expect(yieldKeyToIme(unlisted.event, PICKER_KEYS)).toBe(false);
		for (const key of PICKER_KEYS) {
			const plain = keyEvent({ key, keyCode: 13 });
			expect(yieldKeyToIme(plain.event, PICKER_KEYS)).toBe(false);
			expect(plain.stopPropagation).not.toHaveBeenCalled();
		}
	});
});

describe('handleComposerFindKey', () => {
	let setOutputSearchOpen: ReturnType<typeof vi.fn>;
	beforeEach(() => {
		setOutputSearchOpen = vi.fn();
		useUIStore.setState({ setOutputSearchOpen, outputSearchByKey: {} } as never);
	});

	it('opens the resolved search key on Cmd+F and Ctrl+F', () => {
		for (const mod of [{ metaKey: true }, { ctrlKey: true }]) {
			const { event, preventDefault, stopPropagation } = keyEvent({ key: 'f', ...mod });
			expect(handleComposerFindKey(event, { resolveSearchKey: () => 'k1' })).toBe(true);
			expect(preventDefault).toHaveBeenCalled();
			expect(stopPropagation).not.toHaveBeenCalled();
		}
		expect(setOutputSearchOpen).toHaveBeenCalledWith('k1', true);
	});

	it('ignores Opt+Cmd+F and a plain f', () => {
		expect(
			handleComposerFindKey(keyEvent({ key: 'f', metaKey: true, altKey: true }).event, {
				resolveSearchKey: () => 'k1',
			})
		).toBe(false);
		expect(
			handleComposerFindKey(keyEvent({ key: 'f' }).event, { resolveSearchKey: () => 'k1' })
		).toBe(false);
	});

	it('still claims the chord when there is no search key', () => {
		const { event, preventDefault } = keyEvent({ key: 'f', metaKey: true });
		expect(handleComposerFindKey(event, { resolveSearchKey: () => null })).toBe(true);
		expect(preventDefault).toHaveBeenCalled();
		expect(setOutputSearchOpen).not.toHaveBeenCalled();
	});

	it('handles Cmd+Shift+F when not isolated', () => {
		const { event } = keyEvent({ key: 'f', metaKey: true, shiftKey: true });
		expect(handleComposerFindKey(event, { resolveSearchKey: () => 'k1' })).toBe(true);
	});

	describe('isolated from the window keys', () => {
		it('leaves Cmd+Shift+F to the window', () => {
			const { event, preventDefault } = keyEvent({ key: 'f', metaKey: true, shiftKey: true });
			expect(
				handleComposerFindKey(event, { resolveSearchKey: () => 'k1', isolateFromWindowKeys: true })
			).toBe(false);
			expect(preventDefault).not.toHaveBeenCalled();
		});

		it('opens a closed bar and stops the key', () => {
			const { event, stopPropagation } = keyEvent({ key: 'f', metaKey: true });
			handleComposerFindKey(event, { resolveSearchKey: () => 'k1', isolateFromWindowKeys: true });
			expect(stopPropagation).toHaveBeenCalled();
			expect(setOutputSearchOpen).toHaveBeenCalledWith('k1', true);
		});

		it('refocuses an open bar instead of reopening it', () => {
			useUIStore.setState({ outputSearchByKey: { k1: { open: true } } } as never);
			const input = document.createElement('input');
			const querySelector = vi.spyOn(document, 'querySelector').mockReturnValue(input);
			const focus = vi.spyOn(input, 'focus');

			handleComposerFindKey(keyEvent({ key: 'f', metaKey: true }).event, {
				resolveSearchKey: () => 'k1',
				isolateFromWindowKeys: true,
			});

			expect(querySelector).toHaveBeenCalledWith(OUTPUT_SEARCH_INPUT_SELECTOR);
			expect(focus).toHaveBeenCalled();
			expect(setOutputSearchOpen).not.toHaveBeenCalled();
			querySelector.mockRestore();
		});
	});
});

describe('handleComposerPickerKey', () => {
	function picker(overrides: Partial<Parameters<typeof handleComposerPickerKey<string>>[1]> = {}) {
		let selected = overrides.selectedIndex ?? 0;
		const options = {
			open: true,
			items: ['a', 'b', 'c'],
			selectedIndex: selected,
			setSelectedIndex: vi.fn((update: React.SetStateAction<number>) => {
				selected = typeof update === 'function' ? update(selected) : update;
			}),
			accept: vi.fn(),
			close: vi.fn(),
			inputRef: textareaRef(),
			...overrides,
		};
		return {
			options,
			get selected() {
				return selected;
			},
		};
	}

	it('does nothing while closed', () => {
		const p = picker({ open: false });
		expect(handleComposerPickerKey(keyEvent({ key: 'ArrowDown' }).event, p.options)).toBe(false);
		expect(p.options.setSelectedIndex).not.toHaveBeenCalled();
	});

	it('moves the selection, clamped at both ends', () => {
		const down = picker({ selectedIndex: 2 });
		handleComposerPickerKey(keyEvent({ key: 'ArrowDown' }).event, down.options);
		expect(down.selected).toBe(2);
		const up = picker({ selectedIndex: 0 });
		handleComposerPickerKey(keyEvent({ key: 'ArrowUp' }).event, up.options);
		expect(up.selected).toBe(0);
		const mid = picker({ selectedIndex: 1 });
		handleComposerPickerKey(keyEvent({ key: 'ArrowDown' }).event, mid.options);
		expect(mid.selected).toBe(2);
	});

	it('leaves the selection alone in an empty picker', () => {
		const p = picker({ items: [] });
		expect(handleComposerPickerKey(keyEvent({ key: 'ArrowDown' }).event, p.options)).toBe(true);
		expect(p.options.setSelectedIndex).not.toHaveBeenCalled();
	});

	it.each([
		{ key: 'Tab' },
		{ key: 'Enter' },
		{ key: 'Enter', shiftKey: true },
		{ key: 'Enter', metaKey: true },
	])('accepts the selected row on %o', (init) => {
		const p = picker({ selectedIndex: 1 });
		expect(handleComposerPickerKey(keyEvent(init).event, p.options)).toBe(true);
		expect(p.options.accept).toHaveBeenCalledWith('b');
		expect(p.options.close).not.toHaveBeenCalled();
	});

	it('closes without inserting when the selection is stale', () => {
		const p = picker({ selectedIndex: 5 });
		handleComposerPickerKey(keyEvent({ key: 'Enter' }).event, p.options);
		expect(p.options.accept).not.toHaveBeenCalled();
		expect(p.options.close).toHaveBeenCalled();
	});

	it('closes on Escape and keeps the caret in the composer', () => {
		const p = picker();
		const focus = vi.spyOn(p.options.inputRef.current!, 'focus');
		handleComposerPickerKey(keyEvent({ key: 'Escape' }).event, p.options);
		expect(p.options.close).toHaveBeenCalled();
		expect(focus).toHaveBeenCalled();
	});

	it('passes other keys through', () => {
		const p = picker();
		expect(handleComposerPickerKey(keyEvent({ key: 'ArrowLeft' }).event, p.options)).toBe(false);
	});

	it('keeps Escape from the window even when not isolated', () => {
		const closing = keyEvent({ key: 'Escape' });
		handleComposerPickerKey(closing.event, picker().options);
		expect(closing.stopPropagation).toHaveBeenCalled();

		const composing = keyEvent({ key: 'Escape', ...CHROMIUM_COMPOSING });
		handleComposerPickerKey(composing.event, picker().options);
		expect(composing.stopPropagation).toHaveBeenCalled();
	});

	it('leaves Escape alone while the picker is closed', () => {
		const { event, stopPropagation, preventDefault } = keyEvent({ key: 'Escape' });
		expect(handleComposerPickerKey(event, picker({ open: false }).options)).toBe(false);
		expect(stopPropagation).not.toHaveBeenCalled();
		expect(preventDefault).not.toHaveBeenCalled();
	});

	describe('during an IME composition', () => {
		it.each([
			{ key: 'Enter' },
			{ key: 'Enter', metaKey: true },
			{ key: 'Enter', ctrlKey: true },
			{ key: 'Tab' },
			{ key: 'ArrowDown' },
			{ key: 'ArrowUp' },
			{ key: 'Escape' },
		])('leaves %o to the IME', (init) => {
			for (const ime of [CHROMIUM_COMPOSING, SAFARI_CONFIRM]) {
				const p = picker({ selectedIndex: 1 });
				const { event, preventDefault } = keyEvent({ ...init, ...ime });
				expect(handleComposerPickerKey(event, p.options)).toBe(true);
				expect(preventDefault).not.toHaveBeenCalled();
				expect(p.options.accept).not.toHaveBeenCalled();
				expect(p.options.close).not.toHaveBeenCalled();
				expect(p.options.setSelectedIndex).not.toHaveBeenCalled();
			}
		});

		it('still keeps the key from the window when isolated', () => {
			const { event, stopPropagation } = keyEvent({ key: 'Enter', ...CHROMIUM_COMPOSING });
			handleComposerPickerKey(event, { ...picker().options, isolateFromWindowKeys: true });
			expect(stopPropagation).toHaveBeenCalled();
		});

		it('passes other keys through', () => {
			const p = picker();
			const { event } = keyEvent({ key: 'a', ...CHROMIUM_COMPOSING });
			expect(handleComposerPickerKey(event, p.options)).toBe(false);
		});
	});

	it('stops handled keys only when isolated from the window keys', () => {
		for (const key of ['ArrowDown', 'ArrowUp', 'Tab', 'Enter']) {
			const shared = keyEvent({ key });
			handleComposerPickerKey(shared.event, picker().options);
			expect(shared.stopPropagation).not.toHaveBeenCalled();
		}

		for (const key of ['ArrowDown', 'ArrowUp', 'Tab', 'Enter', 'Escape']) {
			const isolated = keyEvent({ key });
			handleComposerPickerKey(isolated.event, { ...picker().options, isolateFromWindowKeys: true });
			expect(isolated.stopPropagation).toHaveBeenCalled();
		}
	});
});

describe('handleComposerSendKey', () => {
	let send: ReturnType<typeof vi.fn>;
	beforeEach(() => {
		send = vi.fn();
	});
	afterEach(() => {
		document.body.innerHTML = '';
	});

	function press(init: KeyInit, enterToSend: boolean, isolateFromWindowKeys = false) {
		const k = keyEvent(init);
		const handled = handleComposerSendKey(k.event, {
			enterToSend,
			send,
			inputRef: textareaRef(),
			isolateFromWindowKeys,
		});
		return { ...k, handled };
	}

	describe('Enter to send', () => {
		it('sends on Enter and Cmd/Ctrl+Enter', () => {
			press({ key: 'Enter' }, true);
			press({ key: 'Enter', metaKey: true }, true);
			press({ key: 'Enter', ctrlKey: true }, true);
			expect(send).toHaveBeenCalledTimes(3);
		});

		it('leaves Shift+Enter as a newline', () => {
			const { preventDefault, handled } = press({ key: 'Enter', shiftKey: true }, true);
			expect(handled).toBe(true);
			expect(send).not.toHaveBeenCalled();
			expect(preventDefault).not.toHaveBeenCalled();
		});
	});

	describe('Cmd+Enter to send', () => {
		it('sends only on Cmd/Ctrl+Enter', () => {
			const plain = press({ key: 'Enter' }, false);
			expect(plain.preventDefault).not.toHaveBeenCalled();
			expect(send).not.toHaveBeenCalled();
			press({ key: 'Enter', metaKey: true }, false);
			press({ key: 'Enter', ctrlKey: true }, false);
			expect(send).toHaveBeenCalledTimes(2);
		});
	});

	it('stops every Cmd/Ctrl+Enter when isolated, sent or not', () => {
		const sent = press({ key: 'Enter', metaKey: true }, false, true);
		expect(sent.stopPropagation).toHaveBeenCalled();
		const unsent = press({ key: 'Enter', metaKey: true, shiftKey: true }, true, true);
		expect(unsent.stopPropagation).toHaveBeenCalled();
		expect(unsent.preventDefault).toHaveBeenCalled();
		expect(send).toHaveBeenCalledTimes(1);
		const plain = press({ key: 'Enter' }, true, true);
		expect(plain.stopPropagation).not.toHaveBeenCalled();
	});

	it('does not stop Cmd+Enter when not isolated', () => {
		const { stopPropagation } = press({ key: 'Enter', metaKey: true }, false);
		expect(stopPropagation).not.toHaveBeenCalled();
	});

	it('moves focus to the escape target on Escape', () => {
		const inputRef = textareaRef();
		inputRef.current!.focus();
		const target = document.createElement('div');
		target.tabIndex = -1;
		document.body.appendChild(target);
		const { event, preventDefault } = keyEvent({ key: 'Escape' });

		expect(
			handleComposerSendKey(event, {
				enterToSend: true,
				send,
				inputRef,
				escapeFocusTarget: { current: target },
			})
		).toBe(true);
		expect(preventDefault).toHaveBeenCalled();
		expect(document.activeElement).toBe(target);
	});

	it('leaves Escape to the window without an escape target', () => {
		const { handled, preventDefault } = press({ key: 'Escape' }, true);
		expect(handled).toBe(false);
		expect(preventDefault).not.toHaveBeenCalled();
	});

	it('passes other keys through', () => {
		expect(press({ key: 'a' }, true).handled).toBe(false);
	});

	describe('during an IME composition', () => {
		it.each([true, false])('never sends on any Enter (enterToSend %s)', (enterToSend) => {
			for (const ime of [CHROMIUM_COMPOSING, SAFARI_CONFIRM]) {
				for (const mods of [{}, { metaKey: true }, { ctrlKey: true }, { shiftKey: true }]) {
					const { handled, preventDefault } = press({ key: 'Enter', ...mods, ...ime }, enterToSend);
					expect(handled).toBe(true);
					expect(preventDefault).not.toHaveBeenCalled();
				}
			}
			expect(send).not.toHaveBeenCalled();
		});

		it('still stops Cmd/Ctrl+Enter when isolated, and only that', () => {
			const chord = press({ key: 'Enter', metaKey: true, ...CHROMIUM_COMPOSING }, true, true);
			expect(chord.stopPropagation).toHaveBeenCalled();
			const plain = press({ key: 'Enter', ...CHROMIUM_COMPOSING }, true, true);
			expect(plain.stopPropagation).not.toHaveBeenCalled();
			expect(send).not.toHaveBeenCalled();
		});

		it('sends again once the composition is over', () => {
			press({ key: 'Enter', ...CHROMIUM_COMPOSING }, true);
			press({ key: 'Enter', nativeEvent: { isComposing: false }, keyCode: 13 }, true);
			expect(send).toHaveBeenCalledTimes(1);
		});

		it.each([true, false])(
			'claims Escape without preventDefault or blur (with target: %s)',
			(hasTarget) => {
				for (const ime of [CHROMIUM_COMPOSING, SAFARI_CONFIRM]) {
					const inputRef = textareaRef();
					inputRef.current!.focus();
					const blurSpy = vi.spyOn(inputRef.current!, 'blur');
					const target = document.createElement('div');
					target.tabIndex = -1;
					document.body.appendChild(target);
					const { event, preventDefault, stopPropagation } = keyEvent({ key: 'Escape', ...ime });

					const handled = handleComposerSendKey(event, {
						enterToSend: true,
						send,
						inputRef,
						escapeFocusTarget: hasTarget ? { current: target } : undefined,
					});

					expect(handled).toBe(true);
					expect(preventDefault).not.toHaveBeenCalled();
					expect(stopPropagation).toHaveBeenCalled();
					expect(blurSpy).not.toHaveBeenCalled();
					expect(document.activeElement).toBe(inputRef.current);
				}
			}
		);

		it('stops composing Escape even when isolateFromWindowKeys is true (room surface)', () => {
			for (const ime of [CHROMIUM_COMPOSING, SAFARI_CONFIRM]) {
				const inputRef = textareaRef();
				const { event, preventDefault, stopPropagation } = keyEvent({ key: 'Escape', ...ime });

				const handled = handleComposerSendKey(event, {
					enterToSend: false,
					send,
					inputRef,
					isolateFromWindowKeys: true,
				});

				expect(handled).toBe(true);
				expect(preventDefault).not.toHaveBeenCalled();
				expect(stopPropagation).toHaveBeenCalled();
			}
		});
	});
});

describe('findPartialMentionAtCursor', () => {
	it('detects a partial reference at the end of input', () => {
		expect(findPartialMentionAtCursor('ask @co', 7)).toEqual({
			startIndex: 4,
			filter: 'co',
		});
	});

	it('detects a partial reference with cursor in mid-word', () => {
		expect(findPartialMentionAtCursor('ask @co and more', 7)).toEqual({
			startIndex: 4,
			filter: 'co',
		});
		expect(findPartialMentionAtCursor('ask @co-dy more', 7)).toEqual({
			startIndex: 4,
			filter: 'co-dy',
		});
	});

	it('detects bare @ trigger', () => {
		expect(findPartialMentionAtCursor('ask @', 5)).toEqual({
			startIndex: 4,
			filter: '',
		});
	});

	it('detects a completed name without a trailing space', () => {
		expect(findPartialMentionAtCursor('ask @cody', 9)).toEqual({
			startIndex: 4,
			filter: 'cody',
		});
	});

	it('returns null when preceded by non-whitespace (email address)', () => {
		expect(findPartialMentionAtCursor('user@example.com', 8)).toBeNull();
	});

	it('returns null when cursor is past a trailing space', () => {
		expect(findPartialMentionAtCursor('ask @cody ', 10)).toBeNull();
		expect(findPartialMentionAtCursor('ask @cody please', 12)).toBeNull();
	});

	it('returns null when newline sits between @ and cursor', () => {
		expect(findPartialMentionAtCursor('ask @cody\nnext', 13)).toBeNull();
	});

	it('stops tail before sentence punctuation', () => {
		expect(findPartialMentionAtCursor('ask @cody, please', 9)).toEqual({
			startIndex: 4,
			filter: 'cody',
		});
	});

	it('preserves opening quote and includes quoted tail across spaces', () => {
		// Caret at end without closing quote
		expect(findPartialMentionAtCursor('ask @"Alice B', 13)).toEqual({
			startIndex: 4,
			filter: '"Alice B',
		});
		// Caret mid-token without closing quote
		expect(findPartialMentionAtCursor('ask @"Alice B', 10)).toEqual({
			startIndex: 4,
			filter: '"Alice B',
		});
		// Caret mid-token with closing quote
		expect(findPartialMentionAtCursor('ask @"Alice B" more', 10)).toEqual({
			startIndex: 4,
			filter: '"Alice B',
		});
		// Caret right before closing quote
		expect(findPartialMentionAtCursor('ask @"Alice B"', 13)).toEqual({
			startIndex: 4,
			filter: '"Alice B',
		});
		// Caret past closing quote (completed mention, not a partial trigger)
		expect(findPartialMentionAtCursor('ask @"Alice B"', 14)).toBeNull();
	});
});

describe('handleComposerAgentTabKey', () => {
	const agentA: AgentMentionSuggestion = {
		kind: 'agent',
		displayText: 'Codex',
		value: '@Codex ',
		targetSessionId: 'sess-a',
		score: 10,
	};
	const agentB: AgentMentionSuggestion = {
		kind: 'agent',
		displayText: 'Copilot',
		value: '@Copilot ',
		targetSessionId: 'sess-b',
		score: 8,
	};
	const groupA: AgentMentionSuggestion = {
		kind: 'group',
		displayText: 'Core Team',
		value: '@Core-Team ',
		groupId: 'grp-1',
		memberMentionValue: '@Codex @Copilot ',
		score: 12,
	};

	it('ignores non-Tab keys and Tab with modifiers', () => {
		const inputRef = textareaRef();
		inputRef.current!.value = 'ask @co';
		inputRef.current!.selectionStart = inputRef.current!.selectionEnd = 7;

		const enter = keyEvent({ key: 'Enter' });
		expect(
			handleComposerAgentTabKey(enter.event, {
				inputRef,
				getInputValue: () => 'ask @co',
				getAgentSuggestions: () => [agentA],
				accept: vi.fn(),
				openPicker: vi.fn(),
			})
		).toBe(false);

		for (const mod of [
			{ shiftKey: true },
			{ altKey: true },
			{ metaKey: true },
			{ ctrlKey: true },
		]) {
			const tabMod = keyEvent({ key: 'Tab', ...mod });
			expect(
				handleComposerAgentTabKey(tabMod.event, {
					inputRef,
					getInputValue: () => 'ask @co',
					getAgentSuggestions: () => [agentA],
					accept: vi.fn(),
					openPicker: vi.fn(),
				})
			).toBe(false);
		}
	});

	it('leaves Tab to the IME during an active composition', () => {
		const inputRef = textareaRef();
		inputRef.current!.value = 'ask @co';
		inputRef.current!.selectionStart = inputRef.current!.selectionEnd = 7;

		for (const ime of [CHROMIUM_COMPOSING, SAFARI_CONFIRM]) {
			const { event, preventDefault } = keyEvent({ key: 'Tab', ...ime });
			const accept = vi.fn();
			const openPicker = vi.fn();

			const handled = handleComposerAgentTabKey(event, {
				inputRef,
				getInputValue: () => 'ask @co',
				getAgentSuggestions: () => [agentA],
				accept,
				openPicker,
			});

			expect(handled).toBe(false);
			expect(preventDefault).not.toHaveBeenCalled();
			expect(accept).not.toHaveBeenCalled();
			expect(openPicker).not.toHaveBeenCalled();
		}
	});

	it('ignores Tab when text is selected', () => {
		const inputRef = textareaRef();
		inputRef.current!.value = 'ask @co';
		inputRef.current!.selectionStart = 4;
		inputRef.current!.selectionEnd = 7;

		const { event, preventDefault } = keyEvent({ key: 'Tab' });
		const handled = handleComposerAgentTabKey(event, {
			inputRef,
			getInputValue: () => 'ask @co',
			getAgentSuggestions: () => [agentA],
			accept: vi.fn(),
			openPicker: vi.fn(),
		});

		expect(handled).toBe(false);
		expect(preventDefault).not.toHaveBeenCalled();
	});

	it('ignores Tab when there is no @ reference under cursor', () => {
		const inputRef = textareaRef();
		inputRef.current!.value = 'ask something';
		inputRef.current!.selectionStart = inputRef.current!.selectionEnd = 13;

		const { event, preventDefault } = keyEvent({ key: 'Tab' });
		const handled = handleComposerAgentTabKey(event, {
			inputRef,
			getInputValue: () => 'ask something',
			getAgentSuggestions: () => [agentA],
			accept: vi.fn(),
			openPicker: vi.fn(),
		});

		expect(handled).toBe(false);
		expect(preventDefault).not.toHaveBeenCalled();
	});

	it('completes when exactly one agent matches', () => {
		const inputRef = textareaRef();
		inputRef.current!.value = 'ask @co';
		inputRef.current!.selectionStart = inputRef.current!.selectionEnd = 7;

		const { event, preventDefault, stopPropagation } = keyEvent({ key: 'Tab' });
		const accept = vi.fn();
		const openPicker = vi.fn();

		const handled = handleComposerAgentTabKey(event, {
			inputRef,
			getInputValue: () => 'ask @co',
			getAgentSuggestions: (filter) => {
				expect(filter).toBe('co');
				return [agentA];
			},
			accept,
			openPicker,
		});

		expect(handled).toBe(true);
		expect(preventDefault).toHaveBeenCalled();
		expect(stopPropagation).not.toHaveBeenCalled();
		expect(accept).toHaveBeenCalledWith(agentA, 4, 'co');
		expect(openPicker).not.toHaveBeenCalled();
	});

	it('stops propagation when isolated from window keys', () => {
		const inputRef = textareaRef();
		inputRef.current!.value = 'ask @co';
		inputRef.current!.selectionStart = inputRef.current!.selectionEnd = 7;

		const { event, preventDefault, stopPropagation } = keyEvent({ key: 'Tab' });
		const accept = vi.fn();

		const handled = handleComposerAgentTabKey(event, {
			inputRef,
			getInputValue: () => 'ask @co',
			getAgentSuggestions: () => [agentA],
			accept,
			openPicker: vi.fn(),
			isolateFromWindowKeys: true,
		});

		expect(handled).toBe(true);
		expect(preventDefault).toHaveBeenCalled();
		expect(stopPropagation).toHaveBeenCalled();
		expect(accept).toHaveBeenCalledWith(agentA, 4, 'co');
	});

	it('opens the picker when multiple agents match', () => {
		const inputRef = textareaRef();
		inputRef.current!.value = 'ask @co';
		inputRef.current!.selectionStart = inputRef.current!.selectionEnd = 7;

		const { event, preventDefault, stopPropagation } = keyEvent({ key: 'Tab' });
		const accept = vi.fn();
		const openPicker = vi.fn();

		const handled = handleComposerAgentTabKey(event, {
			inputRef,
			getInputValue: () => 'ask @co',
			getAgentSuggestions: () => [agentA, agentB],
			accept,
			openPicker,
			isolateFromWindowKeys: true,
		});

		expect(handled).toBe(true);
		expect(preventDefault).toHaveBeenCalled();
		expect(stopPropagation).toHaveBeenCalled();
		expect(openPicker).toHaveBeenCalledWith(4, 'co');
		expect(accept).not.toHaveBeenCalled();
	});

	it('does not complete or open picker when only a group matches', () => {
		const inputRef = textareaRef();
		inputRef.current!.value = 'ask @core';
		inputRef.current!.selectionStart = inputRef.current!.selectionEnd = 9;

		const { event, preventDefault, stopPropagation } = keyEvent({ key: 'Tab' });
		const accept = vi.fn();
		const openPicker = vi.fn();

		const handled = handleComposerAgentTabKey(event, {
			inputRef,
			getInputValue: () => 'ask @core',
			getAgentSuggestions: () => [groupA],
			accept,
			openPicker,
		});

		expect(handled).toBe(false);
		expect(preventDefault).not.toHaveBeenCalled();
		expect(stopPropagation).not.toHaveBeenCalled();
		expect(accept).not.toHaveBeenCalled();
		expect(openPicker).not.toHaveBeenCalled();
	});

	it('completes the single matching agent even when a group also matches', () => {
		const inputRef = textareaRef();
		inputRef.current!.value = 'ask @co';
		inputRef.current!.selectionStart = inputRef.current!.selectionEnd = 7;

		const { event, preventDefault } = keyEvent({ key: 'Tab' });
		const accept = vi.fn();

		const handled = handleComposerAgentTabKey(event, {
			inputRef,
			getInputValue: () => 'ask @co',
			getAgentSuggestions: () => [groupA, agentA],
			accept,
			openPicker: vi.fn(),
		});

		expect(handled).toBe(true);
		expect(preventDefault).toHaveBeenCalled();
		expect(accept).toHaveBeenCalledWith(agentA, 4, 'co');
	});

	it('completes when token is already a full name without space', () => {
		const inputRef = textareaRef();
		inputRef.current!.value = 'ask @Codex';
		inputRef.current!.selectionStart = inputRef.current!.selectionEnd = 10;

		const { event, preventDefault } = keyEvent({ key: 'Tab' });
		const accept = vi.fn();

		const handled = handleComposerAgentTabKey(event, {
			inputRef,
			getInputValue: () => 'ask @Codex',
			getAgentSuggestions: () => [agentA],
			accept,
			openPicker: vi.fn(),
		});

		expect(handled).toBe(true);
		expect(preventDefault).toHaveBeenCalled();
		expect(accept).toHaveBeenCalledWith(agentA, 4, 'Codex');
	});

	it('completes with cursor mid-token', () => {
		const inputRef = textareaRef();
		inputRef.current!.value = 'ask @co-dex please';
		inputRef.current!.selectionStart = inputRef.current!.selectionEnd = 7;

		const { event, preventDefault } = keyEvent({ key: 'Tab' });
		const accept = vi.fn();

		const handled = handleComposerAgentTabKey(event, {
			inputRef,
			getInputValue: () => 'ask @co-dex please',
			getAgentSuggestions: (filter) => {
				expect(filter).toBe('co-dex');
				return [agentA];
			},
			accept,
			openPicker: vi.fn(),
		});

		expect(handled).toBe(true);
		expect(preventDefault).toHaveBeenCalled();
		expect(accept).toHaveBeenCalledWith(agentA, 4, 'co-dex');
	});

	it('completes quoted partial mention on single match passing raw filter to accept', () => {
		const inputRef = textareaRef();
		inputRef.current!.value = 'ask @"Alice B';
		inputRef.current!.selectionStart = inputRef.current!.selectionEnd = 13;

		const { event, preventDefault } = keyEvent({ key: 'Tab' });
		const accept = vi.fn();
		const agentAlice: AgentMentionSuggestion = {
			kind: 'agent',
			displayText: 'Alice Bob',
			value: '@"Alice Bob" ',
			targetSessionId: 'sess-alice',
			score: 10,
		};

		const handled = handleComposerAgentTabKey(event, {
			inputRef,
			getInputValue: () => 'ask @"Alice B',
			getAgentSuggestions: (filter) => {
				// Search term is stripped of quotes
				expect(filter).toBe('Alice B');
				return [agentAlice];
			},
			accept,
			openPicker: vi.fn(),
		});

		expect(handled).toBe(true);
		expect(preventDefault).toHaveBeenCalled();
		// Accept receives raw filter so spliceMentionLiteral can measure the replaced span
		expect(accept).toHaveBeenCalledWith(agentAlice, 4, '"Alice B');
	});

	it('opens picker with raw filter on multiple matches for quoted partial mention', () => {
		const inputRef = textareaRef();
		inputRef.current!.value = 'ask @"Alice B';
		inputRef.current!.selectionStart = inputRef.current!.selectionEnd = 13;

		const { event, preventDefault } = keyEvent({ key: 'Tab' });
		const openPicker = vi.fn();
		const agent1: AgentMentionSuggestion = {
			kind: 'agent',
			displayText: 'Alice Bob',
			value: '@"Alice Bob" ',
			targetSessionId: 'sess-1',
			score: 10,
		};
		const agent2: AgentMentionSuggestion = {
			kind: 'agent',
			displayText: 'Alice Brown',
			value: '@"Alice Brown" ',
			targetSessionId: 'sess-2',
			score: 9,
		};

		const handled = handleComposerAgentTabKey(event, {
			inputRef,
			getInputValue: () => 'ask @"Alice B',
			getAgentSuggestions: (filter) => {
				expect(filter).toBe('Alice B');
				return [agent1, agent2];
			},
			accept: vi.fn(),
			openPicker,
		});

		expect(handled).toBe(true);
		expect(preventDefault).toHaveBeenCalled();
		expect(openPicker).toHaveBeenCalledWith(4, '"Alice B');
	});
});
