/**
 * Symphony IPC Handlers
 *
 * Provides handlers for fetching Symphony registry, GitHub issues with
 * runmaestro.ai label, managing contributions, and coordinating contribution runs.
 *
 * Cache Strategy:
 * - Registry cached with 2-hour TTL
 * - Issues cached with 5-minute TTL (change frequently)
 * - Force refresh bypasses cache
 */

import { ipcMain, App, BrowserWindow } from 'electron';
import fs from 'fs/promises';
import path from 'path';
import { logger } from '../../utils/logger';
import { createIpcHandler, CreateHandlerOptions } from '../../utils/ipcHandler';
import { execFileNoThrow } from '../../utils/execFile';
import {
  SYMPHONY_REGISTRY_URL,
  REGISTRY_CACHE_TTL_MS,
  ISSUES_CACHE_TTL_MS,
  SYMPHONY_STATE_PATH,
  SYMPHONY_CACHE_PATH,
  SYMPHONY_REPOS_DIR,
  BRANCH_TEMPLATE,
  GITHUB_API_BASE,
  SYMPHONY_ISSUE_LABEL,
  DOCUMENT_PATH_PATTERNS,
  DEFAULT_CONTRIBUTOR_STATS,
} from '../../../shared/symphony-constants';
import type {
  SymphonyRegistry,
  SymphonyCache,
  SymphonyState,
  SymphonyIssue,
  ActiveContribution,
  CompletedContribution,
  ContributorStats,
  ContributionStatus,
  GetRegistryResponse,
  GetIssuesResponse,
  StartContributionResponse,
  CompleteContributionResponse,
  IssueStatus,
  DocumentReference,
} from '../../../shared/symphony-types';
import { SymphonyError } from '../../../shared/symphony-types';

// ============================================================================
// Constants
// ============================================================================

const LOG_CONTEXT = '[Symphony]';

// ============================================================================
// Validation Helpers
// ============================================================================

/**
 * Sanitize repository name to prevent path traversal attacks.
 * Removes any characters that could be used for path traversal.
 */
function sanitizeRepoName(repoName: string): string {
  // Only allow alphanumeric, dashes, underscores, and dots (not leading)
  return repoName
    .replace(/\.\./g, '') // Remove path traversal sequences
    .replace(/[^a-zA-Z0-9_\-]/g, '-') // Replace unsafe chars with dashes
    .replace(/^\.+/, '') // Remove leading dots
    .substring(0, 100); // Limit length
}

/**
 * Validate that a URL is a GitHub repository URL.
 * Only allows HTTPS URLs to github.com.
 */
function validateGitHubUrl(url: string): { valid: boolean; error?: string } {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') {
      return { valid: false, error: 'Only HTTPS URLs are allowed' };
    }
    if (parsed.hostname !== 'github.com' && parsed.hostname !== 'www.github.com') {
      return { valid: false, error: 'Only GitHub repositories are allowed' };
    }
    // Check for valid repo path format (owner/repo)
    const pathParts = parsed.pathname.split('/').filter(Boolean);
    if (pathParts.length < 2) {
      return { valid: false, error: 'Invalid repository path' };
    }
    return { valid: true };
  } catch {
    return { valid: false, error: 'Invalid URL format' };
  }
}

/**
 * Validate repository slug format (owner/repo).
 */
function validateRepoSlug(slug: string): { valid: boolean; error?: string } {
  if (!slug || typeof slug !== 'string') {
    return { valid: false, error: 'Repository slug is required' };
  }
  const parts = slug.split('/');
  if (parts.length !== 2) {
    return { valid: false, error: 'Invalid repository slug format (expected owner/repo)' };
  }
  const [owner, repo] = parts;
  if (!owner || !repo) {
    return { valid: false, error: 'Owner and repository name are required' };
  }
  // GitHub username/repo name rules
  if (!/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(owner)) {
    return { valid: false, error: 'Invalid owner name' };
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(repo)) {
    return { valid: false, error: 'Invalid repository name' };
  }
  return { valid: true };
}

/**
 * Validate contribution start parameters.
 */
function validateContributionParams(params: {
  repoSlug: string;
  repoUrl: string;
  repoName: string;
  issueNumber: number;
  documentPaths: DocumentReference[];
}): { valid: boolean; error?: string } {
  // Validate repo slug
  const slugValidation = validateRepoSlug(params.repoSlug);
  if (!slugValidation.valid) {
    return slugValidation;
  }

  // Validate URL
  const urlValidation = validateGitHubUrl(params.repoUrl);
  if (!urlValidation.valid) {
    return urlValidation;
  }

  // Validate repo name
  if (!params.repoName || typeof params.repoName !== 'string') {
    return { valid: false, error: 'Repository name is required' };
  }

  // Validate issue number
  if (!Number.isInteger(params.issueNumber) || params.issueNumber <= 0) {
    return { valid: false, error: 'Invalid issue number' };
  }

  // Validate document paths (check for path traversal in repo-relative paths)
  for (const doc of params.documentPaths) {
    // Skip validation for external URLs (they're downloaded, not file paths)
    if (doc.isExternal) continue;
    if (doc.path.includes('..') || doc.path.startsWith('/')) {
      return { valid: false, error: `Invalid document path: ${doc.path}` };
    }
  }

  return { valid: true };
}

// ============================================================================
// Dependencies Interface
// ============================================================================

