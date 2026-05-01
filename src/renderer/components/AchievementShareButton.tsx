/**
 * AchievementShareButton
 *
 * Self-contained share button for the user's Maestro achievement card. Renders
 * a Share2 icon button that opens a Copy-to-Clipboard / Save-as-Image popover
 * and generates the shareable PNG via canvas.
 *
 * Originally lived inside `AchievementCard` (and was the only place users
 * could share). Extracted so the Usage Dashboard can surface the same
 * affordance from its header without re-implementing the canvas pipeline.
 *
 * The full image-generation logic lives here verbatim from its previous home;
 * keep edits in lockstep with the visual design — the resulting PNG is what
 * users post to social.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { Share2, Copy, Download, Check } from 'lucide-react';
import type { Theme, AutoRunStats, MaestroUsageStats, LeaderboardRegistration } from '../types';
import { getBadgeForTime, formatCumulativeTime } from '../constants/conductorBadges';
import { formatTokensCompact } from '../utils/formatters';
import maestroWandIcon from '../assets/icon-wand.png';
import { safeClipboardWriteBlob } from '../utils/clipboard';
import { logger } from '../utils/logger';
import { captureException } from '../utils/sentry';

/** Shape of the global stats subset the share image consumes. Mirrors the
 * structure used by `AchievementCard`; defined here to keep the new module
 * self-contained without re-exporting from the card. */
export interface AchievementShareGlobalStats {
	totalSessions: number;
	totalMessages: number;
	totalInputTokens: number;
	totalOutputTokens: number;
	totalCacheReadTokens: number;
	totalCacheCreationTokens: number;
	totalCostUsd: number;
	totalSizeBytes: number;
	isComplete?: boolean;
	hasCostData?: boolean;
	byProvider?: Record<string, unknown>;
}

export interface AchievementShareButtonProps {
	theme: Theme;
	autoRunStats: AutoRunStats;
	globalStats?: AchievementShareGlobalStats | null;
	usageStats?: MaestroUsageStats | null;
	handsOnTimeMs?: number;
	leaderboardRegistration?: LeaderboardRegistration | null;
	/**
	 * Visual variant. `default` matches the inline-card placement (small
	 * subdued icon button). `header` makes the button match the surrounding
	 * action buttons (Export CSV, etc.) on a modal toolbar — slightly larger
	 * hit area, accent tint background.
	 */
	variant?: 'default' | 'header';
	/** Optional title override for the button's tooltip. */
	title?: string;
}

const GOLD_COLOR = '#FFD700';

/**
 * Format the global hands-on time for the achievement image footer.
 * Rounds down to the nearest minute; under one minute reads as "0m" so the
 * canvas math stays predictable.
 */
function formatHandsOnTime(ms: number): string {
	if (ms < 1000) return '0m';
	const totalMinutes = Math.floor(ms / 60000);
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	if (hours > 0) {
		return `${hours}h ${minutes}m`;
	}
	return `${minutes}m`;
}

/**
 * Word-wrap a string to a max pixel width using the canvas's current font.
 * Used by the share image to fit flavor text in a fixed column.
 */
function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
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
}

/**
 * Fetch a remote image as a base64 data URL via the main process (CORS-safe)
 * and resolve it as an `HTMLImageElement` for canvas drawing. Resolves to
 * `null` on any failure — callers fall back to a drawn placeholder.
 */
async function loadImage(url: string): Promise<HTMLImageElement | null> {
	try {
		const base64DataUrl = await window.maestro.fs.fetchImageAsBase64(url);
		if (!base64DataUrl) return null;
		return new Promise((resolve) => {
			const img = new Image();
			img.onload = () => resolve(img);
			img.onerror = () => resolve(null);
			img.src = base64DataUrl;
		});
	} catch (error) {
		logger.error('Failed to load image:', undefined, error);
		return null;
	}
}

