import { useState, useEffect, useRef } from 'react';
import { X, GitPullRequest, Loader2, AlertTriangle, ExternalLink } from 'lucide-react';
import type { Theme, GhCliStatus } from '../types';
import { useLayerStack } from '../contexts/LayerStackContext';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';

export interface PRDetails {
  url: string;
  title: string;
  description: string;
  sourceBranch: string;
  targetBranch: string;
}

interface CreatePRModalProps {
  isOpen: boolean;
  onClose: () => void;
  theme: Theme;
  // Worktree info
  worktreePath: string;
  worktreeBranch: string;
  // Available branches for target selection
  availableBranches: string[];
  // Callback when PR is created
  onPRCreated?: (details: PRDetails) => void;
}

/**
 * CreatePRModal - Modal for creating a pull request from a worktree branch
 *
 * Features:
 * - Branch selector with main/master as default
 * - Title input (auto-populated from branch name)
 * - Optional description
 * - gh CLI status checking
 * - Progress indicator during PR creation
 */
export function CreatePRModal({
  isOpen,
  onClose,
  theme,
  worktreePath,
  worktreeBranch,
  availableBranches,
  onPRCreated,
}: CreatePRModalProps) {
  const { registerLayer, unregisterLayer } = useLayerStack();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Form state
  const [targetBranch, setTargetBranch] = useState('main');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');

  // Status state
  const [ghCliStatus, setGhCliStatus] = useState<GhCliStatus | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasUncommittedChanges, setHasUncommittedChanges] = useState(false);
  const [uncommittedCount, setUncommittedCount] = useState(0);

  // Register with layer stack for Escape handling
  useEffect(() => {
    if (isOpen) {
      const id = registerLayer({
        type: 'modal',
        priority: MODAL_PRIORITIES.CREATE_PR,
        onEscape: () => onCloseRef.current(),
        blocksLowerLayers: true,
        capturesFocus: true,
        focusTrap: 'lenient',
      });
      return () => unregisterLayer(id);
    }
  }, [isOpen, registerLayer, unregisterLayer]);

  // Check gh CLI status and uncommitted changes on mount
  useEffect(() => {
    if (isOpen) {
      checkGhCli();
      checkUncommittedChanges();
      // Auto-populate title from branch name
      const branchTitle = worktreeBranch
        .replace(/[-_]/g, ' ')
        .replace(/^(feat|fix|chore|docs|refactor|test|style)[\s:]/i, '$1: ')
        .trim();
      setTitle(branchTitle || worktreeBranch);
    }
  }, [isOpen, worktreeBranch, worktreePath]);

  // Set default target branch (prefer main, fallback to master)
  useEffect(() => {
    if (isOpen && availableBranches.length > 0) {
      if (availableBranches.includes('main')) {
        setTargetBranch('main');
      } else if (availableBranches.includes('master')) {
        setTargetBranch('master');
      } else {
        setTargetBranch(availableBranches[0]);
      }
    }
  }, [isOpen, availableBranches]);

  const checkGhCli = async () => {
    try {
      const status = await window.maestro.git.checkGhCli();
      setGhCliStatus(status);
    } catch (err) {
      setGhCliStatus({ installed: false, authenticated: false });
    }
  };

  const checkUncommittedChanges = async () => {
    try {
      const result = await window.maestro.git.status(worktreePath);
      const lines = result.stdout.trim().split('\n').filter((line: string) => line.length > 0);
      setUncommittedCount(lines.length);
      setHasUncommittedChanges(lines.length > 0);
    } catch (err) {
      setHasUncommittedChanges(false);
      setUncommittedCount(0);
    }
  };

  const handleCreatePR = async () => {
    if (!ghCliStatus?.authenticated) return;

    setIsCreating(true);
    setError(null);

    try {
      const result = await window.maestro.git.createPR(
        worktreePath,
        targetBranch,
        title,
        description
      );

      if (result.success && result.prUrl) {
        onPRCreated?.({
          url: result.prUrl,
          title,
          description,
          sourceBranch: worktreeBranch,
          targetBranch,
        });
        onClose();
      } else {
        setError(result.error || 'Failed to create PR');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create PR');
    } finally {
      setIsCreating(false);
    }
  };

  if (!isOpen) return null;

  const canCreate = ghCliStatus?.authenticated && title.trim() && !isCreating;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60"
        onClick={onClose}
      />

      {/* Modal */}
      <div
        className="relative w-full max-w-md rounded-lg shadow-2xl border"
        style={{
          backgroundColor: theme.colors.bgSidebar,
          borderColor: theme.colors.border,
        }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-4 py-3 border-b"
          style={{ borderColor: theme.colors.border }}
        >
          <div className="flex items-center gap-2">
            <GitPullRequest className="w-5 h-5" style={{ color: theme.colors.accent }} />
            <h2 className="font-bold" style={{ color: theme.colors.textMain }}>
              Create Pull Request
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-white/10 transition-colors"
          >
            <X className="w-4 h-4" style={{ color: theme.colors.textDim }} />
          </button>
        </div>

        {/* Content */}
        <div className="p-4 space-y-4">
          {/* gh CLI not installed */}
          {ghCliStatus !== null && !ghCliStatus.installed && (
            <div
              className="flex items-start gap-2 p-3 rounded border"
              style={{
                backgroundColor: theme.colors.warning + '10',
                borderColor: theme.colors.warning,
              }}
            >
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" style={{ color: theme.colors.warning }} />
              <div className="text-sm">
                <p style={{ color: theme.colors.warning }}>GitHub CLI not installed</p>
                <p className="mt-1" style={{ color: theme.colors.textDim }}>
                  Install{' '}
                  <a
                    href="https://cli.github.com"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline hover:opacity-80"
                    style={{ color: theme.colors.accent }}
                  >
                    GitHub CLI
                  </a>
                  {' '}to create pull requests.
                </p>
              </div>
            </div>
          )}

          {/* gh CLI not authenticated */}
          {ghCliStatus?.installed && !ghCliStatus.authenticated && (
            <div
              className="flex items-start gap-2 p-3 rounded border"
              style={{
                backgroundColor: theme.colors.warning + '10',
                borderColor: theme.colors.warning,
              }}
            >
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" style={{ color: theme.colors.warning }} />
              <div className="text-sm">
                <p style={{ color: theme.colors.warning }}>GitHub CLI not authenticated</p>
                <p className="mt-1" style={{ color: theme.colors.textDim }}>
                  Run{' '}
                  <code
                    className="px-1 py-0.5 rounded"
                    style={{ backgroundColor: theme.colors.bgActivity }}
                  >
                    gh auth login
                  </code>
                  {' '}in your terminal to authenticate.
                </p>
              </div>
            </div>
          )}

          {/* Still checking gh CLI */}
          {ghCliStatus === null && (
            <div className="flex items-center gap-2 text-sm" style={{ color: theme.colors.textDim }}>
              <Loader2 className="w-4 h-4 animate-spin" />
              Checking GitHub CLI...
            </div>
          )}

          {/* Form (only shown when gh CLI is authenticated) */}
          {ghCliStatus?.authenticated && (
            <>
              {/* Uncommitted changes warning */}
              {hasUncommittedChanges && (
                <div
                  className="flex items-start gap-2 p-3 rounded border"
                  style={{
                    backgroundColor: theme.colors.warning + '10',
                    borderColor: theme.colors.warning,
                  }}
                >
                  <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" style={{ color: theme.colors.warning }} />
                  <div className="text-sm">
                    <p style={{ color: theme.colors.warning }}>
                      {uncommittedCount} uncommitted change{uncommittedCount !== 1 ? 's' : ''}
                    </p>
                    <p className="mt-1" style={{ color: theme.colors.textDim }}>
                      Only committed changes will be included in the PR. Uncommitted changes will not be pushed.
                    </p>
                  </div>
                </div>
              )}

              {/* From branch (read-only) */}
              <div>
                <label className="text-xs font-medium mb-1.5 block" style={{ color: theme.colors.textDim }}>
                  From Branch
                </label>
                <div
                  className="px-3 py-2 rounded border text-sm"
                  style={{
                    borderColor: theme.colors.border,
                    color: theme.colors.textMain,
                    backgroundColor: theme.colors.bgActivity,
                  }}
                >
                  {worktreeBranch}
                </div>
              </div>

              {/* Target branch */}
              <div>
                <label className="text-xs font-medium mb-1.5 block" style={{ color: theme.colors.textDim }}>
                  Target Branch
                </label>
                <select
                  value={targetBranch}
                  onChange={(e) => setTargetBranch(e.target.value)}
                  className="w-full px-3 py-2 rounded border bg-transparent outline-none text-sm cursor-pointer"
                  style={{
                    borderColor: theme.colors.border,
                    color: theme.colors.textMain,
                  }}
                >
                  {availableBranches.map((branch) => (
                    <option key={branch} value={branch} style={{ backgroundColor: theme.colors.bgSidebar }}>
                      {branch}
                    </option>
                  ))}
                </select>
              </div>

              {/* Title */}
              <div>
                <label className="text-xs font-medium mb-1.5 block" style={{ color: theme.colors.textDim }}>
                  Title
                </label>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="PR title..."
                  className="w-full px-3 py-2 rounded border bg-transparent outline-none text-sm"
                  style={{
                    borderColor: theme.colors.border,
                    color: theme.colors.textMain,
                  }}
                />
              </div>

              {/* Description */}
              <div>
                <label className="text-xs font-medium mb-1.5 block" style={{ color: theme.colors.textDim }}>
                  Description <span className="opacity-50">(optional)</span>
                </label>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Add a description..."
                  rows={3}
                  className="w-full px-3 py-2 rounded border bg-transparent outline-none text-sm resize-none"
                  style={{
                    borderColor: theme.colors.border,
                    color: theme.colors.textMain,
                  }}
                />
              </div>

              {/* Error message */}
              {error && (
                <div
                  className="flex items-start gap-2 p-3 rounded border"
                  style={{
                    backgroundColor: theme.colors.error + '10',
                    borderColor: theme.colors.error,
                  }}
                >
                  <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" style={{ color: theme.colors.error }} />
                  <p className="text-sm" style={{ color: theme.colors.error }}>{error}</p>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div
          className="flex items-center justify-end gap-2 px-4 py-3 border-t"
          style={{ borderColor: theme.colors.border }}
        >
          <button
            onClick={onClose}
            className="px-4 py-2 rounded text-sm hover:bg-white/10 transition-colors"
            style={{ color: theme.colors.textMain }}
          >
            Cancel
          </button>
          <button
            onClick={handleCreatePR}
            disabled={!canCreate}
            className={`flex items-center gap-2 px-4 py-2 rounded text-sm font-medium transition-colors ${
              canCreate ? 'hover:opacity-90' : 'opacity-50 cursor-not-allowed'
            }`}
            style={{
              backgroundColor: theme.colors.accent,
              color: theme.colors.accentForeground,
            }}
          >
            {isCreating ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Creating...
              </>
            ) : (
              <>
                <GitPullRequest className="w-4 h-4" />
                Create PR
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

export default CreatePRModal;
