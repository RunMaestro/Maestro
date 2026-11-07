/**
 * SemanticSearchToggle - the switch between a surface's text search and its
 * search by meaning.
 *
 * Both search surfaces that offer a semantic mode (the History panel's filter
 * and cross-tab search) draw this one control, so the mode reads as the same
 * feature in both. A surface renders it ONLY while `useSemanticSearchReady()`
 * is true: a toggle for a model that is not downloaded would switch the user
 * into a mode that can only answer with a refusal.
 */

import { Sparkles } from 'lucide-react';

import type { Theme } from '../../types';

export interface SemanticSearchToggleProps {
	theme: Theme;
	active: boolean;
	onToggle: () => void;
	/**
	 * `chip` draws the label beside the icon (a modal header with room for it);
	 * `icon` is the icon alone (the History panel's narrow filter row).
	 */
	variant?: 'chip' | 'icon';
	className?: string;
	testId?: string;
}

export function SemanticSearchToggle({
	theme,
	active,
	onToggle,
	variant = 'chip',
	className = '',
	testId = 'semantic-search-toggle',
}: SemanticSearchToggleProps) {
	const title = active
		? 'Searching by meaning. Switch back to text search'
		: 'Search by meaning (semantic search)';
	return (
		<button
			type="button"
			onClick={onToggle}
			aria-pressed={active}
			aria-label="Semantic search"
			title={title}
			data-testid={testId}
			className={`flex items-center justify-center gap-1.5 rounded border text-xs font-medium whitespace-nowrap transition-colors shrink-0 ${
				variant === 'chip' ? 'px-2 py-1' : 'w-8 h-8'
			} ${className}`.trim()}
			style={{
				borderColor: active ? theme.colors.accent : theme.colors.border,
				backgroundColor: active ? `${theme.colors.accent}20` : 'transparent',
				color: active ? theme.colors.accent : theme.colors.textDim,
			}}
		>
			<Sparkles className="w-3.5 h-3.5" />
			{variant === 'chip' && <span>Semantic</span>}
		</button>
	);
}
