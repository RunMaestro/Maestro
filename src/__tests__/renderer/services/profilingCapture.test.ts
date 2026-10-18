import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../renderer/utils/sentry', () => ({ captureException: vi.fn() }));

import {
	resetProfilingCapture,
	runProfilingCaptureInBackground,
	startProfilingCapture,
	useProfilingCaptureStore,
} from '../../../renderer/services/profilingCapture';
import { useNotificationStore } from '../../../renderer/stores/notificationStore';
import { useUIStore } from '../../../renderer/stores/uiStore';

describe('profilingCapture service', () => {
	let resolveStop: (v: unknown) => void;
	const debug = {
		stopProfiling: vi.fn(),
		profilingRunInBackground: vi.fn().mockResolvedValue({ success: true }),
		onProfilingProgress: vi.fn(() => () => {}),
	};

	beforeEach(() => {
		vi.clearAllMocks();
		useProfilingCaptureStore.setState({ phase: 'idle', backgrounded: false });
		useNotificationStore.setState({ toasts: [] });
		useUIStore.getState().setProfilingActive(true);
		debug.stopProfiling.mockReturnValue(new Promise((r) => (resolveStop = r)));
		(window as any).maestro = { debug, logger: {} };
	});

	it('is idempotent while a run is in flight', () => {
		startProfilingCapture();
		startProfilingCapture();
		expect(debug.stopProfiling).toHaveBeenCalledTimes(1);
	});

	it('backgrounding raises one persistent toast and tells main to skip the dialog', () => {
		startProfilingCapture();
		runProfilingCaptureInBackground();
		runProfilingCaptureInBackground();
		expect(debug.profilingRunInBackground).toHaveBeenCalledTimes(1);
		const toasts = useNotificationStore.getState().toasts;
		expect(toasts).toHaveLength(1);
		expect(toasts[0].duration).toBe(0);
	});

	it('a backgrounded run replaces its progress toast with the saved path', async () => {
		startProfilingCapture();
		runProfilingCaptureInBackground();
		resolveStop({ success: true, cancelled: false, path: '/Desktop/p.zip', bundleSizeBytes: 5 });
		await vi.waitFor(() => expect(useProfilingCaptureStore.getState().phase).toBe('done'));
		const toasts = useNotificationStore.getState().toasts;
		expect(toasts).toHaveLength(1);
		expect(toasts[0].title).toBe('Performance profile saved');
		expect(toasts[0].message).toContain('/Desktop/p.zip');
		expect(useUIStore.getState().profilingActive).toBe(false);
	});

	it('a foreground run raises no toast, and reset is refused mid-run', async () => {
		startProfilingCapture();
		resetProfilingCapture();
		expect(useProfilingCaptureStore.getState().phase).toBe('stopping');
		resolveStop({ success: true, cancelled: false, path: '/x.zip', bundleSizeBytes: 1 });
		await vi.waitFor(() => expect(useProfilingCaptureStore.getState().phase).toBe('done'));
		expect(useNotificationStore.getState().toasts).toHaveLength(0);
		resetProfilingCapture();
		expect(useProfilingCaptureStore.getState().phase).toBe('idle');
	});
});
