import { Lightbulb } from 'lucide-react';
import { notifyToast } from '../../../../../stores/notificationStore';
import type { Theme } from '../../../../../types';
import { ToggleSwitch } from '../../../../ui/ToggleSwitch';
import { SettingsSectionHeading } from '../../../SettingsSectionHeading';

interface DiscoverySectionProps {
	theme: Theme;
	didYouKnowEnabled: boolean;
	setDidYouKnowEnabled: (enabled: boolean) => void;
	didYouKnowSeenTipIds: string[];
	setDidYouKnowSeenTipIds: (value: string[]) => void;
}

export function DiscoverySection({
	theme,
	didYouKnowEnabled,
	setDidYouKnowEnabled,
	didYouKnowSeenTipIds,
	setDidYouKnowSeenTipIds,
}: DiscoverySectionProps) {
	return (
		<div>
			<SettingsSectionHeading icon={Lightbulb}>Discovery</SettingsSectionHeading>
			<div
				className="p-3 rounded border space-y-3"
				style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
			>
				<div
					data-setting-id="general-did-you-know"
					className="flex items-center justify-between cursor-pointer"
					onClick={() => setDidYouKnowEnabled(!didYouKnowEnabled)}
					role="button"
					tabIndex={0}
					onKeyDown={(e) => {
						if (e.key === 'Enter' || e.key === ' ') {
							e.preventDefault();
							setDidYouKnowEnabled(!didYouKnowEnabled);
						}
					}}
				>
					<div className="flex-1 pr-3">
						<div className="font-medium" style={{ color: theme.colors.textMain }}>
							Show 'Did You Know?' on launch
						</div>
						<div className="text-xs opacity-70 mt-0.5">
							Learn one Maestro feature each time you start the app. Open one any time from the
							command palette.
						</div>
					</div>
					<ToggleSwitch
						checked={didYouKnowEnabled}
						onChange={setDidYouKnowEnabled}
						theme={theme}
						ariaLabel="Show 'Did You Know?' on launch"
					/>
				</div>
				<div
					data-setting-id="general-did-you-know-reset"
					className="pt-3 border-t"
					style={{ borderColor: theme.colors.border }}
				>
					<div className="font-medium" style={{ color: theme.colors.textMain }}>
						Show all tips again
					</div>
					<div className="text-xs opacity-70 mt-0.5 mb-2">
						Clears the list of tips you have already seen, so the rotation starts over.
					</div>
					<button
						type="button"
						onClick={() => {
							setDidYouKnowSeenTipIds([]);
							notifyToast({
								color: 'green',
								title: 'Tip rotation reset',
								message: 'All Did You Know? tips are ready to show again.',
							});
						}}
						disabled={didYouKnowSeenTipIds.length === 0}
						className="flex items-center gap-2 px-3 py-1.5 rounded text-xs font-medium transition-colors disabled:opacity-50"
						style={{
							backgroundColor: theme.colors.border,
							color: theme.colors.textMain,
						}}
					>
						Show all tips again
					</button>
				</div>
			</div>
		</div>
	);
}
