import type React from 'react';
import { describe, expect, it } from 'vitest';
import { isImeComposing } from '../../../renderer/utils/ime';

const CHROMIUM_COMPOSING = { nativeEvent: { isComposing: true } };
const SAFARI_CONFIRM = { keyCode: 229 };

function keyEvent(props: {
	key: string;
	keyCode?: number;
	nativeEvent?: { isComposing?: boolean };
}): React.KeyboardEvent {
	return {
		key: props.key,
		keyCode: props.keyCode ?? 0,
		nativeEvent: props.nativeEvent as unknown as KeyboardEvent,
	} as unknown as React.KeyboardEvent;
}

describe('isImeComposing', () => {
	it('reads isComposing and keyCode 229 from React synthetic events', () => {
		expect(isImeComposing(keyEvent({ key: 'Enter', ...CHROMIUM_COMPOSING }))).toBe(true);
		expect(isImeComposing(keyEvent({ key: 'Enter', ...SAFARI_CONFIRM }))).toBe(true);
		expect(isImeComposing(keyEvent({ key: 'Enter', nativeEvent: { isComposing: true } }))).toBe(
			true
		);
		expect(isImeComposing(keyEvent({ key: 'Escape', ...CHROMIUM_COMPOSING }))).toBe(true);
		expect(isImeComposing(keyEvent({ key: 'Escape', ...SAFARI_CONFIRM }))).toBe(true);
		expect(isImeComposing(keyEvent({ key: 'Enter', keyCode: 13 }))).toBe(false);
		expect(isImeComposing(keyEvent({ key: 'Enter' }))).toBe(false);
		expect(isImeComposing(keyEvent({ key: 'Escape', keyCode: 27 }))).toBe(false);
		expect(isImeComposing(keyEvent({ key: 'Escape' }))).toBe(false);
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
