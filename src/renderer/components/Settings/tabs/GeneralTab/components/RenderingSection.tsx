import { Monitor, PartyPopper } from 'lucide-react';
import type { Theme } from '../../../../../types';
import { SettingsSectionHeading } from '../../../SettingsSectionHeading';
import { ToggleSettingRow } from '../../DisplayTab/components/ToggleSettingRow';

interface RenderingSectionProps {
	theme: Theme;
	disableGpuAcceleration: boolean;
	setDisableGpuAcceleration: (disabled: boolean) => void;
	disableConfetti: boolean;
	setDisableConfetti: (disabled: boolean) => void;
}

export function RenderingSection({
	theme,
	disableGpuAcceleration,
	setDisableGpuAcceleration,
	disableConfetti,
	setDisableConfetti,
}: RenderingSectionProps) {
	return (
		<div data-setting-id="general-rendering">
			<SettingsSectionHeading icon={Monitor}>Rendering Options</SettingsSectionHeading>
			<div
				className="p-3 rounded border space-y-3"
				style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
			>
				<ToggleSettingRow
					theme={theme}
					title={
						<span className="font-medium" style={{ color: theme.colors.textMain }}>
							Disable GPU acceleration
						</span>
					}
					description={
						<span style={{ color: theme.colors.textDim }}>
							Use software rendering instead of GPU. Requires restart to take effect.
						</span>
					}
					checked={disableGpuAcceleration}
					onChange={setDisableGpuAcceleration}
					ariaLabel="Disable GPU acceleration"
					clickableRow
				/>

				<ToggleSettingRow
					theme={theme}
					title={
						<span
							className="font-medium flex items-center gap-2"
							style={{ color: theme.colors.textMain }}
						>
							<PartyPopper className="w-4 h-4" />
							Disable confetti animations
						</span>
					}
					description={
						<span style={{ color: theme.colors.textDim }}>
							Skip celebratory confetti effects on achievements and milestones
						</span>
					}
					checked={disableConfetti}
					onChange={setDisableConfetti}
					ariaLabel="Disable confetti animations"
					borderTop
					clickableRow
				/>
			</div>
		</div>
	);
}
