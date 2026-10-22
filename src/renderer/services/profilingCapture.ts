/**
 * Stop-and-save flow for a performance capture, owned by a module rather than
 * by the progress modal.
 *
 * Ending a recording can take minutes on a long capture (Chromium flushes every
 * process's buffer through the main process, then the bundle is zipped). When
 * the modal owned the flow it also owned the user: it could not be dismissed
 * until the backend finished, so one slow flush froze the whole app. Here the
 * flow lives in a store, the modal is only a view of it, and dismissing the
 * modal mid-run moves the capture to the background: the save dialog is skipped
 * (it is a sheet over the main window), the bundle goes to the default
 * location, and a persistent toast carries the result.
 */

import { create } from 'zustand';
import { useModalStore } from '../stores/modalStore';
import { notifyToast, useNotificationStore } from '../stores/notificationStore';
import { useUIStore } from '../stores/uiStore';
import { captureException } from '../utils/sentry';

export type ProfilingCapturePhase =
	| 'idle'
	| 'stopping'
	| 'awaiting-save'
	| 'compressing'
	| 'done'
	| 'cancelled'
	| 'error';

export interface ProfilingCaptureState {
	phase: ProfilingCapturePhase;
	percent: number;
	bytesProcessed: number;
	totalBytes: number;
	savedPath: string | null;
	bundleSize: number;
	bufferExhausted: boolean;
	peakBufferPercent: number;
	errorMessage: string | null;
	/** The user dismissed the modal while the flow was still running. */
	backgrounded: boolean;
}

const INITIAL: ProfilingCaptureState = {
	phase: 'idle',
	percent: 0,
	bytesProcessed: 0,
	totalBytes: 0,
	savedPath: null,
	bundleSize: 0,
	bufferExhausted: false,
	peakBufferPercent: 0,
	errorMessage: null,
	backgrounded: false,
};

export const useProfilingCaptureStore = create<ProfilingCaptureState>()(() => INITIAL);

export function isProfilingCaptureRunning(phase: ProfilingCapturePhase): boolean {
	return phase === 'stopping' || phase === 'awaiting-save' || phase === 'compressing';
}

/** Id of the "still working" toast, so it can be replaced by the result. */
let progressToastId: string | null = null;

function dropProgressToast(): void {
	if (progressToastId) {
		useNotificationStore.getState().removeToast(progressToastId);
		progressToastId = null;
	}
}

function reopenModal(): void {
	useModalStore.getState().openModal('profilingCapture');
}

function announceBackgroundResult(): void {
	dropProgressToast();
	const s = useProfilingCaptureStore.getState();
	if (s.phase === 'done') {
		notifyToast({
			color: s.bufferExhausted ? 'yellow' : 'green',
			title: 'Performance profile saved',
			message: s.savedPath ? `${s.savedPath}\nClick for the file path.` : 'Click for details.',
			dismissible: true,
			onClick: reopenModal,
		});
	} else if (s.phase === 'error') {
		notifyToast({
			color: 'red',
			title: 'Performance profile failed',
			message: s.errorMessage || 'Failed to save profile',
			dismissible: true,
			onClick: reopenModal,
		});
	}
}

/** Terminal states that a backgrounded run reports through a toast. */
function settle(patch: Partial<ProfilingCaptureState>): void {
	useProfilingCaptureStore.setState(patch);
	useUIStore.getState().setProfilingActive(false);
	if (useProfilingCaptureStore.getState().backgrounded) announceBackgroundResult();
}

let unsubscribeProgress: (() => void) | null = null;

/**
 * Stop the recording and bundle it. Idempotent: a second call while a run is in
 * flight (or finished and not yet dismissed) does nothing, so reopening the
 * modal never restarts anything.
 */
export function startProfilingCapture(): void {
	const { phase } = useProfilingCaptureStore.getState();
	if (phase !== 'idle') return;

	useProfilingCaptureStore.setState({ ...INITIAL, phase: 'stopping' });

	unsubscribeProgress?.();
	unsubscribeProgress =
		window.maestro?.debug?.onProfilingProgress?.((event) => {
			// Terminal states come from the awaited result below, which carries the
			// whole payload; reacting to them here would flash "saved" without a path.
			if (
				event.phase !== 'stopping' &&
				event.phase !== 'awaiting-save' &&
				event.phase !== 'compressing'
			) {
				return;
			}
			useProfilingCaptureStore.setState((s) => ({
				phase: event.phase as ProfilingCapturePhase,
				percent: typeof event.percent === 'number' ? event.percent : s.percent,
				bytesProcessed:
					typeof event.bytesProcessed === 'number' ? event.bytesProcessed : s.bytesProcessed,
				totalBytes: typeof event.totalBytes === 'number' ? event.totalBytes : s.totalBytes,
			}));
		}) ?? null;

	void (async () => {
		try {
			const res = await window.maestro.debug.stopProfiling();
			if (!res?.success) {
				settle({ phase: 'error', errorMessage: res?.error || 'Failed to save profile' });
			} else if (res.cancelled) {
				settle({ phase: 'cancelled' });
			} else {
				settle({
					phase: 'done',
					percent: 100,
					savedPath: res.path,
					bundleSize: res.bundleSizeBytes,
					bufferExhausted: Boolean(res.bufferExhausted),
					peakBufferPercent: res.peakBufferPercent ?? 0,
				});
			}
		} catch (err) {
			settle({ phase: 'error', errorMessage: 'Failed to save profile' });
			captureException(err);
		} finally {
			unsubscribeProgress?.();
			unsubscribeProgress = null;
		}
	})();
}

/**
 * Let the app go back to work while the capture finishes. Skips the save dialog
 * and leaves a persistent toast that reopens the result when clicked.
 */
export function runProfilingCaptureInBackground(): void {
	const s = useProfilingCaptureStore.getState();
	if (!isProfilingCaptureRunning(s.phase) || s.backgrounded) return;
	useProfilingCaptureStore.setState({ backgrounded: true });
	// Best-effort: if this loses the race with the save dialog, the dialog simply
	// appears as it always did.
	void window.maestro?.debug?.profilingRunInBackground?.();
	progressToastId = notifyToast({
		color: 'theme',
		title: 'Performance profiling',
		message: 'Finishing the capture in the background. It saves to your Desktop when done.',
		dismissible: true,
		onClick: reopenModal,
	});
}

/** Forget a finished run so the next capture starts clean. */
export function resetProfilingCapture(): void {
	if (isProfilingCaptureRunning(useProfilingCaptureStore.getState().phase)) return;
	useProfilingCaptureStore.setState(INITIAL);
}
