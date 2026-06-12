import type { Theme } from '../../../../../types';

interface AgentSelectionFooterProps {
	theme: Theme;
	canProceed: boolean;
	onContinue: () => void;
}

export function AgentSelectionFooter({
	theme,
	canProceed,
	onContinue,
}: AgentSelectionFooterProps): JSX.Element {
	return (
		<div className="flex flex-col items-center gap-4">
			<button
				onClick={onContinue}
				disabled={!canProceed}
				className="px-8 py-2.5 rounded-lg font-medium transition-all focus:outline-none focus:ring-2 focus:ring-offset-2 whitespace-nowrap"
				style={{
					backgroundColor: canProceed ? theme.colors.accent : theme.colors.border,
					color: canProceed ? theme.colors.accentForeground : theme.colors.textDim,
					cursor: canProceed ? 'pointer' : 'not-allowed',
					opacity: canProceed ? 1 : 0.6,
					['--tw-ring-color' as any]: theme.colors.accent,
					['--tw-ring-offset-color' as any]: theme.colors.bgMain,
				}}
			>
				Continue
			</button>

			<div className="flex justify-center gap-6">
				<span className="text-xs flex items-center gap-1" style={{ color: theme.colors.textDim }}>
					<kbd
						className="px-1.5 py-0.5 rounded text-xs"
						style={{ backgroundColor: theme.colors.border }}
					>
						← → ↑ ↓
					</kbd>
					Navigate
				</span>
				<span className="text-xs flex items-center gap-1" style={{ color: theme.colors.textDim }}>
					<kbd
						className="px-1.5 py-0.5 rounded text-xs"
						style={{ backgroundColor: theme.colors.border }}
					>
						Tab
					</kbd>
					Fields
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
			</div>
		</div>
	);
}
