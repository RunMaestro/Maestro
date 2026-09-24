import { memo } from 'react';
import { Play, XCircle } from 'lucide-react';
import type { Theme } from '../../types';
import { AutoRunNoticeBanner } from './AutoRunNoticeBanner';

export interface AutoRunErrorBannerProps {
	theme: Theme;
	errorMessage: string;
	errorDocumentName?: string;
	isRecoverable: boolean;
	/** The pause is a HITL gate: Resume records that the person did the step. */
	isHumanGate?: boolean;
	onResumeAfterError?: () => void;
	onAbortBatchOnError?: () => void;
}

export const AutoRunErrorBanner = memo(function AutoRunErrorBanner({
	theme,
	errorMessage,
	errorDocumentName,
	isRecoverable,
	isHumanGate = false,
	onResumeAfterError,
	onAbortBatchOnError,
}: AutoRunErrorBannerProps) {
	const showResume = isRecoverable && Boolean(onResumeAfterError);
	const showAbort = Boolean(onAbortBatchOnError);

	return (
		<AutoRunNoticeBanner
			theme={theme}
			severity="error"
			title="Auto Run Paused"
			actions={
				showResume || showAbort ? (
					<>
						{/* Resume button - for recoverable errors */}
						{showResume && (
							<button
								onClick={onResumeAfterError}
								className="flex items-center gap-1.5 px-2 py-1 rounded text-2xs font-medium transition-colors hover:opacity-80"
								style={{
									backgroundColor: theme.colors.accent,
									color: theme.colors.accentForeground,
								}}
								title={
									isHumanGate
										? 'Tick the "Human step done" box under this gate and continue'
										: 'Retry and resume Auto Run'
								}
							>
								<Play className="w-3 h-3" />
								{isHumanGate ? 'Done, Resume' : 'Resume'}
							</button>
						)}
						{/* Abort button */}
						{showAbort && (
							<button
								onClick={onAbortBatchOnError}
								className="flex items-center gap-1.5 px-2 py-1 rounded text-2xs font-medium transition-colors hover:opacity-80"
								style={{
									backgroundColor: theme.colors.error,
									color: 'white',
								}}
								title="Stop Auto Run completely"
							>
								<XCircle className="w-3 h-3" />
								Abort Run
							</button>
						)}
					</>
				) : undefined
			}
		>
			{errorMessage}
			{errorDocumentName && (
				<span style={{ color: theme.colors.textDim }}>
					{' '}
					- while processing <strong>{errorDocumentName}</strong>
				</span>
			)}
		</AutoRunNoticeBanner>
	);
});
