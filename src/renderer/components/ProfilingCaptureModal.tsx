/**
 * ProfilingCaptureModal - progress UI for stopping a performance capture.
 *
 * Ending a recording is a multi-step, potentially slow operation: flush the
 * trace, pick a save location, then zip-compress it (tens of seconds for a large
 * trace). Doing that behind a silent IPC call made "End Performance Profiling"
 * look frozen/broken. This modal owns the whole stop-and-bundle flow so the user
 * sees live progress instead.
 *
 * The main process is the source of truth: it emits `debug:profilingProgress`
 * phase events while it works, and the awaited `stopProfiling()` result carries
 * the authoritative terminal state (saved / cancelled / error).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, CheckCircle2, XCircle, AlertTriangle, Gauge, Copy } from 'lucide-react';
import type { Theme } from '../types';
import { Modal } from './ui/Modal';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { useUIStore } from '../stores/uiStore';
import { captureException } from '../utils/sentry';
import { safeClipboardWrite } from '../utils/clipboard';
import { flashCopiedToClipboard } from '../utils/flashCopiedToClipboard';
import { formatSize } from '../../shared/formatters';

interface ProfilingCaptureModalProps {
	theme: Theme;
	onClose: () => void;
}

type Phase = 'stopping' | 'awaiting-save' | 'compressing' | 'done' | 'cancelled' | 'error';

const PHASE_LABEL: Record<Phase, string> = {
	stopping: 'Stopping recording…',
	'awaiting-save': 'Choose where to save the profile…',
	compressing: 'Compressing trace…',
	done: 'Profile saved',
	cancelled: 'Save cancelled',
	error: 'Profiling failed',
};

export function ProfilingCaptureModal({ theme, onClose }: ProfilingCaptureModalProps) {
	const setProfilingActive = useUIStore((s) => s.setProfilingActive);

	const [phase, setPhase] = useState<Phase>('stopping');
	const [percent, setPercent] = useState(0);
	const [bytesProcessed, setBytesProcessed] = useState(0);
	const [totalBytes, setTotalBytes] = useState(0);
	const [savedPath, setSavedPath] = useState<string | null>(null);
	const [bundleSize, setBundleSize] = useState(0);
	const [errorMessage, setErrorMessage] = useState<string | null>(null);
	const startedRef = useRef(false);

	const isTerminal = phase === 'done' || phase === 'cancelled' || phase === 'error';
	const isIndeterminate = phase === 'stopping' || phase === 'awaiting-save';

	// Live intermediate progress from the main process. Terminal states are driven
	// by the awaited stopProfiling() result below (it carries the full payload), so
	// ignore terminal phases here to avoid flashing "saved" before the path lands.
	useEffect(() => {
		const unsub = window.maestro?.debug?.onProfilingProgress?.((event) => {
			if (
				event.phase === 'stopping' ||
				event.phase === 'awaiting-save' ||
				event.phase === 'compressing'
			) {
				setPhase(event.phase);
				if (typeof event.percent === 'number') setPercent(event.percent);
				if (typeof event.bytesProcessed === 'number') setBytesProcessed(event.bytesProcessed);
				if (typeof event.totalBytes === 'number') setTotalBytes(event.totalBytes);
			}
		});
		return () => {
			unsub?.();
		};
	}, []);

	// Kick off the stop-and-bundle exactly once when the modal opens.
	useEffect(() => {
		if (startedRef.current) return;
		startedRef.current = true;
		(async () => {
			try {
				const res = await window.maestro.debug.stopProfiling();
				// Recording has ended regardless of outcome; drop the wand indicator.
				setProfilingActive(false);
				if (!res?.success) {
					setPhase('error');
					setErrorMessage(res?.error || 'Failed to save profile');
					return;
				}
				if (res.cancelled) {
					setPhase('cancelled');
					return;
				}
				setSavedPath(res.path);
				setBundleSize(res.bundleSizeBytes);
				setPercent(100);
				setPhase('done');
			} catch (err) {
				setProfilingActive(false);
				setPhase('error');
				setErrorMessage('Failed to save profile');
				captureException(err);
			}
		})();
	}, [setProfilingActive]);

	// Escape / close is a no-op until the operation finishes so the user can't
	// dismiss a modal whose backend work is still running.
	const handleClose = useCallback(() => {
		if (isTerminal) onClose();
	}, [isTerminal, onClose]);

	const handleCopyPath = useCallback(async () => {
		if (!savedPath) return;
		const ok = await safeClipboardWrite(savedPath);
		if (ok) flashCopiedToClipboard(savedPath);
	}, [savedPath]);

	const barColor =
		phase === 'error'
			? theme.colors.error
			: phase === 'cancelled'
				? theme.colors.warning
				: phase === 'done'
					? theme.colors.success
					: theme.colors.accent;

	const StatusIcon =
		phase === 'done'
			? CheckCircle2
			: phase === 'error'
				? XCircle
				: phase === 'cancelled'
					? AlertTriangle
					: Loader2;

	const iconColor =
		phase === 'done'
			? theme.colors.success
			: phase === 'error'
				? theme.colors.error
				: phase === 'cancelled'
					? theme.colors.warning
					: theme.colors.accent;

	return (
		<Modal
			theme={theme}
			title="Performance Profiling"
			priority={MODAL_PRIORITIES.DEBUG_PROFILING_CAPTURE}
			onClose={handleClose}
			headerIcon={<Gauge size={18} style={{ color: theme.colors.accent }} />}
			width={620}
			showCloseButton={isTerminal}
			footer={
				isTerminal ? (
					<div className="flex justify-end">
						<button
							type="button"
							onClick={onClose}
							className="px-4 py-2 rounded-md text-sm font-medium"
							style={{ backgroundColor: theme.colors.accent, color: theme.colors.accentForeground }}
						>
							Done
						</button>
					</div>
				) : undefined
			}
			layerOptions={{ focusTrap: 'strict' }}
		>
			<div className="flex flex-col gap-4 select-text">
				{/* Status line */}
				<div className="flex items-center gap-2">
					<StatusIcon
						size={18}
						style={{ color: iconColor }}
						className={isTerminal ? undefined : 'animate-spin'}
					/>
					<span className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
						{PHASE_LABEL[phase]}
						{phase === 'compressing' ? ` ${percent}%` : ''}
					</span>
				</div>

				{/* Progress bar (hidden once we reach a cancelled/error terminal state) */}
				{phase !== 'cancelled' && phase !== 'error' && (
					<div
						className="w-full h-2 rounded-full overflow-hidden"
						style={{ backgroundColor: theme.colors.bgActivity }}
					>
						{isIndeterminate ? (
							<div
								className="h-full rounded-full profiling-progress-indeterminate"
								style={{ backgroundColor: barColor }}
							/>
						) : (
							<div
								className="h-full rounded-full transition-all duration-200"
								style={{ width: `${percent}%`, backgroundColor: barColor }}
							/>
						)}
					</div>
				)}

				{/* Byte counter during compression */}
				{phase === 'compressing' && totalBytes > 0 && (
					<div className="text-xs" style={{ color: theme.colors.textDim }}>
						{formatSize(bytesProcessed)} / {formatSize(totalBytes)} read
					</div>
				)}

				{/* Terminal detail */}
				{phase === 'done' && (
					<div className="text-xs flex flex-col gap-1" style={{ color: theme.colors.textDim }}>
						{savedPath && (
							<div className="flex items-start gap-2">
								<span className="min-w-0 break-all">
									Saved to <span style={{ color: theme.colors.textMain }}>{savedPath}</span>
								</span>
								<button
									type="button"
									onClick={handleCopyPath}
									title="Copy full path to clipboard"
									aria-label="Copy full path to clipboard"
									className="shrink-0 p-1 rounded hover:bg-white/10 transition-colors outline-none focus:ring-2 focus:ring-accent"
									style={{ color: theme.colors.textDim }}
								>
									<Copy size={14} />
								</button>
							</div>
						)}
						{bundleSize > 0 && <span>Bundle size: {formatSize(bundleSize)}</span>}
					</div>
				)}
				{phase === 'cancelled' && (
					<div className="text-xs" style={{ color: theme.colors.textDim }}>
						The recording was discarded and nothing was written to disk.
					</div>
				)}
				{phase === 'error' && errorMessage && (
					<div className="text-xs" style={{ color: theme.colors.error }}>
						{errorMessage}
					</div>
				)}
			</div>
		</Modal>
	);
}
