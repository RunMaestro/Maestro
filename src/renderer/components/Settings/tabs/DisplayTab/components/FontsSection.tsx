import { useRef } from 'react';
import { Type } from 'lucide-react';
import type { Theme } from '../../../../../types';
import { SettingsSectionHeading } from '../../../SettingsSectionHeading';
import { SectionCard } from './SectionCard';
import { CustomFontsRow } from './CustomFontsRow';
import { FontConfigurationPanel } from '../../../../FontConfigurationPanel';
import { FontSizeStepper } from '../../../../ui/FontSizeStepper';
import { useElementWidth } from '../../../../../hooks/ui/useElementWidth';
import {
	TYPOGRAPHY_SURFACE_LIST,
	TYPOGRAPHY_SURFACE_SPECS,
	canInherit,
	inheritOptionsForSurface,
	type TypographySurface,
} from '../../../../../../shared/typography';
import type { FontConfigurationState } from '../types';

interface FontsSectionProps {
	theme: Theme;
	/** Every font/size value and setter, read through useSettings. */
	settings: Record<string, unknown>;
	fontConfiguration: FontConfigurationState;
	setSurfaceFontFamily: (surface: TypographySurface, value: string) => void;
	setSurfaceFontSize: (surface: TypographySurface, value: number) => void;
}

/**
 * Width below which the dependent surfaces stack into one column.
 *
 * Two columns need roughly 280px each: the font dropdown carries long option
 * labels ("Bundled with Maestro (always available)") and the size stepper is a
 * fixed row of controls that cannot shrink. The Settings content pane is 684px
 * at the modal's default width but only 424px at its minimum, so the grid has
 * to collapse rather than assume the space is there.
 */
const TWO_COLUMN_MIN_WIDTH = 560;

/**
 * Every font control in one card.
 *
 * Previously five sibling sections, each rendering its own copy of the global
 * custom-font manager. That put five identical inputs on screen for one shared
 * list and made the section read as far more settings than it holds.
 *
 * The structure now states the model instead of repeating it:
 *
 *   - The custom-font list is global, so it is its own section above this one
 *     rather than a control repeated inside every picker.
 *   - Interface and Terminal lead the grid as the two ROOTS - the proportional
 *     reading face and the fixed-width working face - and the four surfaces
 *     that may follow them come after, so reading order matches inheritance
 *     order.
 *   - Six surfaces at two across is three even rows, which is why the grid
 *     does not need a full-width exception for the roots.
 */
export function FontsSection({
	theme,
	settings,
	fontConfiguration,
	setSurfaceFontFamily,
	setSurfaceFontSize,
}: FontsSectionProps) {
	const gridRef = useRef<HTMLDivElement>(null);
	const gridWidth = useElementWidth(gridRef);
	// Falls back to two columns until the first measurement lands: at the
	// default modal width that is the right answer, so the common case does not
	// flash a single column on open.
	const singleColumn = gridWidth > 0 && gridWidth < TWO_COLUMN_MIN_WIDTH;

	const baseSize = Number(settings.fontSize ?? 14);

	const renderSurface = (surface: TypographySurface) => {
		const spec = TYPOGRAPHY_SURFACE_SPECS[surface];
		const storedFont = String(settings[spec.fontKey] ?? '');
		const storedSize = Number(settings[spec.sizeKey] ?? 0);
		const inheritable = canInherit(spec);

		return (
			// A flex column, not a plain block, so the pickers line up across the
			// row. Grid rows stretch their items to equal height by default, and
			// the description below claims the slack with `flex-1` - so a cell
			// whose description runs to one line grows that gap by exactly the
			// height of the extra line its neighbour needed, and both controls
			// land on the same baseline.
			//
			// Done in the layout rather than by measuring text: the descriptions
			// re-wrap with the pane width, the interface font, and the zoom, so any
			// padding computed once would be wrong at the next width.
			<div
				key={surface}
				className="min-w-0 flex flex-col gap-1"
				data-testid={`font-surface-${surface}`}
			>
				<div className="flex items-baseline justify-between gap-2">
					<span className="text-xs font-medium" style={{ color: theme.colors.textMain }}>
						{spec.label}
					</span>
				</div>
				<p className="text-xs-plus leading-snug opacity-60 flex-1">{spec.description}</p>
				<FontConfigurationPanel
					compact
					fontFamily={storedFont}
					setFontFamily={(value) => setSurfaceFontFamily(surface, value)}
					systemFonts={fontConfiguration.systemFonts}
					fontsLoaded={fontConfiguration.fontsLoaded}
					fontsReliable={fontConfiguration.fontsReliable}
					fontLoading={fontConfiguration.fontLoading}
					customFonts={fontConfiguration.customFonts}
					onAddCustomFont={fontConfiguration.addCustomFont}
					onRemoveCustomFont={fontConfiguration.removeCustomFont}
					onFontInteraction={fontConfiguration.handleFontInteraction}
					theme={theme}
					inheritOptions={inheritable ? inheritOptionsForSurface(spec) : undefined}
					sizeControl={
						<FontSizeStepper
							theme={theme}
							value={inheritable ? storedSize : baseSize}
							inheritedSize={baseSize}
							allowInherit={inheritable}
							testId={`font-size-${surface}`}
							onChange={(value) => setSurfaceFontSize(surface, value)}
						/>
					}
				/>
			</div>
		);
	};

	return (
		<>
			<div data-setting-id="display-custom-fonts">
				<SettingsSectionHeading icon={Type}>Custom Fonts</SettingsSectionHeading>
				<p className="text-xs opacity-60 mb-2 -mt-1">
					Names of fonts installed on this machine that aren&apos;t in the lists below. Added once
					here, then offered in every picker.
				</p>
				<SectionCard theme={theme}>
					<CustomFontsRow
						theme={theme}
						customFonts={fontConfiguration.customFonts}
						onAddCustomFont={fontConfiguration.addCustomFont}
						onRemoveCustomFont={fontConfiguration.removeCustomFont}
					/>
				</SectionCard>
			</div>

			<div data-setting-id="display-fonts">
				<SettingsSectionHeading icon={Type}>Fonts</SettingsSectionHeading>
				<p className="text-xs opacity-60 mb-2 -mt-1">
					Interface is the proportional face and Terminal the fixed-width one. Everything else can
					follow either, or carry a font of its own. Press Up/Down on any picker to preview.
				</p>
				<SectionCard theme={theme}>
					{/* All six surfaces in one grid: the two roots lead, and the four
					    that may follow them come after, so reading order matches the
					    inheritance order. Collapses to a single column when the pane
					    is too narrow for two dropdowns side by side. */}
					<div
						ref={gridRef}
						// `items-stretch` is the grid default, stated explicitly because
						// the row alignment above depends on it: without equal-height
						// cells the description's `flex-1` has no slack to claim and the
						// pickers drift apart again.
						className={`grid items-stretch gap-x-6 gap-y-5 ${
							singleColumn ? 'grid-cols-1' : 'grid-cols-2'
						}`}
						data-testid="font-surfaces"
						data-columns={singleColumn ? '1' : '2'}
					>
						{TYPOGRAPHY_SURFACE_LIST.map((spec) => renderSurface(spec.id))}
					</div>
				</SectionCard>
			</div>
		</>
	);
}
