import { memo } from 'react';
import { Play, XCircle } from 'lucide-react';
import type { Theme } from '../../types';
import { AutoRunNoticeBanner } from './AutoRunNoticeBanner';

export interface AutoRunErrorBannerProps {
	theme: Theme;
	errorMessage: string;
	errorDocumentName?: string;
	isRecoverable: boolean;
	onResumeAfterError?: () => void;
	onAbortBatchOnError?: () => void;
	/**
	 * When set, the actions render disabled with this string as their tooltip
	 * instead of being hidden. Used when the paused run belongs to another
	 * Maestro window: the pause is real and worth showing, but neither button
	 * can reach the loop from here. Hiding them instead would make an error
	 * pause look like it had no recovery path at all.
	 */
	disabledReason?: string;
}

export const AutoRunErrorBanner = memo(function AutoRunErrorBanner({
	theme,
	errorMessage,
	errorDocumentName,
	isRecoverable,
	onResumeAfterError,
	onAbortBatchOnError,
	disabledReason,
}: AutoRunErrorBannerProps) {
	const showResume = isRecoverable && Boolean(onResumeAfterError);
	const showAbort = Boolean(onAbortBatchOnError);
	const disabled = Boolean(disabledReason);

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
								disabled={disabled}
								className={`flex items-center gap-1.5 px-2 py-1 rounded text-2xs font-medium transition-colors ${disabled ? 'cursor-not-allowed' : 'hover:opacity-80'}`}
								style={{
									backgroundColor: theme.colors.accent,
									color: theme.colors.accentForeground,
									opacity: disabled ? 0.6 : 1,
								}}
								title={disabledReason ?? 'Retry and resume Auto Run'}
							>
								<Play className="w-3 h-3" />
								Resume
							</button>
						)}
						{/* Abort button */}
						{showAbort && (
							<button
								onClick={onAbortBatchOnError}
								disabled={disabled}
								className={`flex items-center gap-1.5 px-2 py-1 rounded text-2xs font-medium transition-colors ${disabled ? 'cursor-not-allowed' : 'hover:opacity-80'}`}
								style={{
									backgroundColor: theme.colors.error,
									color: 'white',
									opacity: disabled ? 0.6 : 1,
								}}
								title={disabledReason ?? 'Stop Auto Run completely'}
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
