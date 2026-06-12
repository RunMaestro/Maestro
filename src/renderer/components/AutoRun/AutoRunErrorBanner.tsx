import { memo } from 'react';
import { AlertTriangle, Play, XCircle } from 'lucide-react';
import type { Theme } from '../../types';

export interface AutoRunErrorBannerProps {
	theme: Theme;
	errorMessage: string;
	errorDocumentName?: string;
	isRecoverable: boolean;
	onResumeAfterError?: () => void;
	onAbortBatchOnError?: () => void;
}

export const AutoRunErrorBanner = memo(function AutoRunErrorBanner({
	theme,
	errorMessage,
	errorDocumentName,
	isRecoverable,
	onResumeAfterError,
	onAbortBatchOnError,
}: AutoRunErrorBannerProps) {
	return (
		<div
			role="alert"
			className="mx-2 mb-2 p-3 rounded-lg border"
			style={{
				backgroundColor: `${theme.colors.error}15`,
				borderColor: theme.colors.error,
			}}
		>
			<div className="flex items-start gap-2">
				<AlertTriangle
					className="w-4 h-4 mt-0.5 flex-shrink-0"
					style={{ color: theme.colors.error }}
				/>
				<div className="flex-1 min-w-0">
					<div className="text-xs font-semibold mb-1" style={{ color: theme.colors.error }}>
						Auto Run Paused
					</div>
					<div className="text-xs mb-2" style={{ color: theme.colors.textMain }}>
						{errorMessage}
						{errorDocumentName && (
							<span style={{ color: theme.colors.textDim }}>
								{' '}
								— while processing <strong>{errorDocumentName}</strong>
							</span>
						)}
					</div>
					<div className="flex gap-2 flex-wrap">
						{/* Resume button - for recoverable errors */}
						{isRecoverable && onResumeAfterError && (
							<button
								onClick={onResumeAfterError}
								className="flex items-center gap-1.5 px-2 py-1 rounded text-[10px] font-medium transition-colors hover:opacity-80"
								style={{
									backgroundColor: theme.colors.accent,
									color: theme.colors.accentForeground,
								}}
								title="Retry and resume Auto Run"
							>
								<Play className="w-3 h-3" />
								Resume
							</button>
						)}
						{/* Abort button */}
						{onAbortBatchOnError && (
							<button
								onClick={onAbortBatchOnError}
								className="flex items-center gap-1.5 px-2 py-1 rounded text-[10px] font-medium transition-colors hover:opacity-80"
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
					</div>
				</div>
			</div>
		</div>
	);
});
