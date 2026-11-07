import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Sparkles } from 'lucide-react';
import { Spinner } from './ui/Spinner';
import type { Theme } from '../types';
import { useSettingsStore } from '../stores/settingsStore';
import { useLocalModelTaskReadiness } from '../hooks/localModels';
import {
	localModelAssignmentSourceLabel,
	resolveLocalModelAssignment,
} from '../../shared/local-models/tasks';
import type { PullRequestDraft } from '../../shared/gitDrafts';

interface PullRequestDraftButtonProps {
	theme: Theme;
	/** The local repository the pull request is opened from. */
	cwd: string;
	/** The branch currently picked as the target. */
	baseBranch: string;
	/** The form is locked (a pull request is being created). */
	disabled?: boolean;
	/** Put the draft in the form. The caller fills its fields and nothing else. */
	onDraft: (draft: PullRequestDraft) => void;
}

/**
 * PullRequestDraftButton - "Draft with local model" for the Create Pull Request
 * form.
 *
 * Asks the `git-drafts` Local Models assignment for a title and body written
 * from the branch's commits and changed files, and hands them to the form. It
 * FILLS the fields and stops: creating the pull request stays a separate press
 * of Create PR, so a small model's draft is always read first.
 *
 * What it draws follows the task's readiness, resolved in the main process:
 *   - off (the default): nothing. The feature is not on, so the form is
 *     exactly the form it was.
 *   - unavailable: the button, disabled, with the reason and what to do.
 *   - ready: the button, with the model or endpoint it will run on beside it.
 *
 * `maestro-cli models run git-drafts --cwd <path>` is the same draft from the
 * command line.
 */
export function PullRequestDraftButton({
	theme,
	cwd,
	baseBranch,
	disabled = false,
	onDraft,
}: PullRequestDraftButtonProps) {
	const assignments = useSettingsStore((s) => s.localModelAssignments);
	const endpoints = useSettingsStore((s) => s.localModelEndpoints);

	// Everything the verdict depends on that the renderer can see, so a source
	// assigned while the form is open is picked up without reopening it.
	const revision = useMemo(
		() => JSON.stringify([resolveLocalModelAssignment(assignments, 'git-drafts'), endpoints]),
		[assignments, endpoints]
	);
	const { readiness, refresh } = useLocalModelTaskReadiness(revision, 'git-drafts');
	const verdict = readiness['git-drafts'];

	const [drafting, setDrafting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [note, setNote] = useState<string | null>(null);

	// Each press takes the next number; only the newest may fill the form, and
	// none may after unmount (the form closed while the model was writing).
	const latestRequest = useRef(0);
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);

	// A draft is written against one target branch. Picking another drops the
	// one in flight and clears what the last one said.
	useEffect(() => {
		latestRequest.current += 1;
		setDrafting(false);
		setError(null);
		setNote(null);
	}, [baseBranch, cwd]);

	const handleDraft = useCallback(async () => {
		const request = ++latestRequest.current;
		setDrafting(true);
		setError(null);
		setNote(null);
		try {
			const result = await window.maestro.localModels.draftPullRequest({ cwd, baseBranch });
			if (!mounted.current || request !== latestRequest.current) return;
			if (result.success) {
				onDraft({ title: result.title, body: result.body });
				const commits = `${result.commitCount} commit${result.commitCount === 1 ? '' : 's'}`;
				setNote(
					`Drafted${result.producedBy ? ` by ${result.producedBy}` : ''} from ${commits}${
						result.truncated ? ' (summary shortened to fit the model)' : ''
					}. Review it before creating.`
				);
			} else {
				setError(result.error);
				// The source went away since readiness was read: show that state.
				if (result.status === 'unavailable' || result.status === 'off') void refresh();
			}
		} catch (caught) {
			if (!mounted.current || request !== latestRequest.current) return;
			setError(caught instanceof Error ? caught.message : String(caught));
		} finally {
			if (mounted.current && request === latestRequest.current) setDrafting(false);
		}
	}, [cwd, baseBranch, onDraft, refresh]);

	if (!verdict || verdict.state === 'off' || verdict.state === 'utility-agent') return null;

	const unavailable = verdict.state === 'unavailable';
	const sourceLabel = localModelAssignmentSourceLabel(verdict.assignment, endpoints);
	const canDraft = !unavailable && !disabled && !drafting;

	return (
		<div className="space-y-1.5" data-testid="pr-draft">
			<div className="flex items-center gap-2 min-w-0">
				<button
					type="button"
					onClick={handleDraft}
					disabled={!canDraft}
					data-testid="pr-draft-button"
					title="Fills the title and description from this branch's commits and changed files. Nothing is submitted."
					className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded border text-xs font-medium shrink-0 transition-colors ${
						canDraft ? 'hover:bg-white/10' : 'opacity-50 cursor-not-allowed'
					}`}
					style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
				>
					{drafting ? (
						<Spinner size={14} ariaLabel="Drafting" />
					) : (
						<Sparkles className="w-3.5 h-3.5" style={{ color: theme.colors.accent }} />
					)}
					{drafting ? 'Drafting...' : 'Draft with local model'}
				</button>
				{sourceLabel && (
					<span
						className="text-xs truncate min-w-0"
						style={{ color: theme.colors.textDim }}
						title={sourceLabel}
						data-testid="pr-draft-source"
					>
						{sourceLabel}
					</span>
				)}
			</div>

			{unavailable && (
				<div
					className="flex items-start gap-1.5 text-xs select-text"
					style={{ color: theme.colors.warning }}
					data-testid="pr-draft-unavailable"
				>
					<AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
					<span>
						{verdict.detail}
						{verdict.suggestedAction ? ` ${verdict.suggestedAction}` : ''}
					</span>
				</div>
			)}

			{error && (
				<div
					className="flex items-start gap-1.5 text-xs select-text"
					style={{ color: theme.colors.error }}
					data-testid="pr-draft-error"
				>
					<AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
					<span className="break-words min-w-0">{error}</span>
				</div>
			)}

			{note && !error && (
				<p className="text-xs" style={{ color: theme.colors.textDim }} data-testid="pr-draft-note">
					{note}
				</p>
			)}
		</div>
	);
}
