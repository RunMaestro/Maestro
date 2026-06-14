import { useEffect, useState } from 'react';
import type { Theme } from '../../../../../types';
import { formatElapsedTime } from '../../../../../../shared/formatters';
import type { CreatedFileInfo } from '../types';
import { countCreatedFileTasks } from '../utils/createdFiles';
import { AustinFactTypewriter } from './AustinFactTypewriter';
import { CreatedFilesList } from './CreatedFilesList';

export function LoadingIndicator({
	message,
	theme,
	createdFiles = [],
	startTime,
}: {
	message: string;
	theme: Theme;
	createdFiles?: CreatedFileInfo[];
	startTime?: number;
}): JSX.Element {
	const totalTasks = countCreatedFileTasks(createdFiles);
	const [elapsedMs, setElapsedMs] = useState(0);

	useEffect(() => {
		if (!startTime) return;

		setElapsedMs(Date.now() - startTime);
		const interval = setInterval(() => {
			setElapsedMs(Date.now() - startTime);
		}, 1000);

		return () => clearInterval(interval);
	}, [startTime]);

	return (
		<div className="flex-1 flex flex-col p-6 items-center justify-center">
			<div className="flex flex-col items-center">
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

				<h3
					className="text-lg font-semibold mb-1 text-center"
					style={{ color: theme.colors.textMain }}
				>
					{message}
				</h3>

				<p className="text-sm text-center max-w-md" style={{ color: theme.colors.textDim }}>
					This may take a while. We're creating detailed task documents based on your project
					requirements.
				</p>
				{startTime && elapsedMs > 0 && (
					<p className="text-xs mt-1 font-mono" style={{ color: theme.colors.textDim }}>
						Elapsed: {formatElapsedTime(elapsedMs)}
					</p>
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
				) : (
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
				)}

				<CreatedFilesList files={createdFiles} theme={theme} />
				<AustinFactTypewriter theme={theme} />
			</div>

			<style>{`
        @keyframes bounce-dot {
          0%, 100% {
            transform: translateY(0);
          }
          50% {
            transform: translateY(-6px);
          }
        }
        @keyframes fadeSlideIn {
          from {
            opacity: 0;
            transform: translateY(-8px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
      `}</style>
		</div>
	);
}
