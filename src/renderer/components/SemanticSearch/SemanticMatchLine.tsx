/**
 * SemanticMatchLine - what a search-by-meaning hit shows that a text hit does
 * not: how close it was (the score) and the passage that matched (the snippet).
 *
 * A semantic hit often shares no word with its query, so the snippet is the
 * only evidence the row has for being in the list. Query words that DO occur in
 * it are highlighted; the rest is plain.
 */

import { memo } from 'react';

import {
	formatWorkSearchScore,
	workSearchQueryWords,
} from '../../../shared/local-models/work-search';
import type { Theme } from '../../types';
import { highlightMatches } from '../../utils/highlightMatches';
import { MiniBadge } from '../ui/MiniBadge';

export interface SemanticMatchLineProps {
	theme: Theme;
	/** Cosine similarity to the query. Absent draws no badge. */
	score?: number;
	snippet: string;
	/** The query the hit answers. */
	query: string;
	/** Clamp the snippet to this many lines. Omitted shows all of it. */
	maxLines?: number;
	className?: string;
}

export const SemanticMatchLine = memo(function SemanticMatchLine({
	theme,
	score,
	snippet,
	query,
	maxLines,
	className = '',
}: SemanticMatchLineProps) {
	return (
		<div className={`flex items-start gap-2 min-w-0 ${className}`.trim()} data-semantic-match="">
			{score !== undefined && (
				<MiniBadge
					label={formatWorkSearchScore(score)}
					theme={theme}
					title="How close this is to your query in meaning"
					className="mt-0.5"
				/>
			)}
			<span
				className="text-xs leading-relaxed min-w-0 select-text"
				style={{
					color: theme.colors.textDim,
					...(maxLines
						? {
								display: '-webkit-box',
								WebkitLineClamp: maxLines,
								WebkitBoxOrient: 'vertical' as const,
								overflow: 'hidden',
							}
						: {}),
				}}
			>
				{highlightMatches(snippet, workSearchQueryWords(query), theme.colors.accent)}
			</span>
		</div>
	);
});
