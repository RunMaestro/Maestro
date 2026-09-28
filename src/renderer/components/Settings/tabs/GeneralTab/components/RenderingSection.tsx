import { Monitor, PartyPopper } from 'lucide-react';
import type { Theme } from '../../../../../types';
import { ToggleSwitch } from '../../../../ui/ToggleSwitch';
import { SettingsSectionHeading } from '../../../SettingsSectionHeading';

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
				<div
					className="flex items-center justify-between cursor-pointer"
					onClick={() => setDisableGpuAcceleration(!disableGpuAcceleration)}
					role="button"
					tabIndex={0}
					onKeyDown={(e) => {
						if (e.key === 'Enter' || e.key === ' ') {
							e.preventDefault();
							setDisableGpuAcceleration(!disableGpuAcceleration);
						}
					}}
				>
					<div className="flex-1 pr-3">
						<div className="font-medium" style={{ color: theme.colors.textMain }}>
							Disable GPU acceleration
						</div>
						<div className="text-xs opacity-70 mt-0.5">
							Use software rendering instead of GPU. Requires restart to take effect.
						</div>
					</div>
					<ToggleSwitch
						checked={disableGpuAcceleration}
						onChange={setDisableGpuAcceleration}
						theme={theme}
						ariaLabel="Disable GPU acceleration"
					/>
				</div>

				<div
					className="flex items-center justify-between cursor-pointer pt-3 border-t"
					style={{ borderColor: theme.colors.border }}
					onClick={() => setDisableConfetti(!disableConfetti)}
					role="button"
					tabIndex={0}
					onKeyDown={(e) => {
						if (e.key === 'Enter' || e.key === ' ') {
							e.preventDefault();
							setDisableConfetti(!disableConfetti);
						}
					}}
				>
					<div className="flex-1 pr-3">
						<div
							className="font-medium flex items-center gap-2"
							style={{ color: theme.colors.textMain }}
						>
							<PartyPopper className="w-4 h-4" />
							Disable confetti animations
						</div>
						<div className="text-xs opacity-70 mt-0.5">
							Skip celebratory confetti effects on achievements and milestones
						</div>
					</div>
					<ToggleSwitch
						checked={disableConfetti}
						onChange={setDisableConfetti}
						theme={theme}
						ariaLabel="Disable confetti animations"
					/>
				</div>
			</div>
		</div>
	);
}
