import { Check, FileText } from 'lucide-react';
import type { Theme } from '../../../../../types';

interface DirectoryStatusPanelProps {
	theme: Theme;
	directoryPath: string;
	directoryError: string | null;
	isGitRepo: boolean;
	isValidating: boolean;
	isInitializingRepo: boolean;
	initRepoError: string | null;
	onInitRepo: () => void;
}

export function DirectoryStatusPanel({
	theme,
	directoryPath,
	directoryError,
	isGitRepo,
	isValidating,
	isInitializingRepo,
	initRepoError,
	onInitRepo,
}: DirectoryStatusPanelProps): JSX.Element | null {
	if (!directoryPath.trim() || directoryError) {
		return null;
	}

	if (isValidating) {
		return (
			<div
				className="mb-6 p-4 rounded-lg border flex items-center gap-3"
				style={{
					backgroundColor: theme.colors.bgSidebar,
					borderColor: theme.colors.border,
				}}
			>
				<div
					className="w-4 h-4 border-2 border-t-transparent rounded-full animate-spin"
					style={{ borderColor: theme.colors.accent, borderTopColor: 'transparent' }}
				/>
				<p className="text-sm" style={{ color: theme.colors.textDim }}>
					Validating directory...
				</p>
			</div>
		);
	}

	return (
		<>
			<div
				className="mb-6 p-4 rounded-lg border flex items-center gap-3"
				style={{
					backgroundColor: isGitRepo ? `${theme.colors.success}10` : theme.colors.bgSidebar,
					borderColor: isGitRepo ? theme.colors.success : theme.colors.border,
				}}
			>
				{isGitRepo ? (
					<>
						<div
							className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0"
							style={{ backgroundColor: theme.colors.success }}
						>
							<Check className="w-5 h-5" style={{ color: 'white' }} />
						</div>
						<div>
							<p className="font-medium" style={{ color: theme.colors.textMain }}>
								Git Repository Detected
							</p>
							<p className="text-xs" style={{ color: theme.colors.textDim }}>
								Version control features like branch tracking, change detection, and worktrees will
								be available.
							</p>
						</div>
					</>
				) : (
					<>
						<div
							className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0"
							style={{ backgroundColor: theme.colors.border }}
						>
							<FileText className="w-5 h-5" style={{ color: theme.colors.textDim }} />
						</div>
						<div className="flex-1 flex flex-col gap-2">
							<div>
								<p className="font-medium" style={{ color: theme.colors.textMain }}>
									Regular Directory
								</p>
								<p className="text-xs" style={{ color: theme.colors.textDim }}>
									Not a Git repository.
								</p>
							</div>
							<button
								type="button"
								onClick={onInitRepo}
								disabled={isInitializingRepo || isValidating}
								className="self-start text-xs px-3 py-1.5 rounded border transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2"
								style={{
									backgroundColor: 'transparent',
									borderColor: theme.colors.accent,
									color: theme.colors.accent,
									opacity: isInitializingRepo || isValidating ? 0.6 : 1,
									cursor: isInitializingRepo || isValidating ? 'wait' : 'pointer',
									['--tw-ring-color' as any]: theme.colors.accent,
									['--tw-ring-offset-color' as any]: theme.colors.bgMain,
								}}
							>
								{isInitializingRepo ? 'Initializing...' : 'Initialize as Git Repository'}
							</button>
							{initRepoError && (
								<p className="text-xs" style={{ color: theme.colors.error }}>
									{initRepoError}
								</p>
							)}
						</div>
					</>
				)}
			</div>

			<p className="text-xs text-center mb-6" style={{ color: theme.colors.textDim }}>
				Git repositories get extra features like branch tracking, change detection, and worktrees.
				Regular folders work too!
			</p>
		</>
	);
}
