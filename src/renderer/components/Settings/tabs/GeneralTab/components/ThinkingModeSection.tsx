import { Brain } from 'lucide-react';
import type { Theme, ThinkingMode } from '../../../../../types';
import { ToggleButtonGroup } from '../../../../ToggleButtonGroup';
import { SettingsSectionHeading } from '../../../SettingsSectionHeading';

interface ThinkingModeSectionProps {
	theme: Theme;
	defaultShowThinking: ThinkingMode;
	setDefaultShowThinking: (mode: ThinkingMode) => void;
}

export function ThinkingModeSection({
	theme,
	defaultShowThinking,
	setDefaultShowThinking,
}: ThinkingModeSectionProps) {
	return (
		<div data-setting-id="general-thinking-mode">
			<SettingsSectionHeading icon={Brain}>Default Thinking Mode</SettingsSectionHeading>
			<div
				className="p-3 rounded border"
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
		</div>
	);
}
