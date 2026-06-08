import type { Theme } from '../../../../../types';
import { formatAgentName } from '../../../shared/wizardHelpers';
import type { ToolExecutionEvent } from '../types';
import { ToolExecutionEntry } from './ToolExecutionEntry';

export function ThinkingDisplay({
	theme,
	agentName,
	thinkingContent,
	toolExecutions,
}: {
	theme: Theme;
	agentName: string;
	thinkingContent: string;
	toolExecutions: ToolExecutionEvent[];
}): JSX.Element {
	return (
		<div className="flex justify-start mb-4" data-testid="wizard-thinking-display">
			<div
				className="max-w-[80%] rounded-lg rounded-bl-none px-4 py-3 border-l-2"
				style={{
					backgroundColor: theme.colors.bgActivity,
					borderColor: theme.colors.accent,
				}}
			>
				<div className="flex items-center gap-2 mb-2">
					<span className="text-xs font-medium" style={{ color: theme.colors.accent }}>
						{formatAgentName(agentName)}
					</span>
					<span
						className="text-[10px] px-1.5 py-0.5 rounded"
						style={{
							backgroundColor: `${theme.colors.accent}30`,
							color: theme.colors.accent,
						}}
					>
						thinking
					</span>
				</div>

				{toolExecutions.length > 0 && (
					<div className="mb-2 border-b pb-2" style={{ borderColor: `${theme.colors.border}60` }}>
						{toolExecutions.map((tool, idx) => (
							<ToolExecutionEntry
								key={`${tool.toolName}-${tool.timestamp}-${idx}`}
								tool={tool}
								theme={theme}
							/>
						))}
					</div>
				)}

				<div
					className="text-sm whitespace-pre-wrap font-mono"
					style={{ color: theme.colors.textDim, opacity: 0.85 }}
					data-testid="thinking-display-content"
				>
					{thinkingContent || (toolExecutions.length === 0 ? 'Reasoning...' : '')}
					<span className="animate-pulse ml-1" data-testid="thinking-cursor">
						▊
					</span>
				</div>
			</div>
		</div>
	);
}