export interface SymphonyHandlerDependencies {
  app: App;
  getMainWindow: () => BrowserWindow | null;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get the symphony directory path.
 */
function getSymphonyDir(app: App): string {
  return path.join(app.getPath('userData'), 'symphony');
}

/**
 * Get cache file path.
 */
function getCachePath(app: App): string {
  return path.join(getSymphonyDir(app), SYMPHONY_CACHE_PATH);
}

/**
 * Get state file path.
 */
function getStatePath(app: App): string {
  return path.join(getSymphonyDir(app), SYMPHONY_STATE_PATH);
}

/**
 * Get repos directory path.
 */
function getReposDir(app: App): string {
  return path.join(getSymphonyDir(app), SYMPHONY_REPOS_DIR);
}

/**
 * Ensure symphony directory exists.
 */
async function ensureSymphonyDir(app: App): Promise<void> {
  const dir = getSymphonyDir(app);
  await fs.mkdir(dir, { recursive: true });
}

/**
 * Read cache from disk.
 */
async function readCache(app: App): Promise<SymphonyCache | null> {
  try {
    const content = await fs.readFile(getCachePath(app), 'utf-8');
    return JSON.parse(content) as SymphonyCache;
  } catch {
    return null;
  }
}

/**
 * Write cache to disk.
 */
async function writeCache(app: App, cache: SymphonyCache): Promise<void> {
  await ensureSymphonyDir(app);
  await fs.writeFile(getCachePath(app), JSON.stringify(cache, null, 2), 'utf-8');
}

/**
 * Read symphony state from disk.
 */
async function readState(app: App): Promise<SymphonyState> {
  try {
    const content = await fs.readFile(getStatePath(app), 'utf-8');
    return JSON.parse(content) as SymphonyState;
  } catch {
    // Return default state
    return {
      active: [],
      history: [],
      stats: { ...DEFAULT_CONTRIBUTOR_STATS },
    };
  }
}

/**
 * Write symphony state to disk.
 */
async function writeState(app: App, state: SymphonyState): Promise<void> {
  await ensureSymphonyDir(app);
  await fs.writeFile(getStatePath(app), JSON.stringify(state, null, 2), 'utf-8');
}

/**
 * Check if cached data is still valid.
 */
function isCacheValid(fetchedAt: number, ttlMs: number): boolean {
  return Date.now() - fetchedAt < ttlMs;
}

/**
 * Generate a unique contribution ID.
 */
function generateContributionId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `contrib_${timestamp}_${random}`;
}

/**
 * Generate branch name from template.
 */
function generateBranchName(issueNumber: number): string {
  const timestamp = Date.now().toString(36);
  return BRANCH_TEMPLATE
    .replace('{issue}', String(issueNumber))
    .replace('{timestamp}', timestamp);
}

/** Maximum body size to parse (1MB) to prevent performance issues */
const MAX_BODY_SIZE = 1024 * 1024;

/**
 * Parse document references from issue body.
 * Supports both repository-relative paths and GitHub attachment links.
 */
function parseDocumentPaths(body: string): DocumentReference[] {
  // Guard against extremely large bodies that could cause performance issues
  if (body.length > MAX_BODY_SIZE) {
    logger.warn('Issue body too large, truncating for document parsing', LOG_CONTEXT, {
      bodyLength: body.length,
      maxSize: MAX_BODY_SIZE,
    });
    body = body.substring(0, MAX_BODY_SIZE);
  }

  const docs: Map<string, DocumentReference> = new Map();

  // Pattern for markdown links: [filename.md](url)
  // Captures: [1] = filename (link text), [2] = URL
  const markdownLinkPattern = /\[([^\]]+\.md)\]\(([^)]+)\)/gi;

  // First, check for markdown links (GitHub attachments)
  let match;
  while ((match = markdownLinkPattern.exec(body)) !== null) {
    const filename = match[1];
    const url = match[2];
    // Only add if it's a GitHub attachment URL or similar external URL
    if (url.startsWith('http')) {
      const key = filename.toLowerCase(); // Dedupe by filename
      if (!docs.has(key)) {
        docs.set(key, {
          name: filename,
          path: url,
          isExternal: true,
        });
      }
    }
  }

  // Then check for repo-relative paths using existing patterns
  for (const pattern of DOCUMENT_PATH_PATTERNS) {
    // Reset lastIndex for global regex
    pattern.lastIndex = 0;
    while ((match = pattern.exec(body)) !== null) {
      const docPath = match[1];
      if (docPath && !docPath.startsWith('http')) {
        const filename = docPath.split('/').pop() || docPath;
        const key = filename.toLowerCase();
        // Don't overwrite external links with same filename
        if (!docs.has(key)) {
          docs.set(key, {
            name: filename,
            path: docPath,
            isExternal: false,
          });
        }
      }
    }
  }

  return Array.from(docs.values());
}

// ============================================================================
// Registry Fetching
// ============================================================================

/**
 * Fetch the symphony registry from GitHub.
 */
async function fetchRegistry(): Promise<SymphonyRegistry> {
  logger.info('Fetching Symphony registry', LOG_CONTEXT);

  try {
    const response = await fetch(SYMPHONY_REGISTRY_URL);

    if (!response.ok) {
      throw new SymphonyError(
        `Failed to fetch registry: ${response.status} ${response.statusText}`,
        'network'
      );
    }

    const data = await response.json() as SymphonyRegistry;

    if (!data.repositories || !Array.isArray(data.repositories)) {
      throw new SymphonyError('Invalid registry structure', 'parse');
    }

    logger.info(`Fetched registry with ${data.repositories.length} repos`, LOG_CONTEXT);
    return data;
  } catch (error) {
    if (error instanceof SymphonyError) throw error;
    throw new SymphonyError(
      `Network error: ${error instanceof Error ? error.message : String(error)}`,
      'network',
      error
    );
  }
}

/**
 * Fetch GitHub issues with runmaestro.ai label for a repository.
 */
async function fetchIssues(repoSlug: string): Promise<SymphonyIssue[]> {
  logger.info(`Fetching issues for ${repoSlug}`, LOG_CONTEXT);

  try {
    const url = `${GITHUB_API_BASE}/repos/${repoSlug}/issues?labels=${encodeURIComponent(SYMPHONY_ISSUE_LABEL)}&state=open`;
    const response = await fetch(url, {
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'Maestro-Symphony',
      },
    });

    if (!response.ok) {
      throw new SymphonyError(
        `Failed to fetch issues: ${response.status}`,
        'github_api'
      );
    }

    const rawIssues = await response.json() as Array<{
      number: number;
      title: string;
      body: string | null;
      url: string;
      html_url: string;
      user: { login: string };
      created_at: string;
      updated_at: string;
    }>;

    // Transform to SymphonyIssue format
    const issues: SymphonyIssue[] = rawIssues.map(issue => ({
      number: issue.number,
      title: issue.title,
      body: issue.body || '',
      url: issue.url,
      htmlUrl: issue.html_url,
      author: issue.user.login,
      createdAt: issue.created_at,
      updatedAt: issue.updated_at,
      documentPaths: parseDocumentPaths(issue.body || ''),
      status: 'available' as IssueStatus, // Will be updated with PR status
    }));

    // TODO: In a future enhancement, fetch linked PRs for each issue to determine
    // the actual status. For now, mark all as available.

    logger.info(`Fetched ${issues.length} issues for ${repoSlug}`, LOG_CONTEXT);
    return issues;
  } catch (error) {
    if (error instanceof SymphonyError) throw error;
    throw new SymphonyError(
      `Failed to fetch issues: ${error instanceof Error ? error.message : String(error)}`,
      'github_api',
      error
    );
  }
}

