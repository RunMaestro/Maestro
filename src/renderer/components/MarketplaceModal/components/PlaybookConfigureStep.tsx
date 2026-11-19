import { Check, CheckCircle2 } from 'lucide-react';
import type { Playbook } from '../../../../shared/types';
import type { Theme } from '../../../types';
import { PlaybookConfigureFlow } from '../../PlaybookLaunch/PlaybookConfigureFlow';
import { EscCloseButton } from '../../ui/EscCloseButton';

export interface PlaybookConfigureStepProps {
	theme: Theme;
	/** The record Install and Run just stored, with its parameter answers and overlay. */
	playbook: Playbook;
	/** The agent whose playbook store holds the record. */
	sessionId: string;
	/** The marketplace README, handed to the guided interview. */
	readmeContent?: string | null;
	onClose: () => void;
}

/**
 * The step the Playbook Exchange moves to after Install and Run: the
 * playbook is installed and stored, and its parameters are answered here
 * (`PlaybookConfigureFlow`: the guided interview when it can earn its tokens,
 * then the `ParameterSheet`, saved to the record as they are typed) before it
 * runs on the current agent. There is no way back to the detail view from here; the
 * install already happened, so going back would only invite a second copy.
 */
export function PlaybookConfigureStep({
	theme,
	playbook,
	sessionId,
	readmeContent,
	onClose,
}: PlaybookConfigureStepProps) {
	const documentCount = playbook.documents.length;
	const folderName = playbook.provenance?.targetFolderName;

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
					runLabel="Save and Close"
					runIcon={<Check className="w-3.5 h-3.5" aria-hidden="true" />}
					onRun={onClose}
				/>
			</div>
		</div>
	);
}
