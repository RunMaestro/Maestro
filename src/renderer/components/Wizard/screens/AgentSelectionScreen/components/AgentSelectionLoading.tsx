import type { Theme } from '../../../../../types';

export function AgentSelectionLoading({ theme }: { theme: Theme }): JSX.Element {
	return (
		<div
			className="flex-1 flex flex-col items-center justify-center p-8"
			style={{ color: theme.colors.textMain }}
		>
			<div
				className="w-8 h-8 border-2 border-t-transparent rounded-full animate-spin mb-4"
				style={{ borderColor: theme.colors.accent, borderTopColor: 'transparent' }}
			/>
			<p className="text-sm" style={{ color: theme.colors.textDim }}>
				Detecting available agents...
			</p>
		</div>
	);
}
