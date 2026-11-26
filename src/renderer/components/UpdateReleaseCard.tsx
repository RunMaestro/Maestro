import type { ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { Theme } from '../types';
import { Markdown } from './Markdown';
import { releaseDisplayName } from '../../shared/updateRollback';

export interface UpdateReleaseCardRelease {
	tag_name: string;
	name: string;
	body: string;
	published_at: string;
}

interface UpdateReleaseCardProps {
	theme: Theme;
	release: UpdateReleaseCardRelease;
	expanded: boolean;
	onToggle: () => void;
	/** Rendered at the right of the header row, after the date (e.g. a Roll Back button). */
	trailing?: ReactNode;
}

function formatReleaseDate(dateString: string): string {
	return new Date(dateString).toLocaleDateString('en-US', {
		year: 'numeric',
		month: 'short',
		day: 'numeric',
	});
}

/**
 * One release in the Check for Updates modal: a header row (tag, name, date)
 * that expands to the release notes. Shared by the "newer releases" list and
 * the rollback list, so both read the same.
 */
export function UpdateReleaseCard({
	theme,
	release,
	expanded,
	onToggle,
	trailing,
}: UpdateReleaseCardProps) {
	const displayName = releaseDisplayName(release.name, release.tag_name);
	const Chevron = expanded ? ChevronDown : ChevronRight;

	return (
		<div className="border rounded overflow-hidden" style={{ borderColor: theme.colors.border }}>
			<div
				className="flex items-center gap-2 pr-3"
				style={{ backgroundColor: theme.colors.bgActivity }}
			>
				<button
					onClick={onToggle}
					aria-expanded={expanded}
					className="flex-1 min-w-0 flex items-center justify-between gap-2 p-3 hover:bg-white/5 transition-colors text-left"
				>
					<div className="flex items-center gap-2 min-w-0">
						<Chevron className="w-4 h-4 shrink-0" style={{ color: theme.colors.textDim }} />
						<span className="font-mono font-bold text-sm" style={{ color: theme.colors.accent }}>
							{release.tag_name}
						</span>
						{displayName && (
							<span className="text-xs truncate" style={{ color: theme.colors.textDim }}>
								- {displayName}
							</span>
						)}
					</div>
					<span className="text-xs shrink-0" style={{ color: theme.colors.textDim }}>
						{formatReleaseDate(release.published_at)}
					</span>
				</button>
				{trailing}
			</div>
			{expanded && (
				<div
					className="py-3 px-5 border-t text-xs prose prose-sm prose-invert max-w-none"
					style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
				>
					<Markdown
						preset="release-notes"
						theme={theme}
						content={release.body || 'No release notes available.'}
					/>
				</div>
			)}
		</div>
	);
}
