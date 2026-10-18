/**
 * Drive `isCoarsePointer()` in tests.
 *
 * `isCoarsePointer()` (src/renderer/utils/touch.ts) reads
 * `window.matchMedia('(pointer: coarse)')`. jsdom has no `matchMedia`, so the
 * default is a fine (mouse) pointer; call `setCoarsePointer(true)` to make a
 * test see a finger, and `restorePointer()` in `afterEach` so the stub does not
 * leak into the next file's assumptions. Pulled out of ToolbarControls.test so
 * every touch-only branch is tested against the same stub.
 */

import { vi } from 'vitest';

let original: PropertyDescriptor | undefined;
let installed = false;

export function setCoarsePointer(coarse: boolean): void {
	if (!installed) {
		original = Object.getOwnPropertyDescriptor(window, 'matchMedia');
		installed = true;
	}
	Object.defineProperty(window, 'matchMedia', {
		writable: true,
		configurable: true,
		value: (query: string) => ({
			matches: coarse && query.includes('pointer: coarse'),
			media: query,
			onchange: null,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			addListener: vi.fn(),
			removeListener: vi.fn(),
			dispatchEvent: vi.fn(),
		}),
	});
}

export function restorePointer(): void {
	if (!installed) return;
	if (original) Object.defineProperty(window, 'matchMedia', original);
	else delete (window as unknown as { matchMedia?: unknown }).matchMedia;
	installed = false;
	original = undefined;
}
