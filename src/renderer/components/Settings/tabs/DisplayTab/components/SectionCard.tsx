import type { ReactNode } from 'react';
import type { Theme } from '../../../../../types';

interface SectionCardProps {
	theme: Theme;
	children: ReactNode;
	className?: string;
}

export function SectionCard({ theme, children, className = 'space-y-3' }: SectionCardProps) {
	return (
		<div
			className={`p-3 rounded border ${className}`}
			style={{
				borderColor: theme.colors.border,
				backgroundColor: theme.colors.bgMain,
			}}
		>
			{children}
		</div>
	);
}
