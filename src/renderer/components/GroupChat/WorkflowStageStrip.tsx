import { useEffect, useRef, useState } from 'react';
import type { GroupChatWorkflowStageStatus } from '../../../shared/group-chat-workflow-types';
import type { Theme } from '../../types';
import { selectWorkflowRun, useGroupChatStore } from '../../stores/groupChatStore';
import { logger } from '../../utils/logger';

interface WorkflowStageStripProps {
	theme: Theme;
	groupChatId: string;
}

type PendingAction = 'start' | 'discard' | 'cancel' | null;

/** Compact, chat-native status and controls for the active workflow run. */
export function WorkflowStageStrip({
	theme,
	groupChatId,
}: WorkflowStageStripProps): JSX.Element | null {
	const run = useGroupChatStore(selectWorkflowRun);
	const setWorkflowRun = useGroupChatStore((state) => state.setWorkflowRun);
	const userMessageCount = useGroupChatStore((state) =>
		state.groupChatMessages.reduce((count, message) => count + (message.from === 'user' ? 1 : 0), 0)
	);
	const [pendingAction, setPendingAction] = useState<PendingAction>(null);
	const terminalUserMessageCountRef = useRef<number | null>(null);

	const isTerminal = run?.status === 'complete' || run?.status === 'aborted';

	// A terminal summary remains visible long enough to be noticed, then gets out
	// of the conversation's way when the user starts the next exchange.
	useEffect(() => {
		if (!isTerminal) {
			terminalUserMessageCountRef.current = null;
			return;
		}

		if (terminalUserMessageCountRef.current === null) {
			terminalUserMessageCountRef.current = userMessageCount;
			return;
		}

		if (userMessageCount > terminalUserMessageCountRef.current) {
			setWorkflowRun(null);
			terminalUserMessageCountRef.current = null;
		}
	}, [isTerminal, setWorkflowRun, userMessageCount]);

	if (!run) return null;

	const { plan } = run;
	const stageCount = plan.stages.length;
	const stageLabel = `${stageCount} stage${stageCount === 1 ? '' : 's'}`;

	const runAction = async (action: Exclude<PendingAction, null>): Promise<void> => {
		if (pendingAction) return;
		setPendingAction(action);
		try {
			if (action === 'start') {
				await window.maestro.groupChat.approveWorkflowPlan(groupChatId);
			} else {
				await window.maestro.groupChat.cancelWorkflowRun(groupChatId);
			}
		} catch (error) {
			logger.error(`[WorkflowStageStrip] Failed to ${action} workflow run`, undefined, error);
		} finally {
			setPendingAction(null);
		}
	};

	const rootStyle = {
		backgroundColor: theme.colors.bgSidebar,
		borderColor: theme.colors.border,
		color: theme.colors.textMain,
	};

	if (run.status === 'complete') {
		return (
			<div
				className="select-none shrink-0 border-t px-4 py-2 text-xs"
				style={rootStyle}
				role="status"
				aria-live="polite"
				data-testid="workflow-stage-strip"
			>
				<span className="font-medium" style={{ color: theme.colors.success }}>
					Workflow complete:
				</span>{' '}
				{plan.title} · {stageLabel} finished
			</div>
		);
	}

	if (run.status === 'aborted') {
		const failedStage = plan.stages.find((stage) => run.stageStatuses[stage.id] === 'failed');
		return (
			<div
				className="select-none shrink-0 border-t px-4 py-2 text-xs"
				style={rootStyle}
				role="status"
				aria-live="polite"
				data-testid="workflow-stage-strip"
				data-status={failedStage ? 'failed' : 'aborted'}
			>
				<span className="font-medium" style={{ color: theme.colors.error }}>
					{failedStage ? `Workflow failed at ${failedStage.name}:` : 'Workflow aborted:'}
				</span>{' '}
				{run.abortReason ?? plan.title}
			</div>
		);
	}

	if (run.status === 'awaiting-approval') {
		return (
			<div
				className="select-none shrink-0 flex items-center gap-3 border-t px-4 py-2"
				style={rootStyle}
				data-testid="workflow-stage-strip"
			>
				<div className="min-w-0 flex-1">
					<div className="flex items-baseline gap-2 min-w-0">
						<span className="truncate text-sm font-medium">{plan.title}</span>
						<span className="shrink-0 text-xs" style={{ color: theme.colors.textDim }}>
							{stageLabel}
						</span>
					</div>
					<p className="truncate text-xs" style={{ color: theme.colors.textDim }}>
						You can also type go, or describe changes.
					</p>
				</div>
				<div className="flex shrink-0 items-center gap-2">
					<button
						type="button"
						onClick={() => void runAction('discard')}
						disabled={pendingAction !== null}
						className="rounded border px-2.5 py-1 text-xs font-medium transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-50"
						style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
					>
						Discard
					</button>
					<button
						type="button"
						onClick={() => void runAction('start')}
						disabled={pendingAction !== null}
						className="rounded border px-2.5 py-1 text-xs font-medium transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-50"
						style={{
							backgroundColor: theme.colors.accent,
							borderColor: theme.colors.accent,
							color: theme.colors.accentForeground,
						}}
					>
						Start
					</button>
				</div>
			</div>
		);
	}

	const currentStage = plan.stages[run.currentStageIndex];
	const currentStageNumber = stageCount === 0 ? 0 : Math.min(run.currentStageIndex + 1, stageCount);
	const statusColors: Record<GroupChatWorkflowStageStatus, string> = {
		complete: theme.colors.success,
		running: theme.colors.warning,
		failed: theme.colors.error,
		pending: theme.colors.textDim,
		skipped: theme.colors.textDim,
	};

	return (
		<div
			className="select-none shrink-0 flex items-center gap-3 border-t px-4 py-2"
			style={rootStyle}
			role="status"
			aria-live="polite"
			data-testid="workflow-stage-strip"
		>
			<div className="flex min-w-0 flex-1 items-center gap-3">
				<div className="flex shrink-0 items-center gap-1" aria-label="Workflow stage progress">
					{plan.stages.map((stage, index) => {
						const status = run.stageStatuses[stage.id] ?? 'pending';
						return (
							<span
								key={stage.id}
								className="h-2 w-2 rounded-full"
								style={{
									backgroundColor: statusColors[status],
									opacity: status === 'pending' || status === 'skipped' ? 0.55 : 1,
								}}
								aria-label={`Stage ${index + 1}, ${stage.name}: ${status}`}
								title={`${stage.name}: ${status}`}
								data-testid={`workflow-stage-pip-${stage.id}`}
								data-status={status}
							/>
						);
					})}
				</div>
				<span className="truncate text-sm font-medium">{currentStage?.name ?? plan.title}</span>
				<span className="shrink-0 text-xs" style={{ color: theme.colors.textDim }}>
					Stage {currentStageNumber} of {stageCount}
				</span>
			</div>
			<button
				type="button"
				onClick={() => void runAction('cancel')}
				disabled={pendingAction !== null}
				className="shrink-0 rounded border px-2.5 py-1 text-xs font-medium transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-50"
				style={{ borderColor: `${theme.colors.error}60`, color: theme.colors.error }}
			>
				Cancel
			</button>
		</div>
	);
}
