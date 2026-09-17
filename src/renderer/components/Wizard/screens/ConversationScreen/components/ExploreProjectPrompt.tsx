import type { CSSProperties } from 'react';
import { FolderSearch } from 'lucide-react';
import type { Theme } from '../../../../../types';

/**
 * The one-click alternative to describing an existing project by hand.
 *
 * Sits under the opening question, which is a canned prompt picked in the
 * renderer rather than something the agent produced - so at this point in the
 * wizard nothing has read the repository yet, and someone pointing Maestro at
 * an established codebase is being asked for facts that are already on disk.
 *
 * Offered rather than automatic: the turn costs tokens and a brand-new,
 * empty directory has nothing to read.
 */
export function ExploreProjectPrompt({
	theme,
	disabled,
	onExplore,
}: {
	theme: Theme;
	disabled: boolean;
	onExplore: () => void;
}): JSX.Element {
	return (
		<div className="flex flex-col items-start gap-1 mb-4 ml-1">
			<button
				type="button"
				onClick={onExplore}
				disabled={disabled}
				className="flex items-center gap-2 px-3 py-1.5 rounded-full border text-xs font-medium transition-all hover:scale-[1.02] disabled:opacity-50 disabled:hover:scale-100 focus:outline-none focus:ring-2 focus:ring-offset-2"
				style={
					{
						backgroundColor: `${theme.colors.accent}15`,
						borderColor: `${theme.colors.accent}40`,
						color: theme.colors.accent,
						cursor: disabled ? 'not-allowed' : 'pointer',
						'--tw-ring-color': theme.colors.accent,
						'--tw-ring-offset-color': theme.colors.bgMain,
					} as CSSProperties
				}
			>
				<FolderSearch className="w-3.5 h-3.5" />
				Explore this project for me
			</button>
			<span className="text-xs" style={{ color: theme.colors.textDim }}>
				Already have a codebase? Let the agent read it and summarize the project instead.
			</span>
		</div>
	);
}
