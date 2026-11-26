import React from 'react';
import { AlertCircle, X } from 'lucide-react';
import { GhostIconButton } from '../ui/GhostIconButton';
import type { AgentError, Theme } from '../../types';
import { inlineErrorText } from '../../../shared/failureScreen';

interface AgentErrorBannerProps {
	error: AgentError;
	theme: Theme;
	onShowDetails?: () => void;
	onClear?: () => void;
}

export const AgentErrorBanner = React.memo(function AgentErrorBanner({
	error,
	theme,
	onShowDetails,
	onClear,
}: AgentErrorBannerProps) {
	// A banner is two lines at most. The full message and the agent's last
	// screen live behind View Details (the agent error modal).
	const text = inlineErrorText(error.message);
	return (
		<div
			className="flex items-center gap-3 px-4 py-2 border-b shrink-0"
			style={{
				backgroundColor: theme.colors.error + '15',
				borderColor: theme.colors.error + '40',
			}}
		>
			<AlertCircle className="w-4 h-4 shrink-0" style={{ color: theme.colors.error }} />
			<div className="flex-1 min-w-0">
				<span
					className="text-sm font-medium line-clamp-2 break-words"
					style={{ color: theme.colors.error }}
					title={text}
				>
					{text}
				</span>
			</div>
			<div className="flex items-center gap-2 shrink-0">
				{onShowDetails && (
					<button
						onClick={() => onShowDetails()}
						className="px-2 py-1 text-xs font-medium rounded hover:opacity-80 transition-opacity"
						style={{
							backgroundColor: theme.colors.error,
							color: '#ffffff',
						}}
					>
						View Details
					</button>
				)}
				{onClear && error.recoverable && (
					<GhostIconButton onClick={onClear} title="Dismiss error">
						<X className="w-4 h-4" style={{ color: theme.colors.error }} />
					</GhostIconButton>
				)}
			</div>
		</div>
	);
});
