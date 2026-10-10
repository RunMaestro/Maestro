import type { ReactNode } from 'react';
import frameSrc from '../../assets/did-you-know-frame.png';
import { APERTURE_INSET, FRAME_ASPECT } from './frameGeometry';

interface OrnateFrameProps {
	children: ReactNode;
	className?: string;
}

export function OrnateFrame({ children, className = '' }: OrnateFrameProps) {
	return (
		<div
			className={`relative ${className}`}
			style={{
				aspectRatio: FRAME_ASPECT,
				filter: 'drop-shadow(0 8px 18px rgba(120, 76, 24, 0.3))',
			}}
		>
			<div
				className="absolute overflow-hidden rounded-[2px]"
				style={{
					left: `${APERTURE_INSET.left}%`,
					top: `${APERTURE_INSET.top}%`,
					right: `${APERTURE_INSET.right}%`,
					bottom: `${APERTURE_INSET.bottom}%`,
				}}
			>
				{children}
			</div>
			<img
				src={frameSrc}
				className="absolute inset-0 w-full h-full pointer-events-none select-none"
				draggable={false}
				alt=""
				aria-hidden
			/>
		</div>
	);
}
