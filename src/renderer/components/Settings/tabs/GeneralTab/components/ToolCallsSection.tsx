import { Wrench } from 'lucide-react';
import type { Theme } from '../../../../../types';
import { ToggleSwitch } from '../../../../ui/ToggleSwitch';

interface ToolCallsSectionProps {
	theme: Theme;
	showToolCalls: boolean;
	setShowToolCalls: (enabled: boolean) => void;
}

export function ToolCallsSection({
	theme,
	showToolCalls,
	setShowToolCalls,
}: ToolCallsSectionProps) {
	return (
		<div data-setting-id="general-tool-calls">
			<div className="block text-xs font-bold opacity-70 uppercase mb-2 flex items-center gap-2">
				<Wrench className="w-3 h-3" />
				Tool Calls
			</div>
			<div
				className="p-3 rounded border"
				style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
			>
				<div
					className="flex items-center justify-between cursor-pointer"
					onClick={() => setShowToolCalls(!showToolCalls)}
					role="button"
					tabIndex={0}
					onKeyDown={(e) => {
						if (e.key === 'Enter' || e.key === ' ') {
							e.preventDefault();
							setShowToolCalls(!showToolCalls);
						}
					}}
				>
					<div className="flex-1 pr-3">
						<div className="font-medium" style={{ color: theme.colors.textMain }}>
							Show tool calls in responses
						</div>
						<div className="text-xs opacity-50 mt-0.5" style={{ color: theme.colors.textDim }}>
							Display tool-call activity (tool badges and their input/output) in AI responses. Turn
							off to hide tool calls from the transcript; agents still run tools normally.
						</div>
					</div>
					<ToggleSwitch
						checked={showToolCalls}
						onChange={setShowToolCalls}
						theme={theme}
						ariaLabel="Show tool calls in responses"
					/>
				</div>
			</div>
		</div>
	);
}
