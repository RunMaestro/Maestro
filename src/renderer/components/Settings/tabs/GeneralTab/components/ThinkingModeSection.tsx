import { Brain } from 'lucide-react';
import type { Theme, ThinkingMode } from '../../../../../types';
import { ToggleButtonGroup } from '../../../../ToggleButtonGroup';
import { ToggleSwitch } from '../../../../ui/ToggleSwitch';

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
	// Tool cells are part of the agent's "behind the scenes" activity, so they
	// follow the Thinking toggle: with Thinking off they never show regardless of
	// this switch. Ghost it out to signal the dependency (mirrors the forced-parallel
	// shortcut ghosting in InputBehaviorSection).
	const thinkingOff = defaultShowThinking === 'off';

	return (
		<div data-setting-id="general-thinking-mode">
			<div className="block text-xs font-bold opacity-70 uppercase mb-2 flex items-center gap-2">
				<Brain className="w-3 h-3" />
				Default Thinking Mode
			</div>
			<div
				className="mb-4 p-3 rounded border"
				style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
			>
				<div className="font-medium mb-1" style={{ color: theme.colors.textMain }}>
					Show AI thinking/reasoning content for new tabs
				</div>
				<div className="text-sm opacity-60 mb-3" style={{ color: theme.colors.textDim }}>
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
				style={{
					borderColor: theme.colors.border,
					backgroundColor: theme.colors.bgMain,
					opacity: thinkingOff ? 0.55 : 1,
				}}
			>
				<div
					className="flex items-center justify-between"
					onClick={() => {
						if (thinkingOff) return;
						setShowToolCalls(!showToolCalls);
					}}
					role="button"
					tabIndex={thinkingOff ? -1 : 0}
					aria-disabled={thinkingOff}
					style={{ cursor: thinkingOff ? 'not-allowed' : 'pointer' }}
					onKeyDown={(e) => {
						// Only activate from the row itself. The nested ToggleSwitch handles
						// its own keyboard events, so ignoring descendant keydowns keeps a
						// focused switch from toggling twice (row handler + native click).
						if (e.target !== e.currentTarget) return;
						if (thinkingOff) return;
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
							{thinkingOff
								? 'Tool calls follow the thinking setting. With thinking Off they stay hidden; agents still run tools normally.'
								: 'Display tool-call activity (tool badges and their input/output) in AI responses. Turn off to hide tool calls from the transcript; agents still run tools normally.'}
						</div>
					</div>
					<ToggleSwitch
						checked={showToolCalls && !thinkingOff}
						onChange={setShowToolCalls}
						theme={theme}
						disabled={thinkingOff}
						ariaLabel="Show tool calls in responses"
						title={thinkingOff ? 'Turn on thinking to control tool-call visibility' : undefined}
					/>
				</div>
			</div>
		</div>
	);
}
