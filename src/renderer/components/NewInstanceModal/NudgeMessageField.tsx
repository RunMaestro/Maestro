import React from 'react';
import type { NudgeMessageFieldProps } from './types';
import { NUDGE_MESSAGE_MAX_LENGTH } from './types';

export const NudgeMessageField = React.memo(function NudgeMessageField({
	theme,
	value,
	onChange,
	maxLength = NUDGE_MESSAGE_MAX_LENGTH,
	label = 'Nudge Message',
	labelSuffix = '(optional)',
	description = (
		<>
			This text is added to{' '}
			<strong>
				<u>every message</u>
			</strong>{' '}
			you send to the agent (not visible in chat).
		</>
	),
	placeholder = 'Instructions appended to every message you send...',
}: NudgeMessageFieldProps) {
	return (
		<div>
			<div
				className="block text-xs font-bold opacity-70 uppercase mb-2"
				style={{ color: theme.colors.textMain }}
			>
				{label} <span className="font-normal opacity-50">{labelSuffix}</span>
			</div>
			<p className="text-xs opacity-50 mb-2">{description}</p>
			<div className="relative">
				<textarea
					value={value}
					onChange={(e) => onChange(e.target.value.slice(0, maxLength))}
					placeholder={placeholder}
					className="w-full p-3 pb-8 rounded border bg-transparent outline-none resize-y text-sm"
					style={{
						borderColor: theme.colors.border,
						color: theme.colors.textMain,
						minHeight: '80px',
					}}
					maxLength={maxLength}
				/>
				<div
					className="absolute bottom-2 right-2 text-xs px-1 rounded"
					style={{
						color: value.length > maxLength * 0.9 ? theme.colors.warning : theme.colors.textDim,
						backgroundColor: theme.colors.bgActivity,
					}}
				>
					{value.length}/{maxLength}
				</div>
			</div>
		</div>
	);
});
