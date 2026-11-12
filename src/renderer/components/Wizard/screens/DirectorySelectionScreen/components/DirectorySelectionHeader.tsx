import type { Theme } from '../../../../../types';

interface DirectorySelectionHeaderProps {
	theme: Theme;
	agentName: string;
	yoloFlag: string | null;
}

export function DirectorySelectionHeader({
	theme,
	agentName,
	yoloFlag,
}: DirectorySelectionHeaderProps): JSX.Element {
	return (
		<div className="text-center">
			<h2 className="text-3xl font-bold mb-6" style={{ color: theme.colors.accent }}>
				Howdy, I'm {agentName || 'your agent'}
			</h2>
			<h3 className="text-xl font-semibold mb-4" style={{ color: theme.colors.textMain }}>
				Where Should We Work?
			</h3>
			<p className="text-sm mb-4" style={{ color: theme.colors.textDim }}>
				Choose the folder where your project lives (or will live).
			</p>
			<p className="text-xs max-w-lg mx-auto" style={{ color: theme.colors.textDim, opacity: 0.8 }}>
				Do note, as a matter of design I operate in{' '}
				<code
					className="px-1.5 py-0.5 rounded text-xs"
					style={{ backgroundColor: theme.colors.warning, color: theme.colors.bgMain }}
				>
					Full Access
				</code>{' '}
				mode, aka:
			</p>
			{yoloFlag && (
				<div className="my-3 flex justify-center">
					<code
						className="px-2 py-1 rounded text-xs"
						style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.warning }}
					>
						{yoloFlag}
					</code>
				</div>
			)}
			<p className="text-xs max-w-lg mx-auto" style={{ color: theme.colors.textDim, opacity: 0.8 }}>
				I do my best to only make changes within this directory...
				<br />
				That said, Caveat Emptor.
			</p>
		</div>
	);
}
