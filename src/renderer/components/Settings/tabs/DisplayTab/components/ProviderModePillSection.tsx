import { Tags } from 'lucide-react';
import type { Theme } from '../../../../../types';
import { SettingsSectionHeading } from '../../../SettingsSectionHeading';
import { ToggleSettingRow } from './ToggleSettingRow';

interface ProviderModePillSectionProps {
	theme: Theme;
	showProviderModePill: boolean;
	setShowProviderModePill: (value: boolean) => void;
}

export function ProviderModePillSection({
	theme,
	showProviderModePill,
	setShowProviderModePill,
}: ProviderModePillSectionProps) {
	return (
		<div data-setting-id="display-provider-mode-pill">
			<SettingsSectionHeading icon={Tags}>Provider Mode Pill</SettingsSectionHeading>
			<div className="p-3 rounded border" style={{ borderColor: theme.colors.border }}>
				<ToggleSettingRow
					theme={theme}
					title="Show provider mode"
					description={
						<>
							Display which Claude interface produced a turn (&quot;claude -p&quot; or &quot;TUI
							Wrapper&quot;) as a pill under chat responses and on History entries.
						</>
					}
					checked={showProviderModePill}
					onChange={setShowProviderModePill}
					ariaLabel="Show provider mode pill"
				/>
			</div>
		</div>
	);
}
