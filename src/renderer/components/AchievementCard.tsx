import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Trophy, Clock, Zap, Star, ExternalLink, ChevronDown, History, Share2, Copy, Download, Check } from 'lucide-react';
import type { Theme } from '../types';
import type { AutoRunStats } from '../types';
import {
  CONDUCTOR_BADGES,
  getBadgeForTime,
  getNextBadge,
  getProgressToNextBadge,
  formatTimeRemaining,
  formatCumulativeTime,
  type ConductorBadge,
} from '../constants/conductorBadges';
import { MaestroSilhouette } from './MaestroSilhouette';
import { formatTokensCompact } from '../utils/formatters';

/**
 * Circular progress ring with 11 segments that fill as badges are unlocked
 */
interface BadgeProgressRingProps {
  currentLevel: number;
  size: number;
  theme: Theme;
}

function BadgeProgressRing({ currentLevel, size, theme }: BadgeProgressRingProps) {
  const segments = 11;
  const strokeWidth = 4;
  const gap = 4; // Gap between segments in degrees
  const radius = (size - strokeWidth) / 2;
  const center = size / 2;

  // Each segment takes up (360 - total gaps) / segments degrees
  const totalGapDegrees = gap * segments;
  const segmentDegrees = (360 - totalGapDegrees) / segments;

  // Start from top (-90 degrees) and go clockwise
  const startAngle = -90;

  // Generate SVG arc path for a segment
  const getArcPath = (segmentIndex: number): string => {
    const segmentStart = startAngle + segmentIndex * (segmentDegrees + gap);
    const segmentEnd = segmentStart + segmentDegrees;

    const startRad = (segmentStart * Math.PI) / 180;
    const endRad = (segmentEnd * Math.PI) / 180;

    const x1 = center + radius * Math.cos(startRad);
    const y1 = center + radius * Math.sin(startRad);
    const x2 = center + radius * Math.cos(endRad);
    const y2 = center + radius * Math.sin(endRad);

    // Large arc flag is 0 since each segment is less than 180 degrees
    return `M ${x1} ${y1} A ${radius} ${radius} 0 0 1 ${x2} ${y2}`;
  };

  // Get color for segment based on its level
  const getSegmentColor = (level: number, isUnlocked: boolean): string => {
    if (!isUnlocked) {
      return theme.colors.border;
    }
    // Same gradient logic as the horizontal bar
    if (level <= 3) {
      return theme.colors.accent;
    } else if (level <= 7) {
      // Transition from accent to gold
      const t = (level - 3) / 4;
      return interpolateColor(theme.colors.accent, '#FFD700', t);
    } else {
      // Transition from gold to orange
      const t = (level - 7) / 4;
      return interpolateColor('#FFD700', '#FF6B35', t);
    }
  };

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className="absolute inset-0"
      style={{ transform: 'rotate(0deg)' }}
    >
      {Array.from({ length: segments }, (_, i) => {
        const level = i + 1;
        const isUnlocked = level <= currentLevel;
        const color = getSegmentColor(level, isUnlocked);

        return (
          <path
            key={i}
            d={getArcPath(i)}
            fill="none"
            stroke={color}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            opacity={isUnlocked ? 1 : 0.3}
            style={{
              filter: isUnlocked ? `drop-shadow(0 0 2px ${color}60)` : 'none',
              transition: 'all 0.5s ease-out',
            }}
          />
        );
      })}
    </svg>
  );
}

