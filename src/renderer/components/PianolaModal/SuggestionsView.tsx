import { Lightbulb } from 'lucide-react';
import type { Theme } from '../../types';
import type { PianolaRule } from '../../../shared/pianola/types';
import type { PianolaSuggestionsFile } from '../../../shared/pianola/storage';
import { describeRuleMatch } from './shared';

interface SuggestionsViewProps {
	theme: Theme;
	suggestions: PianolaSuggestionsFile | null;
	loading: boolean;
	onApproveRule: (rule: PianolaRule) => void;
	onApplyProfile: (text: string) => void;
}

/**
 * Learning suggestions: approvable hard-rule proposals and a proposed decision
 * profile draft, synthesized from observed decisions. Nothing here is live until
 * the user approves it; an approved rule is still subject to decide() at runtime
 * (high-risk always escalates), so approving only ever writes config.
 */
export function SuggestionsView({
	theme,
	suggestions,
	loading,
	onApproveRule,
	onApplyProfile,
}: SuggestionsViewProps) {
	if (loading && !suggestions) {
		return (
			<div className="p-6 text-sm" style={{ color: theme.colors.textDim }}>
				Loading suggestions...
			</div>
		);
	}
	const proposals = suggestions?.proposals ?? [];
	const proposedProfile = suggestions?.proposedProfile ?? '';
	const hasProfile =
		proposedProfile.length > 0 && proposedProfile !== (suggestions?.previousProfile ?? '');

	if (proposals.length === 0 && !hasProfile) {
		return (
			<div className="p-6 text-sm leading-relaxed" style={{ color: theme.colors.textDim }}>
				No learning suggestions yet. Pianola proposes rules and profile updates after it has seen
				enough of your decisions. Run{' '}
				<code
					className="px-1 rounded"
					style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textMain }}
				>
					maestro pianola learn
				</code>{' '}
				or wait for the scheduled re-learn, then refresh.
			</div>
		);
	}

	return (
		<div className="p-4 space-y-5">
			{proposals.length > 0 && (
				<div className="space-y-2">
					<div className="flex items-center gap-2">
						<Lightbulb className="w-4 h-4" style={{ color: theme.colors.accent }} />
						<h3 className="text-sm font-semibold" style={{ color: theme.colors.textMain }}>
							Proposed rules
						</h3>
					</div>
					{proposals.map((p) => (
						<div
							key={p.id}
							className="rounded-lg border p-3 flex items-start justify-between gap-3"
							style={{ borderColor: theme.colors.border }}
						>
							<div className="min-w-0">
								<div className="text-sm" style={{ color: theme.colors.textMain }}>
									{p.description ?? p.id}
								</div>
								<div className="text-xs mt-0.5" style={{ color: theme.colors.textDim }}>
									{describeRuleMatch(p)} -&gt; auto-answer {p.answer ? `"${p.answer}"` : ''}
								</div>
							</div>
							<button
								onClick={() => onApproveRule(p)}
								className="shrink-0 px-3 py-1.5 text-xs font-medium rounded-md transition-colors"
								style={{ backgroundColor: theme.colors.accent, color: theme.colors.bgMain }}
							>
								Approve
							</button>
						</div>
					))}
				</div>
			)}

			{hasProfile && (
				<div className="space-y-2">
					<h3 className="text-sm font-semibold" style={{ color: theme.colors.textMain }}>
						Proposed profile
					</h3>
					<pre
						className="text-xs whitespace-pre-wrap rounded-lg border p-3 select-text"
						style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
					>
						{proposedProfile}
					</pre>
					<button
						onClick={() => onApplyProfile(proposedProfile)}
						className="px-3 py-1.5 text-xs font-medium rounded-md transition-colors"
						style={{ backgroundColor: theme.colors.accent, color: theme.colors.bgMain }}
					>
						Apply profile
					</button>
				</div>
			)}
		</div>
	);
}