// ============================================================================
// Git Operations (using safe execFileNoThrow utility)
// ============================================================================

/**
 * Clone a repository to a local path.
 */
async function cloneRepository(
  repoUrl: string,
  targetPath: string
): Promise<{ success: boolean; error?: string }> {
  logger.info('Cloning repository', LOG_CONTEXT, { repoUrl, targetPath });

  const result = await execFileNoThrow('git', ['clone', '--depth=1', repoUrl, targetPath]);

  if (result.exitCode !== 0) {
    return { success: false, error: result.stderr };
  }

  return { success: true };
}

/**
 * Create a new branch for contribution work.
 */
async function createBranch(
  repoPath: string,
  branchName: string
): Promise<{ success: boolean; error?: string }> {
  const result = await execFileNoThrow('git', ['checkout', '-b', branchName], repoPath);

  if (result.exitCode !== 0) {
    return { success: false, error: result.stderr };
  }

  return { success: true };
}

/**
 * Check if gh CLI is authenticated.
 */
async function checkGhAuthentication(): Promise<{ authenticated: boolean; error?: string }> {
  const result = await execFileNoThrow('gh', ['auth', 'status']);
  if (result.exitCode !== 0) {
    // gh auth status outputs to stderr even on success for some info
    const output = result.stderr + result.stdout;
    if (output.includes('not logged in') || output.includes('no accounts')) {
      return { authenticated: false, error: 'GitHub CLI is not authenticated. Run "gh auth login" to authenticate.' };
    }
    // If gh CLI is not installed
    if (output.includes('command not found') || output.includes('not recognized')) {
      return { authenticated: false, error: 'GitHub CLI (gh) is not installed. Install it from https://cli.github.com/' };
    }
    return { authenticated: false, error: `GitHub CLI error: ${output}` };
  }
  return { authenticated: true };
}

/**
 * Get the default branch of a repository.
 */
async function getDefaultBranch(repoPath: string): Promise<string> {
  // Try to get the default branch from remote
  const result = await execFileNoThrow('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], repoPath);
  if (result.exitCode === 0) {
    // Output is like "refs/remotes/origin/main"
    const branch = result.stdout.trim().replace('refs/remotes/origin/', '');
    if (branch) return branch;
  }

  // Fallback: try common branch names
  const checkResult = await execFileNoThrow('git', ['ls-remote', '--heads', 'origin', 'main'], repoPath);
  if (checkResult.exitCode === 0 && checkResult.stdout.includes('refs/heads/main')) {
    return 'main';
  }

  const masterCheck = await execFileNoThrow('git', ['ls-remote', '--heads', 'origin', 'master'], repoPath);
  if (masterCheck.exitCode === 0 && masterCheck.stdout.includes('refs/heads/master')) {
    return 'master';
  }

  // Default to main if we can't determine
  return 'main';
}

/**
 * Push branch and create draft PR using gh CLI.
 */
async function createDraftPR(
  repoPath: string,
  baseBranch: string,
  title: string,
  body: string
): Promise<{ success: boolean; prUrl?: string; prNumber?: number; error?: string }> {
  // Check gh authentication first
  const authCheck = await checkGhAuthentication();
  if (!authCheck.authenticated) {
    return { success: false, error: authCheck.error };
  }

  // Get current branch name
  const branchResult = await execFileNoThrow('git', ['rev-parse', '--abbrev-ref', 'HEAD'], repoPath);
  const branchName = branchResult.stdout.trim();
  if (!branchName || branchResult.exitCode !== 0) {
    return { success: false, error: 'Failed to determine current branch' };
  }

  // First push the branch
  const pushResult = await execFileNoThrow('git', ['push', '-u', 'origin', branchName], repoPath);

  if (pushResult.exitCode !== 0) {
    return { success: false, error: `Failed to push: ${pushResult.stderr}` };
  }

  // Create draft PR using gh CLI (use --head to explicitly specify the branch)
  const prResult = await execFileNoThrow(
    'gh',
    ['pr', 'create', '--draft', '--base', baseBranch, '--head', branchName, '--title', title, '--body', body],
    repoPath
  );

  if (prResult.exitCode !== 0) {
    // If PR creation failed after push, try to delete the remote branch
    logger.warn('PR creation failed, attempting to clean up remote branch', LOG_CONTEXT);
    await execFileNoThrow('git', ['push', 'origin', '--delete', branchName], repoPath);
    return { success: false, error: `Failed to create PR: ${prResult.stderr}` };
  }

  // Parse PR URL from output
  const prUrl = prResult.stdout.trim();
  const prNumberMatch = prUrl.match(/\/pull\/(\d+)/);
  const prNumber = prNumberMatch ? parseInt(prNumberMatch[1], 10) : undefined;

  return { success: true, prUrl, prNumber };
}

/**
 * Mark PR as ready for review.
 */
async function markPRReady(
  repoPath: string,
  prNumber: number
): Promise<{ success: boolean; error?: string }> {
  const result = await execFileNoThrow(
    'gh',
    ['pr', 'ready', String(prNumber)],
    repoPath
  );

  if (result.exitCode !== 0) {
    return { success: false, error: result.stderr };
  }

  return { success: true };
}

/**
 * Post a comment to a PR with Symphony contribution stats.
 */
async function postPRComment(
  repoPath: string,
  prNumber: number,
  stats: {
    inputTokens: number;
    outputTokens: number;
    estimatedCost: number;
    timeSpentMs: number;
    documentsProcessed: number;
    tasksCompleted: number;
  }
): Promise<{ success: boolean; error?: string }> {
  // Format time spent
  const hours = Math.floor(stats.timeSpentMs / 3600000);
  const minutes = Math.floor((stats.timeSpentMs % 3600000) / 60000);
  const seconds = Math.floor((stats.timeSpentMs % 60000) / 1000);
  const timeStr = hours > 0
    ? `${hours}h ${minutes}m ${seconds}s`
    : minutes > 0
      ? `${minutes}m ${seconds}s`
      : `${seconds}s`;

  // Format token counts with commas
  const formatNumber = (n: number) => n.toLocaleString('en-US');

  // Build the comment body
  const commentBody = `## Symphony Contribution Summary

This pull request was created using [Maestro Symphony](https://runmaestro.ai/symphony) - connecting AI-powered contributors with open source projects.

### Contribution Stats
| Metric | Value |
|--------|-------|
| Input Tokens | ${formatNumber(stats.inputTokens)} |
| Output Tokens | ${formatNumber(stats.outputTokens)} |
| Total Tokens | ${formatNumber(stats.inputTokens + stats.outputTokens)} |
| Estimated Cost | $${stats.estimatedCost.toFixed(2)} |
| Time Spent | ${timeStr} |
| Documents Processed | ${stats.documentsProcessed} |
| Tasks Completed | ${stats.tasksCompleted} |

---
*Powered by [Maestro](https://runmaestro.ai) • [Learn about Symphony](https://docs.runmaestro.ai/symphony)*`;

  const result = await execFileNoThrow(
    'gh',
    ['pr', 'comment', String(prNumber), '--body', commentBody],
    repoPath
  );

  if (result.exitCode !== 0) {
    return { success: false, error: result.stderr };
  }

  return { success: true };
}

// ============================================================================
// Real-time Updates
// ============================================================================

/**
 * Broadcast symphony state updates to renderer.
 */
function broadcastSymphonyUpdate(getMainWindow: () => BrowserWindow | null): void {
  const mainWindow = getMainWindow?.();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('symphony:updated');
  }
}

