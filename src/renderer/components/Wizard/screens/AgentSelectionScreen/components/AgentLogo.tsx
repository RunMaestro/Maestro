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
			// Official GitHub Copilot mark (Primer octicon `copilot-24`).
			return (
				<svg
					className="w-12 h-12"
					viewBox="0 0 24 24"
					fill="none"
					xmlns="http://www.w3.org/2000/svg"
					style={{ opacity }}
				>
					<path
						d="M23.922 16.992c-.861 1.495-5.859 5.023-11.922 5.023-6.063 0-11.061-3.528-11.922-5.023A.641.641 0 0 1 0 16.736v-2.869a.841.841 0 0 1 .053-.22c.372-.935 1.347-2.292 2.605-2.656.167-.429.414-1.055.644-1.517a10.195 10.195 0 0 1-.052-1.086c0-1.331.282-2.499 1.132-3.368.397-.406.89-.717 1.474-.952 1.399-1.136 3.392-2.093 6.122-2.093 2.731 0 4.767.957 6.166 2.093.584.235 1.077.546 1.474.952.85.869 1.132 2.037 1.132 3.368 0 .368-.014.733-.052 1.086.23.462.477 1.088.644 1.517 1.258.364 2.233 1.721 2.605 2.656a.832.832 0 0 1 .053.22v2.869a.641.641 0 0 1-.078.256ZM12.172 11h-.344a4.323 4.323 0 0 1-.355.508C10.703 12.455 9.555 13 7.965 13c-1.725 0-2.989-.359-3.782-1.259a2.005 2.005 0 0 1-.085-.104L4 11.741v6.585c1.435.779 4.514 2.179 8 2.179 3.486 0 6.565-1.4 8-2.179v-6.585l-.098-.104s-.033.045-.085.104c-.793.9-2.057 1.259-3.782 1.259-1.59 0-2.738-.545-3.508-1.492a4.323 4.323 0 0 1-.355-.508h-.016.016Zm.641-2.935c.136 1.057.403 1.913.878 2.497.442.544 1.134.938 2.344.938 1.573 0 2.292-.337 2.657-.751.384-.435.558-1.15.558-2.361 0-1.14-.243-1.847-.705-2.319-.477-.488-1.319-.862-2.824-1.025-1.487-.161-2.192.138-2.533.529-.269.307-.437.808-.438 1.578v.021c0 .265.021.562.063.893Zm-1.626 0c.042-.331.063-.628.063-.894v-.02c-.001-.77-.169-1.271-.438-1.578-.341-.391-1.046-.69-2.533-.529-1.505.163-2.347.537-2.824 1.025-.462.472-.705 1.179-.705 2.319 0 1.211.175 1.926.558 2.361.365.414 1.084.751 2.657.751 1.21 0 1.902-.394 2.344-.938.475-.584.742-1.44.878-2.497Z"
						fill={color}
					/>
				</svg>
			);

		case 'hermes':
			// Caduceus (Hermes' winged staff): the site's brand is a classical
			// serif wordmark + engraving with no geometric mark, so this is a
			// clean line-art rendering of Hermes' iconography.
			return (
				<svg
					className="w-12 h-12"
					viewBox="0 0 48 48"
					fill="none"
					xmlns="http://www.w3.org/2000/svg"
					style={{ opacity }}
				>
					<circle cx="24" cy="8" r="2.5" fill={color} />
					<path d="M24 11v30" stroke={color} strokeWidth="2" strokeLinecap="round" />
					<path
						d="M23 15c-4-3-9-3-15-1 5 1 9 2 14 4"
						stroke={color}
						strokeWidth="2"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
					<path
						d="M25 15c4-3 9-3 15-1-5 1-9 2-14 4"
						stroke={color}
						strokeWidth="2"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
					<path
						d="M24 18C15 22 15 27 24 30C33 33 33 38 24 41"
						stroke={color}
						strokeWidth="2"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
					<path
						d="M24 18C33 22 33 27 24 30C15 33 15 38 24 41"
						stroke={color}
						strokeWidth="2"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</svg>
			);

		case 'pi':
			// Official pi.dev mark (their favicon glyph, viewBox 0 0 800 800).
			return (
				<svg
					className="w-12 h-12"
					viewBox="0 0 800 800"
					fill="none"
					xmlns="http://www.w3.org/2000/svg"
					style={{ opacity }}
				>
					<path
						fillRule="evenodd"
						clipRule="evenodd"
						d="M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29ZM282.65 282.65V400H400V282.65Z"
						fill={color}
					/>
					<path d="M517.36 400H634.72V634.72H517.36Z" fill={color} />
				</svg>
			);

		default:
			return (
				<div className="w-12 h-12 rounded-full border-2" style={{ borderColor: color, opacity }} />
			);
	}
}
