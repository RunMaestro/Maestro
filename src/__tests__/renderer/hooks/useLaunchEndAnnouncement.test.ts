/**
 * Tests for useLaunchEndAnnouncement: the one subscription that turns main's
 * `marketplace:launchChanged` broadcast into the outro (or the toast that opens it).
 *
 * What it decides is only WHO listens: the window that owns app-wide side effects, once, for as
 * long as it lives. What the broadcast then does is the service's job (`announceLaunchEnd`,
 * covered in playbookLaunchCompletion.test.ts), so the service is replaced here.
 *
 * The last block pins that App calls the hook at all: nothing else would notice if it did not.
 */

import { renderHook } from '@testing-library/react';
import { readFileSync } from 'fs';
import { join } from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let mockIsLifecycleOwner = true;
vi.mock('../../../renderer/contexts/WindowContext', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../renderer/contexts/WindowContext')>()),
	useIsLifecycleOwner: () => mockIsLifecycleOwner,
}));
vi.mock('../../../renderer/services/playbookLaunchCompletion', () => ({
	announceLaunchEnd: vi.fn(),
}));

import { useLaunchEndAnnouncement } from '../../../renderer/hooks/batch/useLaunchEndAnnouncement';
import { announceLaunchEnd } from '../../../renderer/services/playbookLaunchCompletion';
import { createMockLaunchRecord } from '../../helpers/mockLaunchRecord';

const onLaunchChanged = vi.mocked(window.maestro.marketplace.onLaunchChanged);

beforeEach(() => {
	vi.clearAllMocks();
	mockIsLifecycleOwner = true;
	onLaunchChanged.mockReturnValue(() => {});
});

describe('useLaunchEndAnnouncement', () => {
	it('hands each launch main broadcasts to the announcement', () => {
		renderHook(() => useLaunchEndAnnouncement());
		expect(onLaunchChanged).toHaveBeenCalledTimes(1);
		const [handler] = onLaunchChanged.mock.calls[0];

		const first = createMockLaunchRecord({ launchId: 'launch-1', status: 'completed' });
		const second = createMockLaunchRecord({ launchId: 'launch-2', status: 'stopped' });
		handler(first);
		handler(second);

		expect(announceLaunchEnd).toHaveBeenCalledTimes(2);
		expect(announceLaunchEnd).toHaveBeenNthCalledWith(1, first);
		expect(announceLaunchEnd).toHaveBeenNthCalledWith(2, second);
	});

	it('does not listen in a window that is not the lifecycle owner', () => {
		mockIsLifecycleOwner = false;

		renderHook(() => useLaunchEndAnnouncement());

		expect(onLaunchChanged).not.toHaveBeenCalled();
	});

	it('listens once, however often the window draws again', () => {
		const { rerender } = renderHook(() => useLaunchEndAnnouncement());

		rerender();
		rerender();

		expect(onLaunchChanged).toHaveBeenCalledTimes(1);
	});

	it('stops listening when the window goes away', () => {
		const unsubscribe = vi.fn();
		onLaunchChanged.mockReturnValue(unsubscribe);
		const { unmount } = renderHook(() => useLaunchEndAnnouncement());
		expect(unsubscribe).not.toHaveBeenCalled();

		unmount();

		expect(unsubscribe).toHaveBeenCalledTimes(1);
	});
});

describe('App wiring', () => {
	// App is too large to render in a test, so this reads its source, as the keyboard wiring check in
	// shortcuts.test.ts does. A hook nothing calls shows the person nothing: the launch is ended and
	// cleaned up in main, and no outro and no toast ever follows.
	it('calls the hook once, so the end of a launch always reaches the person', () => {
		const app = readFileSync(join(__dirname, '../../../renderer/App.tsx'), 'utf-8');

		const calls = app.match(/^[ \t]*useLaunchEndAnnouncement\(\);[ \t]*$/gm) ?? [];

		expect(calls, 'App must call useLaunchEndAnnouncement() exactly once').toHaveLength(1);
	});
});
