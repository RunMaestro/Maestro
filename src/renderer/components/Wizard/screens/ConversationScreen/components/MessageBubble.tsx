import ReactMarkdown from 'react-markdown';
import type { Theme } from '../../../../../types';
import type { WizardMessage } from '../../../WizardContext';
import { getConfidenceColor } from '../../../services/wizardPrompts';
import { formatAgentName } from '../../../shared/wizardHelpers';
import {
	REMARK_GFM_PLUGINS,
	type createWizardBubbleMarkdownComponents,
} from '../../../../../utils/markdownConfig';
import { formatTimestamp } from '../../../../../../shared/formatters';

export function MessageBubble({
	message,
	theme,
	agentName,
	providerName,
	wizardMarkdownComponents,
}: {
	message: WizardMessage;
	theme: Theme;
	agentName: string;
	providerName?: string;
	wizardMarkdownComponents: ReturnType<typeof createWizardBubbleMarkdownComponents>;
}): JSX.Element {
	const isUser = message.role === 'user';
	const isSystem = message.role === 'system';

	return (
		<div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-4`}>
			<div
				className={`max-w-[80%] rounded-lg px-4 py-3 ${
					isUser ? 'rounded-br-none' : 'rounded-bl-none'
				}`}
				style={{
					backgroundColor: isUser
						? theme.colors.accent
						: isSystem
							? `${theme.colors.warning}20`
							: theme.colors.bgActivity,
					color: isUser ? theme.colors.accentForeground : theme.colors.textMain,
				}}
			>
				{!isUser && (
					<div
						className="text-xs font-medium mb-2 flex items-center justify-between"
						style={{ color: isSystem ? theme.colors.warning : theme.colors.accent }}
					>
						<div className="flex items-center gap-2">
							<span>{isSystem ? '🎼 System' : formatAgentName(agentName)}</span>
							{message.confidence !== undefined && (
								<span
									className="text-xs px-1.5 py-0.5 rounded"
									style={{
										backgroundColor: `${getConfidenceColor(message.confidence)}20`,
										color: getConfidenceColor(message.confidence),
									}}
								>
									{message.confidence}% confident
								</span>
							)}
						</div>
						{providerName && !isSystem && (
							<span
								className="text-xs px-2 py-0.5 rounded-full"
								style={{
									backgroundColor: `${theme.colors.accent}15`,
									color: theme.colors.accent,
									border: `1px solid ${theme.colors.accent}30`,
								}}
							>
								{providerName}
							</span>
						)}
					</div>
				)}

				<div className="text-sm break-words wizard-markdown">
					{isUser ? (
						<span className="whitespace-pre-wrap">{message.content}</span>
					) : (
						<ReactMarkdown remarkPlugins={REMARK_GFM_PLUGINS} components={wizardMarkdownComponents}>
							{message.content}
						</ReactMarkdown>
					)}
				</div>

				<div
					className="text-xs mt-1 text-right opacity-60"
					style={{ color: isUser ? theme.colors.accentForeground : theme.colors.textDim }}
				>
					{formatTimestamp(message.timestamp, 'time')}
				</div>
			</div>
		</div>
	);
}
