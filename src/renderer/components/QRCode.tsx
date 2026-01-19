/**
 * QR Code Component
 *
 * Generates a QR code for a given URL using the qrcode library.
 * No cloud services - all generation happens locally.
 */

import React, { useState, useEffect } from 'react';
import QRCodeLib from 'qrcode';

interface QRCodeProps {
	/** The URL or text to encode in the QR code */
	value: string;
	/** Size in pixels (default: 128) */
	size?: number;
	/** Background color (default: transparent) */
	bgColor?: string;
	/** Foreground color (default: white) */
	fgColor?: string;
	/** Alt text for accessibility */
	alt?: string;
	/** Additional CSS classes */
	className?: string;
}

export function QRCode({
	value,
	size = 128,
	bgColor = 'transparent',
	fgColor = '#FFFFFF',
	alt = 'QR Code',
	className = '',
}: QRCodeProps) {
	const [dataUrl, setDataUrl] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!value) {
			setDataUrl(null);
			return;
		}

		// Generate QR code as data URL
		QRCodeLib.toDataURL(value, {
			width: size,
			margin: 1,
			color: {
				dark: fgColor,
				light: bgColor,
			},
			errorCorrectionLevel: 'M',
		})
			.then((url) => {
				setDataUrl(url);
				setError(null);
			})
			.catch((err) => {
				console.error('Failed to generate QR code:', err);
				setError('Failed to generate QR code');
				setDataUrl(null);
			});
	}, [value, size, bgColor, fgColor]);

	if (error) {
		return (
			<div
				className={`flex items-center justify-center ${className}`}
				style={{ width: size, height: size }}
			>
				<span className="text-xs text-red-500">{error}</span>
			</div>
		);
	}

	if (!dataUrl) {
		return (
			<div
				className={`flex items-center justify-center ${className}`}
				style={{ width: size, height: size }}
			>
				<div
					className="animate-pulse rounded"
					style={{ width: size, height: size, backgroundColor: 'rgba(255,255,255,0.1)' }}
				/>
			</div>
		);
	}

	return (
		<img
			src={dataUrl}
			alt={alt}
			width={size}
			height={size}
			className={className}
			style={{ imageRendering: 'pixelated' }}
		/>
	);
}
