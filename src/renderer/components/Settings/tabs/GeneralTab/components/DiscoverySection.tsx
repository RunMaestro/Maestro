import { Lightbulb } from 'lucide-react';
import { notifyToast } from '../../../../../stores/notificationStore';
import type { Theme } from '../../../../../types';
import { SectionCard } from '../../DisplayTab/components/SectionCard';
import { ToggleSettingRow } from '../../DisplayTab/components/ToggleSettingRow';
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
			<SectionCard theme={theme}>
				<div data-setting-id="general-did-you-know">
					<ToggleSettingRow
						theme={theme}
						title="Show 'Did You Know?' on launch"
						description="Learn one Maestro feature each time you start the app. Open one any time from the command palette."
						checked={didYouKnowEnabled}
						onChange={setDidYouKnowEnabled}
						ariaLabel="Show 'Did You Know?' on launch"
						clickableRow
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
			</SectionCard>
		</div>
	);
}
