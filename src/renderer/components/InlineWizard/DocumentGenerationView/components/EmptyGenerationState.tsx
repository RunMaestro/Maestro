import type { Theme } from '../../../../types';

interface EmptyGenerationStateProps {
	theme: Theme;
	onCancel?: () => void;
}

export function EmptyGenerationState({ theme, onCancel }: EmptyGenerationStateProps): JSX.Element {
	return (
		<div
			className="flex flex-col h-full items-center justify-center p-6"
			style={{ backgroundColor: theme.colors.bgMain }}
		>
			<p style={{ color: theme.colors.textDim }}>No documents generated yet.</p>
			{onCancel && (
				<button
					type="button"
					onClick={onCancel}
					className="mt-4 px-4 py-2 text-sm rounded"
					style={{
						backgroundColor: theme.colors.bgActivity,
						color: theme.colors.textDim,
					}}
				>
					Cancel
				</button>
			)}
		</div>
	);
}
