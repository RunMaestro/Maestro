import type { CSSProperties } from 'react';
import type { Theme } from '../../../../../types';
import type { WizardError } from '../../../services/wizardErrorDetection';

export function ConversationErrorPanel({
	theme,
	error,
	detectedError,
	errorRetryCount,
	onRetry,
	onGoBack,
	onDownloadDebugLogs,
}: {
	theme: Theme;
	error: string;
	detectedError: WizardError | null;
	errorRetryCount: number;
	onRetry: () => void;
	onGoBack: () => void;
	onDownloadDebugLogs: () => void;
}): JSX.Element {
	return (
		<div
			className="mx-auto max-w-md mb-4 p-4 rounded-lg"
			style={{
				backgroundColor: `${theme.colors.error}15`,
				border: `1px solid ${theme.colors.error}40`,
			}}
		>
			{detectedError && (
				<p className="text-sm font-semibold mb-1" style={{ color: theme.colors.error }}>
					{detectedError.title}
				</p>
			)}
			<p
				className="text-sm mb-2"
				style={{ color: detectedError ? theme.colors.textMain : theme.colors.error }}
			>
				{detectedError ? detectedError.message : error}
			</p>
			{detectedError && (
				<p className="text-xs mb-3 opacity-80" style={{ color: theme.colors.textDim }}>
					{detectedError.recoveryHint}
				</p>
			)}
			<div className="flex justify-center gap-2">
				<button
					onClick={onRetry}
					className="px-4 py-1.5 rounded text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-offset-1"
					style={
						{
							backgroundColor: theme.colors.error,
							color: 'white',
							'--tw-ring-color': theme.colors.error,
							'--tw-ring-offset-color': theme.colors.bgMain,
						} as CSSProperties
					}
				>
					{detectedError && !detectedError.canRetry
						? 'Dismiss'
						: errorRetryCount > 2
							? 'Try Again'
							: 'Dismiss'}
				</button>
				{detectedError && !detectedError.canRetry && (
					<button
						onClick={onGoBack}
						className="px-4 py-1.5 rounded text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-offset-1"
						style={
							{
								backgroundColor: theme.colors.bgSidebar,
								color: theme.colors.textMain,
								border: `1px solid ${theme.colors.border}`,
								'--tw-ring-color': theme.colors.accent,
								'--tw-ring-offset-color': theme.colors.bgMain,
							} as CSSProperties
						}
					>
						Go Back
					</button>
				)}
			</div>
			<button
				onClick={onDownloadDebugLogs}
				className="mt-3 text-xs underline hover:opacity-80 transition-opacity cursor-pointer"
				style={{ color: theme.colors.textDim }}
			>
				(Debug Logs)
			</button>
		</div>
	);
}
