import type React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	handleComposerFindKey,
	handleComposerPickerKey,
	handleComposerSendKey,
} from '../../../renderer/hooks/input/composerKeyDown';
import { useUIStore } from '../../../renderer/stores/uiStore';
import { OUTPUT_SEARCH_INPUT_SELECTOR } from '../../../renderer/hooks/ui/useOutputSearchLayer';

type KeyInit = {
	key: string;
	metaKey?: boolean;
	ctrlKey?: boolean;
	shiftKey?: boolean;
	altKey?: boolean;
};

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

	it('stops handled keys only when isolated from the window keys', () => {
		const shared = keyEvent({ key: 'Tab' });
		handleComposerPickerKey(shared.event, picker().options);
		expect(shared.stopPropagation).not.toHaveBeenCalled();

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
});
