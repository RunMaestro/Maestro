import type { ReactNode } from 'react';
import type { Theme } from '../../../../../types';

interface SectionCardProps {
	theme: Theme;
	children: ReactNode;
	className?: string;
	testId?: string;
}

export function SectionCard({
	theme,
	children,
	className = 'space-y-3',
	testId,
}: SectionCardProps) {
	return (
		<div
			className={`p-3 rounded border ${className}`}
			data-testid={testId}
			style={{
				borderColor: theme.colors.border,
				backgroundColor: theme.colors.bgMain,
			}}
		>
			{children}
		</div>
	);
}
