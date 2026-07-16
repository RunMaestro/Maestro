import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	dismissCenterFlash,
	notifyCenterFlash,
	useCenterFlashStore,
} from '../../../renderer/stores/centerFlashStore';

afterEach(() => {
	dismissCenterFlash();
	vi.useRealTimers();
});

describe('notifyCenterFlash color compatibility', () => {
	it.each([
		['canonical color', { color: 'orange' }, 'orange'],
		['legacy variant', { variant: 'warning' }, 'yellow'],
		['default color', {}, 'theme'],
		[
			'invalid explicit color takes precedence over a legacy variant',
			{ color: 'blue', variant: 'success' },
			'theme',
		],
	] as const)('%s resolves to %s', (_name, options, expectedColor) => {
		notifyCenterFlash({ message: 'Saved', ...options });

		expect(useCenterFlashStore.getState().active?.color).toBe(expectedColor);
	});

	it('retains the renderer zero-duration contract', () => {
		notifyCenterFlash({ message: 'Sticky', duration: 0 });

		expect(useCenterFlashStore.getState().active?.duration).toBe(0);
	});
});