// ============================================================================
// Handler Options Helper
// ============================================================================

const handlerOpts = (operation: string, logSuccess = true): CreateHandlerOptions => ({
  context: LOG_CONTEXT,
  operation,
  logSuccess,
});

// ============================================================================
// IPC Handler Registration
// ============================================================================

export function registerSymphonyHandlers({ app, getMainWindow }: SymphonyHandlerDependencies): void {
  // ─────────────────────────────────────────────────────────────────────────
  // Registry Operations
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Get the symphony registry (with caching).
   */
  ipcMain.handle(
    'symphony:getRegistry',
    createIpcHandler(
      handlerOpts('getRegistry'),
      async (forceRefresh?: boolean): Promise<Omit<GetRegistryResponse, 'success'>> => {
        const cache = await readCache(app);

        // Check cache validity
        if (!forceRefresh && cache?.registry && isCacheValid(cache.registry.fetchedAt, REGISTRY_CACHE_TTL_MS)) {
          return {
            registry: cache.registry.data,
            fromCache: true,
            cacheAge: Date.now() - cache.registry.fetchedAt,
          };
        }

        // Fetch fresh data
        const registry = await fetchRegistry();

        // Update cache
        const newCache: SymphonyCache = {
          ...cache,
          registry: {
            data: registry,
            fetchedAt: Date.now(),
          },
          issues: cache?.issues ?? {},
        };
        await writeCache(app, newCache);

        return {
          registry,
          fromCache: false,
        };
      }
    )
  );

  /**
   * Get issues for a repository (with caching).
   */
  ipcMain.handle(
    'symphony:getIssues',
    createIpcHandler(
      handlerOpts('getIssues'),
      async (repoSlug: string, forceRefresh?: boolean): Promise<Omit<GetIssuesResponse, 'success'>> => {
        const cache = await readCache(app);

        // Check cache
        const cached = cache?.issues?.[repoSlug];
        if (!forceRefresh && cached && isCacheValid(cached.fetchedAt, ISSUES_CACHE_TTL_MS)) {
          return {
            issues: cached.data,
            fromCache: true,
            cacheAge: Date.now() - cached.fetchedAt,
          };
        }

        // Fetch fresh
        const issues = await fetchIssues(repoSlug);

        // Update cache
        const newCache: SymphonyCache = {
          ...cache,
          registry: cache?.registry,
          issues: {
            ...cache?.issues,
            [repoSlug]: {
              data: issues,
              fetchedAt: Date.now(),
            },
          },
        };
        await writeCache(app, newCache);

        return {
          issues,
          fromCache: false,
        };
      }
    )
  );

  // ─────────────────────────────────────────────────────────────────────────
  // State Operations
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Get current symphony state.
   */
  ipcMain.handle(
    'symphony:getState',
    createIpcHandler(
      handlerOpts('getState', false),
      async (): Promise<{ state: SymphonyState }> => {
        const state = await readState(app);
        return { state };
      }
    )
  );

  /**
   * Get active contributions.
   */
  ipcMain.handle(
    'symphony:getActive',
    createIpcHandler(
      handlerOpts('getActive', false),
      async (): Promise<{ contributions: ActiveContribution[] }> => {
        const state = await readState(app);
        return { contributions: state.active };
      }
    )
  );

  /**
   * Get completed contributions.
   */
  ipcMain.handle(
    'symphony:getCompleted',
    createIpcHandler(
      handlerOpts('getCompleted', false),
      async (limit?: number): Promise<{ contributions: CompletedContribution[] }> => {
        const state = await readState(app);
        const sorted = [...state.history].sort(
          (a, b) => new Date(b.completedAt).getTime() - new Date(a.completedAt).getTime()
        );
        return {
          contributions: limit ? sorted.slice(0, limit) : sorted,
        };
      }
    )
  );

  /**
   * Get contributor statistics.
   */
  ipcMain.handle(
    'symphony:getStats',
    createIpcHandler(
      handlerOpts('getStats', false),
      async (): Promise<{ stats: ContributorStats }> => {
        const state = await readState(app);
        return { stats: state.stats };
      }
    )
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Contribution Lifecycle Operations
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Start a new contribution.
   */
  ipcMain.handle(
    'symphony:start',
    createIpcHandler(
      handlerOpts('start'),
      async (params: {
        repoSlug: string;
        repoUrl: string;
        repoName: string;
        issueNumber: number;
        issueTitle: string;
        documentPaths: DocumentReference[];
        agentType: string;
        sessionId: string;
        baseBranch?: string;
      }): Promise<Omit<StartContributionResponse, 'success'>> => {
        // Validate input parameters
        const validation = validateContributionParams({
          repoSlug: params.repoSlug,
          repoUrl: params.repoUrl,
          repoName: params.repoName,
          issueNumber: params.issueNumber,
          documentPaths: params.documentPaths,
        });
        if (!validation.valid) {
          return { error: validation.error };
        }

        // Check gh CLI authentication before starting
        const authCheck = await checkGhAuthentication();
        if (!authCheck.authenticated) {
          return { error: authCheck.error };
        }

        const {
          repoSlug,
          repoUrl,
          repoName,
          issueNumber,
          issueTitle,
          documentPaths,
          agentType,
          sessionId,
        } = params;

        const contributionId = generateContributionId();
        const state = await readState(app);

        // Check if already working on this issue
        const existing = state.active.find(
          c => c.repoSlug === repoSlug && c.issueNumber === issueNumber
        );
        if (existing) {
          return {
            error: `Already working on this issue (contribution: ${existing.id})`,
          };
        }

        // Sanitize repo name for local path
        const sanitizedRepoName = sanitizeRepoName(repoName);

        // Determine local path
        const reposDir = getReposDir(app);
        await fs.mkdir(reposDir, { recursive: true });
        const localPath = path.join(reposDir, `${sanitizedRepoName}-${contributionId}`);

        // Generate branch name
        const branchName = generateBranchName(issueNumber);

        // Clone repository
        const cloneResult = await cloneRepository(repoUrl, localPath);
        if (!cloneResult.success) {
          return { error: `Clone failed: ${cloneResult.error}` };
        }

        // Detect default branch (don't rely on hardcoded 'main')
        const baseBranch = params.baseBranch || await getDefaultBranch(localPath);

        // Create branch
        const branchResult = await createBranch(localPath, branchName);
        if (!branchResult.success) {
          // Cleanup
          await fs.rm(localPath, { recursive: true, force: true }).catch(() => {});
          return { error: `Branch creation failed: ${branchResult.error}` };
        }

        // Create draft PR to claim the issue
        const prTitle = `[WIP] Symphony: ${issueTitle} (#${issueNumber})`;
        const prBody = `## Maestro Symphony Contribution

Working on #${issueNumber} via [Maestro Symphony](https://runmaestro.ai).

**Status:** In Progress
**Started:** ${new Date().toISOString()}

---

This PR will be updated automatically when the Auto Run completes.`;

        const prResult = await createDraftPR(localPath, baseBranch, prTitle, prBody);
        if (!prResult.success) {
          // Cleanup
          await fs.rm(localPath, { recursive: true, force: true }).catch(() => {});
          return { error: `PR creation failed: ${prResult.error}` };
        }

        // Create active contribution entry
        const contribution: ActiveContribution = {
          id: contributionId,
          repoSlug,
          repoName,
          issueNumber,
          issueTitle,
          localPath,
          branchName,
          draftPrNumber: prResult.prNumber!,
          draftPrUrl: prResult.prUrl!,
          startedAt: new Date().toISOString(),
          status: 'running',
          progress: {
            totalDocuments: documentPaths.length,
            completedDocuments: 0,
            totalTasks: 0,
            completedTasks: 0,
          },
          tokenUsage: {
            inputTokens: 0,
            outputTokens: 0,
            estimatedCost: 0,
          },
          timeSpent: 0,
          sessionId,
          agentType,
        };

        // Save state
        state.active.push(contribution);
        await writeState(app, state);

        logger.info('Contribution started', LOG_CONTEXT, {
          contributionId,
          repoSlug,
          issueNumber,
          prNumber: prResult.prNumber,
        });

        broadcastSymphonyUpdate(getMainWindow);

        return {
          contributionId,
          draftPrUrl: prResult.prUrl,
          draftPrNumber: prResult.prNumber,
        };
      }
    )
  );

  /**
   * Update contribution status.
   */
  ipcMain.handle(
    'symphony:updateStatus',
    createIpcHandler(
      handlerOpts('updateStatus', false),
      async (params: {
        contributionId: string;
        status?: ContributionStatus;
        progress?: Partial<ActiveContribution['progress']>;
        tokenUsage?: Partial<ActiveContribution['tokenUsage']>;
        timeSpent?: number;
        error?: string;
      }): Promise<{ updated: boolean }> => {
        const { contributionId, status, progress, tokenUsage, timeSpent, error } = params;
        const state = await readState(app);
        const contribution = state.active.find(c => c.id === contributionId);

        if (!contribution) {
          return { updated: false };
        }

        if (status) contribution.status = status;
        if (progress) contribution.progress = { ...contribution.progress, ...progress };
        if (tokenUsage) contribution.tokenUsage = { ...contribution.tokenUsage, ...tokenUsage };
        if (timeSpent !== undefined) contribution.timeSpent = timeSpent;
        if (error) contribution.error = error;

        await writeState(app, state);
        broadcastSymphonyUpdate(getMainWindow);
        return { updated: true };
      }
    )
  );

  /**
   * Complete a contribution (mark PR as ready).
   * Accepts optional stats from the frontend which override stored values.
   */
  ipcMain.handle(
    'symphony:complete',
    createIpcHandler(
      handlerOpts('complete'),
      async (params: {
        contributionId: string;
        prBody?: string;
        stats?: {
          inputTokens: number;
          outputTokens: number;
          estimatedCost: number;
          timeSpentMs: number;
          documentsProcessed: number;
          tasksCompleted: number;
        };
      }): Promise<Omit<CompleteContributionResponse, 'success'>> => {
        const { contributionId, stats } = params;
        const state = await readState(app);
        const contributionIndex = state.active.findIndex(c => c.id === contributionId);

        if (contributionIndex === -1) {
          return { error: 'Contribution not found' };
        }

        const contribution = state.active[contributionIndex];
        contribution.status = 'completing';
        await writeState(app, state);

        // Mark PR as ready
        const readyResult = await markPRReady(contribution.localPath, contribution.draftPrNumber);
        if (!readyResult.success) {
          contribution.status = 'failed';
          contribution.error = readyResult.error;
          await writeState(app, state);
          return { error: readyResult.error };
        }

        // Post PR comment with stats (use provided stats or fall back to stored values)
        const commentStats = stats || {
          inputTokens: contribution.tokenUsage.inputTokens,
          outputTokens: contribution.tokenUsage.outputTokens,
          estimatedCost: contribution.tokenUsage.estimatedCost,
          timeSpentMs: contribution.timeSpent,
          documentsProcessed: contribution.progress.completedDocuments,
          tasksCompleted: contribution.progress.completedTasks,
        };

        const commentResult = await postPRComment(
          contribution.localPath,
          contribution.draftPrNumber,
          commentStats
        );

        if (!commentResult.success) {
          // Log but don't fail - the PR is already ready, comment is just bonus
          logger.warn('Failed to post PR comment', LOG_CONTEXT, {
            contributionId,
            error: commentResult.error,
          });
        }

        // Use provided stats for the completed record if available
        const finalInputTokens = stats?.inputTokens ?? contribution.tokenUsage.inputTokens;
        const finalOutputTokens = stats?.outputTokens ?? contribution.tokenUsage.outputTokens;
        const finalCost = stats?.estimatedCost ?? contribution.tokenUsage.estimatedCost;
        const finalTimeSpent = stats?.timeSpentMs ?? contribution.timeSpent;
        const finalDocsProcessed = stats?.documentsProcessed ?? contribution.progress.completedDocuments;
        const finalTasksCompleted = stats?.tasksCompleted ?? contribution.progress.completedTasks;

        // Move to completed
        const completed: CompletedContribution = {
          id: contribution.id,
          repoSlug: contribution.repoSlug,
          repoName: contribution.repoName,
          issueNumber: contribution.issueNumber,
          issueTitle: contribution.issueTitle,
          startedAt: contribution.startedAt,
          completedAt: new Date().toISOString(),
          prUrl: contribution.draftPrUrl,
          prNumber: contribution.draftPrNumber,
          tokenUsage: {
            inputTokens: finalInputTokens,
            outputTokens: finalOutputTokens,
            totalCost: finalCost,
          },
          timeSpent: finalTimeSpent,
          documentsProcessed: finalDocsProcessed,
          tasksCompleted: finalTasksCompleted,
        };

        // Update state
        state.active.splice(contributionIndex, 1);
        state.history.push(completed);

        // Update stats
        state.stats.totalContributions += 1;
        state.stats.totalDocumentsProcessed += completed.documentsProcessed;
        state.stats.totalTasksCompleted += completed.tasksCompleted;
        state.stats.totalTokensUsed += completed.tokenUsage.inputTokens + completed.tokenUsage.outputTokens;
        state.stats.totalTimeSpent += completed.timeSpent;
        state.stats.estimatedCostDonated += completed.tokenUsage.totalCost;

        if (!state.stats.repositoriesContributed.includes(contribution.repoSlug)) {
          state.stats.repositoriesContributed.push(contribution.repoSlug);
        }

        state.stats.lastContributionAt = completed.completedAt;
        if (!state.stats.firstContributionAt) {
          state.stats.firstContributionAt = completed.completedAt;
        }

        // Update streak (simplified - just check if last contribution was yesterday or today)
        const today = new Date().toDateString();
        const lastDate = state.stats.lastContributionDate;
        if (lastDate) {
          const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toDateString();
          if (lastDate === yesterday || lastDate === today) {
            state.stats.currentStreak += 1;
          } else {
            state.stats.currentStreak = 1;
          }
        } else {
          state.stats.currentStreak = 1;
        }
        state.stats.lastContributionDate = today;
        if (state.stats.currentStreak > state.stats.longestStreak) {
          state.stats.longestStreak = state.stats.currentStreak;
        }

        await writeState(app, state);

        logger.info('Contribution completed', LOG_CONTEXT, {
          contributionId,
          prUrl: completed.prUrl,
        });

        broadcastSymphonyUpdate(getMainWindow);

        return {
          prUrl: completed.prUrl,
          prNumber: completed.prNumber,
        };
      }
    )
  );

  /**
   * Cancel an active contribution.
   */
  ipcMain.handle(
    'symphony:cancel',
    createIpcHandler(
      handlerOpts('cancel'),
      async (contributionId: string, cleanup?: boolean): Promise<{ cancelled: boolean }> => {
        const state = await readState(app);
        const index = state.active.findIndex(c => c.id === contributionId);

        if (index === -1) {
          return { cancelled: false };
        }

        const contribution = state.active[index];

        // Optionally cleanup local files
        if (cleanup && contribution.localPath) {
          try {
            await fs.rm(contribution.localPath, { recursive: true, force: true });
          } catch (e) {
            logger.warn('Failed to cleanup contribution directory', LOG_CONTEXT, { error: e });
          }
        }

        // Remove from active
        state.active.splice(index, 1);
        await writeState(app, state);

        logger.info('Contribution cancelled', LOG_CONTEXT, { contributionId });

        broadcastSymphonyUpdate(getMainWindow);

        return { cancelled: true };
      }
    )
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Cache Operations
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Clear cache.
   */
  ipcMain.handle(
    'symphony:clearCache',
    createIpcHandler(
      handlerOpts('clearCache'),
      async (): Promise<{ cleared: boolean }> => {
        await writeCache(app, { issues: {} });
        return { cleared: true };
      }
    )
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Session Creation Workflow (App.tsx integration)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Clone a repository for a new Symphony session.
   * This is a simpler version of the start handler for the session creation flow.
   */
  ipcMain.handle(
    'symphony:cloneRepo',
    createIpcHandler(
      handlerOpts('cloneRepo'),
      async (params: { repoUrl: string; localPath: string }): Promise<{ success: boolean; error?: string }> => {
        const { repoUrl, localPath } = params;

        // Validate GitHub URL
        const urlValidation = validateGitHubUrl(repoUrl);
        if (!urlValidation.valid) {
          return { success: false, error: urlValidation.error };
        }

        // Ensure parent directory exists
        const parentDir = path.dirname(localPath);
        await fs.mkdir(parentDir, { recursive: true });

        // Clone with depth=1 for speed
        const result = await cloneRepository(repoUrl, localPath);
        if (!result.success) {
          return { success: false, error: `Clone failed: ${result.error}` };
        }

        logger.info('Repository cloned for Symphony session', LOG_CONTEXT, { localPath });
        return { success: true };
      }
    )
  );

  /**
   * Start the contribution workflow after session is created.
   * Creates branch and sets up Auto Run documents.
   * Draft PR will be created on first real commit (deferred to avoid "no commits" error).
   */
  ipcMain.handle(
    'symphony:startContribution',
    createIpcHandler(
      handlerOpts('startContribution'),
      async (params: {
        contributionId: string;
        sessionId: string;
        repoSlug: string;
        issueNumber: number;
        issueTitle: string;
        localPath: string;
        documentPaths: DocumentReference[];
      }): Promise<{
        success: boolean;
        branchName?: string;
        draftPrNumber?: number;
        draftPrUrl?: string;
        autoRunPath?: string;
        error?: string;
      }> => {
        const { contributionId, sessionId, repoSlug, issueNumber, issueTitle, localPath, documentPaths } = params;

        // Validate inputs
        const slugValidation = validateRepoSlug(repoSlug);
        if (!slugValidation.valid) {
          return { success: false, error: slugValidation.error };
        }

        if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
          return { success: false, error: 'Invalid issue number' };
        }

        // Validate document paths for path traversal (only repo-relative paths)
        for (const doc of documentPaths) {
          if (!doc.isExternal && (doc.path.includes('..') || doc.path.startsWith('/'))) {
            return { success: false, error: `Invalid document path: ${doc.path}` };
          }
        }

        // Check gh CLI authentication (needed later for PR creation)
        const authCheck = await checkGhAuthentication();
        if (!authCheck.authenticated) {
          return { success: false, error: authCheck.error };
        }

        try {
          // 1. Create branch and checkout
          const branchName = generateBranchName(issueNumber);
          const branchResult = await createBranch(localPath, branchName);
          if (!branchResult.success) {
            logger.error('Failed to create branch', LOG_CONTEXT, { localPath, branchName, error: branchResult.error });
            return { success: false, error: `Failed to create branch: ${branchResult.error}` };
          }

          // 2. Set up Auto Run documents directory
          // External docs (GitHub attachments) go to cache dir to avoid polluting the repo
          // Repo-internal docs are referenced in place
          const symphonyDocsDir = path.join(getSymphonyDir(app), 'contributions', contributionId, 'docs');
          await fs.mkdir(symphonyDocsDir, { recursive: true });

          // Track resolved document paths for Auto Run
          const resolvedDocs: { name: string; path: string; isExternal: boolean }[] = [];

          for (const doc of documentPaths) {
            if (doc.isExternal) {
              // Download external file (GitHub attachment) to cache directory
              const destPath = path.join(symphonyDocsDir, doc.name);
              try {
                logger.info('Downloading external document', LOG_CONTEXT, { name: doc.name, url: doc.path });
                const response = await fetch(doc.path);
                if (!response.ok) {
                  logger.warn('Failed to download document', LOG_CONTEXT, { name: doc.name, status: response.status });
                  continue;
                }
                const buffer = await response.arrayBuffer();
                await fs.writeFile(destPath, Buffer.from(buffer));
                logger.info('Downloaded document to cache', LOG_CONTEXT, { name: doc.name, to: destPath });
                resolvedDocs.push({ name: doc.name, path: destPath, isExternal: true });
              } catch (e) {
                logger.warn('Failed to download document', LOG_CONTEXT, { name: doc.name, error: e instanceof Error ? e.message : String(e) });
              }
            } else {
              // Repo-internal doc - verify it exists and reference in place
              const resolvedSource = path.resolve(localPath, doc.path);
              if (!resolvedSource.startsWith(localPath)) {
                logger.error('Attempted path traversal in document path', LOG_CONTEXT, { docPath: doc.path });
                continue;
              }
              try {
                await fs.access(resolvedSource);
                logger.info('Using repo document', LOG_CONTEXT, { name: doc.name, path: resolvedSource });
                resolvedDocs.push({ name: doc.name, path: resolvedSource, isExternal: false });
              } catch (e) {
                logger.warn('Document not found in repo', LOG_CONTEXT, { docPath: doc.path, error: e instanceof Error ? e.message : String(e) });
              }
            }
          }

          // 3. Write contribution metadata for later PR creation
          const metadataPath = path.join(symphonyDocsDir, '..', 'metadata.json');
          await fs.writeFile(metadataPath, JSON.stringify({
            contributionId,
            sessionId,
            repoSlug,
            issueNumber,
            issueTitle,
            branchName,
            localPath,
            resolvedDocs,
            startedAt: new Date().toISOString(),
            prCreated: false,
          }, null, 2));

          // 4. Determine Auto Run path (use cache dir if we have external docs, otherwise repo path)
          const hasExternalDocs = resolvedDocs.some(d => d.isExternal);
          const autoRunPath = hasExternalDocs ? symphonyDocsDir : (resolvedDocs[0]?.path ? path.dirname(resolvedDocs[0].path) : localPath);

          // 5. Broadcast status update (no PR yet - will be created on first commit)
          const mainWindow = getMainWindow?.();
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('symphony:contributionStarted', {
              contributionId,
              sessionId,
              branchName,
              autoRunPath,
              // No PR yet - will be created on first commit
            });
          }

          logger.info('Symphony contribution started', LOG_CONTEXT, {
            contributionId,
            sessionId,
            branchName,
            documentCount: resolvedDocs.length,
            hasExternalDocs,
          });

          return {
            success: true,
            branchName,
            autoRunPath,
            // draftPrNumber and draftPrUrl will be set when PR is created on first commit
          };
        } catch (error) {
          logger.error('Symphony contribution failed', LOG_CONTEXT, { error });
          return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
          };
        }
      }
    )
  );

  /**
   * Create draft PR for a contribution (called on first commit).
   * Reads metadata from the contribution folder, pushes branch, and creates draft PR.
   */
  ipcMain.handle(
    'symphony:createDraftPR',
    createIpcHandler(
      handlerOpts('createDraftPR'),
      async (params: {
        contributionId: string;
      }): Promise<{
        success: boolean;
        draftPrNumber?: number;
        draftPrUrl?: string;
        error?: string;
      }> => {
        const { contributionId } = params;

        // Read contribution metadata
        const metadataPath = path.join(getSymphonyDir(app), 'contributions', contributionId, 'metadata.json');
        let metadata: {
          contributionId: string;
          sessionId: string;
          repoSlug: string;
          issueNumber: number;
          issueTitle: string;
          branchName: string;
          localPath: string;
          prCreated: boolean;
          draftPrNumber?: number;
          draftPrUrl?: string;
        };

        try {
          const content = await fs.readFile(metadataPath, 'utf-8');
          metadata = JSON.parse(content);
        } catch (e) {
          logger.error('Failed to read contribution metadata', LOG_CONTEXT, { contributionId, error: e });
          return { success: false, error: 'Contribution metadata not found' };
        }

        // Check if PR already created
        if (metadata.prCreated && metadata.draftPrUrl) {
          logger.info('Draft PR already exists', LOG_CONTEXT, { contributionId, prUrl: metadata.draftPrUrl });
          return {
            success: true,
            draftPrNumber: metadata.draftPrNumber,
            draftPrUrl: metadata.draftPrUrl,
          };
        }

        // Check gh CLI authentication
        const authCheck = await checkGhAuthentication();
        if (!authCheck.authenticated) {
          return { success: false, error: authCheck.error };
        }

        const { localPath, issueNumber, issueTitle, sessionId } = metadata;

        // Check if there are any commits on this branch
        // Use rev-list to count commits not in the default branch
        const baseBranch = await getDefaultBranch(localPath);
        const commitCheckResult = await execFileNoThrow(
          'git',
          ['rev-list', '--count', `${baseBranch}..HEAD`],
          localPath
        );

        const commitCount = parseInt(commitCheckResult.stdout.trim(), 10) || 0;
        if (commitCount === 0) {
          // No commits yet - return success but indicate no PR created
          logger.info('No commits yet, skipping PR creation', LOG_CONTEXT, { contributionId });
          return {
            success: true,
            // No PR fields - caller should know PR wasn't created yet
          };
        }

        logger.info('Found commits, creating draft PR', LOG_CONTEXT, { contributionId, commitCount });

        // Create PR title and body
        const prTitle = `[WIP] Symphony: ${issueTitle} (#${issueNumber})`;
        const prBody = `## Maestro Symphony Contribution

Working on #${issueNumber} via [Maestro Symphony](https://runmaestro.ai).

**Status:** In Progress
**Started:** ${new Date().toISOString()}

---

This PR will be updated automatically when the Auto Run completes.`;

        // Create draft PR (this also pushes the branch)
        const prResult = await createDraftPR(localPath, baseBranch, prTitle, prBody);
        if (!prResult.success) {
          logger.error('Failed to create draft PR', LOG_CONTEXT, { contributionId, error: prResult.error });
          return { success: false, error: prResult.error };
        }

        // Update metadata with PR info
        metadata.prCreated = true;
        metadata.draftPrNumber = prResult.prNumber;
        metadata.draftPrUrl = prResult.prUrl;
        await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2));

        // Broadcast PR creation event
        const mainWindow = getMainWindow?.();
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('symphony:prCreated', {
            contributionId,
            sessionId,
            draftPrNumber: prResult.prNumber,
            draftPrUrl: prResult.prUrl,
          });
        }

        logger.info('Draft PR created for Symphony contribution', LOG_CONTEXT, {
          contributionId,
          prNumber: prResult.prNumber,
          prUrl: prResult.prUrl,
        });

        return {
          success: true,
          draftPrNumber: prResult.prNumber,
          draftPrUrl: prResult.prUrl,
        };
      }
    )
  );

  // Handler for fetching document content (from main process to avoid CORS)
  ipcMain.handle(
    'symphony:fetchDocumentContent',
    createIpcHandler(
      handlerOpts('fetchDocumentContent'),
      async (params: { url: string }): Promise<{ success: boolean; content?: string; error?: string }> => {
        const { url } = params;

        // Validate URL - only allow GitHub URLs
        try {
          const parsed = new URL(url);
          if (!['github.com', 'raw.githubusercontent.com', 'objects.githubusercontent.com'].some(
            host => parsed.hostname === host || parsed.hostname.endsWith('.' + host)
          )) {
            return { success: false, error: 'Only GitHub URLs are allowed' };
          }
          if (parsed.protocol !== 'https:') {
            return { success: false, error: 'Only HTTPS URLs are allowed' };
          }
        } catch {
          return { success: false, error: 'Invalid URL' };
        }

        try {
          logger.info('Fetching document content', LOG_CONTEXT, { url });
          const response = await fetch(url);
          if (!response.ok) {
            return { success: false, error: `HTTP ${response.status}: ${response.statusText}` };
          }
          const content = await response.text();
          return { success: true, content };
        } catch (error) {
          logger.error('Failed to fetch document content', LOG_CONTEXT, { url, error });
          return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to fetch document',
          };
        }
      }
    )
  );

  logger.info('Symphony handlers registered', LOG_CONTEXT);
}
