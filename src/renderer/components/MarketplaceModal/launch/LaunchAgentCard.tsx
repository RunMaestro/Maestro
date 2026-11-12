/**
 * LaunchAgentCard - the read-only card that names the agent a launch runs on.
 *
 * Name, provider, model and folder, and the reason a launch cannot run on the agent when it
 * cannot. The launch dialog never edits an agent, so the card has no controls of its own; a
 * caller may put one in the corner (`action`), such as Edit on a captured new agent.
 */

import type { ReactNode } from 'react';
import type { Theme } from '../../../types';
import { MiniBadge } from '../../ui/MiniBadge';
import type { LaunchAgentSummary } from './launchAgents';

/** What the card says for an agent with no model of its own. */
const DEFAULT_MODEL_LABEL = 'Provider default';

export interface LaunchAgentCardProps {
	theme: Theme;
	summary: LaunchAgentSummary;
	/** A control for the top right corner of the card. */
	action?: ReactNode;
	testId?: string;
}

export function LaunchAgentCard({
	theme,
	summary,
	action,
	testId = 'launch-agent-card',
}: LaunchAgentCardProps) {
	return (
		<div
			className="rounded border p-3 space-y-2 select-text"
			style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
			data-testid={testId}
		>
			<div className="flex items-start justify-between gap-2">
				<div className="flex items-center gap-2 min-w-0">
					<span
						className="text-sm font-bold truncate"
						style={{ color: theme.colors.textMain }}
						data-testid={`${testId}-name`}
					>
						{summary.name}
					</span>
					{summary.remote && (
						<MiniBadge label="SSH" theme={theme} title="This agent works on an SSH remote" />
					)}
				</div>
				{action}
			</div>
			<dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
				<dt style={{ color: theme.colors.textDim }}>Provider</dt>
				<dd style={{ color: theme.colors.textMain }}>{summary.provider}</dd>
				<dt style={{ color: theme.colors.textDim }}>Model</dt>
				<dd style={{ color: theme.colors.textMain }}>{summary.model ?? DEFAULT_MODEL_LABEL}</dd>
				<dt style={{ color: theme.colors.textDim }}>Folder</dt>
				<dd className="font-mono break-all" style={{ color: theme.colors.textMain }}>
					{summary.folder}
				</dd>
			</dl>
			{summary.problem && (
				<p
					role="alert"
					className="text-xs"
					style={{ color: theme.colors.error }}
					data-testid={`${testId}-problem`}
				>
					{summary.problem}
				</p>
			)}
		</div>
	);
}
