import { Spinner } from '../../ui/Spinner';
import type { Theme } from '../../../types';

interface FileTreeLoadingProgressProps {
	theme: Theme;
	progress?: {
		directoriesScanned: number;
		filesFound: number;
		currentDirectory: string;
	};
	/** Stops the walk. Offered in every mode: a large local tree is as slow to scan as a remote one. */
	onCancel?: () => void;
}

export function FileTreeLoadingProgress({
	theme,
	progress,
	onCancel,
}: FileTreeLoadingProgressProps) {
	const currentFolder = progress?.currentDirectory
		? progress.currentDirectory.split('/').pop() || progress.currentDirectory
		: '';

	return (
		<div className="flex flex-col items-center justify-center gap-3 py-8">
			<Spinner size={24} color={theme.colors.accent} />

			<div className="text-center">
				<div className="text-xs" style={{ color: theme.colors.textMain }}>
					Loading files...
				</div>

				{progress && (progress.directoriesScanned > 0 || progress.filesFound > 0) && (
					<div className="text-xs mt-2 font-mono" style={{ color: theme.colors.textDim }}>
						<span style={{ color: theme.colors.accent }}>
							{progress.filesFound.toLocaleString()}
						</span>
						{' files in '}
						<span style={{ color: theme.colors.accent }}>
							{progress.directoriesScanned.toLocaleString()}
						</span>
						{' folders'}
					</div>
				)}

				{currentFolder && (
					<div
						className="text-2xs mt-1.5 max-w-[200px] truncate opacity-60"
						style={{ color: theme.colors.textDim }}
						title={progress?.currentDirectory}
					>
						scanning: {currentFolder}/
					</div>
				)}

				{onCancel && (
					<button
						type="button"
						onClick={onCancel}
						className="text-xs-plus mt-3 underline-offset-2 hover:underline transition-opacity"
						style={{ color: theme.colors.textDim }}
					>
						Stop loading
					</button>
				)}
			</div>
		</div>
	);
}
