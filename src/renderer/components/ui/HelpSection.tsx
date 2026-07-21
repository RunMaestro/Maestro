import type { ReactNode } from 'react';

interface HelpSectionProps {
	heading: ReactNode;
	children: ReactNode;
}

/**
 * Shared presentation for titled help content. Copy, links, and actions remain
 * owned by the feature that renders each section.
 */
export function HelpSection({ heading, children }: HelpSectionProps) {
	return (
		<section>
			<div className="flex items-center gap-2 mb-3">{heading}</div>
			{children}
		</section>
	);
}
