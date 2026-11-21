import { useRef } from 'react';
import { Heading, Undo2 } from 'lucide-react';
import type { Theme } from '../../../../../types';
import { SettingsSectionHeading } from '../../../SettingsSectionHeading';
import { SectionCard } from './SectionCard';
import { TWO_COLUMN_MIN_WIDTH } from './FontsSection';
import { FontConfigurationPanel } from '../../../../FontConfigurationPanel';
import { FontSizeStepper } from '../../../../ui/FontSizeStepper';
import { useElementWidth } from '../../../../../hooks/ui/useElementWidth';
import {
	HEADING_FONT_SIZE_MAX,
	HEADING_LEVELS,
	HEADING_DEFAULT_SCALE,
	TYPOGRAPHY_SURFACE_SPECS,
	defaultHeadingSize,
	headingFontVar,
	headingSizeVar,
	type HeadingLevel,
	type HeadingTypography,
} from '../../../../../../shared/typography';
import type { FontConfigurationState } from '../types';

interface HeadingsSectionProps {
	theme: Theme;
	headingTypography: HeadingTypography;
	/** The AI chat size in px before zoom (0 = interface), for the default readout. */
	chatFontSize: number;
	/** The interface size in px before zoom. */
	baseFontSize: number;
	fontConfiguration: FontConfigurationState;
	setHeadingFontFamily: (level: HeadingLevel, value: string) => void;
	setHeadingFontSize: (level: HeadingLevel, value: number) => void;
	resetHeadingTypography: (level?: HeadingLevel) => void;
}

/** Stored empty, meaning "keep the font of the text around the heading". */
const SAME_AS_TEXT_OPTION = [{ value: '', label: 'Same as surrounding text' }] as const;

const DEFAULT_SIZE_WORDING = {
	active: 'Default',
	action: 'Default',
	activeTitle: 'Default size for this heading level',
	title: 'Return to the default size for this heading level',
};

/**
 * Heading styles: a font and size per markdown heading level, the way a word
 * processor lets you restyle "Heading 1" once and have every H1 follow.
 *
 * Each cell reuses the surface picker so the font list, custom fonts, and
 * Up/Down preview behave exactly as they do in the Fonts card above. A level
 * left on "Same as surrounding text" and "Default" publishes nothing, so each
 * view keeps its own heading scale until the user overrides it.
 */
export function HeadingsSection({
	theme,
	headingTypography,
	chatFontSize,
	baseFontSize,
	fontConfiguration,
	setHeadingFontFamily,
	setHeadingFontSize,
	resetHeadingTypography,
}: HeadingsSectionProps) {
	const gridRef = useRef<HTMLDivElement>(null);
	const gridWidth = useElementWidth(gridRef);
	const singleColumn = gridWidth > 0 && gridWidth < TWO_COLUMN_MIN_WIDTH;
	const customized = Object.keys(headingTypography).length > 0;
	// The chat is where most headings are read, so the default readout is
	// measured against its size.
	const referenceSize = chatFontSize > 0 ? chatFontSize : baseFontSize;
	const chat = TYPOGRAPHY_SURFACE_SPECS.chat;

	const renderLevel = (level: HeadingLevel) => {
		const style = headingTypography[level];
		const number = level.slice(1);
		return (
			<div key={level} className="min-w-0 flex flex-col gap-1" data-testid={`heading-${level}`}>
				<span className="text-xs font-medium" style={{ color: theme.colors.textMain }}>
					Heading {number}
				</span>
				<FontConfigurationPanel
					compact
					heading={`Heading ${number} font`}
					fontFamily={style?.fontFamily ?? ''}
					setFontFamily={(value) => setHeadingFontFamily(level, value)}
					systemFonts={fontConfiguration.systemFonts}
					fontsLoaded={fontConfiguration.fontsLoaded}
					fontsReliable={fontConfiguration.fontsReliable}
					fontLoading={fontConfiguration.fontLoading}
					customFonts={fontConfiguration.customFonts}
					onAddCustomFont={fontConfiguration.addCustomFont}
					onRemoveCustomFont={fontConfiguration.removeCustomFont}
					onFontInteraction={fontConfiguration.handleFontInteraction}
					theme={theme}
					// The same variables the headings paint with, falling back to the
					// chat face at the default scale, so the sample shows what an H1
					// in a chat reply actually looks like right now.
					previewFontFamily={`var(${headingFontVar(level)}, var(${chat.fontVar}))`}
					previewFontSize={`var(${headingSizeVar(level)}, calc(var(${chat.sizeVar}) * ${HEADING_DEFAULT_SCALE[level]}))`}
					inheritOptions={SAME_AS_TEXT_OPTION}
					sizeControl={
						<FontSizeStepper
							theme={theme}
							value={style?.fontSize ?? 0}
							inheritedSize={defaultHeadingSize(level, referenceSize)}
							max={HEADING_FONT_SIZE_MAX}
							inheritWording={DEFAULT_SIZE_WORDING}
							testId={`heading-size-${level}`}
							onChange={(value) => setHeadingFontSize(level, value)}
						/>
					}
				/>
			</div>
		);
	};

	return (
		<div data-setting-id="display-heading-typography">
			<SettingsSectionHeading
				icon={Heading}
				description="Give each heading level its own font and size, like heading styles in a word processor. Applies to headings in the AI chat, file previews, Auto Run, and every other rendered markdown view. Sizes scale with zoom."
			>
				Headings
			</SettingsSectionHeading>
			<SectionCard theme={theme}>
				<div
					ref={gridRef}
					className={`grid items-stretch gap-x-6 gap-y-5 ${
						singleColumn ? 'grid-cols-1' : 'grid-cols-2'
					}`}
					data-testid="heading-levels"
				>
					{HEADING_LEVELS.map(renderLevel)}
				</div>
				<div className="flex justify-end mt-4">
					<button
						type="button"
						onClick={() => resetHeadingTypography()}
						disabled={!customized}
						data-testid="heading-typography-reset"
						title={customized ? undefined : 'Every heading is already on its default style.'}
						className="flex items-center gap-2 px-3 py-2 rounded border text-xs font-bold transition-colors hover:bg-white/5 disabled:cursor-not-allowed disabled:hover:bg-transparent"
						style={{
							borderColor: theme.colors.border,
							color: theme.colors.textMain,
							opacity: customized ? 1 : 0.45,
						}}
					>
						<Undo2 className="w-3.5 h-3.5" />
						Restore Default Headings
					</button>
				</div>
			</SectionCard>
		</div>
	);
}
