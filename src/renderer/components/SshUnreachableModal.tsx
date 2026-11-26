/**
 * SshUnreachableModal - an SSH remote, or the Maestro host behind it, stopped answering.
 *
 * A hosted agent's turns run on the Maestro host of its remote, so that host going away is told
 * here too, through the same store and the same controls, worded for what is down (`cause`).
 *
 * One dialog per remote, whatever failed first: an agent turn, a file save, the
 * file tree, a git poll, a shell command or a Cue run. The main process has
 * already confirmed the outage with its own probe, so this never reports a
 * single dropped connection. It names the remote, says why in ssh's own words,
 * lists the agents that cannot work until it is back, and closes by itself
 * when a background re-probe finds the host again.
 *
 * Shown only when it matters: the agent the user is looking at runs on the
 * remote, or a live turn died on it (`surfaced`). An outage on a remote the
 * user is not working with is tracked silently and appears the moment they go
 * to one of its agents.
 *
 * It takes the agent error modal's slot with a transport-specific cause, and
 * draws that modal's chrome (the Connection Error icon, the same width): a
 * connection loss exists only where a connection exists, so the dialog is the
 * same for every agent that has one (an SSH agent and a hosted agent alike).
 *
 * Self-sourced from `sshOutageStore`; mounted once by `AppAgentModals`.
 */

import { memo, useEffect, useMemo, useState } from 'react';
import { Users } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { Modal } from './ui/Modal';
import { getErrorIcon } from './AgentErrorModal';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import {
	agentsStoppedBy,
	outageScopeOf,
	selectOpenSshOutages,
	useSshOutageStore,
} from '../stores/sshOutageStore';
import { selectActiveSession, useSessionStore } from '../stores/sessionStore';
import { formatRelativeTime } from '../../shared/formatters';
import { ipcErrorMessage } from '../../shared/serializeError';
import {
	outageCause,
	SSH_RECOVERY_PROBE_INTERVAL_SECONDS,
	type SshReachabilityEvent,
} from '../../shared/sshConnection';
import type { Session, Theme } from '../types';

export { agentsOnRemote } from '../stores/sshOutageStore';

export interface SshUnreachableModalProps {
	theme: Theme;
	sessions: Session[];
}

/**
 * The dialog's words for an outage: what is down. ssh down stops every agent on the remote; a
 * host down (ssh works, the Maestro host does not answer) stops the hosted agents on it.
 */
export function outageWording(event: Pick<SshReachabilityEvent, 'remoteName' | 'cause'>): {
	title: string;
	lost: string;
	stopped: string;
	advice: string;
} {
	if (outageCause(event) === 'host') {
		return {
			title: `Can't reach the Maestro host on "${event.remoteName}"`,
			lost: 'Maestro lost the connection to the host',
			stopped:
				'Agents that run on this host cannot run turns or stop a running one until it answers again.',
			advice: 'Check that the Maestro host is running on the remote.',
		};
	}
	return {
		title: `Can't reach "${event.remoteName}" over SSH`,
		lost: 'Maestro lost the connection',
		stopped:
			'Agents on this remote cannot run turns, open or save files, or refresh their file tree and git status until it answers again.',
		advice: 'Check that the host is on and its network or tunnel is up.',
	};
}

