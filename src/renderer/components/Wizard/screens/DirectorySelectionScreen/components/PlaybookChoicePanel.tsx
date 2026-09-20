import type { Theme } from '../../../../../types';

interface PlaybookChoicePanelProps {
	theme: Theme;
	/** Hidden until there is a directory to work in, like the Continue button. */
	show: boolean;
	isSkipping: boolean;
	skipError: string | null;
	onSkip: () => void;
}

/**
 * What the next step actually is, and how to opt out of it.
 *
 * Continue leads into a discovery conversation and then a generated playbook.
 * That is the right path for work you are about to start and the wrong one for
 * a repository that already has its own planning system, so the way out has to
 * be visible BEFORE the conversation spends a turn (issue #1225).
 */
export function PlaybookChoicePanel({
	theme,
	show,
	isSkipping,
	skipError,
	onSkip,
}: PlaybookChoicePanelProps): JSX.Element | null {
	if (!show) return null;

	return (
		<div className="flex flex-col items-center gap-2 mt-4">
			<p className="text-xs max-w-lg text-center" style={{ color: theme.colors.textDim }}>
				Next I'll look over the project and write you a <strong>playbook</strong>: a markdown
				checklist of tasks that Auto Run can work through unattended.
			</p>

			<button
				onClick={onSkip}
				disabled={isSkipping}
				className="text-xs underline underline-offset-2 transition-opacity focus:outline-none focus:ring-2 focus:ring-offset-2 rounded px-2 py-1"
				style={{
					color: theme.colors.textDim,
					opacity: isSkipping ? 0.6 : 1,
					cursor: isSkipping ? 'wait' : 'pointer',
					['--tw-ring-color' as any]: theme.colors.accent,
					['--tw-ring-offset-color' as any]: theme.colors.bgMain,
				}}
			>
				{isSkipping ? 'Creating your agent...' : 'Skip that, just create the agent'}
			</button>

			{skipError && (
				<p className="text-xs" style={{ color: theme.colors.error }}>
					{skipError}
				</p>
			)}
		</div>
	);
}
