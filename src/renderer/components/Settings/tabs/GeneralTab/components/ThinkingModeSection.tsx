import { Brain } from 'lucide-react';
import type { Theme, ThinkingMode } from '../../../../../types';
import { ToggleButtonGroup } from '../../../../ToggleButtonGroup';
import { ToggleSwitch } from '../../../../ui/ToggleSwitch';
import { SettingsSectionHeading } from '../../../SettingsSectionHeading';

interface ThinkingModeSectionProps {
	theme: Theme;
	defaultShowThinking: ThinkingMode;
	setDefaultShowThinking: (mode: ThinkingMode) => void;
	showToolCalls: boolean;
	setShowToolCalls: (enabled: boolean) => void;
}

export function ThinkingModeSection({
	theme,
	defaultShowThinking,
	setDefaultShowThinking,
	showToolCalls,
	setShowToolCalls,
}: ThinkingModeSectionProps) {
	// Tool-call visibility is independent of the thinking mode. The two settings
	// live under one heading because they both shape how much of the agent's work
	// the transcript shows, but neither gates the other: thinking On with tools
	// hidden gives a pure reasoning chain, and tools On with thinking Off gives a
	// pure activity log.
	return (
		<div data-setting-id="general-thinking-mode">
			<SettingsSectionHeading icon={Brain}>Default Thinking Mode</SettingsSectionHeading>
			<div
				className="mb-4 p-3 rounded border"
				style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
			>
				<div className="font-medium mb-1" style={{ color: theme.colors.textMain }}>
					Show AI thinking/reasoning content for new tabs
				</div>
				<div className="text-sm opacity-70 mb-3">
					{defaultShowThinking === 'off' && 'Thinking hidden, only final responses shown'}
					{defaultShowThinking === 'on' && 'Thinking streams live, clears on completion'}
					{defaultShowThinking === 'sticky' && 'Thinking streams live and stays visible'}
				</div>
				<ToggleButtonGroup
					options={[
						{ value: 'off' as const, label: 'Off' },
						{ value: 'on' as const, label: 'On' },
						{ value: 'sticky' as const, label: 'Sticky' },
					]}
					value={defaultShowThinking}
					onChange={setDefaultShowThinking}
					theme={theme}
				/>
			</div>

			<div
				data-setting-id="general-tool-calls"
				className="p-3 rounded border"
				style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
			>
				<div
					className="flex items-center justify-between cursor-pointer"
					onClick={() => setShowToolCalls(!showToolCalls)}
					role="button"
					tabIndex={0}
					onKeyDown={(e) => {
						// Only activate from the row itself. The nested ToggleSwitch handles
						// its own keyboard events, so ignoring descendant keydowns keeps a
						// focused switch from toggling twice (row handler + native click).
						if (e.target !== e.currentTarget) return;
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
						<div className="text-xs opacity-70 mt-0.5">
							Display tool-call activity (tool badges and their input/output) in AI responses.
							Independent of the thinking mode above, so you can watch the reasoning chain without
							the tool noise. Agents still run tools normally either way.
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
