import React from 'react';
import type { LogEntry, Theme } from '../../../types';
import { summarizeToolInput, summarizeToolOutput } from '../utils/toolSummaries';

/**
 * The compact tool-execution badge: name pill, status glyph, input summary and
 * (once finished) an output preview.
 *
 * Extracted from LogItem so the same markup renders a top-level tool entry AND
 * the subagent tool entries nested under a Task badge - there is exactly one
 * tool renderer.
 */
export const ToolBadge = React.memo(({ log, theme }: { log: LogEntry; theme: Theme }) => {
	// Extract tool input details for display
	const toolInput = log.metadata?.toolState?.input;
	const toolSummary =
		toolInput !== undefined && toolInput !== null ? summarizeToolInput(toolInput) : null;
	// Show the tool result once it has finished. Without this the
	// compact tool log drops the output entirely (e.g. MCP calls
	// like squash_repos that take no args render as a bare name).
	const toolStatus = log.metadata?.toolState?.status;
	const outputSummary =
		toolStatus === 'completed' || toolStatus === 'failed' || toolStatus === 'error'
			? summarizeToolOutput(log.metadata?.toolState?.output)
			: null;

	return (
		<>
			<div className="flex items-start gap-2">
				<span
					className="px-1.5 py-0.5 rounded shrink-0"
					style={{
						backgroundColor: `${theme.colors.accent}30`,
						color: theme.colors.accent,
					}}
				>
					{log.text}
				</span>
				{toolStatus === 'running' && (
					<span className="animate-pulse shrink-0 pt-0.5" style={{ color: theme.colors.warning }}>
						●
					</span>
				)}
				{toolStatus === 'completed' && (
					<span className="shrink-0 pt-0.5" style={{ color: theme.colors.success }}>
						✓
					</span>
				)}
				{(toolStatus === 'failed' || toolStatus === 'error') && (
					<span className="shrink-0 pt-0.5" style={{ color: theme.colors.error }}>
						!
					</span>
				)}
				{toolSummary?.description && (
					<span className="opacity-50 break-words" style={{ color: theme.colors.textMain }}>
						{toolSummary.description}
					</span>
				)}
			</div>
			{toolSummary?.detail && (
				<div
					className="mt-1 ml-1 pl-2 opacity-70 break-words whitespace-pre-wrap border-l"
					style={{
						color: theme.colors.textMain,
						borderColor: `${theme.colors.accent}40`,
					}}
				>
					{toolSummary.detail}
				</div>
			)}
			{outputSummary && (
				<div
					className="mt-1 ml-1 pl-2 opacity-60 break-words whitespace-pre-wrap border-l"
					style={{
						color: theme.colors.textMain,
						borderColor: `${theme.colors.success}40`,
					}}
				>
					{outputSummary}
				</div>
			)}
		</>
	);
});

ToolBadge.displayName = 'ToolBadge';
