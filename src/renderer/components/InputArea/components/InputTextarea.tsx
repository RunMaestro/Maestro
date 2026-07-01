import React, { memo, useMemo, useRef } from 'react';
import type { Session, Theme } from '../../../types';
import { getProviderDisplayName } from '../../../utils/sessionValidation';
import { useSettingsStore } from '../../../stores/settingsStore';
import { tokenizeMentions } from '../../../../shared/mentionPatterns';
import { MentionChip } from '../../MentionChip';
import {
	resolveAgentMention,
	resolveFileMentionIconColor,
} from '../../../utils/mentionChipResolve';

interface InputTextareaProps {
	session: Session;
	theme: Theme;
	isTerminalMode: boolean;
	inputValue: string;
	spellCheckEnabled: boolean;
	inputRef: React.RefObject<HTMLTextAreaElement>;
	onInputFocus: () => void;
	onInputBlur?: () => void;
	onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
	handleInputKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
	handlePaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
	handleDrop: (e: React.DragEvent<HTMLElement>) => void;
}

/**
 * Typography the transparent textarea and the highlight overlay MUST share
 * exactly, or the decorative chips drift away from the caret. Pulled into one
 * constant so the two layers can never disagree (font size / line height /
 * family / letter spacing). Padding is kept in sync separately: the textarea
 * uses `pt-3 pl-3 pr-3` classes; the overlay mirrors them as `0.75rem` below.
 */
const SHARED_TYPOGRAPHY: React.CSSProperties = {
	fontSize: '0.875rem',
	lineHeight: '1.25rem',
	fontFamily: 'inherit',
	letterSpacing: 'normal',
};

export const InputTextarea = memo(function InputTextarea({
	session,
	theme,
	isTerminalMode,
	inputValue,
	spellCheckEnabled,
	inputRef,
	onInputFocus,
	onInputBlur,
	onChange,
	handleInputKeyDown,
	handlePaste,
	handleDrop,
}: InputTextareaProps) {
	const crossAgentMentionsEnabled = useSettingsStore(
		(state) => state.encoreFeatures.crossAgentMentions
	);
	const colorBlindMode = useSettingsStore((state) => state.colorBlindMode);

	// The chip overlay is an AI-mode, Encore-gated enhancement. In terminal mode
	// (shell commands) or with the feature off, the textarea behaves exactly as
	// before: opaque text, no overlay.
	const overlayEnabled = !isTerminalMode && crossAgentMentionsEnabled;

	const overlayRef = useRef<HTMLDivElement>(null);

	// Tokenize the raw input into text / file / agent segments. Same source of
	// truth as the picker + dispatch scanner, so the overlay can never disagree
	// about what counts as a mention.
	const segments = useMemo(
		() => (overlayEnabled ? tokenizeMentions(inputValue) : []),
		[overlayEnabled, inputValue]
	);

	// Keep the decorative overlay pinned to the textarea's scroll position so the
	// chips track the text as the input grows past one line.
	const syncOverlayScroll = (target: HTMLTextAreaElement) => {
		const el = overlayRef.current;
		if (!el) return;
		el.scrollTop = target.scrollTop;
		el.scrollLeft = target.scrollLeft;
	};

	return (
		<div className="relative flex items-start">
			{isTerminalMode && (
				<span
					className="text-sm font-mono font-bold select-none pl-3 pt-3"
					style={{ color: theme.colors.accent }}
				>
					$
				</span>
			)}
			{overlayEnabled && (
				<div
					ref={overlayRef}
					aria-hidden="true"
					className="pointer-events-none absolute inset-0 overflow-hidden"
					style={{
						...SHARED_TYPOGRAPHY,
						zIndex: 0,
						whiteSpace: 'pre-wrap',
						wordBreak: 'break-word',
						padding: '0.75rem 0.75rem 0 0.75rem',
						color: theme.colors.textMain,
					}}
				>
					{segments.map((seg, i) => {
						if (seg.kind === 'text') {
							return <span key={i}>{seg.value}</span>;
						}
						if (seg.kind === 'file') {
							return (
								<MentionChip
									key={i}
									kind="file"
									theme={theme}
									label={seg.path}
									iconColor={resolveFileMentionIconColor(seg.extension, theme, colorBlindMode)}
								/>
							);
						}
						const agent = resolveAgentMention(seg.name, theme);
						return (
							<MentionChip
								key={i}
								kind="agent"
								theme={theme}
								label={agent.label}
								tooltip={agent.label}
								iconColor={agent.color}
							/>
						);
					})}
				</div>
			)}
			<textarea
				ref={inputRef}
				className={`relative flex-1 bg-transparent text-sm outline-none ${isTerminalMode ? 'pl-1.5' : 'pl-3'} pt-3 pr-3 resize-none min-h-[3.5rem] scrollbar-thin`}
				style={{
					...SHARED_TYPOGRAPHY,
					color: overlayEnabled ? 'transparent' : theme.colors.textMain,
					caretColor: theme.colors.textMain,
					maxHeight: '11rem',
					// Sit above the decorative overlay so the caret + native selection win.
					zIndex: overlayEnabled ? 1 : undefined,
				}}
				placeholder={
					isTerminalMode
						? 'Run shell command...'
						: `Talking to ${session.name} powered by ${getProviderDisplayName(session.toolType)}`
				}
				value={inputValue}
				spellCheck={spellCheckEnabled}
				onFocus={onInputFocus}
				onBlur={onInputBlur}
				onChange={onChange}
				onScroll={overlayEnabled ? (e) => syncOverlayScroll(e.currentTarget) : undefined}
				onKeyDown={handleInputKeyDown}
				onPaste={handlePaste}
				onDrop={(e) => {
					e.stopPropagation();
					handleDrop(e);
				}}
				onDragOver={(e) => e.preventDefault()}
				rows={2}
			/>
		</div>
	);
});
