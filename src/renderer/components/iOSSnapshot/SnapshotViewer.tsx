/**
 * SnapshotViewer - Displays iOS simulator screenshots with zoom and pan support.
 *
 * Features:
 * - Image display with fit-to-container sizing
 * - Click-to-zoom lightbox modal
 * - Error state handling for missing/invalid images
 * - Theme-aware styling
 */

import React, { useState, useCallback, memo } from 'react';
import { Image, ZoomIn, AlertCircle, ExternalLink } from 'lucide-react';
import type { Theme } from '../../types';
import { LightboxModal } from '../LightboxModal';

export interface SnapshotViewerProps {
  /** Path to the screenshot image */
  screenshotPath: string | null;
  /** File size in bytes */
  screenshotSize?: number;
  /** Theme for styling */
  theme: Theme;
  /** Optional timestamp for the screenshot */
  timestamp?: Date;
  /** Simulator name for display */
  simulatorName?: string;
}

/**
 * Format file size in human-readable format
 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Component for displaying iOS simulator screenshots
 */
export const SnapshotViewer = memo(function SnapshotViewer({
  screenshotPath,
  screenshotSize,
  theme,
  timestamp,
  simulatorName,
}: SnapshotViewerProps) {
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [imageError, setImageError] = useState(false);
  const [imageLoaded, setImageLoaded] = useState(false);

  // Handle image load error
  const handleImageError = useCallback(() => {
    setImageError(true);
    setImageLoaded(true);
  }, []);

  // Handle image load success
  const handleImageLoad = useCallback(() => {
    setImageError(false);
    setImageLoaded(true);
  }, []);

  // Open in system viewer
  const handleOpenExternal = useCallback(() => {
    if (screenshotPath) {
      window.maestro.shell.openExternal(`file://${screenshotPath}`);
    }
  }, [screenshotPath]);

  // No screenshot case
  if (!screenshotPath) {
    return (
      <div
        className="flex flex-col items-center justify-center py-8 rounded border"
        style={{
          backgroundColor: theme.colors.bgActivity,
          borderColor: theme.colors.border,
        }}
      >
        <Image
          className="w-12 h-12 mb-3"
          style={{ color: theme.colors.textDim }}
        />
        <p className="text-sm" style={{ color: theme.colors.textDim }}>
          No screenshot captured
        </p>
        <p className="text-xs mt-1" style={{ color: theme.colors.textDim }}>
          Run /ios.snapshot to capture the current screen
        </p>
      </div>
    );
  }

  // Error loading image
  if (imageError) {
    return (
      <div
        className="flex flex-col items-center justify-center py-8 rounded border"
        style={{
          backgroundColor: theme.colors.error + '10',
          borderColor: theme.colors.error + '40',
        }}
      >
        <AlertCircle
          className="w-12 h-12 mb-3"
          style={{ color: theme.colors.error }}
        />
        <p className="text-sm" style={{ color: theme.colors.error }}>
          Failed to load screenshot
        </p>
        <p className="text-xs mt-1" style={{ color: theme.colors.textDim }}>
          {screenshotPath}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {/* Image container with click-to-zoom */}
      <div
        className="relative rounded border overflow-hidden cursor-zoom-in group"
        style={{ borderColor: theme.colors.border }}
        onClick={() => setLightboxOpen(true)}
      >
        {/* Loading placeholder */}
        {!imageLoaded && (
          <div
            className="absolute inset-0 flex items-center justify-center"
            style={{ backgroundColor: theme.colors.bgActivity }}
          >
            <div
              className="animate-pulse text-sm"
              style={{ color: theme.colors.textDim }}
            >
              Loading...
            </div>
          </div>
        )}

        {/* Screenshot image */}
        <img
          src={`file://${screenshotPath}`}
          alt={`Screenshot from ${simulatorName || 'simulator'}`}
          className="w-full h-auto max-h-[400px] object-contain"
          style={{
            backgroundColor: theme.colors.bgActivity,
            opacity: imageLoaded ? 1 : 0,
          }}
          onLoad={handleImageLoad}
          onError={handleImageError}
        />

        {/* Zoom overlay on hover */}
        <div
          className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
          style={{ backgroundColor: 'rgba(0, 0, 0, 0.4)' }}
        >
          <div
            className="flex items-center gap-2 px-3 py-1.5 rounded-full"
            style={{
              backgroundColor: theme.colors.accent,
              color: '#fff',
            }}
          >
            <ZoomIn className="w-4 h-4" />
            <span className="text-xs font-medium">Click to enlarge</span>
          </div>
        </div>
      </div>

      {/* Metadata row */}
      <div className="flex items-center justify-between px-1">
        <div className="flex items-center gap-3">
          {/* File size */}
          {screenshotSize && (
            <span className="text-xs" style={{ color: theme.colors.textDim }}>
              {formatFileSize(screenshotSize)}
            </span>
          )}

          {/* Timestamp */}
          {timestamp && (
            <span className="text-xs" style={{ color: theme.colors.textDim }}>
              {timestamp.toLocaleTimeString()}
            </span>
          )}
        </div>

        {/* Open in external viewer button */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            handleOpenExternal();
          }}
          className="flex items-center gap-1 px-2 py-1 rounded text-xs transition-colors hover:bg-white/10"
          style={{ color: theme.colors.accent }}
          title="Open in system viewer"
        >
          <ExternalLink className="w-3 h-3" />
          <span>Open</span>
        </button>
      </div>

      {/* Lightbox modal */}
      {lightboxOpen && (
        <LightboxModal
          image={`file://${screenshotPath}`}
          stagedImages={[`file://${screenshotPath}`]}
          onClose={() => setLightboxOpen(false)}
          onNavigate={() => {}} // Single image, no navigation
          theme={theme}
        />
      )}
    </div>
  );
});

export default SnapshotViewer;
