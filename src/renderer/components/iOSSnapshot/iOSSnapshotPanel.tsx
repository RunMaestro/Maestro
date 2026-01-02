/**
 * iOSSnapshotPanel - Main panel component for iOS snapshot viewing.
 *
 * Combines SnapshotViewer and iOSLogViewer into a unified panel that can be
 * displayed in the Right Bar for iOS development sessions.
 *
 * Features:
 * - Screenshot display with zoom
 * - Log viewer with filtering
 * - Crash log summary
 * - Capture new snapshot button
 * - Snapshot history browsing
 */

import React, { useState, useCallback, useEffect, memo, useRef } from 'react';
import {
  Camera,
  RefreshCw,
  Trash2,
  Clock,
  AlertCircle,
  ChevronDown,
  Loader2,
  Smartphone,
} from 'lucide-react';
import type { Theme, Session } from '../../types';
import { SnapshotViewer } from './SnapshotViewer';
import { IOSLogViewer, type iOSLogEntry, type LogCounts } from './iOSLogViewer';

// Snapshot result type (matches ios-tools/snapshot.ts SnapshotResult)
export interface SnapshotData {
  id: string;
  timestamp: Date;
  simulator: {
    udid: string;
    name: string;
    iosVersion: string;
  };
  screenshot: {
    path: string;
    size: number;
  };
  logs: {
    entries: iOSLogEntry[];
    counts: LogCounts;
    filePath?: string;
  };
  crashes: {
    hasCrashes: boolean;
    reports: Array<{
      id: string;
      process: string;
      bundleId?: string;
      timestamp: Date;
      exceptionType?: string;
      exceptionMessage?: string;
      path: string;
    }>;
  };
  artifactDir: string;
}

export interface iOSSnapshotPanelProps {
  /** Current session */
  session: Session;
  /** Theme for styling */
  theme: Theme;
  /** Optional bundle ID to filter logs */
  bundleId?: string;
}

// Snapshot list item type
interface SnapshotListItem {
  id: string;
  timestamp: Date;
  screenshotPath: string;
}

/**
 * Format relative time (e.g., "2 min ago")
 */
function formatRelativeTime(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);

  if (diffSec < 60) return 'Just now';
  if (diffMin < 60) return `${diffMin} min ago`;
  if (diffHour < 24) return `${diffHour} hour${diffHour > 1 ? 's' : ''} ago`;
  return date.toLocaleDateString();
}

/**
 * iOS Snapshot Panel component
 */
