/**
 * Computer History - digests tab.
 *
 * Markdown summaries written by a local model or an agent: one per 15-minute
 * window, plus a 6-hour roll-up per block when enabled. Newest first, roll-ups
 * badged. Bodies are model output summarizing screen content, so they render as a document
 * (no raw HTML) and links are not followed for the user.
 *
 * The file's own header (`# 15-minute digest <iso> - <iso>` plus a provenance
 * line) repeats what the card header already says, so the card renders only
 * the writer's summary and shows the provenance as a dim caption.
 *
 * Search: the viewer's search box drives `query`. It runs in main over the
 * WHOLE range (`readRecentDigests` with `grep`), not over the loaded page, and
 * matches each digest's summary only (the same rule as
 * `maestro-cli computer-history digests --grep`).
 */

import { useEffect, useMemo, useState } from 'react';
import { ScrollText, SearchX } from 'lucide-react';
import type { Theme } from '../../types';
import { Markdown } from '../Markdown';
import { MiniBadge } from '../ui/MiniBadge';
import { Spinner } from '../ui/Spinner';
import { EmptyStatePlaceholder } from '../ui/EmptyStatePlaceholder';
import { generateProseStyles } from '../../utils/markdownConfig';
import type { DigestWithBody } from '../../../shared/computer-history/reader';
import { splitDigestBody } from '../../../shared/computer-history/digestBody';
import { clockLabel, dayLabel } from './timelineModel';

interface DigestsPanelProps {
	theme: Theme;
	sinceMs: number;
	untilMs: number;
	/** Debounced search text from the viewer's search box; empty = no filter. */
	query?: string;
	refreshToken: number;
}

const SCOPE = 'computer-history-digest';
/** Most digests one read returns (newest first); a search stops at this many matches. */
export const DIGEST_PAGE_LIMIT = 100;

export function DigestsPanel({
	theme,
	sinceMs,
	untilMs,
	query = '',
	refreshToken,
}: DigestsPanelProps) {
	const api = window.maestro?.computerHistory;
	const [digests, setDigests] = useState<DigestWithBody[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [digestsEnabled, setDigestsEnabled] = useState(false);

	useEffect(() => {
		if (!api) return;
		let cancelled = false;
		setDigests(null);
		setError(null);
		Promise.all([
			api.digests({ sinceMs, untilMs, limit: DIGEST_PAGE_LIMIT, grep: query || undefined }),
			api.getConfig(),
		])
			.then(([list, config]) => {
				if (cancelled) return;
				setDigests(list);
				setDigestsEnabled(config.digests.enabled);
			})
			.catch((err) => {
				if (!cancelled) setError(err instanceof Error ? err.message : String(err));
			});
		return () => {
			cancelled = true;
		};
	}, [api, sinceMs, untilMs, query, refreshToken]);

	const cards = useMemo(
		() => (digests ?? []).map((d) => ({ digest: d, parts: splitDigestBody(d.body) })),
		[digests]
	);
	const searchHighlight = useMemo(
		() => (query ? { query, currentMatchIndex: -1 } : undefined),
		[query]
	);

	if (error) {
		return (
			<EmptyStatePlaceholder theme={theme} title="Could not read digests" description={error} />
		);
	}
	if (!digests) {
		return (
			<div className="flex justify-center py-10">
				<Spinner size={20} color={theme.colors.textDim} />
			</div>
		);
	}
	if (digests.length === 0) {
		if (query) {
			return (
				<EmptyStatePlaceholder
					theme={theme}
					icon={<SearchX className="w-8 h-8" />}
					title="No digests match"
					description={`Nothing in this range mentions "${query}". Try a wider range.`}
				/>
			);
		}
		return (
			<EmptyStatePlaceholder
				theme={theme}
				icon={<ScrollText className="w-8 h-8" />}
				title="No digests in this range"
				description={
					digestsEnabled
						? 'Digests are written after each 15-minute window with activity closes.'
						: 'Digests are off. Turn them on in the Computer History settings and pick a local model or an agent to write them.'
				}
			/>
		);
	}

	return (
		<div className="space-y-3 select-text" data-testid="computer-history-digests">
			<style>
				{generateProseStyles({ theme, scopeSelector: `.${SCOPE}`, compactSpacing: true })}
			</style>
			{query && (
				<div
					className="text-xs select-none"
					style={{ color: theme.colors.textDim }}
					data-testid="computer-history-digests-match-count"
				>
					{digests.length >= DIGEST_PAGE_LIMIT
						? `Newest ${DIGEST_PAGE_LIMIT} matching digests`
						: `${digests.length} matching digest${digests.length === 1 ? '' : 's'}`}
				</div>
			)}
			{cards.map(({ digest: d, parts }) => (
				<article
					key={d.file}
					className="rounded-lg border px-4 py-3"
					style={{
						borderColor: d.kind === '6h' ? theme.colors.accent : theme.colors.border,
						backgroundColor: theme.colors.bgActivity,
					}}
				>
					<header className="flex items-center gap-2 mb-2 min-w-0">
						<MiniBadge
							theme={theme}
							label={d.kind === '6h' ? '6-hour roll-up' : '15 minutes'}
							color={d.kind === '6h' ? theme.colors.accent : undefined}
						/>
						<span className="text-xs flex-shrink-0" style={{ color: theme.colors.textDim }}>
							{dayLabel(d.startMs, Date.now())} {clockLabel(d.startMs)} - {clockLabel(d.endMs)}
						</span>
						{parts.provenance && (
							<span
								className="text-xs ml-auto truncate opacity-70"
								style={{ color: theme.colors.textDim }}
								title={parts.provenance}
							>
								{parts.provenance}
							</span>
						)}
					</header>
					{/* `.prose` is what generateProseStyles targets; without it lists
					    lose their bullets and headings render as body text. */}
					<div className={SCOPE}>
						<div className="prose prose-sm max-w-none">
							<Markdown
								preset="document"
								content={parts.summary}
								theme={theme}
								searchHighlight={searchHighlight}
							/>
						</div>
					</div>
				</article>
			))}
		</div>
	);
}
