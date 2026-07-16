import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	dismissCenterFlash,
	notifyCenterFlash,
	useCenterFlashStore,
} from '../../../renderer/stores/centerFlashStore';

describe('centerFlashStore timer ownership', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		dismissCenterFlash();
	});

	afterEach(() => {
		dismissCenterFlash();
		vi.useRealTimers();
	});

	it('replaces a pending flash without letting its stale timer clear the replacement', () => {
		notifyCenterFlash({ message: 'First', duration: 2000 });
		vi.advanceTimersByTime(1000);
		notifyCenterFlash({ message: 'Replacement', duration: 2000 });

		vi.advanceTimersByTime(1000);
		expect(useCenterFlashStore.getState().active?.message).toBe('Replacement');

		vi.advanceTimersByTime(1000);
		expect(useCenterFlashStore.getState().active).toBeNull();
	});

	it('cancels the active timer when dismissed', () => {
		notifyCenterFlash({ message: 'Dismissed', duration: 2000 });
		dismissCenterFlash();
		vi.advanceTimersByTime(2000);

		expect(useCenterFlashStore.getState().active).toBeNull();
	});
});
