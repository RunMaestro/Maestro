/**
 * Finishes a performance capture when the main process says its trace buffer is
 * about to overflow.
 *
 * Chromium records into a fixed-size buffer and silently drops events once it
 * fills - the capture keeps "running" while recording less and less of what
 * happens. Two field captures were lost that way before anything watched for
 * it, retaining 22% and 43% of their windows.
 *
 * The main process now watches buffer usage and emits `profilingAutoStopped`
 * before that point. All this hook does is open the ordinary capture modal,
 * which runs the same stop-and-save flow the user's own "End Performance
 * Profiling" runs. Deliberately not a second stop path: an automatic stop and a
 * manual one produce identical bundles because they ARE the same code.
 *
 * Mounted once, app-wide. The palette is not a valid home for this - it only
 * exists while it is open, and a capture is usually running with it closed.
 */

import { useEffect } from 'react';
import { useModalStore } from '../../stores/modalStore';
import { notifyToast } from '../../stores/notificationStore';
import { useUIStore } from '../../stores/uiStore';

export function useProfilingAutoStop(): void {
	useEffect(() => {
		const unsubscribe = window.maestro?.debug?.onProfilingAutoStopped?.((event) => {
			useUIStore.getState().setProfilingBufferPercent(event.bufferPercent ?? 0);

			const seconds = Math.round((event.elapsedMs ?? 0) / 1000);
			notifyToast({
				color: 'yellow',
				title: 'Profiling',
				// Say why, because the user did not ask for this and the honest
				// reason is also the useful one: how long a recording can run is set
				// by how busy the app is, not by how long the user waits.
				message: `Trace buffer full after ${seconds}s. Capture ended early to keep it complete - saving now.`,
				dismissible: true,
			});

			// Opening the modal is what actually stops and saves the recording.
			useModalStore.getState().openModal('profilingCapture');
		});

		return () => {
			unsubscribe?.();
		};
	}, []);
}
