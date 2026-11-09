/**
 * Move to Host (Federation lift, FED-SSH-06): lift a local SSH remote agent onto the
 * `maestro-cli host` on its remote, so its work keeps running with the laptop closed.
 *
 * Opened from the Left Bar's right-click menu or the command palette, only for an SSH agent whose
 * remote is a connected Federation peer. It shows the plan `maestro-cli lift --dry-run` prints
 * (what moves, which env vars stay), then runs the same lift the CLI runs. Afterwards the local
 * agent keeps every tab and transcript and shows where it moved.
 */

import { useCallback, useEffect, useState } from 'react';
import { ServerCog } from 'lucide-react';
import type { Theme } from '../types';
import type { DesktopLiftAnswer } from '../../main/federation/lift';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { selectModalData, selectModalOpen, useModalStore } from '../stores/modalStore';
import { selectSessionById, useSessionStore } from '../stores/sessionStore';
import { moveAgentToHost, planMoveToHost } from '../services/agentLift';
import { Modal } from './ui/Modal';
import { Spinner } from './ui/Spinner';
import { BundleNotice, BundleOption } from './Bundles/bundleUi';

/** Mounts the Move to Host modal from the modal store. */
export function MoveToHostModalHost({ theme }: { theme: Theme }) {
	const open = useModalStore(selectModalOpen('moveToHost'));
	const data = useModalStore(selectModalData('moveToHost'));
	const session = useSessionStore(selectSessionById(data?.sessionId ?? ''));
	const closeModal = useModalStore((s) => s.closeModal);
	if (!open || !session) return null;
	return (
		<MoveToHostModal
			theme={theme}
			sessionId={session.id}
			agentName={session.name}
			onClose={() => closeModal('moveToHost')}
		/>
	);
}

export function MoveToHostModal({
	theme,
	sessionId,
	agentName,
	onClose,
}: {
	theme: Theme;
	sessionId: string;
	agentName: string;
	onClose: () => void;
}) {
	const [withEnv, setWithEnv] = useState(false);
	const [plan, setPlan] = useState<DesktopLiftAnswer | null>(null);
	const [lifting, setLifting] = useState(false);
	const [liftError, setLiftError] = useState<string | null>(null);

	// The plan follows the secret env vars choice, exactly as `--with-env` changes the dry run.
	useEffect(() => {
		let cancelled = false;
		setPlan(null);
		void planMoveToHost(sessionId, withEnv).then((answer) => {
			if (!cancelled) setPlan(answer);
		});
		return () => {
			cancelled = true;
		};
	}, [sessionId, withEnv]);

	const handleMove = useCallback(async () => {
		setLifting(true);
		setLiftError(null);
		const answer = await moveAgentToHost(sessionId, withEnv);
		setLifting(false);
		if (answer.ok) onClose();
		else setLiftError(answer.error);
	}, [sessionId, withEnv, onClose]);

	const planReady = plan?.ok === true;

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
				</div>
			}
		>
			<p className="text-xs" style={{ color: theme.colors.textDim }}>
				The agent moves to the maestro-cli host on its SSH remote and keeps running there with this
				machine off. Every tab and transcript stays here too; this copy becomes a pointer, and
				messages to it are refused. Same as maestro-cli lift.
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
		</Modal>
	);
}
