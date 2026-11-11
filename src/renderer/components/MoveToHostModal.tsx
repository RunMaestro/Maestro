/**
 * Move to Host (Federation lift, FED-SSH-06): lift a local SSH remote agent onto the
 * `maestro-cli host` on its remote, so its work keeps running with the laptop closed.
 *
 * Opened from the Left Bar's right-click menu or the command palette for an SSH agent whose remote
 * takes part in Federation. Two stages, one modal:
 * 1. Set up, while the remote runs no host: install this app's maestro-cli there
 *    and start the host, the same `setupRemoteHost()` as `maestro-cli remote-host install --start`.
 * 2. Move, once the peer is connected: show the plan `maestro-cli lift --dry-run`
 *    prints (what moves, which env vars stay), then run the same lift the CLI runs. Afterwards the
 *    local agent keeps every tab and transcript and shows where it moved.
 */

import { useCallback, useEffect, useState } from 'react';
import { Download, ServerCog } from 'lucide-react';
import type { Theme } from '../types';
import type { DesktopLiftAnswer } from '../../main/federation/lift';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { selectModalData, selectModalOpen, useModalStore } from '../stores/modalStore';
import { selectSessionById, useSessionStore } from '../stores/sessionStore';
import { moveAgentToHost, planMoveToHost, setupRemoteHostFromWindow } from '../services/agentLift';
import { useAgentFederationStatus } from '../hooks/federation/useAgentLift';
import type { AgentFederationStatus } from '../utils/peerMirrorView';
import type { DesktopSetupHostOptions } from '../../main/federation/setup-host';
import { Modal } from './ui/Modal';
import { Spinner } from './ui/Spinner';
import { BundleNotice, BundleOption } from './Bundles/bundleUi';

/** Mounts the Move to Host modal from the modal store. */
export function MoveToHostModalHost({ theme }: { theme: Theme }) {
	const open = useModalStore(selectModalOpen('moveToHost'));
	const data = useModalStore(selectModalData('moveToHost'));
	const session = useSessionStore(selectSessionById(data?.sessionId ?? ''));
	const closeModal = useModalStore((s) => s.closeModal);
	const status = useAgentFederationStatus(session ?? null);
	if (!open || !session) return null;
	return (
		<MoveToHostModal
			theme={theme}
			sessionId={session.id}
			agentName={session.name}
			status={status}
			onClose={() => closeModal('moveToHost')}
		/>
	);
}

/** A setup failure the person can fix from here with one more option. */
const SETUP_RETRY: Record<
	string,
	{ label: string; options: DesktopSetupHostOptions; hint: string }
> = {
	'host-running': {
		label: 'Upgrade and Restart Host',
		options: { restart: true },
		hint: 'Stops the host once its work in flight finishes, upgrades it, and starts it again.',
	},
	'broken-cli': {
		label: 'Reinstall maestro-cli',
		options: { force: true },
		hint: "The maestro-cli on the remote no longer runs. Installs Maestro's own copy in ~/.maestro, which takes precedence; a copy Maestro did not install is left on disk.",
	},
	'foreign-cli': {
		label: "Install Maestro's Own Copy",
		options: { force: true },
		hint: 'Leaves the existing install alone and puts a copy in ~/.maestro that takes precedence.',
	},
};

