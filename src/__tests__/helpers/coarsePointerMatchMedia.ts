import { vi } from 'vitest';

/** Installs a deterministic coarse-pointer media query and returns its restoration. */
export function installCoarsePointerMatchMedia(coarse: boolean): () => void {
	const originalDescriptor = Object.getOwnPropertyDescriptor(window, 'matchMedia');

	Object.defineProperty(window, 'matchMedia', {
		writable: true,
		configurable: true,
		value: (query: string) => ({
			matches: coarse,
			media: query,
			onchange: null,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			addListener: vi.fn(),
			removeListener: vi.fn(),
			dispatchEvent: vi.fn(),
		}),
	});

	return () => {
		if (originalDescriptor) {
			Object.defineProperty(window, 'matchMedia', originalDescriptor);
		} else {
			Reflect.deleteProperty(window, 'matchMedia');
		}
	};
}
