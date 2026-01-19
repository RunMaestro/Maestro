import React from 'react';

// Import the conductor silhouette images
import conductorLight from '../assets/conductor-light.png';
import conductorDark from '../assets/conductor-dark.png';

interface MaestroSilhouetteProps {
	className?: string;
	style?: React.CSSProperties;
	variant?: 'dark' | 'light'; // dark = black silhouette, light = white silhouette
	size?: number;
}

/**
 * Maestro conductor silhouette component
 * Uses PNG assets for the authentic conductor graphic
 * - dark variant: black silhouette (for light backgrounds)
 * - light variant: white silhouette (for dark backgrounds)
 */
export function MaestroSilhouette({
	className = '',
	style = {},
	variant = 'dark',
	size = 200,
}: MaestroSilhouetteProps) {
	const imageSrc = variant === 'dark' ? conductorDark : conductorLight;

	return (
		<img
			src={imageSrc}
			alt="Maestro conductor silhouette"
			className={className}
			style={{
				width: size,
				height: size,
				objectFit: 'contain',
				...style,
			}}
		/>
	);
}

/**
 * Animated maestro for the Standing Ovation overlay
 * Includes a subtle conducting motion animation via CSS
 */
export function AnimatedMaestro({
	className = '',
	style = {},
	variant = 'dark',
	size = 200,
}: MaestroSilhouetteProps) {
	const imageSrc = variant === 'dark' ? conductorDark : conductorLight;

	return (
		<img
			src={imageSrc}
			alt="Animated maestro conductor"
			className={className}
			style={{
				width: size,
				height: size,
				objectFit: 'contain',
				animation: 'conductingMotion 2s ease-in-out infinite',
				...style,
			}}
		/>
	);
}

// Add the CSS animation to the document if not already present
if (typeof document !== 'undefined') {
	const styleId = 'maestro-animation-styles';
	if (!document.getElementById(styleId)) {
		const styleSheet = document.createElement('style');
		styleSheet.id = styleId;
		styleSheet.textContent = `
      @keyframes conductingMotion {
        0%, 100% { transform: rotate(0deg); }
        25% { transform: rotate(-3deg); }
        75% { transform: rotate(3deg); }
      }
    `;
		document.head.appendChild(styleSheet);
	}
}

export default MaestroSilhouette;
