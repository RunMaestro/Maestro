/**
 * AlertCallout - renders a GitHub-style alert callout (Note / Tip / Important /
 * Warning / Caution) with a theme-aware accent, tint, and icon.
 *
 * Presentational only: `remarkAlert` detects the `[!TYPE]` marker and tags the
 * blockquote with a `markdown-alert-<type>` class; the chat + document blockquote
 * renderers extract the type (via `alertTypeFromClassName`) and delegate here,
 * passing the already-transformed body children.
 *
 * Labels, accents, and icon geometry live in `../alertMeta` because the File
 * Preview Fast tier renders the same callouts as HTML strings and must not
 * drift from this component.
 *
 * Icons are rendered as inline SVG rather than importing from `lucide-react`.
 * This component is pulled in by `markdownConfig` (the document component map),
 * which is imported across a large swath of the app; adding a new lucide import
 * there would force every test that stubs `lucide-react` with a partial mock to
 * list these icons.
 */

import React from 'react';
import type { Theme } from '../../../types';
import type { AlertType } from '../remarkAlert';
import { ALERT_ICON_NODES, ALERT_LABELS, alertAccent, alertTint } from '../alertMeta';

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
			{ALERT_ICON_NODES[type].map(([tag, attrs], i) =>
				React.createElement(tag, { key: i, ...attrs })
			)}
		</svg>
	);
}

export interface AlertCalloutProps {
	type: AlertType;
	theme: Theme;
	children: React.ReactNode;
}

export function AlertCallout({ type, theme, children }: AlertCalloutProps) {
	const accent = alertAccent(type, theme);

	return (
		<div
			className="markdown-alert"
			data-alert-type={type}
			style={{
				borderLeft: `4px solid ${accent}`,
				background: alertTint(type, theme),
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
				<span>{ALERT_LABELS[type]}</span>
			</div>
			<div style={{ color: theme.colors.textMain }}>{children}</div>
		</div>
	);
}
