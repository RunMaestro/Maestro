/**
 * SideQuestionCard - the question and answer of a `/btw` side question.
 *
 * Sits above the composer rather than in the transcript on purpose: a side
 * question is never part of the conversation, so its answer must not look like
 * it is. It stays until dismissed (the X, or Escape on an empty composer) or
 * replaced by the next `/btw`, so the user can keep typing while reading it.
 */

import { memo } from 'react';
import { AlertTriangle, MessageCircleQuestion, X } from 'lucide-react';
import type { Theme } from '../../../types';
import type { SideQuestionEntry } from '../../../stores/sideQuestionStore';
import { Markdown } from '../../Markdown';
import { Spinner } from '../../ui/Spinner';
import { CopyIconButton } from '../../ui/CopyIconButton';

interface SideQuestionCardProps {
	theme: Theme;
	entry: SideQuestionEntry;
	onDismiss: () => void;
}

export const SideQuestionCard = memo(function SideQuestionCard({
	theme,
	entry,
	onDismiss,
}: SideQuestionCardProps) {
	const { status, question, answer, error, model } = entry;

	return (
		<div
			className="flex flex-col gap-2 px-3 py-2 border-b"
			style={{ borderColor: `${theme.colors.accent}30` }}
			data-testid="side-question-card"
		>
			<div className="flex items-center gap-2 text-xs-plus" style={{ color: theme.colors.textDim }}>
				<MessageCircleQuestion
					className="w-3.5 h-3.5 shrink-0"
					style={{ color: theme.colors.accent }}
				/>
				<span className="font-mono shrink-0" style={{ color: theme.colors.accent }}>
					/btw
				</span>
				<span className="truncate flex-1 select-text" title={question}>
					{question}
				</span>
				{status === 'answered' && answer && (
					<CopyIconButton
						value={answer}
						theme={theme}
						title="Copy answer"
						iconClassName="w-3.5 h-3.5"
					/>
				)}
				<button
					type="button"
					className="p-0.5 rounded hover:opacity-80 shrink-0"
					style={{ color: theme.colors.textDim }}
					// The composer keeps focus: closing the card is not leaving the draft.
					onMouseDown={(e) => e.preventDefault()}
					onClick={onDismiss}
					title="Dismiss (Esc on an empty composer)"
					aria-label="Dismiss side question"
					data-testid="side-question-dismiss"
				>
					<X className="w-3.5 h-3.5" />
				</button>
			</div>

			{status === 'thinking' && (
				<div
					className="flex items-center gap-2 text-xs"
					style={{ color: theme.colors.textDim }}
					data-testid="side-question-thinking"
				>
					<Spinner size={13} color={theme.colors.accent} ariaLabel="Answering" />
					Answering from this conversation{model ? ` (${model})` : ''}. It will not be added to it.
				</div>
			)}

			{status === 'error' && (
				<div
					className="flex items-start gap-2 text-xs"
					style={{ color: theme.colors.error }}
					data-testid="side-question-error"
				>
					<AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
					<span className="select-text">{error}</span>
				</div>
			)}

			{status === 'answered' && answer && (
				<div
					className="max-h-64 overflow-y-auto text-sm select-text"
					style={{ color: theme.colors.textMain }}
					data-testid="side-question-answer"
				>
					<Markdown preset="chat" theme={theme} content={answer} />
				</div>
			)}
		</div>
	);
});
