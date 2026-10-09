import type { Theme } from '../../../../types';

interface GenerationActionsProps {
	theme: Theme;
	documentsLength: number;
	onComplete: () => void;
	onCompleteAndStartAutoRun?: () => void;
}

export function GenerationActions({
	theme,
	documentsLength,
	onComplete,
	onCompleteAndStartAutoRun,
}: GenerationActionsProps): JSX.Element {
	return (
		<div className="mt-8 flex items-center gap-3">
			<button
				type="button"
				onClick={onComplete}
				className="px-6 py-3 text-base font-semibold rounded-lg transition-all hover:opacity-90 hover:scale-105"
				style={{
					backgroundColor: theme.colors.bgActivity,
					color: theme.colors.textMain,
					border: `1px solid ${theme.colors.border}`,
				}}
			>
				Exit Wizard
			</button>
			{onCompleteAndStartAutoRun && documentsLength > 0 && (
				<button
					type="button"
					onClick={onCompleteAndStartAutoRun}
					className="px-6 py-3 text-base font-semibold rounded-lg transition-all hover:opacity-90 hover:scale-105"
					style={{
						backgroundColor: theme.colors.success,
						color: 'white',
					}}
				>
					Start Auto Run
				</button>
			)}
		</div>
	);
}
