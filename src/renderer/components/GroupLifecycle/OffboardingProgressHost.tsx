/**
 * OffboardingProgressHost - the dialog a removal shows while it waits on its
 * group's Offboarding prompt.
 *
 * Mounted once, app-wide. It draws the oldest waiting removal the person has
 * not dismissed (`selectVisibleOffboarding`). The removal itself is held by
 * `offboardBeforeRemoval` and goes ahead on its own when the turn finishes or
 * the time limit runs out; this dialog only reports and offers two actions:
 *
 * - **Remove now, skip Offboarding** ends the wait at once.
 * - **View tab** takes the person to the tab the prompt runs in.
 *
 * Escape and the X close the dialog without ending the wait: the agent is
 * still removed when Offboarding finishes.
 */

import { useEffect, useState } from 'react';
import { LogOut } from 'lucide-react';
import type { Theme } from '../../types';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';
import { useGroupLifecycleStore, selectVisibleOffboarding } from '../../stores/groupLifecycleStore';
import { useSessionStore } from '../../stores/sessionStore';
import { skipOffboarding } from '../../services/groupLifecycle';
import { jumpToAgent } from '../../services/agentNavigation';
import { formatElapsedTimeColon } from '../../../shared/formatters';
import { safeExcerpt } from '../../../shared/safeExcerpt';
import { Modal, MODAL_BUTTON_BASE_CLASS, MODAL_BUTTON_SECONDARY_CLASS } from '../ui/Modal';
import { Spinner } from '../ui/Spinner';

/** How much of the turn's latest output the dialog quotes. */
const LATEST_OUTPUT_CHARS = 160;

export function OffboardingProgressHost({ theme }: { theme: Theme }) {
	const pending = useGroupLifecycleStore(selectVisibleOffboarding);
	const dismiss = useGroupLifecycleStore((state) => state.dismiss);
	const [now, setNow] = useState(() => Date.now());

	useEffect(() => {
		if (!pending) return;
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [pending]);

	// The latest thing the turn said, so the dialog shows progress, not just a clock.
	const latestOutput = useSessionStore((state) => {
		if (!pending) return null;
		const agent = state.sessions.find((candidate) => candidate.id === pending.runAgentId);
		const tab = agent?.aiTabs.find((candidate) => candidate.id === pending.tabId);
		const last = tab?.logs[tab.logs.length - 1];
		return last && last.source !== 'user' ? last.text : null;
	});

	if (!pending) return null;

	const total = Math.max(pending.deadline - pending.startedAt, 1);
	const elapsed = Math.min(Math.max(now - pending.startedAt, 0), total);
	const percent = Math.round((elapsed / total) * 100);
	const excerpt = latestOutput ? safeExcerpt(latestOutput, LATEST_OUTPUT_CHARS, false).text : '';

	return (
		<Modal
			theme={theme}
			title={`Removing "${pending.subjectName}"`}
			priority={MODAL_PRIORITIES.OFFBOARDING_PROGRESS}
			onClose={() => dismiss(pending.subjectAgentId)}
			width={520}
			testId="offboarding-progress"
			footer={
				<>
					<button
						type="button"
						className={`${MODAL_BUTTON_BASE_CLASS} mr-auto hover:bg-white/5`}
						style={{ color: theme.colors.textDim }}
						onClick={() => {
							dismiss(pending.subjectAgentId);
							jumpToAgent(pending.runAgentId, { tabId: pending.tabId });
						}}
						data-testid="offboarding-view-tab"
					>
						View tab
					</button>
					<button
						type="button"
						className={MODAL_BUTTON_SECONDARY_CLASS}
						style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
						onClick={() => skipOffboarding(pending.subjectAgentId)}
						data-testid="offboarding-skip"
					>
						Remove now, skip Offboarding
					</button>
				</>
			}
		>
			<div className="space-y-4 select-none">
				<div className="flex items-center gap-3">
					<div
						className="w-8 h-8 rounded-lg grid place-items-center shrink-0"
						style={{ backgroundColor: `${theme.colors.warning}22`, color: theme.colors.warning }}
					>
						<LogOut className="w-4 h-4" />
					</div>
					<div className="min-w-0">
						<div className="text-sm font-semibold" style={{ color: theme.colors.textMain }}>
							Offboarding is running
						</div>
						<div className="text-xs truncate" style={{ color: theme.colors.textDim }}>
							Group {pending.groupName} · tab "{pending.tabName}"
						</div>
					</div>
				</div>

				<div
					className="flex items-start gap-2 text-xs select-text min-h-[1.25rem]"
					style={{ color: theme.colors.textMain }}
					data-testid="offboarding-latest-output"
				>
					<Spinner size={12} className="mt-0.5 shrink-0" />
					<span className="break-words">{excerpt || 'Waiting for the turn to start...'}</span>
				</div>

				<div>
					<div
						className="h-1.5 rounded-full overflow-hidden"
						style={{ backgroundColor: theme.colors.border }}
						role="progressbar"
						aria-valuemin={0}
						aria-valuemax={100}
						aria-valuenow={percent}
						aria-label="Time until removal goes ahead"
					>
						<div
							className="h-full rounded-full"
							style={{ width: `${percent}%`, backgroundColor: theme.colors.warning }}
						/>
					</div>
					<div
						className="flex justify-between mt-1.5 text-xs"
						style={{ color: theme.colors.textDim }}
					>
						<span>{formatElapsedTimeColon(Math.floor(elapsed / 1000))} elapsed</span>
						<span>Removes anyway at {formatElapsedTimeColon(Math.floor(total / 1000))}</span>
					</div>
				</div>

				<p className="text-xs" style={{ color: theme.colors.textDim }}>
					Close this to keep waiting in the background. The agent is removed when Offboarding
					finishes.
				</p>
			</div>
		</Modal>
	);
}
