/**
 * Maestro Symphony Type Definitions
 *
 * Types for the Symphony feature that connects Maestro users
 * with open source projects seeking contributions.
 */

// ============================================================================
// Registry Types (Stored in Maestro repo: symphony-registry.json)
// ============================================================================

/**
 * The Symphony registry listing all registered repositories.
 * Hosted at: https://raw.githubusercontent.com/pedramamini/Maestro/main/symphony-registry.json
 */
export interface SymphonyRegistry {
  /** Schema version for forward compatibility */
  schemaVersion: '1.0';
  /** Last update timestamp in ISO 8601 format */
  lastUpdated: string;
  /** Registered repositories accepting contributions */
  repositories: RegisteredRepository[];
}

/**
 * A repository registered in the Symphony program.
 */
export interface RegisteredRepository {
  /** Repository slug (e.g., "owner/repo-name") */
  slug: string;
  /** Display name for the repository */
  name: string;
  /** Short description of the project */
  description: string;
  /** Repository URL */
  url: string;
  /** Primary category for filtering */
  category: SymphonyCategory;
  /** Optional tags for search */
  tags?: string[];
  /** Repository owner/maintainer info */
  maintainer: {
    name: string;
    url?: string;
  };
  /** Whether repo is currently active in Symphony */
  isActive: boolean;
  /** Featured flag for homepage display */
  featured?: boolean;
  /** Date added to registry (ISO 8601) */
  addedAt: string;
}

/**
 * Categories for organizing Symphony repositories.
 */
export type SymphonyCategory =
  | 'ai-ml'           // AI/ML tools and libraries
  | 'developer-tools' // Developer productivity tools
  | 'infrastructure'  // DevOps, cloud, infrastructure
  | 'documentation'   // Documentation projects
  | 'web'             // Web frameworks and libraries
  | 'mobile'          // Mobile development
  | 'data'            // Data processing, databases
  | 'security'        // Security tools
  | 'other';          // Miscellaneous

// ============================================================================
// GitHub Issue Types (Fetched via GitHub API)
// ============================================================================

/**
 * Reference to an Auto Run document.
 * Supports both repository-relative paths and external URLs (e.g., GitHub attachments).
 */
export interface DocumentReference {
  /** Display name (filename without path) */
  name: string;
  /**
   * For repo-relative paths: the path within the repository (e.g., "docs/task.md")
   * For external files: the download URL
   */
  path: string;
  /** Whether this is an external URL that needs to be downloaded */
  isExternal: boolean;
}

/**
 * A GitHub issue with the `runmaestro.ai` label.
 * Represents a contribution opportunity.
 */
export interface SymphonyIssue {
  /** GitHub issue number */
  number: number;
  /** Issue title */
  title: string;
  /** Issue body (contains Auto Run doc paths) */
  body: string;
  /** Issue URL */
  url: string;
  /** HTML URL for browser */
  htmlUrl: string;
  /** Issue author */
  author: string;
  /** When issue was created */
  createdAt: string;
  /** When issue was last updated */
  updatedAt: string;
  /** Parsed Auto Run document references from issue body */
  documentPaths: DocumentReference[];
  /** Availability status */
  status: IssueStatus;
  /** If in progress, the PR working on it */
  claimedByPr?: {
    number: number;
    url: string;
    author: string;
    isDraft: boolean;
  };
}

/**
 * Issue availability status.
 */
export type IssueStatus = 'available' | 'in_progress' | 'completed';

// ============================================================================
// Contribution Types (Local tracking)
// ============================================================================

/**
 * An active contribution in progress.
 * Each contribution creates a dedicated agent session.
 */
export interface ActiveContribution {
  /** Unique contribution ID */
  id: string;
  /** Repository slug */
  repoSlug: string;
  /** Repository name (cached) */
  repoName: string;
  /** GitHub issue number */
  issueNumber: number;
  /** Issue title (cached) */
  issueTitle: string;
  /** Local path to cloned repository */
  localPath: string;
  /** Branch name created for this contribution */
  branchName: string;
  /** Draft PR number (created immediately) */
  draftPrNumber: number;
  /** Draft PR URL */
  draftPrUrl: string;
  /** When contribution was started */
  startedAt: string;
  /** Current status */
  status: ContributionStatus;
  /** Progress tracking */
  progress: {
    totalDocuments: number;
    completedDocuments: number;
    currentDocument?: string;
    totalTasks: number;
    completedTasks: number;
  };
  /** Token usage so far */
  tokenUsage: {
    inputTokens: number;
    outputTokens: number;
    estimatedCost: number;
  };
  /** Time spent in Auto Run (ms) */
  timeSpent: number;
  /** Maestro session ID - the dedicated agent session */
  sessionId: string;
  /** Agent provider used (e.g., 'claude-code') */
  agentType: string;
  /** Error details if failed */
  error?: string;
}

// ============================================================================
// Session Metadata Types (Stored on Session object)
// ============================================================================

/**
 * Symphony-specific metadata attached to agent sessions.
 * Stored on session.symphonyMetadata when session is a Symphony contribution.
 */
export interface SymphonySessionMetadata {
  /** Flag to identify Symphony sessions */
  isSymphonySession: true;
  /** Contribution ID for cross-referencing */
  contributionId: string;
  /** Repository slug (e.g., "owner/repo") */
  repoSlug: string;
  /** GitHub issue number being worked on */
  issueNumber: number;
  /** Issue title for display */
  issueTitle: string;
  /** Draft PR number (set after first commit) */
  draftPrNumber?: number;
  /** Draft PR URL (set after first commit) */
  draftPrUrl?: string;
  /** Auto Run document paths from the issue */
  documentPaths: string[];
  /** Contribution status */
  status: ContributionStatus;
}

