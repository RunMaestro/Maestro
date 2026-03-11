/**
 * <DirIcon> — RTL-aware Lucide icon wrapper.
 *
 * Wraps a Lucide icon component and automatically adds the `rtl-flip`
 * CSS class when:
 *   1. The current document direction is RTL, AND
 *   2. The icon is in the directional flip list (see rtlIcons.ts).
 *
 * Usage:
 *   import { ChevronRight } from 'lucide-react';
 *   import { DirIcon } from './shared/DirIcon';
 *
 *   <DirIcon icon={ChevronRight} className="w-4 h-4" />
 *
 * This is opt-in — existing direct icon usage continues to work
 * unchanged.  Only wrap icons that need directional awareness.
 */

import React from 'react';
import type { LucideIcon, LucideProps } from 'lucide-react';
import { shouldFlipIcon } from '../../utils/rtlIcons';
import { useSettingsStore } from '../../stores/settingsStore';
import { isRtlLanguage } from './DirectionProvider';

export interface DirIconProps extends LucideProps {
	/** The Lucide icon component to render. */
	icon: LucideIcon;
}

/**
 * Renders a Lucide icon with automatic RTL horizontal flipping.
 *
 * If the icon's display name is in the flip list and the current
 * language is RTL, the `rtl-flip` CSS class is appended so the
 * global `[dir="rtl"] .rtl-flip { transform: scaleX(-1) }` rule
 * takes effect.
 */
export function DirIcon({ icon: Icon, className, ...rest }: DirIconProps): React.ReactElement {
	const language = useSettingsStore((s) => s.language);
	const isRtl = isRtlLanguage(language);

	const iconName = Icon.displayName || '';
	const needsFlip = isRtl && shouldFlipIcon(iconName);

	const combinedClassName = needsFlip
		? className
			? `${className} rtl-flip`
			: 'rtl-flip'
		: className || undefined;

	return <Icon className={combinedClassName} {...rest} />;
}
