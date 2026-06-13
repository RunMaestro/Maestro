import { AlertTriangle } from 'lucide-react';
import type { Theme } from '../../../../../types';
import { wizardDebugLogger } from '../../../services/phaseGenerator';

export function ErrorDisplay({
	error,
	onRetry,
	onSkip,
	theme,
}: {
	error: string;
	onRetry: () => void;
	onSkip: () => void;
	theme: Theme;
}): JSX.Element {
	return (
		<div className="flex-1 flex flex-col items-center justify-center p-8">
			<div
				className="w-16 h-16 rounded-full flex items-center justify-center mb-6"
				style={{ backgroundColor: `${theme.colors.error}20` }}
			>
				<AlertTriangle className="w-8 h-8" style={{ color: theme.colors.error }} />
			</div>

			<h3
				className="text-xl font-semibold mb-2 text-center"
				style={{ color: theme.colors.textMain }}
			>
				Generation Failed
			</h3>
			<p className="text-sm text-center max-w-md mb-6" style={{ color: theme.colors.error }}>
				{error}
			</p>

			<div className="flex items-center gap-4">
				<button
					onClick={onRetry}
					className="px-6 py-2.5 rounded-lg font-medium transition-all hover:scale-105"
					style={{ backgroundColor: theme.colors.accent, color: theme.colors.accentForeground }}
				>
					Try Again
				</button>
				<button
					onClick={onSkip}
					className="px-6 py-2.5 rounded-lg font-medium transition-colors"
					style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textDim }}
				>
					Go Back
				</button>
			</div>

			<button
				onClick={() => wizardDebugLogger.downloadLogs()}
				className="mt-6 text-xs underline hover:opacity-80 transition-opacity cursor-pointer"
				style={{ color: theme.colors.textDim }}
			>
				(Debug Logs)
			</button>
		</div>
	);
}
