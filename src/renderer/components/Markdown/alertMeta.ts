/**
 * Shared presentation metadata for GitHub-style alert callouts.
 *
 * Two rendering paths need the same label, accent, and icon for each alert
 * type: `<AlertCallout>` (React, used by the chat and document component maps)
 * and the File Preview Fast tier, which emits HTML strings from a markdown-it
 * token stream and has no React to render into. Keeping the metadata here means
 * a new type - or a changed icon - lands on both at once.
 *
 * Icon path data is from lucide (ISC licensed): info, lightbulb,
 * message-square-warning, triangle-alert, octagon-alert.
 *
 * `note` and `important` share the `accent` color (the theme palette has no
 * distinct sixth hue); their icon and label keep them distinguishable.
 */

import type { Theme } from '../../types';
import type { AlertType } from './remarkAlert';

/** lucide icon primitives as [tag, attrs] tuples, drawn on a 24x24 viewBox. */
export type IconNode = Array<[string, Record<string, string | number>]>;

export const ALERT_ICON_NODES: Record<AlertType, IconNode> = {
	note: [
		['circle', { cx: 12, cy: 12, r: 10 }],
		['path', { d: 'M12 16v-4' }],
		['path', { d: 'M12 8h.01' }],
	],
	tip: [
		[
			'path',
			{
				d: 'M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5',
			},
		],
		['path', { d: 'M9 18h6' }],
		['path', { d: 'M10 22h4' }],
	],
	important: [
		['path', { d: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z' }],
		['path', { d: 'M12 7v2' }],
		['path', { d: 'M12 13h.01' }],
	],
	warning: [
		['path', { d: 'm21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z' }],
		['path', { d: 'M12 9v4' }],
		['path', { d: 'M12 17h.01' }],
	],
	caution: [
		[
			'polygon',
			{ points: '7.86 2 16.14 2 22 7.86 22 16.14 16.14 22 7.86 22 2 16.14 2 7.86 7.86 2' },
		],
		['line', { x1: 12, x2: 12, y1: 8, y2: 12 }],
		['line', { x1: 12, x2: 12.01, y1: 16, y2: 16 }],
	],
};

/** Header text shown above the callout body. */
export const ALERT_LABELS: Record<AlertType, string> = {
	note: 'Note',
	tip: 'Tip',
	important: 'Important',
	warning: 'Warning',
	caution: 'Caution',
};

/** Theme palette key each type draws its accent from. */
const ALERT_COLOR_KEYS: Record<AlertType, 'accent' | 'success' | 'warning' | 'error'> = {
	note: 'accent',
	tip: 'success',
	important: 'accent',
	warning: 'warning',
	caution: 'error',
};

/** Accent color for a type under the active theme. */
export function alertAccent(type: AlertType, theme: Theme): string {
	return theme.colors[ALERT_COLOR_KEYS[type]];
}

/**
 * 8% alpha tint of the accent, used as the callout background. `${color}14` is
 * the hex-alpha idiom used elsewhere in the app.
 */
export function alertTint(type: AlertType, theme: Theme): string {
	return `${alertAccent(type, theme)}14`;
}

/**
 * The alert icon as an SVG markup string, for surfaces that build HTML rather
 * than React elements (the Fast tier). Strokes with `currentColor` so the
 * caller's stylesheet owns the accent.
 */
export function alertIconMarkup(type: AlertType, size = 15): string {
	const children = ALERT_ICON_NODES[type]
		.map(([tag, attrs]) => {
			const serialized = Object.entries(attrs)
				.map(([key, value]) => `${key}="${value}"`)
				.join(' ');
			return `<${tag} ${serialized}/>`;
		})
		.join('');
	return (
		`<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
		`stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${children}</svg>`
	);
}
