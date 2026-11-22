import type React from 'react';

/**
 * Whether the key belongs to an active IME composition. `isComposing` alone
 * misses Safari, which fires the Enter that confirms a candidate after
 * `compositionend` (so `isComposing` is false) but still reports keyCode 229,
 * the value every browser gives a key the input method processed. Accepts
 * either a React synthetic KeyboardEvent or a native DOM KeyboardEvent.
 */
export function isImeComposing(e: React.KeyboardEvent | KeyboardEvent): boolean {
	const isComposing = 'nativeEvent' in e ? e.nativeEvent?.isComposing : e.isComposing;
	return isComposing === true || e.keyCode === 229;
}
