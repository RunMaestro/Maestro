import React, { useEffect, useRef, useState, useCallback } from 'react';
import { X, Download, ExternalLink, Loader2, CheckCircle2, AlertCircle, RefreshCw, ChevronDown, ChevronRight } from 'lucide-react';
import type { Theme } from '../types';
import { useLayerStack } from '../contexts/LayerStackContext';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import ReactMarkdown from 'react-markdown';

interface Release {
  tag_name: string;
  name: string;
  body: string;
  html_url: string;
  published_at: string;
}

interface UpdateCheckResult {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  versionsBehind: number;
  releases: Release[];
  releasesUrl: string;
  error?: string;
}

interface UpdateCheckModalProps {
  theme: Theme;
  onClose: () => void;
}

export function UpdateCheckModal({ theme, onClose }: UpdateCheckModalProps) {
  const { registerLayer, unregisterLayer } = useLayerStack();
  const layerIdRef = useRef<string>();
  const containerRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [result, setResult] = useState<UpdateCheckResult | null>(null);
  const [expandedReleases, setExpandedReleases] = useState<Set<string>>(new Set());

  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Check for updates on mount
  useEffect(() => {
    checkForUpdates();
  }, []);

  const checkForUpdates = async () => {
    setLoading(true);
    try {
      const updateResult = await window.maestro.updates.check();
      setResult(updateResult);
      // Auto-expand if only 1 version behind, otherwise keep all collapsed
      if (updateResult.updateAvailable && updateResult.releases.length === 1) {
        setExpandedReleases(new Set([updateResult.releases[0].tag_name]));
      } else {
        setExpandedReleases(new Set());
      }
    } catch (error) {
      setResult({
        currentVersion: __APP_VERSION__,
        latestVersion: __APP_VERSION__,
        updateAvailable: false,
        versionsBehind: 0,
        releases: [],
        releasesUrl: 'https://github.com/pedramamini/Maestro/releases',
        error: error instanceof Error ? error.message : 'Failed to check for updates',
      });
    } finally {
      setLoading(false);
    }
  };

  const toggleRelease = (tagName: string) => {
    setExpandedReleases(prev => {
      const next = new Set(prev);
      if (next.has(tagName)) {
        next.delete(tagName);
      } else {
        next.add(tagName);
      }
      return next;
    });
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  // Register layer on mount
  useEffect(() => {
    const id = registerLayer({
      type: 'modal',
      priority: MODAL_PRIORITIES.UPDATE_CHECK,
      blocksLowerLayers: true,
      capturesFocus: true,
      focusTrap: 'strict',
      ariaLabel: 'Check for Updates',
      onEscape: () => onCloseRef.current(),
    });
    layerIdRef.current = id;

    containerRef.current?.focus();

    return () => {
      if (layerIdRef.current) {
        unregisterLayer(layerIdRef.current);
      }
    };
  }, [registerLayer, unregisterLayer]);

  return (
    <div
      ref={containerRef}
      className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-[9999] animate-in fade-in duration-200"
      role="dialog"
      aria-modal="true"
      aria-label="Check for Updates"
      tabIndex={-1}
    >
      <div
        className="w-[500px] max-h-[80vh] border rounded-lg shadow-2xl overflow-hidden flex flex-col"
        style={{ backgroundColor: theme.colors.bgSidebar, borderColor: theme.colors.border }}
      >
        {/* Header */}
        <div
          className="p-4 border-b flex items-center justify-between shrink-0"
          style={{ borderColor: theme.colors.border }}
        >
          <div className="flex items-center gap-2">
            <Download className="w-5 h-5" style={{ color: theme.colors.accent }} />
            <h2 className="text-sm font-bold" style={{ color: theme.colors.textMain }}>
              Check for Updates
            </h2>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={checkForUpdates}
              disabled={loading}
              className="p-1 rounded hover:bg-white/10 transition-colors disabled:opacity-50"
              title="Refresh"
            >
              <RefreshCw
                className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`}
                style={{ color: theme.colors.textDim }}
              />
            </button>
            <button
              onClick={onClose}
              className="p-1 rounded hover:bg-white/10 transition-colors"
              style={{ color: theme.colors.textDim }}
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="p-5 space-y-4 overflow-y-auto flex-1">
          {loading ? (
            <div className="flex flex-col items-center justify-center py-8 gap-3">
              <Loader2 className="w-8 h-8 animate-spin" style={{ color: theme.colors.accent }} />
              <span className="text-sm" style={{ color: theme.colors.textDim }}>
                Checking for updates...
              </span>
            </div>
          ) : result?.error ? (
            <div className="flex flex-col items-center justify-center py-8 gap-3">
              <AlertCircle className="w-8 h-8" style={{ color: theme.colors.error }} />
              <span className="text-sm text-center" style={{ color: theme.colors.textDim }}>
                {result.error}
              </span>
              <button
                onClick={() => window.maestro.shell.openExternal(result.releasesUrl)}
                className="flex items-center gap-2 text-sm hover:underline"
                style={{ color: theme.colors.accent }}
              >
                Check releases manually
                <ExternalLink className="w-3 h-3" />
              </button>
            </div>
          ) : result?.updateAvailable ? (
            <>
              {/* Update Available Banner */}
              <div
                className="p-4 rounded-lg border"
                style={{
                  backgroundColor: `${theme.colors.warning}15`,
                  borderColor: theme.colors.warning,
                }}
              >
                <div className="flex items-start gap-3">
                  <Download className="w-5 h-5 mt-0.5" style={{ color: theme.colors.warning }} />
                  <div className="flex-1">
                    <div className="text-sm font-bold mb-1" style={{ color: theme.colors.textMain }}>
                      Update Available!
                    </div>
                    <div className="text-xs mb-2" style={{ color: theme.colors.textDim }}>
                      You are <span className="font-bold" style={{ color: theme.colors.warning }}>
                        {result.versionsBehind} version{result.versionsBehind !== 1 ? 's' : ''}
                      </span> behind the latest release.
                    </div>
                    <div className="text-xs font-mono" style={{ color: theme.colors.textDim }}>
                      Current: v{result.currentVersion} → Latest: v{result.latestVersion}
                    </div>
                  </div>
                </div>
              </div>

              {/* Upgrade Instructions */}
              <div
                className="p-4 rounded border"
                style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgActivity }}
              >
                <div className="text-sm font-bold mb-2" style={{ color: theme.colors.textMain }}>
                  How to Upgrade
                </div>
                <div className="text-xs space-y-1" style={{ color: theme.colors.textDim }}>
                  <p>Upgrading is simple - just download and replace the app binary:</p>
                  <ol className="list-decimal list-inside ml-2 space-y-1">
                    <li>Download the latest release for your platform</li>
                    <li>Replace the existing Maestro app</li>
                    <li>Restart Maestro</li>
                  </ol>
                  <p className="mt-2 pt-2 border-t" style={{ borderColor: theme.colors.border, color: theme.colors.success }}>
                    All your data (sessions, settings, history) will persist automatically.
                  </p>
                </div>
              </div>

              {/* Release Notes */}
              <div>
                <div className="text-sm font-bold mb-3" style={{ color: theme.colors.textMain }}>
                  Release Notes
                </div>
                <div className="space-y-2">
                  {result.releases.map((release) => (
                    <div
                      key={release.tag_name}
                      className="border rounded overflow-hidden"
                      style={{ borderColor: theme.colors.border }}
                    >
                      <button
                        onClick={() => toggleRelease(release.tag_name)}
                        className="w-full flex items-center justify-between p-3 hover:bg-white/5 transition-colors text-left"
                        style={{ backgroundColor: theme.colors.bgActivity }}
                      >
                        <div className="flex items-center gap-2">
                          {expandedReleases.has(release.tag_name) ? (
                            <ChevronDown className="w-4 h-4" style={{ color: theme.colors.textDim }} />
                          ) : (
                            <ChevronRight className="w-4 h-4" style={{ color: theme.colors.textDim }} />
                          )}
                          <span className="font-mono font-bold text-sm" style={{ color: theme.colors.accent }}>
                            {release.tag_name}
                          </span>
                          {release.name && release.name !== release.tag_name && (
                            <span className="text-xs" style={{ color: theme.colors.textDim }}>
                              - {release.name}
                            </span>
                          )}
                        </div>
                        <span className="text-xs" style={{ color: theme.colors.textDim }}>
                          {formatDate(release.published_at)}
                        </span>
                      </button>
                      {expandedReleases.has(release.tag_name) && (
                        <div
                          className="p-3 border-t text-xs prose prose-sm prose-invert max-w-none"
                          style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
                        >
                          <ReactMarkdown
                            components={{
                              h1: ({ children }) => <h1 className="text-base font-bold mt-3 mb-2" style={{ color: theme.colors.textMain }}>{children}</h1>,
                              h2: ({ children }) => <h2 className="text-sm font-bold mt-3 mb-2" style={{ color: theme.colors.textMain }}>{children}</h2>,
                              h3: ({ children }) => <h3 className="text-xs font-bold mt-2 mb-1" style={{ color: theme.colors.textMain }}>{children}</h3>,
                              p: ({ children }) => <p className="my-1.5" style={{ color: theme.colors.textDim }}>{children}</p>,
                              ul: ({ children }) => <ul className="list-disc list-inside my-1.5 space-y-0.5">{children}</ul>,
                              ol: ({ children }) => <ol className="list-decimal list-inside my-1.5 space-y-0.5">{children}</ol>,
                              li: ({ children }) => <li style={{ color: theme.colors.textDim }}>{children}</li>,
                              code: ({ children }) => (
                                <code
                                  className="px-1 py-0.5 rounded font-mono text-xs"
                                  style={{ backgroundColor: theme.colors.bgMain, color: theme.colors.accent }}
                                >
                                  {children}
                                </code>
                              ),
                              a: ({ href, children }) => (
                                <a
                                  href={href}
                                  onClick={(e) => {
                                    e.preventDefault();
                                    if (href) window.maestro.shell.openExternal(href);
                                  }}
                                  className="hover:underline cursor-pointer"
                                  style={{ color: theme.colors.accent }}
                                >
                                  {children}
                                </a>
                              ),
                            }}
                          >
                            {release.body || 'No release notes available.'}
                          </ReactMarkdown>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              {/* Download Button */}
              <button
                onClick={() => window.maestro.shell.openExternal(result.releasesUrl)}
                className="w-full flex items-center justify-center gap-2 p-3 rounded-lg font-bold text-sm transition-colors hover:opacity-90"
                style={{ backgroundColor: theme.colors.accent, color: theme.colors.bgMain }}
              >
                <Download className="w-4 h-4" />
                Download Latest Release
                <ExternalLink className="w-3 h-3" />
              </button>
            </>
          ) : (
            <div className="flex flex-col items-center justify-center py-8 gap-3">
              <CheckCircle2 className="w-12 h-12" style={{ color: theme.colors.success }} />
              <div className="text-center">
                <div className="text-sm font-bold mb-1" style={{ color: theme.colors.textMain }}>
                  You're up to date!
                </div>
                <div className="text-xs font-mono" style={{ color: theme.colors.textDim }}>
                  Maestro v{result?.currentVersion || __APP_VERSION__}
                </div>
              </div>
              <button
                onClick={() => window.maestro.shell.openExternal(result?.releasesUrl || 'https://github.com/pedramamini/Maestro/releases')}
                className="flex items-center gap-2 text-xs hover:underline mt-2"
                style={{ color: theme.colors.accent }}
              >
                View all releases
                <ExternalLink className="w-3 h-3" />
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
