import { useCallback, useState } from 'react';
import type { GhCliStatus } from '../components/BuildToolsWarningDialog';

export interface UseGhCliPreflightResult {
	/** True while the BuildToolsWarningDialog should be visible. */
	isOpen: boolean;
	/** True while the gh check is in flight. Shell renders a spinner. */
	isChecking: boolean;
	/** Result of the most recent gh check; null while pending. */
	status: GhCliStatus | null;
	/** Begin the pre-flight check + open the dialog. */
	start: () => void;
	/** Confirm path - closes dialog and triggers callback. */
	confirm: (onConfirmed: () => void) => void;
	/** Cancel/close path - closes dialog without side effects. */
	cancel: () => void;
}

/**
 * Pre-flight state machine for the Symphony "Start Contribution" flow.
 *
 * Invariant: `start()` opens the dialog synchronously and only THEN issues the
 * gh-CLI probe. This is critical because the spinner is gated on
 * `isChecking && isOpen` - both must be true within the same React render.
 */
export function useGhCliPreflight(checkGhCli: () => Promise<GhCliStatus>): UseGhCliPreflightResult {
	const [isOpen, setIsOpen] = useState(false);
	const [isChecking, setIsChecking] = useState(false);
	const [status, setStatus] = useState<GhCliStatus | null>(null);

	const start = useCallback(() => {
		// 1) Reset previous status BEFORE we open, so a stale "all clear" doesn't flash.
		setStatus(null);
		// 2) Toggle isChecking on, then open the dialog - both in this render pass.
		setIsChecking(true);
		setIsOpen(true);
		// 3) Probe gh. fall back to "not installed" on rejection so the user
		//    sees an actionable state, not a phantom spinner.
		checkGhCli()
			.then((s) => setStatus(s))
			.catch(() => setStatus({ installed: false, authenticated: false }))
			.finally(() => setIsChecking(false));
	}, [checkGhCli]);

	const confirm = useCallback((onConfirmed: () => void) => {
		setIsOpen(false);
		onConfirmed();
	}, []);

	const cancel = useCallback(() => {
		setIsOpen(false);
	}, []);

	return { isOpen, isChecking, status, start, confirm, cancel };
}