// Helper to interpolate between two hex colors
function interpolateColor(color1: string, color2: string, t: number): string {
  const hex1 = color1.replace('#', '');
  const hex2 = color2.replace('#', '');

  const r1 = parseInt(hex1.substring(0, 2), 16);
  const g1 = parseInt(hex1.substring(2, 4), 16);
  const b1 = parseInt(hex1.substring(4, 6), 16);

  const r2 = parseInt(hex2.substring(0, 2), 16);
  const g2 = parseInt(hex2.substring(2, 4), 16);
  const b2 = parseInt(hex2.substring(4, 6), 16);

  const r = Math.round(r1 + (r2 - r1) * t);
  const g = Math.round(g1 + (g2 - g1) * t);
  const b = Math.round(b1 + (b2 - b1) * t);

  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

interface ClaudeGlobalStats {
  totalSessions: number;
  totalMessages: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  totalCostUsd: number;
  totalSizeBytes: number;
  isComplete?: boolean;
}

interface AchievementCardProps {
  theme: Theme;
  autoRunStats: AutoRunStats;
  globalStats?: ClaudeGlobalStats | null;
}

interface BadgeTooltipProps {
  badge: ConductorBadge;
  theme: Theme;
  isUnlocked: boolean;
  position: 'left' | 'center' | 'right';
  onClose: () => void;
}

function BadgeTooltip({ badge, theme, isUnlocked, position, onClose }: BadgeTooltipProps) {
  // Calculate horizontal positioning based on badge position
  const getPositionStyles = () => {
    switch (position) {
      case 'left':
        return { left: 0, transform: 'translateX(0)' };
      case 'right':
        return { right: 0, transform: 'translateX(0)' };
      default:
        return { left: '50%', transform: 'translateX(-50%)' };
    }
  };

  const getArrowStyles = () => {
    switch (position) {
      case 'left':
        return { left: '16px', transform: 'translateX(0)' };
      case 'right':
        return { right: '16px', left: 'auto', transform: 'translateX(0)' };
      default:
        return { left: '50%', transform: 'translateX(-50%)' };
    }
  };

  return (
    <div
      className="absolute bottom-full mb-2 p-3 rounded-lg shadow-xl z-[100] w-64"
      style={{
        backgroundColor: theme.colors.bgSidebar,
        border: `1px solid ${theme.colors.border}`,
        boxShadow: `0 4px 20px rgba(0,0,0,0.3)`,
        ...getPositionStyles(),
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Level number - prominent */}
      <div className="text-center mb-1">
        <span className="text-lg font-bold" style={{ color: theme.colors.accent }}>
          Level {badge.level}
        </span>
      </div>

      {/* Badge title */}
      <div className="text-center mb-2">
        <span className="font-bold text-sm" style={{ color: theme.colors.textMain }}>
          {badge.name}
        </span>
      </div>

      {/* Description */}
      <p className="text-xs mb-2 text-center" style={{ color: theme.colors.textDim }}>
        {badge.description}
      </p>

      {/* Flavor text if unlocked */}
      {isUnlocked && (
        <p className="text-xs italic mb-2 text-center" style={{ color: theme.colors.textMain }}>
          "{badge.flavorText}"
        </p>
      )}

      {/* Required time and status */}
      <div className="flex items-center justify-between text-xs pt-2 border-t" style={{ borderColor: theme.colors.border }}>
        <span style={{ color: theme.colors.textDim }}>
          Required: {formatCumulativeTime(badge.requiredTimeMs)}
        </span>
        {isUnlocked ? (
          <span style={{ color: theme.colors.success }}>Unlocked</span>
        ) : (
          <span style={{ color: theme.colors.textDim }}>Locked</span>
        )}
      </div>

      {/* Example conductor link */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          window.maestro.shell.openExternal(badge.exampleConductor.wikipediaUrl);
        }}
        className="flex items-center justify-center gap-1 text-xs mt-2 hover:underline w-full"
        style={{ color: theme.colors.accent }}
      >
        <ExternalLink className="w-3 h-3" />
        {badge.exampleConductor.name}
      </button>

      {/* Arrow pointing down */}
      <div
        className="absolute top-full w-0 h-0"
        style={{
          borderLeft: '6px solid transparent',
          borderRight: '6px solid transparent',
          borderTop: `6px solid ${theme.colors.border}`,
          ...getArrowStyles(),
        }}
      />
    </div>
  );
}

/**
 * Achievement card component for displaying in the About modal
 * Shows current badge, progress to next level, and stats
 */
export function AchievementCard({ theme, autoRunStats, globalStats, onEscapeWithBadgeOpen }: AchievementCardProps & { onEscapeWithBadgeOpen?: (handler: (() => boolean) | null) => void }) {
  const [selectedBadge, setSelectedBadge] = useState<number | null>(null);
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [shareMenuOpen, setShareMenuOpen] = useState(false);
  const [copySuccess, setCopySuccess] = useState(false);
  const badgeContainerRef = useRef<HTMLDivElement>(null);
  const shareMenuRef = useRef<HTMLDivElement>(null);

  // Register escape handler with parent when badge is selected
  useEffect(() => {
    if (onEscapeWithBadgeOpen) {
      if (selectedBadge !== null) {
        // Return a handler that closes the badge and returns true (handled)
        onEscapeWithBadgeOpen(() => {
          setSelectedBadge(null);
          return true;
        });
      } else {
        onEscapeWithBadgeOpen(null);
      }
    }
  }, [selectedBadge, onEscapeWithBadgeOpen]);

  // Handle click outside to close badge tooltip
  useEffect(() => {
    if (selectedBadge === null) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (badgeContainerRef.current && !badgeContainerRef.current.contains(e.target as Node)) {
        setSelectedBadge(null);
      }
    };

    // Use setTimeout to avoid immediate trigger from the click that opened it
    const timeoutId = setTimeout(() => {
      document.addEventListener('click', handleClickOutside);
    }, 0);

    return () => {
      clearTimeout(timeoutId);
      document.removeEventListener('click', handleClickOutside);
    };
  }, [selectedBadge]);

  // Determine tooltip position based on badge level
  const getTooltipPosition = (level: number): 'left' | 'center' | 'right' => {
    if (level <= 2) return 'left';
    if (level >= 10) return 'right';
    return 'center';
  };

  const currentBadge = getBadgeForTime(autoRunStats.cumulativeTimeMs);
  const nextBadge = getNextBadge(currentBadge);
  const progressPercent = getProgressToNextBadge(
    autoRunStats.cumulativeTimeMs,
    currentBadge,
    nextBadge
  );

  const currentLevel = currentBadge?.level || 0;
  const goldColor = '#FFD700';
  const purpleAccent = theme.colors.accent;

  // Close share menu when clicking outside
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

  // Helper to wrap text for canvas
  const wrapText = (ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] => {
    const words = text.split(' ');
    const lines: string[] = [];
    let currentLine = '';

    words.forEach(word => {
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

  // formatTokensCompact imported from ../utils/formatters

  // Generate shareable achievement card as canvas
  const generateShareImage = useCallback(async (): Promise<HTMLCanvasElement> => {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;

    const width = 600;
    const height = 380;
    canvas.width = width;
    canvas.height = height;

    // Background gradient matching app icon (radial gradient from center)
    const bgGradient = ctx.createRadialGradient(
      width / 2, height / 2, 0,
      width / 2, height / 2, width * 0.7
    );
    bgGradient.addColorStop(0, '#2d1f4e');  // Lighter purple center
    bgGradient.addColorStop(1, '#1a1a2e');  // Dark purple edges
    ctx.fillStyle = bgGradient;
    ctx.roundRect(0, 0, width, height, 20);
    ctx.fill();

    // Subtle gradient overlay for depth
    const overlayGradient = ctx.createLinearGradient(0, 0, 0, height);
    overlayGradient.addColorStop(0, 'rgba(139, 92, 246, 0.15)');
    overlayGradient.addColorStop(0.5, 'rgba(0, 0, 0, 0)');
    overlayGradient.addColorStop(1, 'rgba(0, 0, 0, 0.2)');
    ctx.fillStyle = overlayGradient;
    ctx.roundRect(0, 0, width, height, 20);
    ctx.fill();

    // Border with purple glow effect
    ctx.strokeStyle = '#8B5CF6';
    ctx.lineWidth = 2;
    ctx.roundRect(0, 0, width, height, 20);
    ctx.stroke();

    // Outer glow border
    ctx.strokeStyle = 'rgba(139, 92, 246, 0.3)';
    ctx.lineWidth = 4;
    ctx.roundRect(-2, -2, width + 4, height + 4, 22);
    ctx.stroke();

    // Trophy icon circle with gradient
    const trophyX = width / 2;
    const trophyY = 52;
    const trophyRadius = 32;

    ctx.beginPath();
    ctx.arc(trophyX, trophyY, trophyRadius, 0, Math.PI * 2);
    const trophyGradient = ctx.createRadialGradient(trophyX, trophyY - 10, 0, trophyX, trophyY, trophyRadius);
    trophyGradient.addColorStop(0, '#FFE066');
    trophyGradient.addColorStop(1, '#F59E0B');
    ctx.fillStyle = trophyGradient;
    ctx.fill();

    // Trophy emoji
    ctx.font = 'bold 32px system-ui';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#78350F';
    ctx.fillText('🏆', trophyX, trophyY + 2);

    // Title
    ctx.font = 'bold 18px system-ui';
    ctx.fillStyle = '#F472B6';  // Pink accent like in screenshots
    ctx.letterSpacing = '2px';
    ctx.fillText('MAESTRO ACHIEVEMENTS', width / 2, 105);

    if (currentBadge) {
      // Level indicator with stars
      ctx.font = 'bold 14px system-ui';
      ctx.fillStyle = goldColor;
      ctx.fillText(`★ Level ${currentBadge.level} of 11 ★`, width / 2, 130);

      // Badge name - larger and more prominent
      ctx.font = 'bold 26px system-ui';
      ctx.fillStyle = '#F472B6';
      ctx.fillText(currentBadge.name, width / 2, 162);

      // Flavor text in quotes
      ctx.font = 'italic 13px system-ui';
      ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
      const flavorLines = wrapText(ctx, `"${currentBadge.flavorText}"`, width - 100);
      let yOffset = 190;
      flavorLines.forEach(line => {
        ctx.fillText(line, width / 2, yOffset);
        yOffset += 18;
      });
    } else {
      // No badge yet
      ctx.font = 'bold 22px system-ui';
      ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
      ctx.fillText('Journey Just Beginning...', width / 2, 155);

      ctx.font = '14px system-ui';
      ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
      ctx.fillText('Complete 15 minutes of AutoRun to unlock first badge', width / 2, 185);
    }

    // Stats container with dark background
    const statsY = 240;
    const statsHeight = 85;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
    ctx.roundRect(30, statsY, width - 60, statsHeight, 12);
    ctx.fill();

    // Stats border
    ctx.strokeStyle = 'rgba(139, 92, 246, 0.3)';
    ctx.lineWidth = 1;
    ctx.roundRect(30, statsY, width - 60, statsHeight, 12);
    ctx.stroke();

    // Stats grid - 4 columns
    const statsColWidth = (width - 60) / 4;
    const statsCenterY = statsY + statsHeight / 2;

    // Helper to draw a stat
    const drawStat = (x: number, value: string, label: string) => {
      ctx.font = 'bold 20px system-ui';
      ctx.fillStyle = '#FFFFFF';
      ctx.textAlign = 'center';
      ctx.fillText(value, x, statsCenterY - 5);

      ctx.font = '11px system-ui';
      ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
      ctx.fillText(label, x, statsCenterY + 15);
    };

    // Column 1: Total AutoRun
    drawStat(30 + statsColWidth * 0.5, formatCumulativeTime(autoRunStats.cumulativeTimeMs), 'Total AutoRun');

    // Column 2: Longest Run
    drawStat(30 + statsColWidth * 1.5, formatCumulativeTime(autoRunStats.longestRunMs), 'Longest Run');

    // Column 3: Sessions (from globalStats)
    const sessionsValue = globalStats?.totalSessions?.toLocaleString() || '—';
    drawStat(30 + statsColWidth * 2.5, sessionsValue, 'Sessions');

    // Column 4: Total Tokens (from globalStats)
    const totalTokens = globalStats
      ? globalStats.totalInputTokens + globalStats.totalOutputTokens
      : 0;
    const tokensValue = totalTokens > 0 ? formatTokensCompact(totalTokens) : '—';
    drawStat(30 + statsColWidth * 3.5, tokensValue, 'Total Tokens');

    // Footer with branding and GitHub
    ctx.font = 'bold 11px system-ui';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.textAlign = 'center';
    ctx.fillText('MAESTRO • Agent Orchestration Command Center', width / 2, height - 30);

    // GitHub link
    ctx.font = '10px system-ui';
    ctx.fillStyle = 'rgba(139, 92, 246, 0.8)';
    ctx.fillText('github.com/pedramamini/Maestro', width / 2, height - 14);

    return canvas;
  }, [currentBadge, autoRunStats.cumulativeTimeMs, autoRunStats.longestRunMs, globalStats]);

  // Copy to clipboard
  const copyToClipboard = useCallback(async () => {
    try {
      const canvas = await generateShareImage();
      canvas.toBlob(async (blob) => {
        if (blob) {
          await navigator.clipboard.write([
            new ClipboardItem({ 'image/png': blob })
          ]);
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
      link.download = `maestro-achievement-level-${currentLevel}.png`;
      link.href = canvas.toDataURL('image/png');
      link.click();
    } catch (error) {
      console.error('Failed to download image:', error);
    }
  }, [generateShareImage, currentLevel]);

  return (
    <div
      className="p-4 rounded border"
      style={{
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.bgActivity,
      }}
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Trophy className="w-4 h-4" style={{ color: '#FFD700' }} />
          <span className="text-sm font-bold" style={{ color: theme.colors.textMain }}>
            Maestro Achievements
          </span>
        </div>

        {/* Share button */}
        <div className="relative" ref={shareMenuRef}>
          <button
            onClick={() => setShareMenuOpen(!shareMenuOpen)}
            className="p-1.5 rounded-md transition-colors hover:bg-white/10"
            style={{ color: theme.colors.textDim }}
            title="Share achievements"
          >
            <Share2 className="w-4 h-4" />
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
                onClick={() => {
                  copyToClipboard();
                  setShareMenuOpen(false);
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
      </div>

      {/* Current badge display */}
      <div className="flex items-center gap-4 mb-4">
        {/* Maestro icon with circular progress ring */}
        <div className="relative flex-shrink-0" style={{ width: 72, height: 72 }}>
          {/* Circular progress ring - 11 segments */}
          <BadgeProgressRing currentLevel={currentLevel} size={72} theme={theme} />

          {/* Inner circle with Maestro icon - always use dark bg with light silhouette for visibility */}
          <div
            className="absolute rounded-full flex items-center justify-center overflow-hidden"
            style={{
              top: 8,
              left: 8,
              width: 56,
              height: 56,
              background: currentLevel > 0 ? '#2d2d44' : theme.colors.bgMain,
              border: `2px solid ${currentLevel > 0 ? '#FFD700' : theme.colors.border}`,
            }}
          >
            <MaestroSilhouette
              variant="light"
              size={36}
              style={{ opacity: currentLevel > 0 ? 1 : 0.3 }}
            />
          </div>

          {/* Level number badge - positioned outside the ring */}
          {currentLevel > 0 && (
            <div
              className="absolute flex items-center justify-center text-xs font-bold"
              style={{
                top: -2,
                right: -2,
                width: 20,
                height: 20,
                borderRadius: '50%',
                background: 'linear-gradient(135deg, #FFD700 0%, #FFA500 100%)',
                color: '#000',
                boxShadow: '0 2px 4px rgba(0,0,0,0.3)',
              }}
            >
              {currentLevel}
            </div>
          )}
        </div>

        {/* Badge info */}
        <div className="flex-1 min-w-0">
          {currentBadge ? (
            <>
              <div className="font-medium truncate" style={{ color: theme.colors.textMain }}>
                {currentBadge.name}
              </div>
              <div className="text-xs" style={{ color: theme.colors.textDim }}>
                Level {currentBadge.level} of 11
              </div>
            </>
          ) : (
            <>
              <div className="font-medium" style={{ color: theme.colors.textDim }}>
                No Badge Yet
              </div>
              <div className="text-xs" style={{ color: theme.colors.textDim }}>
                Complete 15 minutes of AutoRun to unlock
              </div>
            </>
          )}
        </div>
      </div>

      {/* Progress bar to next level */}
      {nextBadge && (
        <div className="mb-4">
          <div className="flex items-center justify-between text-xs mb-1">
            <span style={{ color: theme.colors.textDim }}>
              Next: {nextBadge.shortName}
            </span>
            <span style={{ color: theme.colors.accent }}>
              {formatTimeRemaining(autoRunStats.cumulativeTimeMs, nextBadge)}
            </span>
          </div>
          <div
            className="h-2 rounded-full overflow-hidden"
            style={{ backgroundColor: theme.colors.bgMain }}
          >
            <div
              className="h-full rounded-full transition-all duration-500"
              style={{
                width: `${progressPercent}%`,
                background: `linear-gradient(90deg, ${theme.colors.accent} 0%, #FFD700 100%)`,
              }}
            />
          </div>
        </div>
      )}

      {/* Stats grid */}
      <div className="grid grid-cols-3 gap-2 mb-4">
        <div className="text-center p-2 rounded" style={{ backgroundColor: theme.colors.bgMain }}>
          <div className="flex items-center justify-center gap-1 mb-1">
            <Clock className="w-3 h-3" style={{ color: theme.colors.textDim }} />
          </div>
          <div className="text-xs font-mono font-bold" style={{ color: theme.colors.textMain }}>
            {formatCumulativeTime(autoRunStats.cumulativeTimeMs)}
          </div>
          <div className="text-xs" style={{ color: theme.colors.textDim }}>
            Total Time
          </div>
        </div>

        <div className="text-center p-2 rounded" style={{ backgroundColor: theme.colors.bgMain }}>
          <div className="flex items-center justify-center gap-1 mb-1">
            <Trophy className="w-3 h-3" style={{ color: '#FFD700' }} />
          </div>
          <div className="text-xs font-mono font-bold" style={{ color: theme.colors.textMain }}>
            {formatCumulativeTime(autoRunStats.longestRunMs)}
          </div>
          <div className="text-xs" style={{ color: theme.colors.textDim }}>
            Longest Run
          </div>
        </div>

        <div className="text-center p-2 rounded" style={{ backgroundColor: theme.colors.bgMain }}>
          <div className="flex items-center justify-center gap-1 mb-1">
            <Zap className="w-3 h-3" style={{ color: theme.colors.accent }} />
          </div>
          <div className="text-xs font-mono font-bold" style={{ color: theme.colors.textMain }}>
            {autoRunStats.totalRuns}
          </div>
          <div className="text-xs" style={{ color: theme.colors.textDim }}>
            Total Runs
          </div>
        </div>
      </div>

      {/* Badge progression preview */}
      <div ref={badgeContainerRef}>
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs" style={{ color: theme.colors.textDim }}>
            Badge Progression
          </span>
          <span className="text-xs" style={{ color: theme.colors.textDim }}>
            {currentLevel}/11 unlocked
          </span>
        </div>
        <div className="flex gap-1">
          {CONDUCTOR_BADGES.map((badge) => {
            const isUnlocked = badge.level <= currentLevel;
            const isCurrent = badge.level === currentLevel;
            const isSelected = selectedBadge === badge.level;

            return (
              <div
                key={badge.id}
                className="relative flex-1"
                onClick={() => setSelectedBadge(isSelected ? null : badge.level)}
              >
                <div
                  className="h-3 rounded-full cursor-pointer transition-all hover:scale-110"
                  style={{
                    backgroundColor: isUnlocked
                      ? badge.level <= 3
                        ? theme.colors.accent
                        : badge.level <= 7
                          ? '#FFD700'
                          : '#FF6B35'
                      : theme.colors.border,
                    opacity: isUnlocked ? 1 : 0.5,
                    border: isUnlocked ? 'none' : `1px dashed ${theme.colors.textDim}`,
                    boxShadow: isCurrent ? `0 0 0 2px ${theme.colors.bgActivity}, 0 0 0 4px #FFD700` : 'none',
                  }}
                  title={`${badge.name} - Click to view details`}
                />
                {isSelected && (
                  <BadgeTooltip
                    badge={badge}
                    theme={theme}
                    isUnlocked={isUnlocked}
                    position={getTooltipPosition(badge.level)}
                    onClose={() => setSelectedBadge(null)}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Badge Unlock History - only visible at level 2+ */}
      {autoRunStats.badgeHistory && autoRunStats.badgeHistory.length > 1 && (
        <div className="mt-3">
          <button
            onClick={() => setHistoryExpanded(!historyExpanded)}
            className="flex items-center gap-1.5 text-xs w-full hover:opacity-80 transition-opacity"
            style={{ color: theme.colors.textDim }}
          >
            <History className="w-3 h-3" />
            <span>Path to the Podium: Timeline</span>
            <ChevronDown
              className={`w-3 h-3 ml-auto transition-transform duration-200 ${
                historyExpanded ? 'rotate-180' : ''
              }`}
            />
          </button>
          {historyExpanded && (
            <div
              className="mt-2 p-2 rounded space-y-1.5 max-h-32 overflow-y-auto"
              style={{ backgroundColor: theme.colors.bgMain }}
            >
              {[...autoRunStats.badgeHistory]
                .sort((a, b) => a.level - b.level)
                .map((record) => {
                  const badge = CONDUCTOR_BADGES.find((b) => b.level === record.level);
                  if (!badge) return null;
                  return (
                    <div
                      key={record.level}
                      className="flex items-center justify-between text-xs"
                    >
                      <div className="flex items-center gap-2">
                        <div
                          className="w-4 h-4 rounded-full flex items-center justify-center text-[10px] font-bold"
                          style={{
                            background:
                              badge.level <= 3
                                ? theme.colors.accent
                                : badge.level <= 7
                                  ? '#FFD700'
                                  : '#FF6B35',
                            color: '#000',
                          }}
                        >
                          {badge.level}
                        </div>
                        <span style={{ color: theme.colors.textMain }}>{badge.shortName}</span>
                      </div>
                      <span style={{ color: theme.colors.textDim }}>
                        {new Date(record.unlockedAt).toLocaleDateString(undefined, {
                          month: 'short',
                          day: 'numeric',
                          year: 'numeric',
                        })}
                      </span>
                    </div>
                  );
                })}
            </div>
          )}
        </div>
      )}

      {/* Max level celebration */}
      {!nextBadge && currentBadge && (
        <div
          className="mt-4 p-3 rounded-lg text-center"
          style={{
            background: `linear-gradient(135deg, ${theme.colors.accent}20 0%, #FFD70020 100%)`,
            border: `1px solid #FFD700`,
          }}
        >
          <div className="flex items-center justify-center gap-2 mb-1">
            <Star className="w-4 h-4" style={{ color: '#FFD700' }} />
            <span className="font-bold" style={{ color: '#FFD700' }}>
              Maximum Level Achieved!
            </span>
            <Star className="w-4 h-4" style={{ color: '#FFD700' }} />
          </div>
          <p className="text-xs" style={{ color: theme.colors.textDim }}>
            You are a true Titan of the Baton
          </p>
        </div>
      )}
    </div>
  );
}

export default AchievementCard;
