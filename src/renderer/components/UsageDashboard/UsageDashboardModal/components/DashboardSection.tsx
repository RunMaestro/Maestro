import type { CSSProperties, KeyboardEvent, ReactNode } from 'react';
import type { Theme } from '../../../../types';
import { getSectionLabel, type SectionId } from '../sections';

interface DashboardSectionProps {
	sectionId: SectionId;
	focusedSection: SectionId | null;
	setSectionRef: (sectionId: SectionId) => (el: HTMLDivElement | null) => void;
	handleSectionKeyDown: (event: KeyboardEvent<HTMLDivElement>, sectionId: SectionId) => void;
	theme: Theme;
	children: ReactNode;
	className?: string;
	style?: CSSProperties;
}

export function DashboardSection({
	sectionId,
	focusedSection,
	setSectionRef,
	handleSectionKeyDown,
	theme,
	children,
	className = 'outline-none rounded-lg transition-shadow dashboard-section-enter',
	style,
}: DashboardSectionProps) {
	return (
		<div
			ref={setSectionRef(sectionId)}
			tabIndex={0}
			role="region"
			aria-label={getSectionLabel(sectionId)}
			onKeyDown={(event) => handleSectionKeyDown(event, sectionId)}
			className={className}
			style={{
				...style,
				boxShadow: focusedSection === sectionId ? `0 0 0 2px ${theme.colors.accent}` : 'none',
			}}
			data-testid={`section-${sectionId}`}
		>
			{children}
		</div>
	);
}
