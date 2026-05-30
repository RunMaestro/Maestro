/**
 * MaestroFlags - Texas + American flag pair marking Maestro's origin.
 *
 * Shared between the About modal and the Settings → About tab so the
 * flag SVGs live in exactly one place. The Texas flag links to the
 * saloon where Maestro was born.
 */

import { openInSystemBrowser } from '../../utils/openUrl';

export interface MaestroFlagsProps {
	/** Flag width in pixels. Height is derived at the 3:2 flag ratio. */
	width?: number;
	/** Opacity applied to both flags. */
	opacity?: number;
}

export function MaestroFlags({ width = 40, opacity = 0.7 }: MaestroFlagsProps) {
	const height = (width * 2) / 3;
	const sizeStyle = { width, height, opacity };

	return (
		<div className="flex items-center gap-4">
			{/* Texas Flag - Lone Star Flag */}
			<button
				onClick={() => openInSystemBrowser('https://www.sanjacsaloon.com')}
				className="hover:opacity-100 transition-opacity cursor-pointer"
				style={{ background: 'none', border: 'none', padding: 0 }}
				title="San Jac Saloon"
				aria-label="San Jac Saloon"
			>
				<svg viewBox="0 0 150 100" style={sizeStyle}>
					<rect x="0" y="0" width="50" height="100" fill="#002868" />
					<rect x="50" y="0" width="100" height="50" fill="#FFFFFF" />
					<rect x="50" y="50" width="100" height="50" fill="#BF0A30" />
					<polygon
						points="25,15 29.5,30 45,30 32.5,40 37,55 25,45 13,55 17.5,40 5,30 20.5,30"
						fill="#FFFFFF"
					/>
				</svg>
			</button>
			{/* American Flag */}
			<svg viewBox="0 0 150 100" style={sizeStyle}>
				{/* Red and white stripes */}
				<rect x="0" y="0" width="150" height="100" fill="#BF0A30" />
				<rect x="0" y="7.69" width="150" height="7.69" fill="#FFFFFF" />
				<rect x="0" y="23.08" width="150" height="7.69" fill="#FFFFFF" />
				<rect x="0" y="38.46" width="150" height="7.69" fill="#FFFFFF" />
				<rect x="0" y="53.85" width="150" height="7.69" fill="#FFFFFF" />
				<rect x="0" y="69.23" width="150" height="7.69" fill="#FFFFFF" />
				<rect x="0" y="84.62" width="150" height="7.69" fill="#FFFFFF" />
				{/* Blue canton */}
				<rect x="0" y="0" width="60" height="53.85" fill="#002868" />
				{/* Stars - simplified 5 rows */}
				<circle cx="6" cy="5" r="2" fill="#FFFFFF" />
				<circle cx="18" cy="5" r="2" fill="#FFFFFF" />
				<circle cx="30" cy="5" r="2" fill="#FFFFFF" />
				<circle cx="42" cy="5" r="2" fill="#FFFFFF" />
				<circle cx="54" cy="5" r="2" fill="#FFFFFF" />
				<circle cx="12" cy="13" r="2" fill="#FFFFFF" />
				<circle cx="24" cy="13" r="2" fill="#FFFFFF" />
				<circle cx="36" cy="13" r="2" fill="#FFFFFF" />
				<circle cx="48" cy="13" r="2" fill="#FFFFFF" />
				<circle cx="6" cy="21" r="2" fill="#FFFFFF" />
				<circle cx="18" cy="21" r="2" fill="#FFFFFF" />
				<circle cx="30" cy="21" r="2" fill="#FFFFFF" />
				<circle cx="42" cy="21" r="2" fill="#FFFFFF" />
				<circle cx="54" cy="21" r="2" fill="#FFFFFF" />
				<circle cx="12" cy="29" r="2" fill="#FFFFFF" />
				<circle cx="24" cy="29" r="2" fill="#FFFFFF" />
				<circle cx="36" cy="29" r="2" fill="#FFFFFF" />
				<circle cx="48" cy="29" r="2" fill="#FFFFFF" />
				<circle cx="6" cy="37" r="2" fill="#FFFFFF" />
				<circle cx="18" cy="37" r="2" fill="#FFFFFF" />
				<circle cx="30" cy="37" r="2" fill="#FFFFFF" />
				<circle cx="42" cy="37" r="2" fill="#FFFFFF" />
				<circle cx="54" cy="37" r="2" fill="#FFFFFF" />
				<circle cx="12" cy="45" r="2" fill="#FFFFFF" />
				<circle cx="24" cy="45" r="2" fill="#FFFFFF" />
				<circle cx="36" cy="45" r="2" fill="#FFFFFF" />
				<circle cx="48" cy="45" r="2" fill="#FFFFFF" />
			</svg>
		</div>
	);
}
