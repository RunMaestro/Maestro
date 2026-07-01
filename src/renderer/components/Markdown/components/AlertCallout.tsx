/**
 * AlertCallout - renders a GitHub-style alert callout (Note / Tip / Important /
 * Warning / Caution) with a theme-aware accent, tint, and icon.
 *
 * Presentational only: `remarkAlert` detects the `[!TYPE]` marker and tags the
 * blockquote with a `markdown-alert-<type>` class; the chat + document blockquote
 * renderers extract the type (via `alertTypeFromClassName`) and delegate here,
 * passing the already-transformed body children.
 *
 * Icons are rendered as inline SVG rather than importing from `lucide-react`.
 * This component is pulled in by `markdownConfig` (the document component map),
 * which is imported across a large swath of the app; adding a new lucide import
 * there would force every test that stubs `lucide-react` with a partial mock to
 * list these icons. Inlining the paths keeps the module dependency-free. Icon
 * path data is from lucide (ISC licensed): info, lightbulb, message-square-warning,
 * triangle-alert, octagon-alert.
 *
 * Colors reuse the theme palette so callouts match whichever Maestro theme is
 * active. `note` and `important` share the `accent` color (the palette has no
 * distinct sixth hue); their icon and label keep them distinguishable.
 */

import React from 'react';
import type { Theme } from '../../../types';
import type { AlertType } from '../remarkAlert';

/** lucide icon primitives as [tag, attrs] tuples, drawn on a 24x24 viewBox. */
type IconNode = Array<[string, Record<string, string | number>]>;

const ICON_NODES: Record<AlertType, IconNode> = {
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

const ALERT_META: Record<AlertType, { label: string; color: (theme: Theme) => string }> = {
	note: { label: 'Note', color: (t) => t.colors.accent },
	tip: { label: 'Tip', color: (t) => t.colors.success },
	important: { label: 'Important', color: (t) => t.colors.accent },
	warning: { label: 'Warning', color: (t) => t.colors.warning },
	caution: { label: 'Caution', color: (t) => t.colors.error },
};

function AlertIcon({ type, color }: { type: AlertType; color: string }) {
	return (
		<svg
			width={15}
			height={15}
			viewBox="0 0 24 24"
			fill="none"
			stroke={color}
			strokeWidth={2}
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden={true}
			style={{ flexShrink: 0 }}
		>
			{ICON_NODES[type].map(([tag, attrs], i) => React.createElement(tag, { key: i, ...attrs }))}
		</svg>
	);
}

export interface AlertCalloutProps {
	type: AlertType;
	theme: Theme;
	children: React.ReactNode;
}

export function AlertCallout({ type, theme, children }: AlertCalloutProps) {
	const meta = ALERT_META[type];
	const accent = meta.color(theme);

	return (
		<div
			className="markdown-alert"
			data-alert-type={type}
			style={{
				borderLeft: `4px solid ${accent}`,
				// 8% alpha tint of the accent; `${color}14` is the hex-alpha idiom
				// used elsewhere in the app (e.g. TerminalOutput error backgrounds).
				background: `${accent}14`,
				borderRadius: '6px',
				padding: '8px 12px',
				margin: '0.5em 0',
			}}
		>
			<div
				style={{
					display: 'flex',
					alignItems: 'center',
					gap: '6px',
					color: accent,
					fontWeight: 600,
					fontSize: '0.85em',
					marginBottom: '4px',
				}}
			>
				<AlertIcon type={type} color={accent} />
				<span>{meta.label}</span>
			</div>
			<div style={{ color: theme.colors.textMain }}>{children}</div>
		</div>
	);
}
