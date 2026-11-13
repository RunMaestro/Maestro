/**
 * SshUnreachableModal - an SSH remote stopped answering.
 *
 * One dialog per remote, whatever failed first: an agent turn, a file save, the
 * file tree, a git poll, a shell command or a Cue run. The main process has
 * already confirmed the outage with its own probe, so this never reports a
 * single dropped connection. It names the remote, says why in ssh's own words,
 * lists the agents that cannot work until it is back, and closes by itself
 * when a background re-probe finds the host again.
 *
 * Self-sourced from `sshOutageStore`; mounted once by `AppAgentModals`.
 */

import { memo, useMemo, useState } from 'react';
import { Server, Users } from 'lucide-react';

import { Modal } from './ui/Modal';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { selectOpenSshOutages, useSshOutageStore } from '../stores/sshOutageStore';
import { formatRelativeTime } from '../../shared/formatters';
import { ipcErrorMessage } from '../../shared/serializeError';
import { SSH_RECOVERY_PROBE_INTERVAL_SECONDS } from '../../shared/sshConnection';
import type { Session, Theme } from '../types';

export interface SshUnreachableModalProps {
	theme: Theme;
	sessions: Session[];
}

/** Agents whose work runs through `remoteId`. */
export function agentsOnRemote(sessions: Session[], remoteId: string): Session[] {
	return sessions.filter(
		(s) =>
			(s.sessionSshRemoteConfig?.enabled && s.sessionSshRemoteConfig.remoteId === remoteId) ||
			s.sshRemoteId === remoteId
	);
}

export const SshUnreachableModal = memo(function SshUnreachableModal({
	theme,
	sessions,
}: SshUnreachableModalProps) {
	// Select the stable record and derive: a selector returning a fresh array
	// re-renders forever under useSyncExternalStore.
	const outages = useSshOutageStore((s) => s.outages);
	const openOutages = useMemo(() => selectOpenSshOutages({ outages }), [outages]);
	const dismiss = useSshOutageStore((s) => s.dismiss);
	// The oldest open outage. A second remote down at the same time gets its
	// own dialog once this one is dismissed or resolves.
	const outage = openOutages[0];
	const remoteId = outage?.event.remoteId;

	const [checking, setChecking] = useState(false);
	const [checkResult, setCheckResult] = useState<string | null>(null);

	const affected = useMemo(
		() => (remoteId ? agentsOnRemote(sessions, remoteId) : []),
		[sessions, remoteId]
	);

	if (!outage || !remoteId) return null;
	const { remoteName, message, since } = outage.event;

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
			title={`Can't reach "${remoteName}" over SSH`}
			priority={MODAL_PRIORITIES.SSH_UNREACHABLE}
			onClose={handleDismiss}
			width={520}
			zIndex={10001}
			headerIcon={<Server className="w-5 h-5" style={{ color: theme.colors.error }} />}
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
					Maestro lost the connection {formatRelativeTime(since)}. Agents on this remote cannot run
					turns, open or save files, or refresh their file tree and git status until it answers
					again.
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
					when the connection comes back. Check that the host is on and its network or tunnel is up.
				</p>
			</div>
		</Modal>
	);
});
