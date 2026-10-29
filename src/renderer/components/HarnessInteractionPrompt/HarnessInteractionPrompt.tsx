import { memo, useEffect, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { Check, MessagesSquare, ShieldQuestion, X } from 'lucide-react';
import type { Theme } from '../../types';
import type { HarnessInteractionRequest } from '../../../shared/harness-control/types';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';
import { useModalLayer } from '../../hooks/ui/useModalLayer';
import {
	selectActiveHarnessInteraction,
	useHarnessInteractionStore,
} from '../../stores/harnessInteractionStore';

/** Render useful tool detail while bounding display to existing request metadata. */
function detailText(request: HarnessInteractionRequest | undefined): string {
	if (!request) return '';
	if (request.detail) return request.detail;
	if (!request.input) return '';
	if (typeof request.input.command === 'string') return request.input.command;
	for (const key of ['file_path', 'path', 'filePath']) {
		if (typeof request.input[key] === 'string') return request.input[key] as string;
	}
	try {
		return JSON.stringify(request.input, null, 2);
	} catch {
		return '(unable to display request input)';
	}
}

/** Display the active owner-scoped approval or elicitation and submit its resolution. */
export const HarnessInteractionPrompt = memo(function HarnessInteractionPrompt({
	theme,
}: {
	theme: Theme;
}) {
	const request = useHarnessInteractionStore(selectActiveHarnessInteraction);
	const responding = useHarnessInteractionStore((state) =>
		request ? state.responding[request.requestId] === true : false
	);
	const respond = useHarnessInteractionStore((state) => state.respond);
	const enqueue = useHarnessInteractionStore((state) => state.enqueue);
	const settle = useHarnessInteractionStore((state) => state.settle);
	const clearSession = useHarnessInteractionStore((state) => state.clearSession);
	const loadPending = useHarnessInteractionStore((state) => state.loadPending);
	const [answer, setAnswer] = useState('');
	const [questionAnswers, setQuestionAnswers] = useState<Record<string, string | string[]>>({});
	const [touchedQuestions, setTouchedQuestions] = useState<Record<string, true>>({});

	useEffect(() => {
		const process = window.maestro?.process;
		const offRequest = process?.onHarnessInteractionRequest?.((next) => enqueue(next));
		const offSettled = process?.onHarnessInteractionSettled?.((event) => settle(event));
		const offExit = process?.onExit?.((sessionId) => clearSession(sessionId));
		void loadPending();
		return () => {
			offRequest?.();
			offSettled?.();
			offExit?.();
		};
	}, [enqueue, settle, clearSession, loadPending]);

	useEffect(() => {
		setAnswer('');
		const defaults = Object.fromEntries(
			(request?.questions ?? [])
				.filter((question) => question.default !== undefined)
				.map((question) => [question.id, question.default!])
		);
		setQuestionAnswers(defaults);
		setTouchedQuestions({});
	}, [request?.requestId]);

	const cancel = () => {
		if (request)
			void respond({ requestId: request.requestId, outcome: 'cancelled', reason: 'cancelled' });
	};
	useModalLayer(MODAL_PRIORITIES.PERMISSION_PROMPT, 'Harness permission request', cancel, {
		enabled: !!request && !responding,
	});

	if (!request) return null;
	const detail = detailText(request);
	const submitAnswer = (event: FormEvent) => {
		event.preventDefault();
		if (!answer.trim()) return;
		void respond({
			requestId: request.requestId,
			outcome: 'answers',
			answers: { answer },
		});
	};

	const questions = request.questions ?? [];
	const questionsComplete = questions.every((question) => {
		if (question.required === false || question.default !== undefined) return true;
		const value = questionAnswers[question.id];
		const answered = Array.isArray(value)
			? value.length > 0
			: typeof value === 'string' && value.trim().length > 0;
		return answered || (touchedQuestions[question.id] && question.allowEmpty === true);
	});
	const markQuestionTouched = (questionId: string) =>
		setTouchedQuestions((current) => ({ ...current, [questionId]: true }));
	const submitQuestions = (event: FormEvent) => {
		event.preventDefault();
		if (!questionsComplete) return;
		const answers = Object.fromEntries(
			Object.entries(questionAnswers).filter(([id, value]) => {
				const answered = Array.isArray(value) ? value.length > 0 : value.trim().length > 0;
				const emptyAllowed =
					touchedQuestions[id] && questions.find((question) => question.id === id)?.allowEmpty;
				return answered || emptyAllowed;
			})
		);
		void respond({ requestId: request.requestId, outcome: 'answers', answers });
	};

	return createPortal(
		<div
			className="fixed inset-0 z-[1008] flex items-center justify-center select-none"
			style={{ backgroundColor: 'rgba(0,0,0,0.45)' }}
		>
			<div
				role="dialog"
				aria-label={request.kind === 'permission' ? 'Permission request' : 'Agent question'}
				className="w-[560px] max-w-[92vw] rounded-xl shadow-2xl border p-5"
				style={{
					backgroundColor: theme.colors.bgSidebar,
					borderColor: theme.colors.border,
					color: theme.colors.textMain,
				}}
			>
				<div className="flex items-center gap-2 mb-2">
					{request.kind === 'permission' ? (
						<ShieldQuestion className="w-4 h-4" style={{ color: theme.colors.accent }} />
					) : (
						<MessagesSquare className="w-4 h-4" style={{ color: theme.colors.accent }} />
					)}
					<h2 className="text-sm font-semibold">{request.title}</h2>
				</div>
				<p className="text-xs mb-3" style={{ color: theme.colors.textDim }}>
					{request.provider}
					{request.toolName ? ` · ${request.toolName}` : ''}
				</p>
				{detail && (
					<pre
						className="text-xs rounded-md p-3 mb-4 overflow-auto max-h-56 select-text whitespace-pre-wrap break-words"
						style={{
							backgroundColor: theme.colors.bgMain,
							border: `1px solid ${theme.colors.border}`,
						}}
					>
						{detail}
					</pre>
				)}
				{questions.length > 0 ? (
					<form onSubmit={submitQuestions} className="max-h-[55vh] overflow-y-auto">
						{questions.map((question) => {
							const value = questionAnswers[question.id];
							return (
								<fieldset key={question.id} className="mb-4">
									<legend className="text-xs font-semibold mb-2">
										{question.header ? `${question.header}: ` : ''}
										{question.question}
									</legend>
									{question.description && (
										<p className="text-xs mb-2" style={{ color: theme.colors.textDim }}>
											{question.description}
										</p>
									)}
									{question.options.map((option) => {
										const checked = Array.isArray(value)
											? value.includes(option.label)
											: value === option.label;
										return (
											<label
												key={option.optionId}
												className="flex items-start gap-2 text-xs mb-2 cursor-pointer"
												title={option.description}
											>
												<input
													type={question.multiSelect ? 'checkbox' : 'radio'}
													name={question.id}
													checked={checked}
													disabled={responding}
													onChange={() => {
														markQuestionTouched(question.id);
														setQuestionAnswers((current) => {
															if (!question.multiSelect)
																return { ...current, [question.id]: option.label };
															const currentValue = current[question.id];
															const selected: string[] = Array.isArray(currentValue)
																? currentValue
																: [];
															return {
																...current,
																[question.id]: checked
																	? selected.filter((item) => item !== option.label)
																	: [...selected, option.label],
															};
														});
													}}
												/>
												<span>{option.label}</span>
											</label>
										);
									})}
									{(question.allowCustom || question.options.length === 0) && (
										<input
											type={question.secret ? 'password' : 'text'}
											value={typeof value === 'string' ? value : ''}
											disabled={responding}
											onChange={(event) => {
												markQuestionTouched(question.id);
												setQuestionAnswers((current) => ({
													...current,
													[question.id]: event.target.value,
												}));
											}}
											className="w-full text-xs px-3 py-2 rounded-md"
											style={{
												backgroundColor: theme.colors.bgMain,
												color: theme.colors.textMain,
												border: `1px solid ${theme.colors.border}`,
											}}
										/>
									)}
								</fieldset>
							);
						})}
						<div className="flex justify-end gap-2">
							<button
								type="button"
								onClick={cancel}
								disabled={responding}
								className="text-xs px-3 py-1.5 rounded-md"
								style={{ color: theme.colors.error }}
							>
								Cancel
							</button>
							<button
								type="submit"
								disabled={responding || !questionsComplete}
								className="text-xs px-3 py-1.5 rounded-md disabled:opacity-50"
								style={{
									backgroundColor: theme.colors.accent,
									color: theme.colors.accentForeground,
								}}
							>
								Answer
							</button>
						</div>
					</form>
				) : request.options.length > 0 ? (
					<div className="flex flex-wrap justify-end gap-2">
						<button
							onClick={cancel}
							disabled={responding}
							className="text-xs px-3 py-1.5 rounded-md cursor-pointer"
							style={{ color: theme.colors.textDim }}
						>
							Cancel
						</button>
						{request.options.map((option) => {
							const rejection = option.kind.startsWith('reject');
							return (
								<button
									key={option.optionId}
									autoFocus={rejection}
									disabled={responding}
									title={option.description}
									onClick={() =>
										void respond({
											requestId: request.requestId,
											outcome: 'selected',
											optionId: option.optionId,
										})
									}
									className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md cursor-pointer disabled:opacity-50"
									style={{
										color: rejection ? theme.colors.error : theme.colors.accentForeground,
										backgroundColor: rejection ? 'transparent' : theme.colors.accent,
										border: `1px solid ${rejection ? `${theme.colors.error}60` : theme.colors.accent}`,
									}}
								>
									{rejection ? <X className="w-3.5 h-3.5" /> : <Check className="w-3.5 h-3.5" />}
									{option.label}
								</button>
							);
						})}
					</div>
				) : (
					<form onSubmit={submitAnswer} className="flex gap-2">
						<input
							autoFocus
							type={request.secret ? 'password' : 'text'}
							value={answer}
							onChange={(event) => setAnswer(event.target.value)}
							disabled={responding}
							className="flex-1 text-xs px-3 py-2 rounded-md"
							style={{
								backgroundColor: theme.colors.bgMain,
								color: theme.colors.textMain,
								border: `1px solid ${theme.colors.border}`,
							}}
						/>
						<button
							type="submit"
							disabled={responding || !answer.trim()}
							className="text-xs px-3 py-1.5 rounded-md disabled:opacity-50"
							style={{ backgroundColor: theme.colors.accent, color: theme.colors.accentForeground }}
						>
							Answer
						</button>
						<button
							type="button"
							onClick={cancel}
							disabled={responding}
							className="text-xs px-3 py-1.5 rounded-md"
							style={{ color: theme.colors.error }}
						>
							Cancel
						</button>
					</form>
				)}
			</div>
		</div>,
		document.body
	);
});
