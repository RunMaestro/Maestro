import type { Theme } from '../../../../../types';
import { formatAgentName } from '../../../shared/wizardHelpers';

export function StreamingResponseBubble({
	theme,
	agentName,
	streamingText,
}: {
	theme: Theme;
	agentName: string;
	streamingText: string;
}): JSX.Element {
	return (
		<div className="flex justify-start mb-4">
			<div
				className="max-w-[80%] rounded-lg rounded-bl-none px-4 py-3"
				style={{ backgroundColor: theme.colors.bgActivity }}
			>
				<div className="text-xs font-medium mb-2" style={{ color: theme.colors.accent }}>
					{formatAgentName(agentName)}
				</div>
				<div className="text-sm whitespace-pre-wrap" style={{ color: theme.colors.textMain }}>
					{streamingText}
					<span className="animate-pulse">▊</span>
				</div>
			</div>
		</div>
	);
}
