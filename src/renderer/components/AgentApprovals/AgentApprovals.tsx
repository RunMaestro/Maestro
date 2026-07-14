import { memo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Check, ShieldQuestion, X } from 'lucide-react';
import type { Theme } from '../../types';
import type { AgentApprovalRequest } from '../../../shared/agent-runtime-features';

export interface AgentApprovalsProps {
	theme: Theme;
	approvals: AgentApprovalRequest[];
	onRespond: (response: { sessionId: string; requestId: string; optionId: string }) => void;
}

function AgentApprovalsInner({ theme, approvals, onRespond }: AgentApprovalsProps) {
	const request = approvals[0];

	const respond = useCallback(
		(optionId: string) => {
			if (!request) {
				return;
			}
			onRespond({ sessionId: request.sessionId, requestId: request.id, optionId });
		},
		[onRespond, request]
	);

	const deny = request?.options.find((option) => option.kind === 'deny');
	const onKeyDown = useCallback(
		(event: React.KeyboardEvent<HTMLDivElement>) => {
			if (event.key === 'Escape' && deny) {
				event.preventDefault();
				respond(deny.id);
			}
		},
		[deny, respond]
	);

	if (!request) {
		return null;
	}

	const titleId = `agent-approval-title-${request.id}`;

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
				<div className="flex justify-end gap-2">
					{request.options.map((option) => {
						const isApprove = option.kind === 'approve';
						const isDeny = option.kind === 'deny';
						return (
							<button
								key={option.id}
								type="button"
								onClick={() => respond(option.id)}
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
			</div>
		</div>,
		document.body
	);
}

export const AgentApprovals = memo(AgentApprovalsInner);
