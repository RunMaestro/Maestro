import { FontConfigurationPanel } from '../../../../FontConfigurationPanel';
import type { Theme } from '../../../../../types';
import type { FontConfigurationState } from '../types';

interface FontFamilySectionProps {
	theme: Theme;
	fontFamily: string;
	setFontFamily: (font: string) => void;
	fontConfiguration: FontConfigurationState;
}

export function FontFamilySection({
	theme,
	fontFamily,
	setFontFamily,
	fontConfiguration,
}: FontFamilySectionProps) {
	return (
		<div data-setting-id="display-font-family">
			<FontConfigurationPanel
				fontFamily={fontFamily}
				setFontFamily={setFontFamily}
				systemFonts={fontConfiguration.systemFonts}
				fontsLoaded={fontConfiguration.fontsLoaded}
				fontLoading={fontConfiguration.fontLoading}
				customFonts={fontConfiguration.customFonts}
				onAddCustomFont={fontConfiguration.addCustomFont}
				onRemoveCustomFont={fontConfiguration.removeCustomFont}
				onFontInteraction={fontConfiguration.handleFontInteraction}
				theme={theme}
			/>
		</div>
	);
}