export function MoveToHostModal({
	theme,
	sessionId,
	agentName,
	status,
	onClose,
}: {
	theme: Theme;
	sessionId: string;
	agentName: string;
	status: AgentFederationStatus;
	onClose: () => void;
}) {
	const [withEnv, setWithEnv] = useState(false);
	const [plan, setPlan] = useState<DesktopLiftAnswer | null>(null);
	const [lifting, setLifting] = useState(false);
	const [liftError, setLiftError] = useState<string | null>(null);
	const [settingUp, setSettingUp] = useState(false);
	const [setupError, setSetupError] = useState<{ code: string; error: string } | null>(null);
	const [setupNote, setSetupNote] = useState<string | null>(null);
	// Options the person already accepted. A remote can need both (an older host from another
	// install): each retry adds its option to these, so retries never alternate between refusals.
	const [setupOptions, setSetupOptions] = useState<DesktopSetupHostOptions>({});

	const sshStatus = status.kind === 'ssh' ? status : null;
	const hostReady = sshStatus?.hostReady === true;
	const remoteName = sshStatus?.peer?.name ?? 'its SSH remote';
	const canSetUp = sshStatus !== null && sshStatus.peer !== undefined;

	// The plan follows the secret env vars choice, exactly as `--with-env` changes the dry run. It
	// is built once the remote's host is connected; before that the modal is in its setup stage.
	useEffect(() => {
		if (!hostReady) return;
		let cancelled = false;
		setPlan(null);
		void planMoveToHost(sessionId, withEnv).then((answer) => {
			if (!cancelled) setPlan(answer);
		});
		return () => {
			cancelled = true;
		};
	}, [sessionId, withEnv, hostReady]);

	const handleSetUp = useCallback(
		async (options: DesktopSetupHostOptions = {}) => {
			if (!sshStatus) return;
			setSetupOptions(options);
			setSettingUp(true);
			setSetupError(null);
			setSetupNote(null);
			const answer = await setupRemoteHostFromWindow(sshStatus.remoteId, options, {
				toastOnError: false,
			});
			setSettingUp(false);
			if (!answer.ok) {
				setSetupError({ code: answer.code, error: answer.error });
				return;
			}
			if (answer.reconnectError) setSetupNote(answer.reconnectError);
			else if (answer.result.lingerFix) {
				setSetupNote(
					`Lingering is off for the SSH user, so the host may stop when the SSH session ends. Run on the remote: ${answer.result.lingerFix}`
				);
			}
		},
		[sshStatus]
	);

	const handleMove = useCallback(async () => {
		setLifting(true);
		setLiftError(null);
		const answer = await moveAgentToHost(sessionId, withEnv);
		setLifting(false);
		if (answer.ok) onClose();
		else setLiftError(answer.error);
	}, [sessionId, withEnv, onClose]);

	const planReady = hostReady && plan?.ok === true;
	const retry = setupError ? SETUP_RETRY[setupError.code] : undefined;

	return (
		<Modal
			theme={theme}
			title="Move to Host"
			subtitle={agentName}
			priority={MODAL_PRIORITIES.MOVE_TO_HOST}
			onClose={onClose}
			headerIcon={<ServerCog className="w-4 h-4" style={{ color: theme.colors.accent }} />}
			width={640}
			resizeKey="moveToHost"
			defaultSize={{ width: 640, height: 520 }}
			contentClassName="p-5 overflow-y-auto flex-1 space-y-4 select-none"
			footer={
				<div className="flex gap-2 w-full justify-end">
					<button
						type="button"
						onClick={onClose}
						className="px-3 py-1.5 rounded border text-xs hover:bg-white/5 transition-colors"
						style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
					>
						Cancel
					</button>
					{hostReady ? (
						<button
							type="button"
							onClick={handleMove}
							disabled={!planReady || lifting}
							className="flex items-center gap-2 px-3 py-1.5 rounded text-xs font-medium transition-colors disabled:opacity-50"
							style={{ backgroundColor: theme.colors.accent, color: theme.colors.bgMain }}
						>
							{lifting ? <Spinner size={14} /> : <ServerCog className="w-3.5 h-3.5" />}
							{lifting ? 'Moving…' : 'Move to Host'}
						</button>
					) : (
						<button
							type="button"
							onClick={() => void handleSetUp({ ...setupOptions, ...retry?.options })}
							disabled={!canSetUp || settingUp}
							className="flex items-center gap-2 px-3 py-1.5 rounded text-xs font-medium transition-colors disabled:opacity-50"
							style={{ backgroundColor: theme.colors.accent, color: theme.colors.bgMain }}
							data-testid="move-to-host-setup"
						>
							{settingUp ? <Spinner size={14} /> : <Download className="w-3.5 h-3.5" />}
							{settingUp ? 'Setting up…' : (retry?.label ?? 'Set Up Host')}
						</button>
					)}
				</div>
			}
		>
			{!hostReady && (
				<>
					<p className="text-xs" style={{ color: theme.colors.textDim }}>
						{remoteName} runs no Maestro host yet. Set Up Host copies this Maestro&apos;s
						maestro-cli there, with Node.js and SQLite for that machine (Linux, macOS, or Windows
						through Git Bash or WSL), into ~/.maestro as your SSH user, and starts the host. Then
						this agent can move onto it. Same as maestro-cli remote-host install --start.
					</p>
					{!canSetUp && (
						<BundleNotice theme={theme} tone="error" title="Federation does not reach this remote">
							<div>
								The remote is disabled, Federation is off for it, or Maestro has not checked it yet.
								Check Settings &gt; SSH Hosts: the remote must be enabled with Federation on
								(maestro-cli update-ssh-remote &lt;id&gt; --enabled true --federation on).
							</div>
						</BundleNotice>
					)}
					{settingUp && (
						<div
							className="flex items-center gap-2 text-xs"
							style={{ color: theme.colors.textDim }}
							data-testid="move-to-host-setup-running"
						>
							<Spinner size={14} /> Installing and starting the host. A first install downloads
							Node.js and builds SQLite, which can take a few minutes.
						</div>
					)}
					{setupError && (
						<BundleNotice theme={theme} tone="error" title="The host is not set up">
							<div className="select-text">{setupError.error}</div>
							{retry && <div className="mt-1">{retry.hint}</div>}
						</BundleNotice>
					)}
				</>
			)}
			{setupNote && (
				<BundleNotice theme={theme} tone="warning" title="Host started">
					<div className="select-text">{setupNote}</div>
				</BundleNotice>
			)}
			{hostReady && (
				<>
					<p className="text-xs" style={{ color: theme.colors.textDim }}>
						The agent moves to the maestro-cli host on its SSH remote and keeps running there with
						this machine off. Every tab and transcript stays here too; this copy becomes a pointer,
						and messages to it are refused. Same as maestro-cli lift.
					</p>

					<BundleOption
						theme={theme}
						label="Send secret env vars too"
						hint="--with-env: keys that look like tokens or passwords stay here unless checked"
						checked={withEnv}
						disabled={lifting}
						onChange={setWithEnv}
					/>

					{!plan && (
						<div
							className="flex items-center gap-2 text-xs"
							style={{ color: theme.colors.textDim }}
							data-testid="move-to-host-plan-loading"
						>
							<Spinner size={14} /> Building the plan…
						</div>
					)}
					{plan && !plan.ok && (
						<BundleNotice theme={theme} tone="error" title="This agent cannot move">
							<div>{plan.error}</div>
						</BundleNotice>
					)}
					{plan?.ok && (
						<pre
							className="text-xs font-mono whitespace-pre-wrap rounded border p-3 select-text"
							style={{
								borderColor: theme.colors.border,
								backgroundColor: theme.colors.bgActivity,
								color: theme.colors.textMain,
							}}
							data-testid="move-to-host-plan"
						>
							{plan.planText}
						</pre>
					)}
					{liftError && (
						<BundleNotice theme={theme} tone="error" title="The move failed">
							<div>{liftError}</div>
						</BundleNotice>
					)}
				</>
			)}
		</Modal>
	);
}
