/**
 * PlaybookFailureReportStep - the consent surface of "Report a problem".
 *
 * Shows the issue exactly as it would be filed (repo, title, raw body), so
 * the user sees every byte before anything leaves the machine. The support
 * package is off unless the user ticks it, and it is the one thing added to
 * the body after this view: a link under "Support Package".
 */

import type { PlaybookFailureIssuePreview } from '../../../shared/feedback';
import type { Theme } from '../../types';
import { Spinner } from '../ui/Spinner';

export interface PlaybookFailureReportStepProps {
	theme: Theme;
	/** Null while the preview is being built. */
	preview: PlaybookFailureIssuePreview | null;
	/** Why the preview could not be built, if it could not. */
	error?: string | null;
	includeDebugPackage: boolean;
	onIncludeDebugPackageChange: (include: boolean) => void;
}

export function PlaybookFailureReportStep({
	theme,
	preview,
	error,
	includeDebugPackage,
	onIncludeDebugPackageChange,
}: PlaybookFailureReportStepProps) {
	if (error) {
		return (
			<p
				className="text-sm select-text"
				style={{ color: theme.colors.error }}
				data-testid="playbook-failure-preview-error"
			>
				{error}
			</p>
		);
	}
	if (!preview) {
		return (
			<div
				className="flex items-center gap-2 text-sm"
				style={{ color: theme.colors.textDim }}
				data-testid="playbook-failure-preview-loading"
			>
				<Spinner size={14} color={theme.colors.textDim} />
				Preparing the report...
			</div>
		);
	}
	return (
		<div className="flex flex-col gap-3" data-testid="playbook-failure-report-step">
			<p className="text-sm" style={{ color: theme.colors.textMain }}>
				This is the exact issue that will be filed on{' '}
				<span className="font-mono select-text">{preview.repo}</span>. It carries no paths, branch
				names, repository names, or parameter values. If someone already reported this failure, your
				report adds a +1 and your Maestro version to their issue instead.
			</p>
			<div
				className="text-sm font-semibold select-text"
				style={{ color: theme.colors.textMain }}
				data-testid="playbook-failure-preview-title"
			>
				{preview.title}
			</div>
			<pre
				className="text-xs font-mono whitespace-pre-wrap break-words rounded border p-3 select-text"
				style={{
					borderColor: theme.colors.border,
					backgroundColor: theme.colors.bgActivity,
					color: theme.colors.textMain,
				}}
				data-testid="playbook-failure-preview-body"
			>
				{preview.body}
			</pre>
			<label
				className="flex items-center gap-2 cursor-pointer"
				title="Uploads diagnostics to your GitHub account and links them from the public issue. No conversations, secrets, file paths, project names, username, or computer name are included."
			>
				<input
					type="checkbox"
					checked={includeDebugPackage}
					onChange={(e) => onIncludeDebugPackageChange(e.target.checked)}
					className="rounded"
					style={{ accentColor: theme.colors.accent }}
					data-testid="playbook-failure-include-debug-package"
				/>
				<span className="text-sm" style={{ color: theme.colors.textDim }}>
					Attach a support package (adds a link under "Support Package")
				</span>
			</label>
		</div>
	);
}
