import type { Theme } from '../../../../../types';

export function DirectoryKeyboardHints({ theme }: { theme: Theme }): JSX.Element {
	return (
		<div className="flex justify-center gap-6">
			<span className="text-xs flex items-center gap-1" style={{ color: theme.colors.textDim }}>
				<kbd
					className="px-1.5 py-0.5 rounded text-xs"
					style={{ backgroundColor: theme.colors.border }}
				>
					Tab
				</kbd>
				Navigate
			</span>
			<span className="text-xs flex items-center gap-1" style={{ color: theme.colors.textDim }}>
				<kbd
					className="px-1.5 py-0.5 rounded text-xs"
					style={{ backgroundColor: theme.colors.border }}
				>
					Enter
				</kbd>
				Continue
			</span>
			<span className="text-xs flex items-center gap-1" style={{ color: theme.colors.textDim }}>
				<kbd
					className="px-1.5 py-0.5 rounded text-xs"
					style={{ backgroundColor: theme.colors.border }}
				>
					Esc
				</kbd>
				Exit Wizard
			</span>
		</div>
	);
}
