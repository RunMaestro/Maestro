/**
 * GitRunningBadge - "this git command is still going" marker for a menu row.
 *
 * A pull or push keeps running after its console is dismissed with Run in
 * Background, and until this existed the only trace of it was the toast that
 * eventually landed. Every surface that offers Pull / Push (the Left Bar
 * right-click menu, the header branch pill menu) renders this in place of the
 * ahead/behind count while a run is in flight, so the menu that started the
 * command is also the menu that reports it is still working.
 *
 * It replaces the ahead/behind badge rather than sitting beside it: those
 * counts are stale mid-transfer anyway, and the row has one badge slot.
 */

import { memo } from 'react';
import { Spinner } from './Spinner';
import type { Theme } from '../../types';

/**
 * Hover text for the Create Pull Request row's badge. `gh pr create` has no
 * console to watch, so the promise is the outcome, not the output.
 */
export const PR_RUNNING_TITLE = 'Still creating in the background - you will be told how it went';

export interface GitRunningBadgeProps {
	theme: Theme;
	/** Badge text. Defaults to `Running`. */
	label?: string;
	/** Wrapper classes, for spacing/alignment at the call site. */
	className?: string;
	/** Test id, so each menu can assert its own row. */
	testId?: string;
	/** Hover text. Defaults to the pull/push wording. */
	title?: string;
}

export const GitRunningBadge = memo(function GitRunningBadge({
	theme,
	label = 'Running',
	className = 'flex items-center gap-1',
	testId = 'git-running-badge',
	title = 'Still running in the background - open it to watch the output',
}: GitRunningBadgeProps) {
	return (
		<span
			className={className}
			style={{ color: theme.colors.accent }}
			data-testid={testId}
			title={title}
		>
			<Spinner size={11} ariaLabel={`${label}...`} />
			{label}
		</span>
	);
});

export default GitRunningBadge;
