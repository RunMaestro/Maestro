import { useState } from 'react';
import { Lightbulb } from 'lucide-react';
import type { Theme } from '../../types';
import type { PianolaRule } from '../../../shared/pianola/types';
import type {
	PianolaHumanDecisionEvidence,
	PianolaSuggestionCandidate,
	PianolaSuggestionReview,
	PianolaSuggestionsFile,
} from '../../../shared/pianola/storage';
import { canonicalJson } from '../../../shared/canonicalJson';
import { jumpToAgentConversation } from '../../utils/jumpToAgentConversation';
import { describeRuleMatch } from './shared';

interface SuggestionsViewProps {
	theme: Theme;
	suggestions: PianolaSuggestionsFile | null;
	rules: PianolaRule[];
	loading: boolean;
	onReview: (review: PianolaSuggestionReview) => void;
	onApplyProfile: (text: string) => void;
	onClose: () => void;
}

export function SuggestionsView({
	theme,
	suggestions,
	rules,
	loading,
	onReview,
	onApplyProfile,
	onClose,
}: SuggestionsViewProps) {
	const [editing, setEditing] = useState<string | null>(null);
	const [answer, setAnswer] = useState('');
	const [description, setDescription] = useState('');
	const [priority, setPriority] = useState(0);
	const candidates = suggestions?.candidates ?? [];
	const conflicts = suggestions?.conflicts ?? [];
	const proposedProfile = suggestions?.proposedProfile ?? '';
	const hasProfile =
		proposedProfile.length > 0 && proposedProfile !== (suggestions?.previousProfile ?? '');
	const review = (candidate: PianolaSuggestionCandidate, operation: 'accept' | 'reject') =>
		onReview({
			candidateId: candidate.id,
			evidenceFingerprint: candidate.evidenceFingerprint,
			operation,
		});
	const sources = (evidence: PianolaHumanDecisionEvidence[]) => (
		<ul className="space-y-2 mt-2">
			{evidence.map((source) => (
				<li
					key={`${source.agentId}:${source.tabId}:${source.questionMessageId}:${source.answerMessageId}`}
					className="text-xs select-text"
				>
					<button
						className="underline"
						style={{ color: theme.colors.accent }}
						onClick={() => {
							onClose();
							jumpToAgentConversation({
								sessionId: source.agentId,
								tabId: source.tabId,
								agentName: source.agentId,
							});
						}}
					>
						Open source chat {source.agentId} / {source.tabId}
					</button>
					<div>
						Question ({source.questionMessageId}): {source.question}
					</div>
					<div>
						Answer ({source.answerMessageId}): {source.answer}
					</div>
				</li>
			))}
		</ul>
	);
	if (loading && !suggestions) return <div className="p-6 text-sm">Loading suggestions...</div>;
	return (
		<div className="p-4 space-y-5" style={{ color: theme.colors.textMain }}>
			{candidates.length === 0 && conflicts.length === 0 && !hasProfile && (
				<p className="text-sm">
					No current learning suggestions. Legacy proposals require regeneration with source
					evidence before review.
				</p>
			)}
			{candidates.length > 0 && (
				<section className="space-y-3">
					<h3 className="text-sm font-semibold flex gap-2">
						<Lightbulb className="w-4 h-4" /> Proposed rules
					</h3>
					{candidates.map((candidate) => (
						<div
							key={candidate.id}
							className="rounded-lg border p-3 space-y-2"
							style={{ borderColor: theme.colors.border }}
						>
							<div className="text-sm">{candidate.rule.description ?? candidate.id}</div>
							<div className="text-xs">
								Pending proposal. Owner: human; next action: accept, edit and approve, or reject.
								Not active until approved.
							</div>
							<div className="text-xs select-text">
								Scope: {candidate.rule.scope} {candidate.rule.scopeId ?? ''};{' '}
								{describeRuleMatch(candidate.rule)}
								<br />
								Action: {candidate.action}; answer: {candidate.rule.answer}
								<br />
								Conditions: {candidate.conditions.join('; ') || 'None'}
								<br />
								Exclusions: {candidate.exclusions.join('; ') || 'None'}
								<br />
								Independent sources: {candidate.sampleCount}
							</div>
							{sources(candidate.evidence)}
							{(suggestions?.rejections ?? [])
								.filter((item) => item.candidateId === candidate.id)
								.map((item) => (
									<div key={item.evidenceFingerprint} className="text-xs">
										Previously rejected evidence ({new Date(item.rejectedAt).toLocaleString()})
										{item.reason ? `: ${item.reason}` : ''}
										{sources(item.candidate.evidence)}
									</div>
								))}
							{editing === candidate.id ? (
								<div className="space-y-2 text-xs">
									<label className="block">
										Answer{' '}
										<input
											aria-label="Edited answer"
											className="w-full p-1"
											style={{ backgroundColor: theme.colors.bgActivity }}
											value={answer}
											onChange={(e) => setAnswer(e.target.value)}
										/>
									</label>
									<label className="block">
										Description{' '}
										<input
											aria-label="Edited description"
											className="w-full p-1"
											style={{ backgroundColor: theme.colors.bgActivity }}
											value={description}
											onChange={(e) => setDescription(e.target.value)}
										/>
									</label>
									<label className="block">
										Priority{' '}
										<input
											aria-label="Edited priority"
											type="number"
											style={{ backgroundColor: theme.colors.bgActivity }}
											value={priority}
											onChange={(e) => setPriority(Number(e.target.value))}
										/>
									</label>
									<button
										disabled={!answer.trim()}
										onClick={() => {
											onReview({
												operation: 'edit',
												candidateId: candidate.id,
												evidenceFingerprint: candidate.evidenceFingerprint,
												rule: { ...candidate.rule, answer, description, priority },
											});
											setEditing(null);
										}}
									>
										Approve edited rule
									</button>{' '}
									<button onClick={() => setEditing(null)}>Cancel</button>
								</div>
							) : (
								<div className="flex gap-3 text-xs">
									<button onClick={() => review(candidate, 'accept')}>Accept</button>
									<button
										onClick={() => {
											setEditing(candidate.id);
											setAnswer(candidate.rule.answer ?? '');
											setDescription(candidate.rule.description ?? '');
											setPriority(candidate.rule.priority);
										}}
									>
										Edit
									</button>
									<button onClick={() => review(candidate, 'reject')}>Reject</button>
								</div>
							)}
						</div>
					))}
				</section>
			)}
			{conflicts.length > 0 && (
				<section className="space-y-3">
					<h3 className="text-sm font-semibold">Learned rule conflicts</h3>
					{conflicts.map((conflict) => {
						const approval = suggestions?.approvals?.find(
							(a) =>
								a.rule.id === conflict.ruleId &&
								a.candidate.evidenceFingerprint === conflict.evidenceFingerprint &&
								a.approvedAt === conflict.approvedAt
						);
						const current = rules.find((rule) => rule.id === conflict.ruleId);
						const state = !current
							? 'removed'
							: !current.enabled
								? 'disabled'
								: approval && canonicalJson(current) === canonicalJson(approval.rule)
									? 'active'
									: 'changed';
						return (
							<div
								key={`${conflict.ruleId}:${conflict.approvedAt}`}
								className="rounded-lg border p-3 text-xs space-y-2"
								style={{ borderColor: theme.colors.border }}
							>
								<div>
									Rule {conflict.ruleId}: {state}; review needed ({conflict.reason}).
								</div>
								<div>
									Owner: human. Next action: {conflict.nextAction} Use the Rules tab to review or
									change the current rule.
								</div>
								{approval && (
									<>
										<div>
											Originally approved: {approval.rule.answer}; sources:{' '}
											{approval.candidate.sampleCount}
										</div>
										{sources(approval.candidate.evidence)}
									</>
								)}
								<div>New or corrected evidence:</div>
								{sources(conflict.evidence)}
							</div>
						);
					})}
				</section>
			)}
			{hasProfile && (
				<section className="space-y-2">
					<h3 className="text-sm font-semibold">Proposed profile. Owner: human</h3>
					<pre className="text-xs whitespace-pre-wrap select-text">{proposedProfile}</pre>
					<button className="text-xs" onClick={() => onApplyProfile(proposedProfile)}>
						Apply profile
					</button>
				</section>
			)}
		</div>
	);
}