export function AchievementShareButton({
	theme,
	autoRunStats,
	globalStats,
	usageStats,
	handsOnTimeMs,
	leaderboardRegistration,
	variant = 'default',
	title = 'Share achievements',
}: AchievementShareButtonProps) {
	const [shareMenuOpen, setShareMenuOpen] = useState(false);
	const [copySuccess, setCopySuccess] = useState(false);
	const shareMenuRef = useRef<HTMLDivElement>(null);

	const currentBadge = getBadgeForTime(autoRunStats.cumulativeTimeMs);
	const currentLevel = currentBadge?.level || 0;

	// Close on outside click. setTimeout guards against the click that opened
	// the menu also triggering the close handler in the same tick.
	useEffect(() => {
		if (!shareMenuOpen) return;
		const handleClickOutside = (e: MouseEvent) => {
			if (shareMenuRef.current && !shareMenuRef.current.contains(e.target as Node)) {
				setShareMenuOpen(false);
			}
		};
		const timeoutId = setTimeout(() => {
			document.addEventListener('click', handleClickOutside);
		}, 0);
		return () => {
			clearTimeout(timeoutId);
			document.removeEventListener('click', handleClickOutside);
		};
	}, [shareMenuOpen]);

	const generateShareImage = useCallback(async (): Promise<HTMLCanvasElement> => {
		const canvas = document.createElement('canvas');
		const ctx = canvas.getContext('2d')!;

		const hasPersonalization = leaderboardRegistration?.displayName;
		const displayName = leaderboardRegistration?.displayName;
		const githubUsername = leaderboardRegistration?.githubUsername;
		const twitterHandle = leaderboardRegistration?.twitterHandle;
		const linkedinHandle = leaderboardRegistration?.linkedinHandle;
		const discordUsername = leaderboardRegistration?.discordUsername;

		const socialHandles: { icon: string; handle: string; color: string }[] = [];
		if (githubUsername)
			socialHandles.push({ icon: 'github', handle: githubUsername, color: '#FFFFFF' });
		if (twitterHandle)
			socialHandles.push({ icon: 'twitter', handle: twitterHandle, color: '#FFFFFF' });
		if (linkedinHandle)
			socialHandles.push({ icon: 'linkedin', handle: linkedinHandle, color: '#0A66C2' });
		if (discordUsername)
			socialHandles.push({ icon: 'discord', handle: discordUsername, color: '#5865F2' });

		const hasSocialHandles = socialHandles.length > 0;

		const scale = 3;
		const width = 600;
		const height = hasSocialHandles ? 580 : 540;
		canvas.width = width * scale;
		canvas.height = height * scale;
		canvas.style.width = `${width}px`;
		canvas.style.height = `${height}px`;
		ctx.scale(scale, scale);
		ctx.imageSmoothingEnabled = true;
		ctx.imageSmoothingQuality = 'high';

		let avatarImage: HTMLImageElement | null = null;
		if (githubUsername) {
			avatarImage = await loadImage(`https://github.com/${githubUsername}.png?size=200`);
		}

		const githubLogoImage = await loadImage(
			'https://github.githubassets.com/images/modules/logos_page/GitHub-Mark.png'
		);

		const wandIconImage = await new Promise<HTMLImageElement | null>((resolve) => {
			const img = new Image();
			img.onload = () => resolve(img);
			img.onerror = () => resolve(null);
			img.src = maestroWandIcon;
		});

		const bgGradient = ctx.createRadialGradient(
			width / 2,
			height / 2,
			0,
			width / 2,
			height / 2,
			width * 0.7
		);
		bgGradient.addColorStop(0, '#2d1f4e');
		bgGradient.addColorStop(1, '#1a1a2e');
		ctx.fillStyle = bgGradient;
		ctx.roundRect(0, 0, width, height, 20);
		ctx.fill();

		const overlayGradient = ctx.createLinearGradient(0, 0, 0, height);
		overlayGradient.addColorStop(0, 'rgba(139, 92, 246, 0.15)');
		overlayGradient.addColorStop(0.5, 'rgba(0, 0, 0, 0)');
		overlayGradient.addColorStop(1, 'rgba(0, 0, 0, 0.2)');
		ctx.fillStyle = overlayGradient;
		ctx.roundRect(0, 0, width, height, 20);
		ctx.fill();

		ctx.strokeStyle = '#8B5CF6';
		ctx.lineWidth = 2;
		ctx.roundRect(0, 0, width, height, 20);
		ctx.stroke();

		ctx.strokeStyle = 'rgba(139, 92, 246, 0.3)';
		ctx.lineWidth = 4;
		ctx.roundRect(-2, -2, width + 4, height + 4, 22);
		ctx.stroke();

		const iconX = width / 2;
		const iconY = 70;
		const iconRadius = 40;

		if (avatarImage) {
			ctx.save();
			ctx.beginPath();
			ctx.arc(iconX, iconY, iconRadius, 0, Math.PI * 2);
			ctx.closePath();
			ctx.clip();
			ctx.drawImage(
				avatarImage,
				iconX - iconRadius,
				iconY - iconRadius,
				iconRadius * 2,
				iconRadius * 2
			);
			ctx.restore();

			ctx.beginPath();
			ctx.arc(iconX, iconY, iconRadius + 2, 0, Math.PI * 2);
			ctx.strokeStyle = '#FFD700';
			ctx.lineWidth = 3;
			ctx.stroke();

			const badgeRadius = 18;
			const badgeX = iconX + iconRadius - 6;
			const badgeY = iconY + iconRadius - 6;

			if (wandIconImage) {
				ctx.save();
				ctx.beginPath();
				ctx.arc(badgeX, badgeY, badgeRadius, 0, Math.PI * 2);
				ctx.closePath();
				ctx.clip();
				ctx.drawImage(
					wandIconImage,
					badgeX - badgeRadius,
					badgeY - badgeRadius,
					badgeRadius * 2,
					badgeRadius * 2
				);
				ctx.restore();
				ctx.beginPath();
				ctx.arc(badgeX, badgeY, badgeRadius, 0, Math.PI * 2);
				ctx.strokeStyle = '#DDD6FE';
				ctx.lineWidth = 2;
				ctx.stroke();
			}
		} else {
			ctx.beginPath();
			ctx.arc(iconX, iconY, iconRadius, 0, Math.PI * 2);
			const defaultGradient = ctx.createRadialGradient(
				iconX - 10,
				iconY - 10,
				0,
				iconX,
				iconY,
				iconRadius
			);
			defaultGradient.addColorStop(0, '#C4B5FD');
			defaultGradient.addColorStop(0.5, '#A78BFA');
			defaultGradient.addColorStop(1, '#8B5CF6');
			ctx.fillStyle = defaultGradient;
			ctx.fill();
			ctx.strokeStyle = '#DDD6FE';
			ctx.lineWidth = 3;
			ctx.stroke();

			ctx.font = '38px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
			ctx.textAlign = 'center';
			ctx.textBaseline = 'middle';
			ctx.fillText('🏆', iconX, iconY + 2);
		}

		const titleY = iconY + iconRadius + 32;
		ctx.font = '600 18px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
		ctx.fillStyle = '#F472B6';
		ctx.textAlign = 'center';
		if (hasPersonalization && displayName) {
			ctx.fillText(displayName.toUpperCase(), width / 2, titleY);
		} else {
			ctx.fillText('MAESTRO ACHIEVEMENTS', width / 2, titleY);
		}

		const levelY = titleY + 28;
		const badgeNameY = levelY + 32;
		let flavorEndY = badgeNameY + 20;

		if (currentBadge) {
			ctx.font = '600 14px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
			ctx.fillStyle = GOLD_COLOR;
			ctx.fillText(`★ Level ${currentBadge.level} of 11 ★`, width / 2, levelY);

			ctx.font = '700 26px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
			ctx.fillStyle = '#F472B6';
			ctx.fillText(currentBadge.name, width / 2, badgeNameY);

			ctx.font = 'italic 13px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
			ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
			const flavorLines = wrapText(ctx, `"${currentBadge.flavorText}"`, width - 100);
			let yOffset = badgeNameY + 30;
			flavorLines.forEach((line) => {
				ctx.fillText(line, width / 2, yOffset);
				yOffset += 18;
			});
			flavorEndY = yOffset;
		} else {
			ctx.font = '700 22px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
			ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
			ctx.fillText('Journey Just Beginning...', width / 2, badgeNameY);

			ctx.font = '400 14px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
			ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
			ctx.fillText(
				'Complete 15 minutes of AutoRun to unlock first badge',
				width / 2,
				badgeNameY + 28
			);
			flavorEndY = badgeNameY + 46;
		}

		const totalTokens = globalStats
			? globalStats.totalInputTokens + globalStats.totalOutputTokens
			: 0;
		const tokensValue = totalTokens > 0 ? formatTokensCompact(totalTokens) : '—';
		const sessionsValue = globalStats?.totalSessions?.toLocaleString() || '—';
		const handsOnValue = handsOnTimeMs ? formatHandsOnTime(handsOnTimeMs) : '—';
		const autoRunTotal = formatCumulativeTime(autoRunStats.cumulativeTimeMs);
		const autoRunBest = formatCumulativeTime(autoRunStats.longestRunMs);

		const maxAgents = usageStats?.maxAgents?.toString() || '0';
		const maxAutoRuns = usageStats?.maxSimultaneousAutoRuns?.toString() || '0';
		const maxQueries = usageStats?.maxSimultaneousQueries?.toString() || '0';
		const maxQueue = usageStats?.maxQueueDepth?.toString() || '0';

		const rowHeight = 56;
		const rowGap = 10;

		const row1Y = flavorEndY + 14;
		ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
		ctx.roundRect(30, row1Y, width - 60, rowHeight, 12);
		ctx.fill();
		ctx.strokeStyle = 'rgba(139, 92, 246, 0.3)';
		ctx.lineWidth = 1;
		ctx.roundRect(30, row1Y, width - 60, rowHeight, 12);
		ctx.stroke();

		const row1ColWidth = (width - 60) / 2;
		const row1CenterY = row1Y + rowHeight / 2;

		const drawStatInRow = (
			x: number,
			centerY: number,
			value: string,
			label: string,
			fontSize: number = 20
		) => {
			ctx.font = `700 ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
			ctx.fillStyle = '#FFFFFF';
			ctx.textAlign = 'center';
			ctx.fillText(value, x, centerY - 3);

			ctx.font = '500 10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
			ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
			ctx.fillText(label, x, centerY + 14);
		};

		drawStatInRow(30 + row1ColWidth * 0.5, row1CenterY, sessionsValue, 'Sessions', 22);
		drawStatInRow(30 + row1ColWidth * 1.5, row1CenterY, tokensValue, 'Total Tokens', 22);

		const row2Y = row1Y + rowHeight + rowGap;
		ctx.fillStyle = 'rgba(0, 0, 0, 0.30)';
		ctx.roundRect(30, row2Y, width - 60, rowHeight, 12);
		ctx.fill();
		ctx.strokeStyle = 'rgba(139, 92, 246, 0.25)';
		ctx.lineWidth = 1;
		ctx.roundRect(30, row2Y, width - 60, rowHeight, 12);
		ctx.stroke();

		const row2ColWidth = (width - 60) / 3;
		const row2CenterY = row2Y + rowHeight / 2;

		drawStatInRow(30 + row2ColWidth * 0.5, row2CenterY, autoRunTotal, 'Total AutoRun', 18);
		drawStatInRow(30 + row2ColWidth * 1.5, row2CenterY, autoRunBest, 'Longest AutoRun', 18);
		drawStatInRow(30 + row2ColWidth * 2.5, row2CenterY, handsOnValue, 'Hands-on Time', 18);

		const row3Y = row2Y + rowHeight + rowGap;
		const row3Height = 66;
		ctx.fillStyle = 'rgba(0, 0, 0, 0.25)';
		ctx.roundRect(30, row3Y, width - 60, row3Height, 12);
		ctx.fill();
		ctx.strokeStyle = 'rgba(139, 92, 246, 0.2)';
		ctx.lineWidth = 1;
		ctx.roundRect(30, row3Y, width - 60, row3Height, 12);
		ctx.stroke();

		ctx.font = '600 10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
		ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
		ctx.textAlign = 'center';
		ctx.fillText('PEAK USAGE', width / 2, row3Y + 14);

		const row3ColWidth = (width - 60) / 4;
		const row3CenterY = row3Y + row3Height / 2 + 8;

		const drawPeakStat = (x: number, value: string, label: string) => {
			ctx.font = '700 18px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
			ctx.fillStyle = '#FFFFFF';
			ctx.textAlign = 'center';
			ctx.fillText(value, x, row3CenterY - 3);

			ctx.font = '500 9px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
			ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
			ctx.fillText(label, x, row3CenterY + 12);
		};

		drawPeakStat(30 + row3ColWidth * 0.5, maxAgents, 'Registered Agents');
		drawPeakStat(30 + row3ColWidth * 1.5, maxAutoRuns, 'Parallel AutoRuns');
		drawPeakStat(30 + row3ColWidth * 2.5, maxQueries, 'Parallel Queries');
		drawPeakStat(30 + row3ColWidth * 3.5, maxQueue, 'Queue Depth');

		if (hasSocialHandles) {
			const socialY = height - 70;
			const socialHeight = 20;

			ctx.font = '500 11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

			const handleGap = 24;
			const iconSize = 14;
			const iconGap = 6;
			let totalWidth = 0;
			socialHandles.forEach((social) => {
				const textWidth = ctx.measureText(social.handle).width;
				totalWidth += iconSize + iconGap + textWidth;
			});
			totalWidth += handleGap * (socialHandles.length - 1);

			let currentX = (width - totalWidth) / 2;

			const drawSocialIcon = (x: number, y: number, icon: string, size: number) => {
				ctx.save();
				const halfSize = size / 2;

				if (icon === 'github') {
					if (githubLogoImage) {
						ctx.save();
						ctx.beginPath();
						ctx.arc(x, y, halfSize, 0, Math.PI * 2);
						ctx.closePath();
						ctx.clip();
						ctx.drawImage(githubLogoImage, x - halfSize, y - halfSize, size, size);
						ctx.restore();
					} else {
						ctx.fillStyle = '#FFFFFF';
						ctx.beginPath();
						ctx.arc(x, y, halfSize, 0, Math.PI * 2);
						ctx.fill();
						ctx.fillStyle = '#1a1a2e';
						ctx.font = `bold ${size * 0.45}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
						ctx.textAlign = 'center';
						ctx.textBaseline = 'middle';
						ctx.fillText('GH', x, y + 1);
					}
				} else if (icon === 'twitter') {
					ctx.strokeStyle = '#FFFFFF';
					ctx.lineWidth = 2;
					ctx.lineCap = 'round';
					ctx.beginPath();
					ctx.moveTo(x - halfSize * 0.6, y - halfSize * 0.6);
					ctx.lineTo(x + halfSize * 0.6, y + halfSize * 0.6);
					ctx.moveTo(x + halfSize * 0.6, y - halfSize * 0.6);
					ctx.lineTo(x - halfSize * 0.6, y + halfSize * 0.6);
					ctx.stroke();
				} else if (icon === 'linkedin') {
					ctx.fillStyle = '#0A66C2';
					ctx.beginPath();
					ctx.roundRect(x - halfSize, y - halfSize, size, size, 2);
					ctx.fill();
					ctx.fillStyle = '#FFFFFF';
					ctx.font = `bold ${size * 0.6}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
					ctx.textAlign = 'center';
					ctx.textBaseline = 'middle';
					ctx.fillText('in', x, y + 1);
				} else if (icon === 'discord') {
					ctx.fillStyle = '#5865F2';
					ctx.beginPath();
					ctx.roundRect(x - halfSize, y - halfSize, size, size, 3);
					ctx.fill();
					ctx.fillStyle = '#FFFFFF';
					const s = halfSize * 0.8;
					ctx.beginPath();
					ctx.moveTo(x - s * 0.8, y - s * 0.3);
					ctx.quadraticCurveTo(x - s * 0.7, y - s * 0.7, x - s * 0.3, y - s * 0.55);
					ctx.quadraticCurveTo(x, y - s * 0.45, x + s * 0.3, y - s * 0.55);
					ctx.quadraticCurveTo(x + s * 0.7, y - s * 0.7, x + s * 0.8, y - s * 0.3);
					ctx.quadraticCurveTo(x + s * 0.9, y + s * 0.2, x + s * 0.5, y + s * 0.65);
					ctx.quadraticCurveTo(x, y + s * 0.75, x - s * 0.5, y + s * 0.65);
					ctx.quadraticCurveTo(x - s * 0.9, y + s * 0.2, x - s * 0.8, y - s * 0.3);
					ctx.closePath();
					ctx.fill();
					ctx.fillStyle = '#5865F2';
					ctx.beginPath();
					ctx.ellipse(x - s * 0.35, y - s * 0.05, s * 0.18, s * 0.22, 0, 0, Math.PI * 2);
					ctx.fill();
					ctx.beginPath();
					ctx.ellipse(x + s * 0.35, y - s * 0.05, s * 0.18, s * 0.22, 0, 0, Math.PI * 2);
					ctx.fill();
				}
				ctx.restore();
			};

			socialHandles.forEach((social, index) => {
				drawSocialIcon(currentX + iconSize / 2, socialY + socialHeight / 2, social.icon, iconSize);
				currentX += iconSize + iconGap;

				ctx.font = '500 11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
				ctx.textAlign = 'left';
				ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
				ctx.fillText(social.handle, currentX, socialY + socialHeight / 2 + 4);

				const textWidth = ctx.measureText(social.handle).width;
				currentX += textWidth;

				if (index < socialHandles.length - 1) {
					currentX += handleGap;
				}
			});
		}

		const footerY = height - 20;
		ctx.font = '500 11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
		ctx.fillStyle = 'rgba(139, 92, 246, 0.8)';
		ctx.textAlign = 'center';
		ctx.fillText('RunMaestro.ai • Agent Orchestration Command Center', width / 2, footerY);

		return canvas;
	}, [
		currentBadge,
		autoRunStats.cumulativeTimeMs,
		autoRunStats.longestRunMs,
		globalStats,
		usageStats,
		handsOnTimeMs,
		leaderboardRegistration,
	]);

	const copyToClipboard = useCallback(async () => {
		try {
			const canvas = await generateShareImage();
			const blob = await new Promise<Blob | null>((resolve) => {
				canvas.toBlob((b) => resolve(b), 'image/png');
			});
			if (blob) {
				const ok = await safeClipboardWriteBlob([new ClipboardItem({ 'image/png': blob })]);
				if (ok) {
					setCopySuccess(true);
					setTimeout(() => setCopySuccess(false), 2000);
				}
			}
		} catch (error) {
			logger.error('Failed to generate share image:', undefined, error);
			captureException(error, { extra: { action: 'share-achievement-copy' } });
		}
	}, [generateShareImage]);

	const downloadImage = useCallback(async () => {
		try {
			const canvas = await generateShareImage();
			const link = document.createElement('a');
			link.download = `maestro-achievement-level-${currentLevel}.png`;
			link.href = canvas.toDataURL('image/png');
			link.click();
		} catch (error) {
			logger.error('Failed to download image:', undefined, error);
			captureException(error, { extra: { action: 'share-achievement-download', currentLevel } });
		}
	}, [generateShareImage, currentLevel]);

	// Header variant matches the visual weight of sibling toolbar buttons
	// (Export CSV, Close); default variant keeps the in-card subdued look.
	const buttonClass =
		variant === 'header'
			? 'flex items-center gap-1.5 px-3 py-1.5 rounded text-sm hover:bg-opacity-10 transition-colors'
			: 'p-1.5 rounded-md transition-colors hover:bg-white/10';
	const buttonStyle: React.CSSProperties =
		variant === 'header'
			? {
					color: theme.colors.textMain,
					backgroundColor: `${theme.colors.accent}15`,
				}
			: { color: theme.colors.textDim };

	return (
		<div className="relative" ref={shareMenuRef}>
			<button
				onClick={() => setShareMenuOpen(!shareMenuOpen)}
				className={buttonClass}
				style={buttonStyle}
				onMouseEnter={
					variant === 'header'
						? (e) => (e.currentTarget.style.backgroundColor = `${theme.colors.accent}25`)
						: undefined
				}
				onMouseLeave={
					variant === 'header'
						? (e) => (e.currentTarget.style.backgroundColor = `${theme.colors.accent}15`)
						: undefined
				}
				title={title}
				data-testid="achievement-share-button"
			>
				<Share2 className="w-4 h-4" />
				{variant === 'header' && <span>Share</span>}
			</button>

			{shareMenuOpen && (
				<div
					className="absolute right-0 top-full mt-1 p-1.5 rounded-lg shadow-xl z-50"
					style={{
						backgroundColor: theme.colors.bgSidebar,
						border: `1px solid ${theme.colors.border}`,
					}}
				>
					<button
						onClick={async () => {
							await copyToClipboard();
							setTimeout(() => setShareMenuOpen(false), 1000);
						}}
						className="w-full flex items-center gap-2 px-3 py-2 rounded text-sm whitespace-nowrap hover:bg-white/10 transition-colors"
					>
						{copySuccess ? (
							<Check className="w-4 h-4 shrink-0" style={{ color: theme.colors.success }} />
						) : (
							<Copy className="w-4 h-4 shrink-0" style={{ color: theme.colors.textDim }} />
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
						className="w-full flex items-center gap-2 px-3 py-2 rounded text-sm whitespace-nowrap hover:bg-white/10 transition-colors"
					>
						<Download className="w-4 h-4 shrink-0" style={{ color: theme.colors.textDim }} />
						<span style={{ color: theme.colors.textMain }}>Save as Image</span>
					</button>
				</div>
			)}
		</div>
	);
}

export default AchievementShareButton;
