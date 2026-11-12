import type { CSSProperties, JSX } from 'react';

export interface SafeSvgIconProps {
	path: string;
	viewBox?: string;
	className?: string;
	style?: CSSProperties;
	'data-testid'?: string;
}

/**
 * Renders a plugin-contributed SVG path inside host-owned SVG markup.
 *
 * Plugins contribute only validated `path` data; they never provide SVG elements,
 * attributes, markup, or presentation values. The host owns fill and stroke.
 */
export function SafeSvgIcon({
	path,
	viewBox = '0 0 24 24',
	...svgProps
}: SafeSvgIconProps): JSX.Element {
	return (
		<svg
			className={svgProps.className}
			style={svgProps.style}
			data-testid={svgProps['data-testid']}
			viewBox={viewBox}
			fill="none"
			stroke="currentColor"
			aria-hidden="true"
		>
			<path d={path} />
		</svg>
	);
}
