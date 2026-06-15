import type { Theme } from '../../../../../types';

export function AgentLogo({
	agentId,
	supported,
	detected,
	brandColor,
	theme,
}: {
	agentId: string;
	supported: boolean;
	detected: boolean;
	brandColor?: string;
	theme: Theme;
}): JSX.Element {
	const color = supported && detected ? brandColor || theme.colors.accent : theme.colors.textDim;
	const opacity = supported ? 1 : 0.35;

	switch (agentId) {
		case 'claude-code':
			return (
				<svg
					className="w-12 h-12"
					viewBox="0 0 48 48"
					fill="none"
					xmlns="http://www.w3.org/2000/svg"
					style={{ opacity }}
				>
					<path
						d="M28.5 8L17 40h5.5l2.3-7h10.4l2.3 7H43L31.5 8h-3zm1.5 6.5L34.2 28h-8.4l4.2-13.5z"
						fill={color}
					/>
					<path d="M5 40l8-20h5l-8 20H5z" fill={color} />
				</svg>
			);

		case 'codex':
			return (
				<svg
					className="w-12 h-12"
					viewBox="0 0 48 48"
					fill="none"
					xmlns="http://www.w3.org/2000/svg"
					style={{ opacity }}
				>
					<path d="M24 6L40 15v18l-16 9-16-9V15l16-9z" stroke={color} strokeWidth="2" fill="none" />
					<path d="M24 6v36M40 15L8 33M8 15l32 18" stroke={color} strokeWidth="2" />
				</svg>
			);

		case 'opencode':
			return (
				<svg
					className="w-12 h-12"
					viewBox="0 0 48 48"
					fill="none"
					xmlns="http://www.w3.org/2000/svg"
					style={{ opacity }}
				>
					<rect
						x="4"
						y="8"
						width="40"
						height="32"
						rx="4"
						stroke={color}
						strokeWidth="2"
						fill="none"
					/>
					<path
						d="M12 20l6 4-6 4M22 28h10"
						stroke={color}
						strokeWidth="2"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</svg>
			);

		case 'factory-droid':
			return (
				<svg
					className="w-12 h-12"
					viewBox="0 0 48 48"
					fill="none"
					xmlns="http://www.w3.org/2000/svg"
					style={{ opacity }}
				>
					<circle cx="24" cy="24" r="3" fill={color} />
					<ellipse cx="24" cy="12" rx="4" ry="8" fill={color} fillOpacity="0.9" />
					<ellipse
						cx="34.4"
						cy="18"
						rx="4"
						ry="8"
						fill={color}
						fillOpacity="0.9"
						transform="rotate(60 34.4 18)"
					/>
					<ellipse
						cx="34.4"
						cy="30"
						rx="4"
						ry="8"
						fill={color}
						fillOpacity="0.9"
						transform="rotate(120 34.4 30)"
					/>
					<ellipse cx="24" cy="36" rx="4" ry="8" fill={color} fillOpacity="0.9" />
					<ellipse
						cx="13.6"
						cy="30"
						rx="4"
						ry="8"
						fill={color}
						fillOpacity="0.9"
						transform="rotate(60 13.6 30)"
					/>
					<ellipse
						cx="13.6"
						cy="18"
						rx="4"
						ry="8"
						fill={color}
						fillOpacity="0.9"
						transform="rotate(120 13.6 18)"
					/>
				</svg>
			);

		case 'copilot-cli':
			return (
				<svg
					className="w-12 h-12"
					viewBox="0 0 48 48"
					fill="none"
					xmlns="http://www.w3.org/2000/svg"
					style={{ opacity }}
				>
					<path
						d="M24 9c-7.2 0-13 5.4-13 12 0 4.5 2.3 8 6.4 10.3V37l6.6-3.4L30.6 37v-5.7C34.7 29 37 25.5 37 21c0-6.6-5.8-12-13-12Z"
						stroke={color}
						strokeWidth="2"
						fill="none"
					/>
					<circle cx="19" cy="21" r="2.5" fill={color} />
					<circle cx="29" cy="21" r="2.5" fill={color} />
					<path d="M18 27.5h12" stroke={color} strokeWidth="2" strokeLinecap="round" />
				</svg>
			);

		default:
			return (
				<div className="w-12 h-12 rounded-full border-2" style={{ borderColor: color, opacity }} />
			);
	}
}