export const SshUnreachableModal = memo(function SshUnreachableModal({
	theme,
	sessions,
}: SshUnreachableModalProps) {
	// Select the stable record and derive: a selector returning a fresh array
	// re-renders forever under useSyncExternalStore.
	const outages = useSshOutageStore((s) => s.outages);
	// Shallow-compared: the scope is a fresh object on every store change.
	const activeScope = useSessionStore(useShallow((s) => outageScopeOf(selectActiveSession(s))));
	const openOutages = useMemo(
		() => selectOpenSshOutages({ outages }, activeScope),
		[outages, activeScope]
	);
	const dismiss = useSshOutageStore((s) => s.dismiss);
	const surface = useSshOutageStore((s) => s.surface);
	// The oldest open outage. A second remote down at the same time gets its
	// own dialog once this one is dismissed or resolves.
	const outage = openOutages[0];
	const remoteId = outage?.event.remoteId;

	const [checking, setChecking] = useState(false);
	const [checkResult, setCheckResult] = useState<string | null>(null);

	const event = outage?.event;
	const affected = useMemo(
		() => (event ? agentsStoppedBy(sessions, event) : []),
		[sessions, event]
	);

	// Once on screen, the outage stays the user's business: it announces its
	// recovery, and stays up if they switch to another agent mid-outage.
	useEffect(() => {
		if (remoteId) surface(remoteId);
	}, [remoteId, surface]);

	if (!outage || !remoteId) return null;
	const { message, since } = outage.event;
	const wording = outageWording(outage.event);

	const handleCheckNow = async () => {
		setChecking(true);
		setCheckResult(null);
		try {
			const result = await window.maestro.sshRemote.checkReachability(remoteId);
			if (!result.success) {
				setCheckResult(ipcErrorMessage(result.error, 'The check could not run.'));
			} else if (result.reachable) {
				// Nothing to do here: the main process pushes the recovery, which
				// closes this dialog and raises the "restored" toast.
			} else {
				if (result.event) useSshOutageStore.getState().applyReachability(result.event);
				setCheckResult('Still unreachable.');
			}
		} catch (err) {
			setCheckResult(ipcErrorMessage(err, 'The check could not run.'));
		} finally {
			setChecking(false);
		}
	};

	const handleDismiss = () => {
		setCheckResult(null);
		dismiss(remoteId);
	};

	return (
		<Modal
			theme={theme}
			title={wording.title}
			priority={MODAL_PRIORITIES.SSH_UNREACHABLE}
			onClose={handleDismiss}
			width={480}
			zIndex={10001}
			// The agent error modal's chrome for a connection error: the same icon, size, and width,
			// so a lost connection carries no mode mark beyond the agent's pill.
			headerIcon={
				<span style={{ color: theme.colors.error }}>{getErrorIcon('network_error')}</span>
			}
			testId="ssh-unreachable-modal"
			footer={
				<div className="flex items-center gap-3 w-full">
					<div
						className="mr-auto text-xs min-w-0 truncate"
						style={{ color: theme.colors.textDim }}
						role="status"
					>
						{checking ? 'Checking...' : checkResult}
					</div>
					<button
						type="button"
						onClick={handleDismiss}
						className="px-4 py-1.5 rounded border text-sm hover:bg-white/5 transition-colors outline-none focus:ring-2"
						style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
					>
						Dismiss
					</button>
					<button
						type="button"
						onClick={handleCheckNow}
						disabled={checking}
						className="px-4 py-1.5 rounded text-sm font-medium transition-opacity outline-none focus:ring-2 disabled:opacity-50"
						style={{
							backgroundColor: theme.colors.accent,
							color: theme.colors.accentForeground,
						}}
						data-testid="ssh-unreachable-check-now"
					>
						Check Now
					</button>
				</div>
			}
		>
			<div className="flex flex-col gap-3 text-sm" style={{ color: theme.colors.textMain }}>
				<p>
					{wording.lost} {formatRelativeTime(since)}. {wording.stopped}
				</p>

				{message && (
					<p
						className="text-xs font-mono rounded px-2 py-1.5 select-text break-words"
						style={{ color: theme.colors.textDim, backgroundColor: theme.colors.bgActivity }}
					>
						{message}
					</p>
				)}

				{affected.length > 0 && (
					<div className="flex items-start gap-1.5 text-xs" style={{ color: theme.colors.textDim }}>
						<Users className="w-3.5 h-3.5 shrink-0 mt-0.5" />
						<span className="min-w-0">{affected.map((s) => s.name).join(', ')}</span>
					</div>
				)}

				<p className="text-xs" style={{ color: theme.colors.textDim }}>
					Maestro checks again every {SSH_RECOVERY_PROBE_INTERVAL_SECONDS} seconds and closes this
					when the connection comes back. {wording.advice}
				</p>
			</div>
		</Modal>
	);
});
