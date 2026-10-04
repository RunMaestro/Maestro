/**
 * Computer History - digests tab.
 *
 * Agent-written markdown summaries: one per 15-minute window, plus a 6-hour
 * roll-up per block when enabled. Newest first, roll-ups badged. Bodies are
 * agent output summarizing screen content, so they render as a document
 * (no raw HTML) and links are not followed for the user.
 */

import { useEffect, useState } from 'react';
import { ScrollText } from 'lucide-react';
import type { Theme } from '../../types';
import { Markdown } from '../Markdown';
import { MiniBadge } from '../ui/MiniBadge';
import { Spinner } from '../ui/Spinner';
import { EmptyStatePlaceholder } from '../ui/EmptyStatePlaceholder';
import { generateProseStyles } from '../../utils/markdownConfig';
import type { DigestWithBody } from '../../../shared/computer-history/reader';
import { clockLabel, dayLabel } from './timelineModel';

interface DigestsPanelProps {
	theme: Theme;
	sinceMs: number;
	untilMs: number;
	refreshToken: number;
}

const SCOPE = 'computer-history-digest';

export function DigestsPanel({ theme, sinceMs, untilMs, refreshToken }: DigestsPanelProps) {
	const api = window.maestro?.computerHistory;
	const [digests, setDigests] = useState<DigestWithBody[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [digestsEnabled, setDigestsEnabled] = useState(false);

	useEffect(() => {
		if (!api) return;
		let cancelled = false;
		setDigests(null);
		setError(null);
		Promise.all([api.digests({ sinceMs, untilMs, limit: 100 }), api.getConfig()])
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
	}, [api, sinceMs, untilMs, refreshToken]);

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
		return (
			<EmptyStatePlaceholder
				theme={theme}
				icon={<ScrollText className="w-8 h-8" />}
				title="No digests in this range"
				description={
					digestsEnabled
						? 'Digests are written after each 15-minute window with activity closes.'
						: 'Digests are off. Turn them on in the Computer History settings and pick an agent to write them.'
				}
			/>
		);
	}

	return (
		<div className="space-y-3 select-text" data-testid="computer-history-digests">
			<style>{generateProseStyles({ theme, scopeSelector: `.${SCOPE}` })}</style>
			{digests.map((d) => (
				<article
					key={d.file}
					className="rounded-lg border px-4 py-3"
					style={{
						borderColor: d.kind === '6h' ? theme.colors.accent : theme.colors.border,
						backgroundColor: theme.colors.bgActivity,
					}}
				>
					<header className="flex items-center gap-2 mb-2">
						<MiniBadge
							theme={theme}
							label={d.kind === '6h' ? '6-hour roll-up' : '15 minutes'}
							color={d.kind === '6h' ? theme.colors.accent : undefined}
						/>
						<span className="text-xs" style={{ color: theme.colors.textDim }}>
							{dayLabel(d.startMs, Date.now())} {clockLabel(d.startMs)} - {clockLabel(d.endMs)}
						</span>
					</header>
					<div className={SCOPE}>
						<Markdown preset="document" content={d.body} theme={theme} />
					</div>
				</article>
			))}
		</div>
	);
}
