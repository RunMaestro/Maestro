import type { CSSProperties } from 'react';

export function TexasFlag({
	className,
	style,
}: {
	className?: string;
	style?: CSSProperties;
}): JSX.Element {
	return (
		<svg viewBox="0 0 150 100" className={className} style={style}>
			<rect x="0" y="0" width="50" height="100" fill="#002868" />
			<rect x="50" y="0" width="100" height="50" fill="#FFFFFF" />
			<rect x="50" y="50" width="100" height="50" fill="#BF0A30" />
			<polygon
				points="25,15 29.5,30 45,30 32.5,40 37,55 25,45 13,55 17.5,40 5,30 20.5,30"
				fill="#FFFFFF"
			/>
		</svg>
	);
}