export const iOSSnapshotPanel = memo(function iOSSnapshotPanel({
  session,
  theme,
  bundleId,
}: iOSSnapshotPanelProps) {
  const [snapshot, setSnapshot] = useState<SnapshotData | null>(null);
  const [snapshotList, setSnapshotList] = useState<SnapshotListItem[]>([]);
  const [isCapturing, setIsCapturing] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Load snapshot list on mount
  const loadSnapshotList = useCallback(async () => {
    try {
      const list = await window.maestro.ios.artifacts.list(session.id);
      if (list && Array.isArray(list)) {
        setSnapshotList(
          list.map((item: any) => ({
            id: item.id,
            timestamp: new Date(item.timestamp),
            screenshotPath: item.screenshotPath,
          }))
        );
      }
    } catch (err) {
      console.error('Failed to load snapshot list:', err);
    }
  }, [session.id]);

  // Load initial data
  useEffect(() => {
    const loadInitialData = async () => {
      setIsLoading(true);
      await loadSnapshotList();
      setIsLoading(false);
    };

    loadInitialData();
  }, [loadSnapshotList]);

  // Capture a new snapshot
  const captureSnapshot = useCallback(async () => {
    setIsCapturing(true);
    setError(null);

    try {
      const result = await window.maestro.ios.snapshot.capture({
        sessionId: session.id,
        bundleId,
        logDuration: 60,
        includeCrashContent: true,
      });

      if (result.success && result.data) {
        // Convert timestamp strings to Date objects
        const data = result.data;
        const snapshotData: SnapshotData = {
          ...data,
          timestamp: new Date(data.timestamp),
          logs: {
            ...data.logs,
            entries: data.logs.entries.map((entry: any) => ({
              ...entry,
              timestamp: new Date(entry.timestamp),
            })),
          },
          crashes: {
            ...data.crashes,
            reports: data.crashes.reports.map((report: any) => ({
              ...report,
              timestamp: new Date(report.timestamp),
            })),
          },
        };

        setSnapshot(snapshotData);
        await loadSnapshotList();
      } else {
        setError(result.error || 'Failed to capture snapshot');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setIsCapturing(false);
    }
  }, [session.id, bundleId, loadSnapshotList]);

  // Load a specific snapshot
  const loadSnapshot = useCallback(async (snapshotId: string) => {
    // For now, we just trigger a new capture since we don't have a load API
    // In a full implementation, this would load from the artifacts directory
    setShowHistory(false);
  }, []);

  // Cleanup old snapshots
  const cleanupSnapshots = useCallback(async () => {
    try {
      await window.maestro.ios.artifacts.prune(session.id, 10);
      await loadSnapshotList();
    } catch (err) {
      console.error('Failed to cleanup snapshots:', err);
    }
  }, [session.id, loadSnapshotList]);

  return (
    <div ref={containerRef} className="flex flex-col h-full space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between pt-2">
        <div className="flex items-center gap-2">
          <Smartphone className="w-4 h-4" style={{ color: theme.colors.accent }} />
          <span className="text-sm font-bold" style={{ color: theme.colors.textMain }}>
            iOS Snapshot
          </span>
        </div>

        <div className="flex items-center gap-2">
          {/* History dropdown */}
          {snapshotList.length > 0 && (
            <div className="relative">
              <button
                onClick={() => setShowHistory(!showHistory)}
                className="flex items-center gap-1 px-2 py-1 rounded text-xs transition-colors hover:bg-white/10"
                style={{ color: theme.colors.textDim }}
              >
                <Clock className="w-3 h-3" />
                <span>{snapshotList.length}</span>
                <ChevronDown className="w-3 h-3" />
              </button>

              {showHistory && (
                <div
                  className="absolute right-0 top-full mt-1 w-48 rounded border shadow-lg z-50"
                  style={{
                    backgroundColor: theme.colors.bgSidebar,
                    borderColor: theme.colors.border,
                  }}
                >
                  <div
                    className="px-3 py-2 text-[10px] uppercase font-bold border-b"
                    style={{ color: theme.colors.textDim, borderColor: theme.colors.border }}
                  >
                    Recent Snapshots
                  </div>
                  <div className="max-h-48 overflow-y-auto">
                    {snapshotList.map((item) => (
                      <button
                        key={item.id}
                        onClick={() => loadSnapshot(item.id)}
                        className="w-full px-3 py-2 text-left text-xs hover:bg-white/5 transition-colors"
                        style={{ color: theme.colors.textMain }}
                      >
                        <div className="truncate font-mono">{item.id}</div>
                        <div style={{ color: theme.colors.textDim }}>
                          {formatRelativeTime(item.timestamp)}
                        </div>
                      </button>
                    ))}
                  </div>
                  {snapshotList.length > 5 && (
                    <button
                      onClick={cleanupSnapshots}
                      className="w-full px-3 py-2 text-xs border-t hover:bg-white/5 transition-colors flex items-center gap-2"
                      style={{ color: theme.colors.textDim, borderColor: theme.colors.border }}
                    >
                      <Trash2 className="w-3 h-3" />
                      Clean up old snapshots
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Capture button */}
          <button
            onClick={captureSnapshot}
            disabled={isCapturing}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-bold transition-colors disabled:opacity-50"
            style={{
              backgroundColor: theme.colors.accent,
              color: '#fff',
            }}
          >
            {isCapturing ? (
              <>
                <Loader2 className="w-3 h-3 animate-spin" />
                <span>Capturing...</span>
              </>
            ) : (
              <>
                <Camera className="w-3 h-3" />
                <span>Capture</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* Error message */}
      {error && (
        <div
          className="flex items-start gap-2 p-3 rounded border"
          style={{
            backgroundColor: theme.colors.error + '10',
            borderColor: theme.colors.error + '40',
          }}
        >
          <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" style={{ color: theme.colors.error }} />
          <div>
            <p className="text-sm font-medium" style={{ color: theme.colors.error }}>
              Capture Failed
            </p>
            <p className="text-xs mt-0.5" style={{ color: theme.colors.textDim }}>
              {error}
            </p>
          </div>
        </div>
      )}

      {/* Loading state */}
      {isLoading && (
        <div
          className="flex items-center justify-center py-12"
          style={{ color: theme.colors.textDim }}
        >
          <Loader2 className="w-6 h-6 animate-spin" />
        </div>
      )}

      {/* No snapshot yet */}
      {!isLoading && !snapshot && !error && (
        <div
          className="flex flex-col items-center justify-center py-12 rounded border"
          style={{
            backgroundColor: theme.colors.bgActivity,
            borderColor: theme.colors.border,
          }}
        >
          <Camera className="w-12 h-12 mb-3" style={{ color: theme.colors.textDim }} />
          <p className="text-sm" style={{ color: theme.colors.textDim }}>
            No snapshot captured yet
          </p>
          <p className="text-xs mt-1 mb-4" style={{ color: theme.colors.textDim }}>
            Capture the current simulator state
          </p>
          <button
            onClick={captureSnapshot}
            disabled={isCapturing}
            className="flex items-center gap-1.5 px-4 py-2 rounded text-sm font-bold transition-colors"
            style={{
              backgroundColor: theme.colors.accent,
              color: '#fff',
            }}
          >
            <Camera className="w-4 h-4" />
            <span>Capture Snapshot</span>
          </button>
        </div>
      )}

      {/* Snapshot content */}
      {!isLoading && snapshot && (
        <div className="flex-1 overflow-y-auto space-y-4 scrollbar-thin">
          {/* Snapshot info header */}
          <div
            className="flex items-center justify-between px-3 py-2 rounded"
            style={{ backgroundColor: theme.colors.bgActivity }}
          >
            <div>
              <div className="text-xs font-bold" style={{ color: theme.colors.textMain }}>
                {snapshot.simulator.name}
              </div>
              <div className="text-[10px]" style={{ color: theme.colors.textDim }}>
                iOS {snapshot.simulator.iosVersion} • {formatRelativeTime(snapshot.timestamp)}
              </div>
            </div>
            <button
              onClick={captureSnapshot}
              disabled={isCapturing}
              className="p-1.5 rounded transition-colors hover:bg-white/10"
              style={{ color: theme.colors.textDim }}
              title="Refresh snapshot"
            >
              <RefreshCw className={`w-4 h-4 ${isCapturing ? 'animate-spin' : ''}`} />
            </button>
          </div>

          {/* Screenshot section */}
          <div>
            <div className="text-xs font-bold uppercase mb-2" style={{ color: theme.colors.textDim }}>
              Screenshot
            </div>
            <SnapshotViewer
              screenshotPath={snapshot.screenshot.path}
              screenshotSize={snapshot.screenshot.size}
              theme={theme}
              timestamp={snapshot.timestamp}
              simulatorName={snapshot.simulator.name}
            />
          </div>

          {/* Crash alerts */}
          {snapshot.crashes.hasCrashes && (
            <div
              className="p-3 rounded border"
              style={{
                backgroundColor: theme.colors.error + '10',
                borderColor: theme.colors.error + '40',
              }}
            >
              <div className="flex items-center gap-2 mb-2">
                <AlertCircle className="w-4 h-4" style={{ color: theme.colors.error }} />
                <span className="text-sm font-bold" style={{ color: theme.colors.error }}>
                  {snapshot.crashes.reports.length} Crash{snapshot.crashes.reports.length > 1 ? 'es' : ''} Detected
                </span>
              </div>
              <div className="space-y-2">
                {snapshot.crashes.reports.map((crash) => (
                  <div
                    key={crash.id}
                    className="p-2 rounded"
                    style={{ backgroundColor: theme.colors.bgActivity }}
                  >
                    <div className="text-xs font-bold" style={{ color: theme.colors.textMain }}>
                      {crash.process}
                    </div>
                    <div className="text-[10px]" style={{ color: theme.colors.textDim }}>
                      {crash.exceptionType}: {crash.exceptionMessage || 'No message'}
                    </div>
                    <div className="text-[10px] font-mono mt-1" style={{ color: theme.colors.textDim }}>
                      {crash.path}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Logs section */}
          <div>
            <div className="text-xs font-bold uppercase mb-2" style={{ color: theme.colors.textDim }}>
              System Logs
            </div>
            <IOSLogViewer
              entries={snapshot.logs.entries}
              counts={snapshot.logs.counts}
              logFilePath={snapshot.logs.filePath}
              theme={theme}
              maxHeight={300}
            />
          </div>
        </div>
      )}
    </div>
  );
});

export default iOSSnapshotPanel;