/**
 * Status of an active contribution.
 */
export type ContributionStatus =
  | 'cloning'           // Cloning repository
  | 'creating_pr'       // Creating draft PR
  | 'running'           // Auto Run in progress
  | 'paused'            // User paused
  | 'completing'        // Pushing final changes
  | 'ready_for_review'  // PR marked ready
  | 'failed'            // Failed (see error field)
  | 'cancelled';        // User cancelled

/**
 * A completed contribution.
 */
export interface CompletedContribution {
  /** Contribution ID */
  id: string;
  /** Repository slug */
  repoSlug: string;
  /** Repository name */
  repoName: string;
  /** GitHub issue number */
  issueNumber: number;
  /** Issue title */
  issueTitle: string;
  /** When started */
  startedAt: string;
  /** When completed */
  completedAt: string;
  /** PR URL */
  prUrl: string;
  /** PR number */
  prNumber: number;
  /** Final token usage */
  tokenUsage: {
    inputTokens: number;
    outputTokens: number;
    totalCost: number;
  };
  /** Total time spent (ms) */
  timeSpent: number;
  /** Documents processed */
  documentsProcessed: number;
  /** Tasks completed (checkboxes) */
  tasksCompleted: number;
  /** Was PR merged? */
  merged?: boolean;
  /** Merge date if merged */
  mergedAt?: string;
}

// ============================================================================
// Contributor Statistics (For achievements)
// ============================================================================

/**
 * Contributor statistics for tracking achievements.
 * Stored locally at: ~/Library/Application Support/Maestro/symphony-stats.json
 */
export interface ContributorStats {
  // ─────────────────────────────────────────────────────────────────────────
  // Counts
  // ─────────────────────────────────────────────────────────────────────────

  /** Total PRs created via Symphony */
  totalContributions: number;
  /** Total PRs that were merged */
  totalMerged: number;
  /** Total GitHub issues resolved */
  totalIssuesResolved: number;
  /** Total Auto Run documents processed */
  totalDocumentsProcessed: number;
  /** Total checkbox tasks completed */
  totalTasksCompleted: number;

  // ─────────────────────────────────────────────────────────────────────────
  // Resources Donated
  // ─────────────────────────────────────────────────────────────────────────

  /** Total tokens used (input + output) */
  totalTokensUsed: number;
  /** Total time spent in Auto Run (ms) */
  totalTimeSpent: number;
  /** Estimated dollar value of tokens donated */
  estimatedCostDonated: number;

  // ─────────────────────────────────────────────────────────────────────────
  // Reach
  // ─────────────────────────────────────────────────────────────────────────

  /** Unique repository slugs contributed to */
  repositoriesContributed: string[];
  /** Number of unique maintainers helped */
  uniqueMaintainersHelped: number;

  // ─────────────────────────────────────────────────────────────────────────
  // Streaks
  // ─────────────────────────────────────────────────────────────────────────

  /** Current consecutive days with contributions */
  currentStreak: number;
  /** Longest streak ever */
  longestStreak: number;
  /** Last contribution date for streak calculation */
  lastContributionDate?: string;

  // ─────────────────────────────────────────────────────────────────────────
  // Timestamps
  // ─────────────────────────────────────────────────────────────────────────

  /** First ever contribution */
  firstContributionAt?: string;
  /** Most recent contribution */
  lastContributionAt?: string;
}

// ============================================================================
// Symphony State (Combined local state)
// ============================================================================

/**
 * Complete Symphony state stored locally.
 */
export interface SymphonyState {
  /** Active contributions in progress */
  active: ActiveContribution[];
  /** Completed contribution history */
  history: CompletedContribution[];
  /** Contributor statistics */
  stats: ContributorStats;
}

// ============================================================================
// Cache Types
// ============================================================================

/**
 * Local cache for registry and issues.
 */
export interface SymphonyCache {
  /** Cached registry data */
  registry?: {
    data: SymphonyRegistry;
    fetchedAt: number;
  };
  /** Cached issues by repo slug */
  issues: Record<string, {
    data: SymphonyIssue[];
    fetchedAt: number;
  }>;
}

// ============================================================================
// API Response Types
// ============================================================================

export interface GetRegistryResponse {
  registry: SymphonyRegistry;
  fromCache: boolean;
  cacheAge?: number;
}

export interface GetIssuesResponse {
  issues: SymphonyIssue[];
  fromCache: boolean;
  cacheAge?: number;
}

export interface StartContributionResponse {
  success: boolean;
  contributionId?: string;
  draftPrUrl?: string;
  draftPrNumber?: number;
  error?: string;
}

export interface CompleteContributionResponse {
  success: boolean;
  prUrl?: string;
  prNumber?: number;
  error?: string;
}

// ============================================================================
// Error Types
// ============================================================================

export type SymphonyErrorType =
  | 'network'           // Network/fetch errors
  | 'github_api'        // GitHub API errors
  | 'git'               // Git operation errors
  | 'parse'             // Document path parsing errors
  | 'pr_creation'       // PR creation failed
  | 'autorun'           // Auto Run execution error
  | 'cancelled';        // User cancelled

export class SymphonyError extends Error {
  constructor(
    message: string,
    public readonly type: SymphonyErrorType,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'SymphonyError';
  }
}
