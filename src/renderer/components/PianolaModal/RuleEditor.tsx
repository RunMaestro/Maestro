import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import type { Theme } from '../../types';
import type {
	PianolaRule,
	PianolaRuleScope,
	PianolaSignalKind,
	PianolaActionKind,
	PianolaRisk,
} from '../../../shared/pianola/types';
import { matchHasNarrowingPredicate } from '../../../shared/pianola/pianola-policy';
import { useModalLayer } from '../../hooks/ui/useModalLayer';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';
import { RULE_SCOPES, RULE_ACTIONS, RULE_RISKS, RULE_KINDS, newBlankRule } from './shared';

export interface RuleEditorProps {
	theme: Theme;
	/** The rule to edit, or null to create a new one. */
	rule: PianolaRule | null;
	onCancel: () => void;
	onSave: (rule: PianolaRule) => void;
}

/** Editable working copy: arrays become comma strings for text inputs. */
interface Draft {
	enabled: boolean;
	scope: PianolaRuleScope;
	scopeId: string;
	maxRisk: PianolaRisk | '';
	kinds: PianolaSignalKind[];
	topicIncludes: string;
	action: PianolaActionKind;
	answer: string;
	priority: number;
	description: string;
}

function toDraft(rule: PianolaRule): Draft {
	return {
		enabled: rule.enabled,
		scope: rule.scope,
		scopeId: rule.scopeId ?? '',
		maxRisk: rule.match.maxRisk ?? '',
		kinds: rule.match.kinds ?? [],
		topicIncludes: (rule.match.topicIncludes ?? []).join(', '),
		action: rule.action,
		answer: rule.answer ?? '',
		priority: rule.priority,
		description: rule.description ?? '',
	};
}

/**
 * Modal form for creating or editing one Pianola rule. Layered above the Pianola
 * dashboard. Mirrors the shared policy's safety contract in the UI: an
 * auto-answer rule must have a narrowing condition (a kind or topic) and a reply,
 * since the policy refuses to auto-answer an unconstrained rule.
 */
