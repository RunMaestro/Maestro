import type { CSSProperties } from 'react';
import type { Theme } from '../../../../../types';

export function ReadyToProceedPanel({
	theme,
	onLetsGo,
}: {
	theme: Theme;
	onLetsGo: () => void;
}): JSX.Element {
	return (
		<div
			className="mx-auto max-w-md mb-4 p-4 rounded-lg text-center"
			style={{
				backgroundColor: `${theme.colors.success}15`,
				border: `1px solid ${theme.colors.success}40`,
			}}
		>
			<p className="text-sm font-medium mb-3" style={{ color: theme.colors.success }}>
				I think I have a good understanding of your project. Ready to create your Playbook?
			</p>
			<button
				onClick={onLetsGo}
				className="px-6 py-2.5 rounded-lg text-sm font-bold transition-all hover:scale-105 focus:outline-none focus:ring-2 focus:ring-offset-2"
				style={
					{
						backgroundColor: theme.colors.success,
						color: theme.colors.bgMain,
						boxShadow: `0 4px 12px ${theme.colors.success}40`,
						'--tw-ring-color': theme.colors.success,
						'--tw-ring-offset-color': theme.colors.bgMain,
					} as CSSProperties
				}
			>
				Let's Get Started!
			</button>
			<p className="text-xs mt-3" style={{ color: theme.colors.textDim }}>
				Or continue chatting below to add more details
			</p>
		</div>
	);
}
