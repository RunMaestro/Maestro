import React, { useEffect, useRef, useState, useCallback } from 'react';
import { X, Wand2, ExternalLink, FileCode, BarChart3, Loader2, Trophy, Globe, Check } from 'lucide-react';
import type { Theme, Session, AutoRunStats } from '../types';
import { useLayerStack } from '../contexts/LayerStackContext';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import pedramAvatar from '../assets/pedram-avatar.png';
import { AchievementCard } from './AchievementCard';
import { formatTokensCompact, formatSize } from '../utils/formatters';

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

interface AboutModalProps {
  theme: Theme;
  sessions: Session[];
  autoRunStats: AutoRunStats;
  onClose: () => void;
  onOpenLeaderboardRegistration?: () => void;
  isLeaderboardRegistered?: boolean;
}

export function AboutModal({ theme, sessions, autoRunStats, onClose, onOpenLeaderboardRegistration, isLeaderboardRegistered }: AboutModalProps) {
  const { registerLayer, unregisterLayer, updateLayerHandler } = useLayerStack();
  const layerIdRef = useRef<string>();
  const [globalStats, setGlobalStats] = useState<ClaudeGlobalStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [isStatsComplete, setIsStatsComplete] = useState(false);
  const badgeEscapeHandlerRef = useRef<(() => boolean) | null>(null);

  // Use ref to avoid re-registering layer when onClose changes
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Load global stats from all Claude projects on mount with streaming updates
  useEffect(() => {
    // Subscribe to streaming updates
    const unsubscribe = window.maestro.claude.onGlobalStatsUpdate((stats) => {
      setGlobalStats(stats);
      setLoading(false);
      if (stats.isComplete) {
        setIsStatsComplete(true);
      }
    });

    // Trigger the stats calculation (which will send streaming updates)
    window.maestro.claude.getGlobalStats().catch((error) => {
      console.error('Failed to load global Claude stats:', error);
      setLoading(false);
      setIsStatsComplete(true);
    });

    return () => {
      unsubscribe();
    };
  }, []);

  // Calculate active time from current sessions
  const totalActiveTimeMs = sessions.reduce((sum, s) => sum + (s.activeTimeMs || 0), 0);

  // formatTokensCompact and formatSize imported from ../utils/formatters

  // Format duration from milliseconds
  const formatDuration = (ms: number): string => {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
      return `${hours}h ${minutes % 60}m`;
    }
    if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    }
    return `${seconds}s`;
  };
  const containerRef = useRef<HTMLDivElement>(null);

  // Custom escape handler that checks for badge overlay first
  // Uses refs to avoid dependency changes that would cause infinite loops
  const handleEscape = useCallback(() => {
    // If badge overlay is open, close it first
    if (badgeEscapeHandlerRef.current) {
      badgeEscapeHandlerRef.current();
      return;
    }
    // Otherwise close the modal
    onCloseRef.current();
  }, []); // No dependencies - uses refs

  // Register layer on mount only
  useEffect(() => {
    const id = registerLayer({
      type: 'modal',
      priority: MODAL_PRIORITIES.ABOUT,
      blocksLowerLayers: true,
      capturesFocus: true,
      focusTrap: 'strict',
      ariaLabel: 'About Maestro',
      onEscape: handleEscape,
    });
    layerIdRef.current = id;

    // Auto-focus the container for immediate keyboard control
    containerRef.current?.focus();

    return () => {
      if (layerIdRef.current) {
        unregisterLayer(layerIdRef.current);
      }
    };
  }, [registerLayer, unregisterLayer, handleEscape]);

  return (
    <div
      ref={containerRef}
      className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-[9999] animate-in fade-in duration-200"
      role="dialog"
      aria-modal="true"
      aria-label="About Maestro"
      tabIndex={-1}
    >
      <div className="w-[450px] max-h-[90vh] border rounded-lg shadow-2xl overflow-hidden flex flex-col" style={{ backgroundColor: theme.colors.bgSidebar, borderColor: theme.colors.border }}>
        <div className="p-4 border-b flex items-center justify-between" style={{ borderColor: theme.colors.border }}>
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-bold" style={{ color: theme.colors.textMain }}>About Maestro</h2>
            <button
              onClick={() => window.maestro.shell.openExternal('https://runmaestro.ai')}
              className="p-1 rounded hover:bg-white/10 transition-colors"
              title="Visit runmaestro.ai"
              style={{ color: theme.colors.accent }}
            >
              <Globe className="w-4 h-4" />
            </button>
            <button
              onClick={() => window.maestro.shell.openExternal('https://discord.gg/86crXbGb')}
              className="p-1 rounded hover:bg-white/10 transition-colors"
              title="Join our Discord"
              style={{ color: theme.colors.accent }}
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/>
              </svg>
            </button>
          </div>
          <button onClick={onClose} style={{ color: theme.colors.textDim }}>
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-5 space-y-4 overflow-y-auto">
          {/* Logo and Title */}
          <div className="flex items-center gap-4">
            <Wand2 className="w-12 h-12" style={{ color: theme.colors.accent }} />
            <div>
              <div className="flex items-baseline gap-2">
                <h1 className="text-2xl font-bold tracking-widest" style={{ color: theme.colors.textMain }}>MAESTRO</h1>
                <span className="text-xs font-mono" style={{ color: theme.colors.textDim }}>v{__APP_VERSION__}</span>
              </div>
              <p className="text-xs opacity-70" style={{ color: theme.colors.textDim }}>Agent Orchestration Command Center</p>
            </div>
          </div>

          {/* Author Section */}
          <div className="flex items-center gap-4 p-4 rounded border" style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgActivity }}>
            <img
              src={pedramAvatar}
              alt="Pedram Amini"
              className="w-16 h-16 rounded-full border-2"
              style={{ borderColor: theme.colors.accent }}
            />
            <div className="flex-1">
              <div className="text-sm font-bold" style={{ color: theme.colors.textMain }}>Pedram Amini</div>
              <div className="text-xs opacity-70 mb-2" style={{ color: theme.colors.textDim }}>Founder, Hacker, Investor, Advisor</div>
              <div className="flex items-center gap-2 text-xs">
                <button
                  onClick={() => window.maestro.shell.openExternal('https://github.com/pedramamini')}
                  className="inline-flex items-center gap-1 hover:underline cursor-pointer"
                  style={{ color: theme.colors.accent, background: 'none', border: 'none', padding: 0 }}
                >
                  GitHub
                </button>
                <span style={{ color: theme.colors.textDim }}>·</span>
                <button
                  onClick={() => window.maestro.shell.openExternal('https://www.linkedin.com/in/pedramamini/')}
                  className="inline-flex items-center gap-1 hover:underline cursor-pointer"
                  style={{ color: theme.colors.accent, background: 'none', border: 'none', padding: 0 }}
                >
                  LinkedIn
                </button>
              </div>
            </div>
          </div>

          {/* Achievements Section */}
          <AchievementCard
            theme={theme}
            autoRunStats={autoRunStats}
            globalStats={globalStats}
            onEscapeWithBadgeOpen={(handler) => { badgeEscapeHandlerRef.current = handler; }}
          />

          {/* Global Usage Stats - show loading or stats from all Claude projects */}
          <div className="p-4 rounded border" style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgActivity }}>
            <div className="flex items-center gap-2 mb-3">
              <BarChart3 className="w-4 h-4" style={{ color: theme.colors.accent }} />
              <span className="text-sm font-bold" style={{ color: theme.colors.textMain }}>Global Statistics</span>
              {!isStatsComplete && (
                <Loader2 className="w-3 h-3 animate-spin" style={{ color: theme.colors.textDim }} />
              )}
            </div>
            {loading ? (
              <div className="flex items-center justify-center py-4 gap-2">
                <Loader2 className="w-4 h-4 animate-spin" style={{ color: theme.colors.textDim }} />
                <span className="text-xs" style={{ color: theme.colors.textDim }}>Loading stats...</span>
              </div>
            ) : globalStats ? (
              <div className="grid grid-cols-2 gap-3 text-xs">
                {/* Sessions & Messages */}
                <div className="flex justify-between">
                  <span style={{ color: theme.colors.textDim }}>Sessions</span>
                  <span className="font-mono font-bold" style={{ color: theme.colors.textMain }}>{formatTokensCompact(globalStats.totalSessions)}</span>
                </div>
                <div className="flex justify-between">
                  <span style={{ color: theme.colors.textDim }}>Messages</span>
                  <span className="font-mono font-bold" style={{ color: theme.colors.textMain }}>{formatTokensCompact(globalStats.totalMessages)}</span>
                </div>

                {/* Tokens */}
                <div className="flex justify-between">
                  <span style={{ color: theme.colors.textDim }}>Input Tokens</span>
                  <span className="font-mono font-bold" style={{ color: theme.colors.textMain }}>{formatTokensCompact(globalStats.totalInputTokens)}</span>
                </div>
                <div className="flex justify-between">
                  <span style={{ color: theme.colors.textDim }}>Output Tokens</span>
                  <span className="font-mono font-bold" style={{ color: theme.colors.textMain }}>{formatTokensCompact(globalStats.totalOutputTokens)}</span>
                </div>

                {/* Cache Tokens (if any) */}
                {(globalStats.totalCacheReadTokens > 0 || globalStats.totalCacheCreationTokens > 0) && (
                  <>
                    <div className="flex justify-between">
                      <span style={{ color: theme.colors.textDim }}>Cache Read</span>
                      <span className="font-mono font-bold" style={{ color: theme.colors.textMain }}>{formatTokensCompact(globalStats.totalCacheReadTokens)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span style={{ color: theme.colors.textDim }}>Cache Creation</span>
                      <span className="font-mono font-bold" style={{ color: theme.colors.textMain }}>{formatTokensCompact(globalStats.totalCacheCreationTokens)}</span>
                    </div>
                  </>
                )}

                {/* Active Time & Total Cost - merged into single line */}
                <div className="flex justify-between col-span-2 pt-2 border-t" style={{ borderColor: theme.colors.border }}>
                  {totalActiveTimeMs > 0 ? (
                    <>
                      <span style={{ color: theme.colors.textDim }}>{formatDuration(totalActiveTimeMs)}</span>
                      <span
                        className={`font-mono font-bold ${!isStatsComplete ? 'animate-pulse' : ''}`}
                        style={{ color: theme.colors.success }}
                      >
                        ${globalStats.totalCostUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </span>
                    </>
                  ) : (
                    <>
                      <span style={{ color: theme.colors.textDim }}>Total Cost</span>
                      <span
                        className={`font-mono font-bold ${!isStatsComplete ? 'animate-pulse' : ''}`}
                        style={{ color: theme.colors.success }}
                      >
                        ${globalStats.totalCostUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </span>
                    </>
                  )}
                </div>
              </div>
            ) : (
              <div className="text-xs text-center py-2" style={{ color: theme.colors.textDim }}>
                No Claude sessions found
              </div>
            )}
          </div>

          {/* Action Links */}
          <div className="flex gap-2">
            {/* Project Link */}
            <button
              onClick={() => window.maestro.shell.openExternal('https://github.com/pedramamini/Maestro')}
              className="flex-1 flex items-center justify-between p-3 rounded border hover:bg-white/5 transition-colors"
              style={{ borderColor: theme.colors.border }}
            >
              <div className="flex items-center gap-2">
                <FileCode className="w-4 h-4" style={{ color: theme.colors.accent }} />
                <span className="text-sm font-medium" style={{ color: theme.colors.textMain }}>GitHub</span>
              </div>
              <ExternalLink className="w-4 h-4" style={{ color: theme.colors.textDim }} />
            </button>

            {/* Leaderboard Registration */}
            {onOpenLeaderboardRegistration && (
              <button
                onClick={onOpenLeaderboardRegistration}
                className="flex-1 flex items-center justify-between p-3 rounded border hover:bg-white/5 transition-colors"
                style={{
                  borderColor: isLeaderboardRegistered ? theme.colors.success : theme.colors.accent,
                  backgroundColor: isLeaderboardRegistered ? `${theme.colors.success}10` : undefined,
                }}
              >
                <div className="flex items-center gap-2">
                  <Trophy className="w-4 h-4" style={{ color: isLeaderboardRegistered ? theme.colors.success : '#FFD700' }} />
                  <span className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
                    {isLeaderboardRegistered ? 'Leaderboard' : 'Join Leaderboard'}
                  </span>
                </div>
                {isLeaderboardRegistered ? (
                  <Check className="w-4 h-4" style={{ color: theme.colors.success }} />
                ) : (
                  <ExternalLink className="w-4 h-4" style={{ color: theme.colors.textDim }} />
                )}
              </button>
            )}
          </div>

          {/* Made in Austin */}
          <div className="pt-1 text-center flex flex-col items-center gap-1">
            <span className="text-xs mb-1" style={{ color: theme.colors.textDim }}>Made in Austin, TX</span>
            {/* Texas Flag - Lone Star Flag */}
            <button
              onClick={() => window.maestro.shell.openExternal('https://www.sanjacsaloon.com')}
              className="hover:opacity-100 transition-opacity cursor-pointer"
              style={{ background: 'none', border: 'none', padding: 0 }}
            >
              <svg
                viewBox="0 0 150 100"
                className="w-12 h-8"
                style={{ opacity: 0.7 }}
              >
                {/* Blue vertical stripe */}
                <rect x="0" y="0" width="50" height="100" fill="#002868" />
                {/* White horizontal stripe */}
                <rect x="50" y="0" width="100" height="50" fill="#FFFFFF" />
                {/* Red horizontal stripe */}
                <rect x="50" y="50" width="100" height="50" fill="#BF0A30" />
                {/* White five-pointed star */}
                <polygon
                  points="25,15 29.5,30 45,30 32.5,40 37,55 25,45 13,55 17.5,40 5,30 20.5,30"
                  fill="#FFFFFF"
                />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
