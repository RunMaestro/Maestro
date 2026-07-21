import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FSWatcher } from 'fs';

const { mockWatch, mockClose, mockOn, mockOnChange } = vi.hoisted(() => ({
	mockWatch: vi.fn(),
	mockClose: vi.fn(),
	mockOn: vi.fn(),
	mockOnChange: { current: undefined as (() => void) | undefined },
}));

vi.mock('fs', () => ({
	default: { watch: mockWatch },
	watch: mockWatch,
}));
vi.mock('fs/promises', () => ({ default: {} }));
vi.mock('electron', () => ({}));
vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../main/utils/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../../../main/utils/remote-fs', () => ({
	writeFileRemote: vi.fn(),
	mkdirRemote: vi.fn(),
}));

import { createLocalManifestWatcher } from '../../../main/services/marketplace-service';

describe('createLocalManifestWatcher', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		mockWatch.mockImplementation((_path: string, onChange: () => void) => {
			mockOnChange.current = onChange;
			return { close: mockClose, on: mockOn } as unknown as FSWatcher;
		});
	});

	afterEach(() => {
		vi.useRealTimers();
		mockOnChange.current = undefined;
	});

	it('uses trailing-edge rescheduling and cancels a pending callback on stop', () => {
		const onChange = vi.fn();
		const app = { getPath: vi.fn(() => '/user-data') };
		const watcher = createLocalManifestWatcher(app as never, onChange, 250);

		mockOnChange.current?.();
		vi.advanceTimersByTime(249);
		expect(onChange).not.toHaveBeenCalled();
		mockOnChange.current?.();
		vi.advanceTimersByTime(249);
		expect(onChange).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(onChange).toHaveBeenCalledOnce();

		mockOnChange.current?.();
		watcher.stop();
		vi.advanceTimersByTime(250);
		expect(onChange).toHaveBeenCalledOnce();
		expect(mockClose).toHaveBeenCalledOnce();
	});
});
