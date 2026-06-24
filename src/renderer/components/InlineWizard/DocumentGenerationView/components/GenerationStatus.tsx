import { Check } from 'lucide-react';
import type { Theme } from '../../../../types';
import { formatElapsedTime } from '../../../../../shared/formatters';

interface GenerationStatusProps {
	theme: Theme;
	isComplete: boolean;
	totalTasks: number;
	elapsedMs: number;
	subfolderName?: string;
}

export function GenerationStatus({
	theme,
	isComplete,
	totalTasks,
	elapsedMs,
	subfolderName,
}: GenerationStatusProps): JSX.Element {
	return (
		<>
			{isComplete ? (
				<div
					className="w-14 h-14 rounded-full flex items-center justify-center mb-4"
					style={{ backgroundColor: `${theme.colors.success}20` }}
				>
					<Check className="w-7 h-7" style={{ color: theme.colors.success }} />
				</div>
			) : (
				<div className="relative mb-4">
					<div
						className="w-14 h-14 rounded-full border-4 border-t-transparent animate-spin"
						style={{
							borderColor: `${theme.colors.border}`,
							borderTopColor: theme.colors.accent,
						}}
					/>
					<div className="absolute inset-0 flex items-center justify-center">
						<div
							className="w-7 h-7 rounded-full animate-pulse"
							style={{ backgroundColor: `${theme.colors.accent}30` }}
						/>
					</div>
				</div>
			)}

			<h3
				className="text-lg font-semibold mb-1 text-center"
				style={{ color: theme.colors.textMain }}
			>
				{isComplete ? 'Documentation generation complete.' : 'Generating Auto Run Documents...'}
			</h3>

			{isComplete ? (
				<p className="text-sm text-center max-w-md" style={{ color: theme.colors.textDim }}>
					Available under{' '}
					<span style={{ color: theme.colors.accent, fontWeight: 500 }}>
						{subfolderName || '.maestro/playbooks'}/
					</span>
				</p>
			) : (
				<>
					<p className="text-sm text-center max-w-md" style={{ color: theme.colors.textDim }}>
						This may take a while. We're creating detailed task documents based on your project
						requirements.
					</p>
					{elapsedMs > 0 && (
						<p className="text-xs mt-1 font-mono" style={{ color: theme.colors.textDim }}>
							Elapsed: {formatElapsedTime(elapsedMs)}
						</p>
					)}
				</>
			)}

			{totalTasks > 0 ? (
				<div className="mt-4 flex items-center gap-2">
					<span className="text-3xl font-bold" style={{ color: theme.colors.accent }}>
						{totalTasks}
					</span>
					<span className="text-lg font-medium" style={{ color: theme.colors.textMain }}>
						{totalTasks === 1 ? 'Task' : 'Tasks'} Planned
					</span>
				</div>
			) : !isComplete ? (
				<div className="flex items-center gap-1 mt-3">
					{[0, 1, 2].map((i) => (
						<div
							key={i}
							className="w-2 h-2 rounded-full"
							style={{
								backgroundColor: theme.colors.accent,
								animation: `bounce-dot 0.8s infinite ${i * 150}ms`,
							}}
						/>
					))}
				</div>
			) : null}
		</>
	);
}
