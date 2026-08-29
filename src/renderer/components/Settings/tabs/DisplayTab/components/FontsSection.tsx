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
	TYPOGRAPHY_ROOTS,
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
 *   - The custom-font list is global, so it appears once, at the top.
 *   - Interface and Terminal are the two ROOTS - the proportional reading face
 *     and the fixed-width working face. They get full-width rows because
 *     everything below can follow them.
 *   - The three dependent surfaces sit in a 2-up grid, each offering "same as
 *     interface" and "same as terminal" alongside a font of its own.
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
			<div key={surface} className="min-w-0 space-y-1" data-testid={`font-surface-${surface}`}>
				<div className="flex items-baseline justify-between gap-2">
					<span className="text-xs font-medium" style={{ color: theme.colors.textMain }}>
						{spec.label}
					</span>
				</div>
				<p className="text-[11px] leading-snug opacity-60">{spec.description}</p>
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

	const dependents = TYPOGRAPHY_SURFACE_LIST.filter(
		(spec) => !TYPOGRAPHY_ROOTS.includes(spec.id as (typeof TYPOGRAPHY_ROOTS)[number])
	);

	return (
		<div data-setting-id="display-fonts">
			<SettingsSectionHeading icon={Type}>Fonts</SettingsSectionHeading>
			<p className="text-xs opacity-60 mb-2 -mt-1">
				Interface is the proportional face and Terminal the fixed-width one. Everything else can
				follow either, or carry a font of its own. Press Up/Down on any picker to preview.
			</p>
			<SectionCard theme={theme} className="space-y-4">
				<CustomFontsRow
					theme={theme}
					customFonts={fontConfiguration.customFonts}
					onAddCustomFont={fontConfiguration.addCustomFont}
					onRemoveCustomFont={fontConfiguration.removeCustomFont}
				/>

				{/* The two roots, full width. They are not peers of the surfaces
				    below - everything below can point at them - so putting them in
				    the same grid would misstate the model. */}
				<div
					className="space-y-4 pt-4 border-t"
					style={{ borderColor: theme.colors.border }}
					data-testid="font-roots"
				>
					{TYPOGRAPHY_ROOTS.map((root) => renderSurface(root))}
				</div>

				<div
					ref={gridRef}
					className={`grid gap-x-6 gap-y-4 pt-4 border-t ${
						singleColumn ? 'grid-cols-1' : 'grid-cols-2'
					}`}
					style={{ borderColor: theme.colors.border }}
					data-testid="font-dependents"
					data-columns={singleColumn ? '1' : '2'}
				>
					{dependents.map((spec) => renderSurface(spec.id))}
				</div>
			</SectionCard>
		</div>
	);
}