export function RuleEditor({ theme, rule, onCancel, onSave }: RuleEditorProps) {
	useModalLayer(MODAL_PRIORITIES.PIANOLA_RULE_EDITOR, 'Pianola Rule Editor', onCancel);

	const base = useMemo(() => rule ?? newBlankRule(), [rule]);
	const [draft, setDraft] = useState<Draft>(() => toDraft(base));

	const isAutoAnswer = draft.action === 'auto_answer';
	const answerTrimmed = draft.answer.trim();

	// Build the match block exactly as it will be persisted, so the narrowing
	// check uses the same shape the policy engine evaluates.
	const match = useMemo<PianolaRule['match']>(() => {
		const topicIncludes = draft.topicIncludes
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean);
		const m: PianolaRule['match'] = {};
		if (draft.maxRisk) m.maxRisk = draft.maxRisk;
		if (draft.kinds.length > 0) m.kinds = draft.kinds;
		if (topicIncludes.length > 0) m.topicIncludes = topicIncludes;
		return m;
	}, [draft.maxRisk, draft.kinds, draft.topicIncludes]);

	// Mirror the policy's safety contract exactly (see hasNarrowingPredicate in
	// pianola-policy.ts): max risk also counts as a narrowing predicate, so a
	// max-risk-only auto-answer rule the watcher would honor is savable here too.
	const hasNarrowing = matchHasNarrowingPredicate(match);

	const validationError = useMemo(() => {
		if (draft.scope !== 'global' && draft.scopeId.trim().length === 0) {
			return `A ${draft.scope} rule needs a ${draft.scope === 'project' ? 'project path' : 'tab id'}.`;
		}
		if (isAutoAnswer && !hasNarrowing) {
			return 'An auto-answer rule needs a narrowing condition: set a max risk, pick a kind, or add a topic.';
		}
		if (isAutoAnswer && answerTrimmed.length === 0) {
			return 'An auto-answer rule needs reply text.';
		}
		return null;
	}, [draft.scope, draft.scopeId, isAutoAnswer, hasNarrowing, answerTrimmed]);

	const handleSave = () => {
		if (validationError) return;

		const next: PianolaRule = {
			id: base.id,
			enabled: draft.enabled,
			scope: draft.scope,
			match,
			action: draft.action,
			priority: Number.isFinite(draft.priority) ? draft.priority : 100,
			createdAt: base.createdAt,
			updatedAt: Date.now(),
		};
		if (draft.scope !== 'global' && draft.scopeId.trim()) next.scopeId = draft.scopeId.trim();
		if (isAutoAnswer && answerTrimmed) next.answer = answerTrimmed;
		if (draft.description.trim()) next.description = draft.description.trim();

		onSave(next);
	};

	const labelStyle = { color: theme.colors.textDim };
	const inputStyle = {
		backgroundColor: theme.colors.bgMain,
		borderColor: theme.colors.border,
		color: theme.colors.textMain,
	};

	return createPortal(
		<div
			className="fixed inset-0 flex items-center justify-center"
			style={{ zIndex: MODAL_PRIORITIES.PIANOLA_RULE_EDITOR }}
			onClick={(e) => {
				if (e.target === e.currentTarget) onCancel();
			}}
		>
			<div className="absolute inset-0 bg-black/40" />

			<div
				className="relative rounded-xl shadow-2xl flex flex-col"
				style={{
					width: '90vw',
					maxWidth: 560,
					maxHeight: '88vh',
					backgroundColor: theme.colors.bgMain,
					border: `1px solid ${theme.colors.border}`,
				}}
			>
				<div
					className="shrink-0 flex items-center justify-between px-5 py-4 border-b"
					style={{ borderColor: theme.colors.border }}
				>
					<h2 className="text-base font-bold" style={{ color: theme.colors.textMain }}>
						{rule ? 'Edit rule' : 'New rule'}
					</h2>
					<button
						onClick={onCancel}
						className="p-1.5 rounded-md hover:bg-white/10 transition-colors"
						style={{ color: theme.colors.textDim }}
						aria-label="Close"
						title="Close"
					>
						<X className="w-4 h-4" />
					</button>
				</div>

				<div className="flex-1 overflow-y-auto scrollbar-thin p-5 space-y-4">
					{/* Action */}
					<div>
						<label className="block text-xs mb-1" style={labelStyle}>
							Action
						</label>
						<div className="flex gap-1">
							{RULE_ACTIONS.map((a) => (
								<button
									key={a}
									onClick={() => setDraft((d) => ({ ...d, action: a }))}
									className="px-3 py-1.5 text-sm rounded-md transition-colors"
									style={{
										backgroundColor:
											draft.action === a ? theme.colors.accent + '22' : 'transparent',
										color: draft.action === a ? theme.colors.accent : theme.colors.textDim,
										border: `1px solid ${draft.action === a ? theme.colors.accent + '55' : theme.colors.border}`,
									}}
								>
									{a === 'auto_answer' ? 'Auto-answer' : a === 'escalate' ? 'Escalate' : 'Ignore'}
								</button>
							))}
						</div>
					</div>

					{/* Scope */}
					<div className="flex gap-3">
						<div className="flex-1">
							<label className="block text-xs mb-1" style={labelStyle}>
								Scope
							</label>
							<select
								value={draft.scope}
								onChange={(e) =>
									setDraft((d) => ({ ...d, scope: e.target.value as PianolaRuleScope }))
								}
								className="w-full px-2 py-1.5 text-sm rounded-md border"
								style={inputStyle}
							>
								{RULE_SCOPES.map((s) => (
									<option key={s} value={s}>
										{s}
									</option>
								))}
							</select>
						</div>
						{draft.scope !== 'global' && (
							<div className="flex-[2]">
								<label className="block text-xs mb-1" style={labelStyle}>
									{draft.scope === 'project' ? 'Project path' : 'Tab id'}
								</label>
								<input
									value={draft.scopeId}
									onChange={(e) => setDraft((d) => ({ ...d, scopeId: e.target.value }))}
									className="w-full px-2 py-1.5 text-sm rounded-md border"
									style={inputStyle}
									placeholder={draft.scope === 'project' ? '/path/to/project' : 'tab-id'}
								/>
							</div>
						)}
					</div>

					{/* Match: maxRisk + priority */}
					<div className="flex gap-3">
						<div className="flex-1">
							<label className="block text-xs mb-1" style={labelStyle}>
								Max risk
							</label>
							<select
								value={draft.maxRisk}
								onChange={(e) =>
									setDraft((d) => ({ ...d, maxRisk: e.target.value as PianolaRisk | '' }))
								}
								className="w-full px-2 py-1.5 text-sm rounded-md border"
								style={inputStyle}
							>
								<option value="">any</option>
								{RULE_RISKS.map((r) => (
									<option key={r} value={r}>
										{r}
									</option>
								))}
							</select>
						</div>
						<div className="flex-1">
							<label className="block text-xs mb-1" style={labelStyle}>
								Priority (lower runs first)
							</label>
							<input
								type="number"
								value={draft.priority}
								onChange={(e) => setDraft((d) => ({ ...d, priority: Number(e.target.value) }))}
								className="w-full px-2 py-1.5 text-sm rounded-md border"
								style={inputStyle}
							/>
						</div>
					</div>

					{/* Match: kinds */}
					<div>
						<label className="block text-xs mb-1" style={labelStyle}>
							Kinds
						</label>
						<div className="flex gap-1">
							{RULE_KINDS.map((k) => {
								const active = draft.kinds.includes(k);
								return (
									<button
										key={k}
										onClick={() =>
											setDraft((d) => ({
												...d,
												kinds: active ? d.kinds.filter((x) => x !== k) : [...d.kinds, k],
											}))
										}
										className="px-3 py-1.5 text-sm rounded-md transition-colors"
										style={{
											backgroundColor: active ? theme.colors.accent + '22' : 'transparent',
											color: active ? theme.colors.accent : theme.colors.textDim,
											border: `1px solid ${active ? theme.colors.accent + '55' : theme.colors.border}`,
										}}
									>
										{k}
									</button>
								);
							})}
						</div>
					</div>

					{/* Match: topicIncludes */}
					<div>
						<label className="block text-xs mb-1" style={labelStyle}>
							Topic includes (comma-separated, case-insensitive)
						</label>
						<input
							value={draft.topicIncludes}
							onChange={(e) => setDraft((d) => ({ ...d, topicIncludes: e.target.value }))}
							className="w-full px-2 py-1.5 text-sm rounded-md border"
							style={inputStyle}
							placeholder="naming, formatting"
						/>
					</div>

					{/* Answer (auto_answer only) */}
					{isAutoAnswer && (
						<div>
							<label className="block text-xs mb-1" style={labelStyle}>
								Reply text
							</label>
							<textarea
								value={draft.answer}
								onChange={(e) => setDraft((d) => ({ ...d, answer: e.target.value }))}
								rows={3}
								className="w-full px-2 py-1.5 text-sm rounded-md border resize-y"
								style={inputStyle}
								placeholder="The exact text Pianola sends to the agent."
							/>
						</div>
					)}

					{/* Description */}
					<div>
						<label className="block text-xs mb-1" style={labelStyle}>
							Description (optional)
						</label>
						<input
							value={draft.description}
							onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
							className="w-full px-2 py-1.5 text-sm rounded-md border"
							style={inputStyle}
							placeholder="What this rule is for."
						/>
					</div>

					{validationError && (
						<div className="text-xs" style={{ color: '#ef4444' }}>
							{validationError}
						</div>
					)}
				</div>

				<div
					className="shrink-0 flex items-center justify-end gap-2 px-5 py-3 border-t"
					style={{ borderColor: theme.colors.border }}
				>
					<button
						onClick={onCancel}
						className="px-3 py-1.5 text-sm rounded-md border transition-colors"
						style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
					>
						Cancel
					</button>
					<button
						onClick={handleSave}
						disabled={validationError !== null}
						className="px-3 py-1.5 text-sm rounded-md transition-colors"
						style={{
							backgroundColor: validationError ? theme.colors.border : theme.colors.accent,
							color: validationError ? theme.colors.textDim : theme.colors.bgMain,
							cursor: validationError ? 'not-allowed' : 'pointer',
						}}
					>
						Save rule
					</button>
				</div>
			</div>
		</div>,
		document.body
	);
}
