import React, { useEffect, useRef, useState, useCallback } from 'react';
import { ExternalLink, Trophy, Clock, Star, Share2, Copy, Download, Check } from 'lucide-react';
import confetti from 'canvas-confetti';
import type { Theme, ThemeMode } from '../types';
import type { ConductorBadge } from '../constants/conductorBadges';
import { useLayerStack } from '../contexts/LayerStackContext';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { AnimatedMaestro } from './MaestroSilhouette';
import {
	formatCumulativeTime,
	formatTimeRemaining,
	getNextBadge,
} from '../constants/conductorBadges';

interface StandingOvationOverlayProps {
	theme: Theme;
	themeMode: ThemeMode;
	badge: ConductorBadge;
	isNewRecord?: boolean;
	recordTimeMs?: number;
	cumulativeTimeMs: number;
	onClose: () => void;
	onOpenLeaderboardRegistration?: () => void;
	isLeaderboardRegistered?: boolean;
	/** Whether confetti animations are disabled by user preference */
	disableConfetti?: boolean;
}

/**
 * Full-screen celebration overlay for badge unlocks and new records
 * Features animated maestro, confetti-like effects, and badge information
 */
export function StandingOvationOverlay({
	theme,
	themeMode,
	badge,
	isNewRecord = false,
	recordTimeMs,
	cumulativeTimeMs,
	onClose,
	onOpenLeaderboardRegistration,
	isLeaderboardRegistered,
	disableConfetti = false,
}: StandingOvationOverlayProps) {
	const { registerLayer, unregisterLayer, updateLayerHandler } = useLayerStack();
	const layerIdRef = useRef<string>();
	const containerRef = useRef<HTMLDivElement>(null);
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;

	// Ref for the close handler that includes confetti animation
	const handleCloseRef = useRef<() => void>(() => {});

	// State
	const nextBadge = getNextBadge(badge);
	const isDark = themeMode === 'dark';
	const maestroVariant = isDark ? 'light' : 'dark';
	const [shareMenuOpen, setShareMenuOpen] = useState(false);
	const [copySuccess, setCopySuccess] = useState(false);
	const [isClosing, setIsClosing] = useState(false);

	// Accent colors
	const goldColor = '#FFD700';
	const purpleAccent = theme.colors.accent;

	// Confetti colors from playground
	const confettiColors = React.useMemo(
		() => [
			'#FFD700', // Gold
			'#FF6B6B', // Red
			'#4ECDC4', // Teal
			'#45B7D1', // Blue
			'#FFA726', // Orange
			'#BA68C8', // Purple
			'#F48FB1', // Pink
			'#FFEAA7', // Yellow
		],
		[]
	);

	// Z-index layering: backdrop (99997) < confetti (99998) < modal (99999)
	const CONFETTI_Z_INDEX = 99998;

	// Fire confetti from multiple origins with playground settings
	const fireConfetti = useCallback(() => {
		// Skip if disabled by user preference
		if (disableConfetti) return;

		const defaults = {
			particleCount: 500,
			angle: 90,
			spread: 91,
			startVelocity: 74,
			gravity: 0.8,
			decay: 0.9,
			drift: 1.5,
			scalar: 1.2,
			ticks: 355,
			flat: false,
			shapes: ['circle', 'star', 'square'] as ('circle' | 'star' | 'square')[],
			colors: confettiColors,
			zIndex: CONFETTI_Z_INDEX,
			disableForReducedMotion: true,
		};

		// Center burst
		confetti({
			...defaults,
			origin: { x: 0.5, y: 1 },
		});

		// Left burst
		confetti({
			...defaults,
			origin: { x: 0, y: 1 },
		});

		// Right burst
		confetti({
			...defaults,
			origin: { x: 1, y: 1 },
		});
	}, [confettiColors, disableConfetti]);

	// Fire confetti on mount only - empty deps to run once
	useEffect(() => {
		fireConfetti();
	}, []);

	// Handle graceful close with confetti
	const handleTakeABow = useCallback(() => {
		if (isClosing) return;
		setIsClosing(true);

		// Fire closing confetti burst
		fireConfetti();

		// Wait for confetti animation then close
		setTimeout(() => {
			onClose();
		}, 1500);
	}, [isClosing, onClose, fireConfetti]);

	// Register with layer stack
	useEffect(() => {
		const id = registerLayer({
			type: 'modal',
			priority: MODAL_PRIORITIES.STANDING_OVATION,
			blocksLowerLayers: true,
			capturesFocus: true,
			focusTrap: 'strict',
			ariaLabel: 'Standing Ovation Achievement',
			onEscape: () => handleCloseRef.current(),
		});
		layerIdRef.current = id;

		containerRef.current?.focus();

		return () => {
			if (layerIdRef.current) {
				unregisterLayer(layerIdRef.current);
			}
		};
	}, [registerLayer, unregisterLayer]);

	// Update close handler ref when handleTakeABow changes
	useEffect(() => {
		handleCloseRef.current = handleTakeABow;
	}, [handleTakeABow]);

	useEffect(() => {
		if (layerIdRef.current) {
			updateLayerHandler(layerIdRef.current, () => handleCloseRef.current());
		}
	}, [updateLayerHandler]);

	// Generate shareable achievement card as canvas using theme colors
	const generateShareImage = useCallback(async (): Promise<HTMLCanvasElement> => {
		const canvas = document.createElement('canvas');
		const ctx = canvas.getContext('2d')!;

		// Card dimensions
		const width = 600;
		const height = 400;
		canvas.width = width;
		canvas.height = height;

		// Helper to ensure solid color (strip alpha if present, default to fallback)
		const ensureSolidColor = (color: string, fallback: string): string => {
			if (!color || color === 'transparent') return fallback;
			// Handle rgba - extract rgb and ignore alpha
			if (color.startsWith('rgba')) {
				const match = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
				if (match) {
					return `rgb(${match[1]}, ${match[2]}, ${match[3]})`;
				}
			}
			return color;
		};

		// Theme-aware colors
		const bgColor = ensureSolidColor(theme.colors.bgSidebar, '#1a1a2e');
		const bgSecondary = ensureSolidColor(theme.colors.bgActivity, '#16213e');
		const textMain = ensureSolidColor(theme.colors.textMain, '#FFFFFF');
		const textDim = ensureSolidColor(theme.colors.textDim, '#AAAAAA');
		const borderColor = ensureSolidColor(theme.colors.border, '#333333');

		// Background gradient using theme colors
		const bgGradient = ctx.createLinearGradient(0, 0, width, height);
		bgGradient.addColorStop(0, bgColor);
		bgGradient.addColorStop(1, bgSecondary);
		ctx.fillStyle = bgGradient;
		ctx.roundRect(0, 0, width, height, 16);
		ctx.fill();

		// Border
		ctx.strokeStyle = goldColor;
		ctx.lineWidth = 3;
		ctx.roundRect(0, 0, width, height, 16);
		ctx.stroke();

		// Header accent
		const headerGradient = ctx.createLinearGradient(0, 0, width, 100);
		headerGradient.addColorStop(0, `${purpleAccent}40`);
		headerGradient.addColorStop(1, 'transparent');
		ctx.fillStyle = headerGradient;
		ctx.fillRect(0, 0, width, 100);

		// Trophy icon (simplified circle)
		ctx.beginPath();
		ctx.arc(width / 2, 60, 30, 0, Math.PI * 2);
		const trophyGradient = ctx.createRadialGradient(width / 2, 60, 0, width / 2, 60, 30);
		trophyGradient.addColorStop(0, '#FFA500');
		trophyGradient.addColorStop(1, goldColor);
		ctx.fillStyle = trophyGradient;
		ctx.fill();

		// Trophy text
		ctx.fillStyle = textMain;
		ctx.font = 'bold 28px system-ui';
		ctx.textAlign = 'center';
		ctx.fillText('🏆', width / 2, 70);

		// "Standing Ovation" title
		ctx.font = 'bold 24px system-ui';
		ctx.fillStyle = goldColor;
		ctx.textAlign = 'center';
		ctx.fillText('STANDING OVATION', width / 2, 120);

		// Achievement type
		ctx.font = '16px system-ui';
		ctx.fillStyle = textMain;
		ctx.fillText(isNewRecord ? 'New Personal Record!' : 'Achievement Unlocked!', width / 2, 145);

		// Level badge
		ctx.font = 'bold 18px system-ui';
		ctx.fillStyle = goldColor;
		ctx.fillText(`⭐ Level ${badge.level} ⭐`, width / 2, 180);

		// Badge name
		ctx.font = 'bold 28px system-ui';
		ctx.fillStyle = purpleAccent;
		ctx.fillText(badge.name, width / 2, 215);

		// Flavor text
		ctx.font = 'italic 14px system-ui';
		ctx.fillStyle = textDim;
		const flavorLines = wrapText(ctx, `"${badge.flavorText}"`, width - 80);
		let yOffset = 250;
		flavorLines.forEach((line) => {
			ctx.fillText(line, width / 2, yOffset);
			yOffset += 18;
		});

		// Stats box with theme border
		const statsY = 300;
		ctx.fillStyle = bgSecondary;
		ctx.beginPath();
		ctx.roundRect(50, statsY - 10, width - 100, 50, 8);
		ctx.fill();
		ctx.strokeStyle = borderColor;
		ctx.lineWidth = 1;
		ctx.stroke();

		ctx.font = '14px system-ui';
		ctx.fillStyle = textDim;
		ctx.textAlign = 'left';
		ctx.fillText('Total AutoRun:', 70, statsY + 15);
		ctx.fillStyle = textMain;
		ctx.font = 'bold 14px system-ui';
		ctx.fillText(formatCumulativeTime(cumulativeTimeMs), 180, statsY + 15);

		if (recordTimeMs) {
			ctx.fillStyle = textDim;
			ctx.font = '14px system-ui';
			ctx.textAlign = 'left';
			ctx.fillText('Longest Run:', 350, statsY + 15);
			ctx.fillStyle = isNewRecord ? goldColor : textMain;
			ctx.font = 'bold 14px system-ui';
			ctx.fillText(formatCumulativeTime(recordTimeMs), 450, statsY + 15);
		}

		// Footer branding
		ctx.font = 'bold 12px system-ui';
		ctx.fillStyle = textDim;
		ctx.textAlign = 'center';
		ctx.fillText('MAESTRO • Agent Orchestration Command Center', width / 2, height - 20);

		return canvas;
	}, [badge, cumulativeTimeMs, recordTimeMs, isNewRecord, purpleAccent, theme.colors]);

	// Helper to wrap text
	const wrapText = (ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] => {
		const words = text.split(' ');
		const lines: string[] = [];
		let currentLine = '';

		words.forEach((word) => {
			const testLine = currentLine ? `${currentLine} ${word}` : word;
			const metrics = ctx.measureText(testLine);
			if (metrics.width > maxWidth && currentLine) {
				lines.push(currentLine);
				currentLine = word;
			} else {
				currentLine = testLine;
			}
		});
		if (currentLine) lines.push(currentLine);
		return lines;
	};

	// Copy to clipboard
	const copyToClipboard = useCallback(async () => {
		try {
			const canvas = await generateShareImage();
			canvas.toBlob(async (blob) => {
				if (blob) {
					await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
					setCopySuccess(true);
					setTimeout(() => setCopySuccess(false), 2000);
				}
			}, 'image/png');
		} catch (error) {
			console.error('Failed to copy to clipboard:', error);
		}
	}, [generateShareImage]);

	// Download as image
	const downloadImage = useCallback(async () => {
		try {
			const canvas = await generateShareImage();
			const link = document.createElement('a');
			link.download = `maestro-achievement-level-${badge.level}.png`;
			link.href = canvas.toDataURL('image/png');
			link.click();
		} catch (error) {
			console.error('Failed to download image:', error);
		}
	}, [generateShareImage, badge.level]);

	return (
		<>
			{/* Dark backdrop - lowest layer (z-index 99997) */}
			<div
				className="fixed inset-0 z-[99997] animate-in fade-in duration-500"
				onClick={handleTakeABow}
				style={{
					backgroundColor: 'rgba(0, 0, 0, 0.85)',
				}}
			/>

			{/* Confetti renders at z-index 99998 (set in fireConfetti) */}

			{/* Modal container - highest layer (z-index 99999) */}
			<div
				ref={containerRef}
				className="fixed inset-0 flex items-center justify-center z-[99999] pointer-events-none p-4"
				role="dialog"
				aria-modal="true"
				aria-label="Standing Ovation Achievement"
				tabIndex={-1}
			>
				{/* Main content card */}
				<div
					className={`relative max-w-lg w-full rounded-2xl shadow-2xl overflow-y-auto transition-all duration-500 pointer-events-auto ${
						isClosing ? 'opacity-0 scale-95' : 'animate-in zoom-in-95'
					}`}
					onClick={(e) => e.stopPropagation()}
					style={{
						backgroundColor: theme.colors.bgSidebar,
						border: `2px solid ${goldColor}`,
						boxShadow: `0 0 40px rgba(0, 0, 0, 0.5)`,
						maxHeight: 'calc(100vh - 2rem)',
					}}
				>
					{/* Header with glow */}
					<div
						className="relative px-8 pt-8 pb-4 text-center"
						style={{
							background: `linear-gradient(180deg, ${purpleAccent}20 0%, transparent 100%)`,
						}}
					>
						{/* Trophy icon */}
						<div className="flex justify-center mb-4">
							<div
								className="relative p-4 rounded-full animate-bounce"
								style={{
									background: `linear-gradient(135deg, ${goldColor} 0%, #FFA500 100%)`,
									boxShadow: `0 0 30px ${goldColor}60`,
								}}
							>
								<Trophy className="w-10 h-10 text-white" />
							</div>
						</div>

						{/* Title */}
						<h1
							className="text-3xl font-bold tracking-wider mb-2"
							style={{
								color: goldColor,
								textShadow: `0 0 20px ${goldColor}60`,
							}}
						>
							STANDING OVATION
						</h1>

						<p className="text-lg" style={{ color: theme.colors.textMain }}>
							{isNewRecord ? 'New Personal Record!' : 'Achievement Unlocked!'}
						</p>
					</div>

					{/* Maestro silhouette */}
					<div className="flex justify-center py-4">
						<div
							className="relative"
							style={{
								filter: `drop-shadow(0 0 20px ${purpleAccent}60)`,
							}}
						>
							<AnimatedMaestro variant={maestroVariant} size={160} />
						</div>
					</div>

					{/* Badge info */}
					<div className="px-8 pb-6 text-center">
						{/* Badge name */}
						<div className="flex items-center justify-center gap-2 mb-2">
							<Star className="w-5 h-5" style={{ color: goldColor }} />
							<span className="text-xl font-bold" style={{ color: theme.colors.textMain }}>
								Level {badge.level}
							</span>
							<Star className="w-5 h-5" style={{ color: goldColor }} />
						</div>

						<h2 className="text-2xl font-bold mb-3" style={{ color: purpleAccent }}>
							{badge.name}
						</h2>

						<p className="text-sm mb-4 leading-relaxed" style={{ color: theme.colors.textDim }}>
							{badge.description}
						</p>

						{/* Flavor text */}
						<p
							className="text-sm italic mb-4"
							style={{ color: theme.colors.textMain, opacity: 0.8 }}
						>
							"{badge.flavorText}"
						</p>

						{/* Example conductor */}
						<div
							className="p-3 rounded-lg mb-4"
							style={{
								backgroundColor: theme.colors.bgActivity,
								border: `1px solid ${theme.colors.border}`,
							}}
						>
							<p className="text-xs mb-1" style={{ color: theme.colors.textDim }}>
								Example Maestro
							</p>
							<p className="font-medium" style={{ color: theme.colors.textMain }}>
								{badge.exampleConductor.name}
							</p>
							<p className="text-xs" style={{ color: theme.colors.textDim }}>
								{badge.exampleConductor.era}
							</p>
							<p className="text-xs mt-1" style={{ color: theme.colors.textDim }}>
								{badge.exampleConductor.achievement}
							</p>
							<button
								onClick={() =>
									window.maestro.shell.openExternal(badge.exampleConductor.wikipediaUrl)
								}
								className="inline-flex items-center gap-1 text-xs mt-2 hover:underline"
								style={{ color: purpleAccent }}
							>
								<ExternalLink className="w-3 h-3" />
								Learn more on Wikipedia
							</button>
						</div>

						{/* Stats */}
						<div
							className="grid grid-cols-2 gap-4 p-3 rounded-lg mb-4"
							style={{
								backgroundColor: theme.colors.bgActivity,
								border: `1px solid ${theme.colors.border}`,
							}}
						>
							<div>
								<div className="flex items-center justify-center gap-1 mb-1">
									<Clock className="w-3 h-3" style={{ color: theme.colors.textDim }} />
									<span className="text-xs" style={{ color: theme.colors.textDim }}>
										Total AutoRun
									</span>
								</div>
								<span className="font-mono font-bold" style={{ color: theme.colors.textMain }}>
									{formatCumulativeTime(cumulativeTimeMs)}
								</span>
							</div>
							{recordTimeMs && (
								<div>
									<div className="flex items-center justify-center gap-1 mb-1">
										<Trophy className="w-3 h-3" style={{ color: goldColor }} />
										<span className="text-xs" style={{ color: theme.colors.textDim }}>
											{isNewRecord ? 'New Record' : 'Longest Run'}
										</span>
									</div>
									<span
										className="font-mono font-bold"
										style={{ color: isNewRecord ? goldColor : theme.colors.textMain }}
									>
										{formatCumulativeTime(recordTimeMs)}
									</span>
								</div>
							)}
						</div>

						{/* Next level info */}
						{nextBadge && (
							<div className="text-xs" style={{ color: theme.colors.textDim }}>
								<span>Next: </span>
								<span style={{ color: purpleAccent }}>{nextBadge.name}</span>
								<span> • {formatTimeRemaining(cumulativeTimeMs, nextBadge)}</span>
							</div>
						)}

						{!nextBadge && (
							<div className="text-xs" style={{ color: goldColor }}>
								You have achieved the highest rank! A true Titan of the Baton.
							</div>
						)}
					</div>

					{/* Buttons */}
					<div className="px-8 pb-8 space-y-3">
						<button
							onClick={handleTakeABow}
							disabled={isClosing}
							className="w-full py-3 rounded-lg font-medium transition-all hover:scale-[1.02] disabled:opacity-70 disabled:cursor-not-allowed"
							style={{
								background: `linear-gradient(135deg, ${purpleAccent} 0%, ${goldColor} 100%)`,
								color: '#FFFFFF',
								boxShadow: `0 4px 20px ${purpleAccent}40`,
							}}
						>
							{isClosing ? '🎉 Bravo! 🎉' : 'Take a Bow'}
						</button>

						{/* Share options */}
						<div className="relative">
							<button
								onClick={() => setShareMenuOpen(!shareMenuOpen)}
								className="w-full py-2.5 rounded-lg font-medium transition-all flex items-center justify-center gap-2 hover:opacity-90"
								style={{
									backgroundColor: theme.colors.bgActivity,
									color: theme.colors.textMain,
									border: `1px solid ${theme.colors.border}`,
								}}
							>
								<Share2 className="w-4 h-4" />
								Share Achievement
							</button>

							{shareMenuOpen && (
								<div
									className="absolute bottom-full left-0 right-0 mb-2 p-2 rounded-lg shadow-xl"
									style={{
										backgroundColor: theme.colors.bgSidebar,
										border: `1px solid ${theme.colors.border}`,
									}}
								>
									<button
										onClick={() => {
											copyToClipboard();
											setShareMenuOpen(false);
										}}
										className="w-full flex items-center gap-3 px-3 py-2 rounded hover:bg-white/10 transition-colors"
									>
										{copySuccess ? (
											<Check className="w-4 h-4" style={{ color: theme.colors.success }} />
										) : (
											<Copy className="w-4 h-4" style={{ color: theme.colors.textDim }} />
										)}
										<span style={{ color: theme.colors.textMain }}>
											{copySuccess ? 'Copied!' : 'Copy to Clipboard'}
										</span>
									</button>
									<button
										onClick={() => {
											downloadImage();
											setShareMenuOpen(false);
										}}
										className="w-full flex items-center gap-3 px-3 py-2 rounded hover:bg-white/10 transition-colors"
									>
										<Download className="w-4 h-4" style={{ color: theme.colors.textDim }} />
										<span style={{ color: theme.colors.textMain }}>Save as Image</span>
									</button>
								</div>
							)}
						</div>

						{/* Leaderboard Registration */}
						{onOpenLeaderboardRegistration && !isLeaderboardRegistered && (
							<button
								onClick={() => {
									onClose();
									onOpenLeaderboardRegistration();
								}}
								className="w-full py-2.5 rounded-lg font-medium transition-all flex items-center justify-center gap-2 hover:opacity-90"
								style={{
									backgroundColor: `${goldColor}20`,
									color: goldColor,
									border: `1px solid ${goldColor}60`,
								}}
							>
								<Trophy className="w-4 h-4" />
								Join Global Leaderboard
							</button>
						)}
					</div>
				</div>
			</div>
		</>
	);
}

export default StandingOvationOverlay;
