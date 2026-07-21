/**
 * QuestionPrompt - renders a claude-code AskUserQuestion request as a picker.
 *
 * Shown by PermissionPrompt in place of the allow/deny body when a relay
 * request has `kind === 'question'` (standard permission mode only). Options
 * render as radio-style buttons for single-select questions and checkboxes for
 * `multiSelect`, plus a free-text "Other" field since claude-code allows custom
 * answers. Submitting encodes the selection (encodeQuestionAnswer) and replies
 * through the SAME relay channel as allow/deny, using the proven
 * `{ behavior: 'deny', message }` shape.
 */

import { useMemo, useState } from 'react';
import { Check, Send } from 'lucide-react';
import type { Theme } from '../../types';
import type { ParsedQuestionUI } from '../../stores/permissionRequestStore';
import { encodeQuestionAnswer, hasAnswer, type QuestionSelection } from './questionAnswer';

interface QuestionPromptProps {
	theme: Theme;
	questions: ParsedQuestionUI[];
	/** Submit the encoded answer string (relay delivers it as deny+message). */
	onSubmit: (message: string) => void;
}

export function QuestionPrompt({ theme, questions, onSubmit }: QuestionPromptProps) {
	// One selection slot per question, kept in a parallel array by index.
	const [selections, setSelections] = useState<QuestionSelection[]>(() =>
		questions.map(() => ({ selectedLabels: [], otherText: '' }))
	);

	const updateSelection = (index: number, next: Partial<QuestionSelection>) => {
		setSelections((prev) => prev.map((sel, i) => (i === index ? { ...sel, ...next } : sel)));
	};

	const toggleLabel = (index: number, label: string, multiSelect: boolean) => {
		setSelections((prev) =>
			prev.map((sel, i) => {
				if (i !== index) {
					return sel;
				}
				if (!multiSelect) {
					return { ...sel, selectedLabels: [label] };
				}
				const has = sel.selectedLabels.includes(label);
				return {
					...sel,
					selectedLabels: has
						? sel.selectedLabels.filter((l) => l !== label)
						: [...sel.selectedLabels, label],
				};
			})
		);
	};

	// Enable submit only once every question has at least one answer, so the
	// model never gets a half-answered batch.
	const canSubmit = useMemo(
		() => questions.length > 0 && selections.every((sel) => hasAnswer(sel)),
		[questions.length, selections]
	);

	const handleSubmit = () => {
		if (!canSubmit) {
			return;
		}
		onSubmit(encodeQuestionAnswer(questions, selections));
	};

	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-col gap-4 max-h-[50vh] overflow-auto pr-1">
				{questions.map((q, qi) => {
					const selection = selections[qi] ?? { selectedLabels: [], otherText: '' };
					return (
						<div key={qi} className="flex flex-col gap-2">
							{q.header && (
								<span
									className="text-[10px] font-semibold uppercase tracking-wide select-text"
									style={{ color: theme.colors.textDim }}
								>
									{q.header}
								</span>
							)}
							<p
								className="text-sm font-medium select-text"
								style={{ color: theme.colors.textMain }}
							>
								{q.question}
							</p>
							<div className="flex flex-col gap-1.5">
								{q.options.map((opt) => {
									const selected = selection.selectedLabels.includes(opt.label);
									return (
										<button
											key={opt.label}
											onClick={() => toggleLabel(qi, opt.label, q.multiSelect)}
											role={q.multiSelect ? 'checkbox' : 'radio'}
											aria-checked={selected}
											className="flex items-start gap-2 text-left text-xs px-3 py-2 rounded-md cursor-pointer transition-colors"
											style={{
												backgroundColor: selected
													? `${theme.colors.accent}22`
													: theme.colors.bgMain,
												border: `1px solid ${selected ? theme.colors.accent : theme.colors.border}`,
												color: theme.colors.textMain,
											}}
										>
											<span
												className={`mt-0.5 flex-shrink-0 w-4 h-4 flex items-center justify-center ${
													q.multiSelect ? 'rounded' : 'rounded-full'
												}`}
												style={{
													border: `1px solid ${
														selected ? theme.colors.accent : theme.colors.border
													}`,
													backgroundColor: selected ? theme.colors.accent : 'transparent',
												}}
											>
												{selected && (
													<Check
														className="w-3 h-3"
														style={{ color: theme.colors.accentForeground }}
													/>
												)}
											</span>
											<span className="flex flex-col select-text">
												<span className="font-medium">{opt.label}</span>
												{opt.description && opt.description !== opt.label && (
													<span style={{ color: theme.colors.textDim }}>{opt.description}</span>
												)}
											</span>
										</button>
									);
								})}
							</div>
							<input
								type="text"
								value={selection.otherText ?? ''}
								onChange={(e) => updateSelection(qi, { otherText: e.target.value })}
								placeholder="Other (type a custom answer)"
								className="text-xs px-3 py-2 rounded-md outline-none select-text"
								style={{
									backgroundColor: theme.colors.bgMain,
									border: `1px solid ${theme.colors.border}`,
									color: theme.colors.textMain,
								}}
							/>
						</div>
					);
				})}
			</div>
			<div className="flex justify-end">
				<button
					onClick={handleSubmit}
					disabled={!canSubmit}
					className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md transition-colors"
					style={{
						backgroundColor: canSubmit ? theme.colors.accent : `${theme.colors.accent}55`,
						color: theme.colors.accentForeground,
						border: `1px solid ${theme.colors.accent}`,
						cursor: canSubmit ? 'pointer' : 'not-allowed',
					}}
				>
					<Send className="w-3.5 h-3.5" />
					Submit answer
				</button>
			</div>
		</div>
	);
}
