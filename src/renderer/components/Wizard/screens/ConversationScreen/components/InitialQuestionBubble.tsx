import type { Theme } from '../../../../../types';
import { formatAgentName } from '../../../shared/wizardHelpers';

export function InitialQuestionBubble({
	theme,
	agentName,
	initialQuestion,
}: {
	theme: Theme;
	agentName: string;
	initialQuestion: string;
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
				<div className="text-sm" style={{ color: theme.colors.textMain }}>
					{initialQuestion}
				</div>
			</div>
		</div>
	);
}
