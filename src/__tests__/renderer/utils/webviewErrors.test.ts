/**
 * `isDetachedWebviewError()` (src/renderer/utils/webviewErrors.ts): the expected races of pushing into a
 * guest that is not attached yet or is tearing down, told apart from real errors worth reporting.
 */

import { describe, expect, it } from 'vitest';
import { isDetachedWebviewError } from '../../../renderer/utils/webviewErrors';

describe('isDetachedWebviewError', () => {
	it('recognizes the attach and teardown races', () => {
		for (const message of [
			'The WebView must be attached to the DOM and the dom-ready event emitted before this method can be called.',
			'Object has been destroyed',
			'WebContents was disposed',
			'Guest is detached',
			'guest not attached',
		]) {
			expect(isDetachedWebviewError(new Error(message)), message).toBe(true);
		}
		expect(isDetachedWebviewError('Object has been destroyed')).toBe(true);
	});

	it('leaves every other error to be reported', () => {
		expect(isDetachedWebviewError(new Error('An object could not be cloned.'))).toBe(false);
		expect(isDetachedWebviewError(new TypeError('x is not a function'))).toBe(false);
		expect(isDetachedWebviewError(null)).toBe(false);
	});
});
