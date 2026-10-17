/**
 * The "holding the voice floor" glyph: a filled microphone in the theme accent.
 *
 * One mark for every place the floor can sit, so the user learns one symbol for
 * "what you say next goes here" whether that is an agent in the Left Bar, a tab
 * in the tab bar, or the Conductor beside the wordmark. Each caller decides
 * WHETHER it holds the floor; this only draws it.
 */

import { memo } from 'react';
import { Mic } from 'lucide-react';
import type { Theme } from '../../types';
import { readableTextOn } from '../../../shared/colorContrast';

export interface VoiceFloorMarkProps {
	theme: Theme;
	/** Says what holds the floor, for the tooltip and the screen reader. */
	label: string;
	testId: string;
}

export const VoiceFloorMark = memo(function VoiceFloorMark({
	theme,
	label,
	testId,
}: VoiceFloorMarkProps) {
	// The accent is the theme's own colour and so are the surfaces this sits on,
	// so a theme whose accent sits near its sidebar or main background would
	// otherwise paint the glyph invisibly.
	const accent = readableTextOn(theme.colors.accent, [theme.colors.bgSidebar, theme.colors.bgMain]);

	return (
		<span
			data-testid={testId}
			className="shrink-0 flex items-center"
			title={label}
			aria-label={label}
		>
			<Mic className="w-3 h-3" style={{ color: accent }} fill={accent} />
		</span>
	);
});
