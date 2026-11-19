import { useState } from 'react';
import { CheckCircle2 } from 'lucide-react';
import {
	compactPlaybookParamValues,
	type PlaybookParamValues,
} from '../../../../shared/playbookParams';
import { clampImportedMaxLoops, isUnboundedLoop } from '../../../../shared/playbookRun';
import type { Playbook } from '../../../../shared/types';
import { buildPlaybookBatchRunConfig } from '../../../hooks/batch/playbookRunConfig';
import { useBatchStore } from '../../../stores/batchStore';
import { notifyToast } from '../../../stores/notificationStore';
import { selectSessionById, useSessionStore } from '../../../stores/sessionStore';
import { useSettingsStore } from '../../../stores/settingsStore';
import type { BatchRunConfig, Theme } from '../../../types';
import { ipcErrorMessage } from '../../../utils/ipcErrorMessage';
import { PlaybookConfigureFlow } from '../../PlaybookLaunch/PlaybookConfigureFlow';
import { PlaybookRunSummary } from '../../PlaybookLaunch/PlaybookRunSummary';
import { EscCloseButton } from '../../ui/EscCloseButton';

export interface PlaybookConfigureStepProps {
	theme: Theme;
	/** The record Install and Run just stored, with its parameter answers and overlay. */
	playbook: Playbook;
	/** The agent whose playbook store holds the record, and the agent the run targets. */
	sessionId: string;
	/** The marketplace README, handed to the guided interview. */
	readmeContent?: string | null;
	/** The manifest asked for unlimited loops and the import capped them. */
	importCappedLoops?: boolean;
	/** Starts the run; resolves true once it is running. */
	onRunPlaybook: (sessionId: string, config: BatchRunConfig) => Promise<boolean>;
	onClose: () => void;
}

/**
 * The step the Playbook Exchange moves to after Install and Run: the
 * playbook is installed and stored, and its parameters are answered here
 * (`PlaybookConfigureFlow`: the guided interview when it can earn its tokens,
 * then the `ParameterSheet`, saved to the record as they are typed). The row
 * above Run prices the run (documents, loops, agent and model), and Run
 * starts it on the current agent through the Auto Run panel's own launch
 * path. The Exchange closes only once the run reports running, and the Auto
 * Run panel shows it from there.
 *
 * There is no way back to the detail view from here; the install already
 * happened, so going back would only invite a second copy.
 */
export function PlaybookConfigureStep({
	theme,
	playbook,
	sessionId,
	readmeContent,
	importCappedLoops = false,
	onRunPlaybook,
	onClose,
}: PlaybookConfigureStepProps) {
	const documentCount = playbook.documents.length;
	const folderName = playbook.provenance?.targetFolderName;
	const session = useSessionStore(selectSessionById(sessionId));
	const isRunning = useBatchStore((s) => Boolean(s.batchRunStates[sessionId]?.isRunning));
	const autoRunDisabled = useSettingsStore((s) => s.autoRunDisabled);

	// A record stored before imports were capped still gets the cap here.
	const capped = importCappedLoops || isUnboundedLoop(playbook.loopEnabled, playbook.maxLoops);
	const [maxLoops, setMaxLoops] = useState(() =>
		clampImportedMaxLoops(playbook.loopEnabled, playbook.maxLoops)
	);

	const agentName = session?.name ?? 'this agent';
	const blockedReason = !session
		? 'The agent this playbook was installed on is gone.'
		: autoRunDisabled
			? 'Auto Run is disabled in Settings.'
			: isRunning
				? `An Auto Run is already going on ${agentName}.`
				: null;

	const handleRun = async (values: PlaybookParamValues) => {
		const answers = compactPlaybookParamValues(values);
		// The record gets what the run uses (Detected proposals and the loop cap
		// included), so a Resume and the Auto Run panel see the same values.
		try {
			const result = await window.maestro.playbooks.update(sessionId, playbook.id, {
				parameterValues: answers,
				...(playbook.loopEnabled && { maxLoops: maxLoops ?? null }),
			});
			if (!result.success) throw new Error(result.error ?? 'The playbook was not updated.');
		} catch (error) {
			notifyToast({
				color: 'red',
				title: 'Playbook not saved',
				message: `The run did not start: ${ipcErrorMessage(error)}`,
			});
			return;
		}
		const config = buildPlaybookBatchRunConfig(
			{ ...playbook, maxLoops, parameterValues: answers },
			{ ownerSessionId: sessionId, launchSource: 'exchange', parameterValues: answers }
		);
		if (await onRunPlaybook(sessionId, config)) onClose();
	};

	return (
		<div className="flex flex-col h-full overflow-hidden" data-testid="playbook-configure-step">
			<div
				className="flex items-center gap-4 px-4 py-3 border-b shrink-0"
				style={{ borderColor: theme.colors.border }}
			>
				<div className="flex-1 min-w-0">
					<div className="text-xs mb-0.5" style={{ color: theme.colors.textDim }}>
						Configure run
					</div>
					<h2 className="text-lg font-semibold truncate" style={{ color: theme.colors.textMain }}>
						{playbook.name}
					</h2>
				</div>
				<EscCloseButton theme={theme} onClose={onClose} />
			</div>

			<div
				className="flex items-start gap-2 px-4 pt-3 text-sm shrink-0"
				style={{ color: theme.colors.textMain }}
			>
				<CheckCircle2
					className="w-4 h-4 mt-0.5 shrink-0"
					style={{ color: theme.colors.success }}
					aria-hidden="true"
				/>
				<span className="select-text">
					Installed {documentCount} {documentCount === 1 ? 'document' : 'documents'}
					{folderName ? (
						<>
							{' '}
							to <strong>{folderName}</strong>
						</>
					) : null}
					.
				</span>
			</div>

			<div className="flex-1 min-h-0">
				<PlaybookConfigureFlow
					theme={theme}
					sessionId={sessionId}
					playbook={playbook}
					readme={readmeContent}
					runLabel="Run"
					blockedReason={blockedReason}
					summary={
						<PlaybookRunSummary
							theme={theme}
							playbook={playbook}
							maxLoops={maxLoops}
							capped={capped}
							onMaxLoopsChange={setMaxLoops}
							agentName={agentName}
							model={session?.customModel}
						/>
					}
					onRun={handleRun}
				/>
			</div>
		</div>
	);
}
