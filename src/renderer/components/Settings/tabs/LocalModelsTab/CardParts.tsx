/**
 * CardParts - the two text pieces the Models cards share: a row's title and a
 * warning line. The Model server card and the System One engine card are both
 * stacks of titled rows, and a warning has to read the same in each.
 */

import type { ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';

import type { Theme } from '../../../../types';

interface CardPartProps {
	theme: Theme;
	children: ReactNode;
}

/** The title of one row of a card. */
export function CardRowTitle({ theme, children }: CardPartProps) {
	return (
		<div className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
			{children}
		</div>
	);
}

/** A warning the user should read before going on. Selectable, since it can name a path or a variable. */
export function CardWarning({ theme, children }: CardPartProps) {
	return (
		<div
			className="flex items-start gap-1.5 text-xs select-text"
			style={{ color: theme.colors.warning }}
		>
			<AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
			<span>{children}</span>
		</div>
	);
}
