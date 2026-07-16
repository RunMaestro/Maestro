import { memo, useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ShieldQuestion, X } from 'lucide-react';
import type { Theme } from '../../types';
import type {
	AgentApprovalRequest,
	AgentApprovalResponse,
} from '../../../shared/agent-runtime-features';

export interface AgentApprovalsProps {
	theme: Theme;
	approvals: AgentApprovalRequest[];
	onRespond: (response: AgentApprovalResponse) => void;
}

function AgentApprovalsInner({ theme, approvals, onRespond }: AgentApprovalsProps) {
	const request = approvals[0];
	const [textValue, setTextValue] = useState('');
	const textInput = request?.textInput;

	useEffect(() => {
		setTextValue(textInput?.prefill ?? '');
	}, [request?.id, textInput?.prefill]);

	const respond = useCallback(
		(response: Omit<AgentApprovalResponse, 'sessionId' | 'requestId'>) => {
			if (!request) return;
			onRespond({ sessionId: request.sessionId, requestId: request.id, ...response });
		},
		[onRespond, request]
	);

	const deny = request?.options.find((option) => option.kind === 'deny');
	const onKeyDown = useCallback(
		(event: React.KeyboardEvent<HTMLDivElement>) => {
			if (event.key !== 'Escape') return;
			event.preventDefault();
			if (textInput) respond({ cancelled: true });
			else if (deny) respond({ optionId: deny.id });
		},
		[deny, respond, textInput]
	);

	if (!request) return null;

	const titleId = `agent-approval-title-${request.id}`;
	const submitText = () => respond({ value: textValue });

	return createPortal(
		<div
			className="fixed inset-0 z-[1008] flex items-center justify-center"
			style={{ backgroundColor: 'rgba(0,0,0,0.45)' }}
		>
			<div
				role="dialog"
				aria-modal="true"
				aria-labelledby={titleId}
				onKeyDown={onKeyDown}
				className="w-[520px] max-w-[90vw] rounded-xl shadow-2xl border p-5"
				style={{
					backgroundColor: theme.colors.bgSidebar,
					borderColor: theme.colors.border,
					color: theme.colors.textMain,
				}}
			>
				<div className="flex items-center gap-2 mb-3">
					<ShieldQuestion className="w-5 h-5" style={{ color: theme.colors.accent }} />
					<h2 id={titleId} className="text-sm font-semibold">
						{request.title}
					</h2>
				</div>
				<p className="text-xs mb-2" style={{ color: theme.colors.textDim }}>
					{request.toolType}
				</p>
				{request.detail && (
					<pre
						className="text-xs rounded-md p-3 mb-4 overflow-auto max-h-48 select-text whitespace-pre-wrap break-words"
						style={{
							backgroundColor: theme.colors.bgMain,
							color: theme.colors.textMain,
							border: `1px solid ${theme.colors.border}`,
						}}
					>
						{request.detail}
					</pre>
				)}
				{textInput ? (
					<div className="space-y-3">
						{textInput.kind === 'editor' ? (
							<textarea
								autoFocus
								value={textValue}
								placeholder={textInput.placeholder}
								onChange={(event) => setTextValue(event.target.value)}
								className="w-full min-h-40 rounded-md border p-2 text-sm"
								style={{ backgroundColor: theme.colors.bgMain, borderColor: theme.colors.border }}
							/>
						) : (
							<input
								autoFocus
								value={textValue}
								placeholder={textInput.placeholder}
								onChange={(event) => setTextValue(event.target.value)}
								onKeyDown={(event) => {
									if (event.key === 'Enter') {
										event.preventDefault();
										submitText();
									}
								}}
								className="w-full rounded-md border p-2 text-sm"
								style={{ backgroundColor: theme.colors.bgMain, borderColor: theme.colors.border }}
							/>
						)}
						<div className="flex justify-end gap-2">
							<button type="button" onClick={() => respond({ cancelled: true })}>
								Cancel
							</button>
							<button type="button" onClick={submitText}>
								Submit
							</button>
						</div>
					</div>
				) : (
					<div className="flex justify-end gap-2">
						{request.options.map((option) => {
							const isApprove = option.kind === 'approve';
							const isDeny = option.kind === 'deny';
							return (
								<button
									key={option.id}
									type="button"
									onClick={() => respond({ optionId: option.id })}
									autoFocus={isDeny}
									className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md cursor-pointer transition-colors"
									style={{
										backgroundColor: isApprove ? theme.colors.accent : 'transparent',
										color: isApprove
											? theme.colors.accentForeground
											: isDeny
												? theme.colors.error
												: theme.colors.textMain,
										border: `1px solid ${isApprove ? theme.colors.accent : isDeny ? `${theme.colors.error}60` : theme.colors.border}`,
									}}
								>
									{isApprove ? (
										<Check className="w-3.5 h-3.5" />
									) : isDeny ? (
										<X className="w-3.5 h-3.5" />
									) : null}
									{option.label}
								</button>
							);
						})}
					</div>
				)}
			</div>
		</div>,
		document.body
	);
}

export const AgentApprovals = memo(AgentApprovalsInner);
