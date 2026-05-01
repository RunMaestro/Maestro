import type { Theme } from '../../types';

interface TagPillProps {
	label: string;
	theme: Theme;
}

export function TagPill({ label, theme }: TagPillProps) {
	return (
		<span
			className="inline-flex items-center px-2 py-0.5 rounded text-xs"
			style={{
				backgroundColor: theme.colors.bgActivity,
				color: theme.colors.textDim,
				border: `1px solid ${theme.colors.border}`,
			}}
		>
			{label}
		</span>
	);
}
