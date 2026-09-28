/**
 * AiCommandProposal - the spinner, the proposed command, and the yes/no.
 *
 * Sits between the AI command bar and the composer while a request is in
 * flight or waiting on an answer. It is deliberately IN the composer rather
 * than in the transcript: nothing has run yet, so nothing belongs in the
 * conversation. Only an accepted command earns a transcript card, and when it
 * does it is the ordinary command card, indistinguishable from a typed one.
 *
 * Keyboard is the primary interface - the caret never leaves the textarea, and
 * `useInputKeyDown` drives selection and confirmation from there. The buttons
 * are the mouse mirror of those keys, so both must produce identical results.
 */

import { memo, type ReactNode } from 'react';
import { AlertTriangle, Play, X } from 'lucide-react';
import type { Theme } from '../../../types';
import type { AiCommandEntry } from '../../../stores/aiCommandStore';
import { useSettingsStore } from '../../../stores/settingsStore';
import { useFixedPitchFont } from '../../../hooks/ui/useFixedPitchFont';
import { Spinner } from '../../ui/Spinner';
import { CopyIconButton } from '../../ui/CopyIconButton';

interface AiCommandProposalProps {
	theme: Theme;
	entry: AiCommandEntry;
	/** Run the proposed command. */
	onAccept: () => void;
	/** Dismiss and hand the request text back to the composer. */
	onDismiss: () => void;
	/** Highlight a choice (mouse hover mirrors the arrow keys). */
	onChoose: (choice: 'run' | 'cancel') => void;
}

export const AiCommandProposal = memo(function AiCommandProposal({
	theme,
	entry,
	onAccept,
	onDismiss,
	onChoose,
}: AiCommandProposalProps) {
	const { status, request, command, error, choice } = entry;

	// The proposal is a command line, so it is set in the same fixed-pitch face
	// the composer and the output card use - what you confirm here looks exactly
	// like what runs.
	const fontFamily = useSettingsStore((state) => state.fontFamily);
	const shellFontFamily = useFixedPitchFont(fontFamily);

	return (
		<div
			className="flex flex-col gap-2 px-3 py-2 border-b"
			style={{ borderColor: `${theme.colors.accent}30` }}
			data-testid="ai-command-proposal"
		>
			{/* The request stays on screen the whole time. Judging a proposed
			    command means judging it against what was actually asked for. */}
			<div
				className="text-xs-plus truncate"
				style={{ color: theme.colors.textDim }}
				title={request}
			>
				{request}
			</div>

			{status === 'thinking' && (
				<div
					className="flex items-center gap-2 text-xs"
					style={{ color: theme.colors.textDim }}
					data-testid="ai-command-thinking"
				>
					<Spinner size={13} color={theme.colors.accent} ariaLabel="Processing" />
					Processing
				</div>
			)}

			{status === 'error' && (
				<div
					className="flex items-start gap-2 text-xs"
					style={{ color: theme.colors.error }}
					data-testid="ai-command-error"
				>
					<AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
					<span className="select-text">{error}</span>
				</div>
			)}

			{status === 'proposed' && command && (
				<>
					<div
						className="flex items-start gap-2 rounded px-2 py-1.5 border"
						style={{
							borderColor: `${theme.colors.accent}40`,
							backgroundColor: `color-mix(in srgb, ${theme.colors.accent} 8%, transparent)`,
						}}
					>
						<span
							className="text-sm font-bold select-none shrink-0"
							style={{ color: theme.colors.accent, fontFamily: shellFontFamily }}
						>
							$
						</span>
						<code
							className="flex-1 text-sm whitespace-pre-wrap break-all select-text"
							style={{ color: theme.colors.textMain, fontFamily: shellFontFamily }}
							data-testid="ai-command-proposed"
						>
							{command}
						</code>
						<CopyIconButton
							value={command}
							theme={theme}
							title="Copy command"
							iconClassName="w-3.5 h-3.5"
						/>
					</div>

					<div className="flex items-center gap-2">
						<ChoiceButton
							theme={theme}
							active={choice === 'run'}
							accent={theme.colors.accent}
							icon={<Play className="w-3 h-3" />}
							label="Run"
							hint="Enter"
							testId="ai-command-run"
							onSelect={() => onChoose('run')}
							onActivate={onAccept}
						/>
						<ChoiceButton
							theme={theme}
							active={choice === 'cancel'}
							accent={theme.colors.textDim}
							icon={<X className="w-3 h-3" />}
							label="Cancel"
							hint="Esc"
							testId="ai-command-cancel"
							onSelect={() => onChoose('cancel')}
							onActivate={onDismiss}
						/>
						<span className="ml-auto text-2xs" style={{ color: theme.colors.textDim }}>
							&#8592; &#8594; to choose
						</span>
					</div>
				</>
			)}
		</div>
	);
});

interface ChoiceButtonProps {
	theme: Theme;
	active: boolean;
	accent: string;
	icon: ReactNode;
	label: string;
	hint: string;
	testId: string;
	onSelect: () => void;
	onActivate: () => void;
}

/**
 * One of the two answers. Hovering selects it and clicking commits it, so the
 * mouse walks the same two-step the arrow keys do and a click can never commit
 * the option the keyboard was pointing at.
 */
function ChoiceButton({
	theme,
	active,
	accent,
	icon,
	label,
	hint,
	testId,
	onSelect,
	onActivate,
}: ChoiceButtonProps) {
	return (
		<button
			type="button"
			className="flex items-center gap-1.5 px-2 py-1 rounded text-xs border transition-colors"
			style={{
				borderColor: active ? accent : theme.colors.border,
				backgroundColor: active ? `${accent}20` : 'transparent',
				color: active ? accent : theme.colors.textDim,
			}}
			// The composer keeps focus: the caret must not leave the textarea just
			// because the user reached for the mouse.
			onMouseDown={(e) => e.preventDefault()}
			onMouseEnter={onSelect}
			onClick={onActivate}
			aria-pressed={active}
			data-testid={testId}
		>
			{icon}
			{label}
			<kbd
				className="px-1 rounded border font-mono text-2xs"
				style={{ borderColor: theme.colors.border }}
			>
				{hint}
			</kbd>
		</button>
	);
}
