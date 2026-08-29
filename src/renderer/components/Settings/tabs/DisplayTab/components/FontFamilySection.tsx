import { FontConfigurationPanel } from '../../../../FontConfigurationPanel';
import type { Theme } from '../../../../../types';
import type { FontConfigurationState } from '../types';

interface FontFamilySectionProps {
	theme: Theme;
	fontFamily: string;
	setFontFamily: (font: string) => void;
	fontConfiguration: FontConfigurationState;
	/** Section heading. Defaults to "Interface Font". */
	heading?: string;
	/** Optional helper text under the heading. */
	description?: string;
	/** Optional leading "inherit" option (value should be an empty string). */
	inheritOption?: { value: string; label: string };
	/** Per-surface size control rendered beside the picker. */
	sizeControl?: React.ReactNode;
}

export function FontFamilySection({
	theme,
	fontFamily,
	setFontFamily,
	fontConfiguration,
	heading,
	description,
	inheritOption,
	sizeControl,
}: FontFamilySectionProps) {
	return (
		<FontConfigurationPanel
			fontFamily={fontFamily}
			setFontFamily={setFontFamily}
			systemFonts={fontConfiguration.systemFonts}
			fontsLoaded={fontConfiguration.fontsLoaded}
			fontsReliable={fontConfiguration.fontsReliable}
			fontLoading={fontConfiguration.fontLoading}
			customFonts={fontConfiguration.customFonts}
			onAddCustomFont={fontConfiguration.addCustomFont}
			onRemoveCustomFont={fontConfiguration.removeCustomFont}
			onFontInteraction={fontConfiguration.handleFontInteraction}
			theme={theme}
			heading={heading}
			description={description}
			inheritOption={inheritOption}
			sizeControl={sizeControl}
		/>
	);
}
