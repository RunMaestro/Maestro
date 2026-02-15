/**
 * Maestro Symphony Constants
 */

import type { ContributorStats } from './symphony-types';

// Registry URL (hosted in Maestro repo)
export const SYMPHONY_REGISTRY_URL =
  'https://raw.githubusercontent.com/RunMaestro/Maestro/main/symphony-registry.json';

// GitHub API base
export const GITHUB_API_BASE = 'https://api.github.com';

// Issue label to look for
export const SYMPHONY_ISSUE_LABEL = 'runmaestro.ai';

// Label that marks an issue as blocked (grayed out in UI)
export const SYMPHONY_BLOCKING_LABEL = 'blocking';

// Cache settings
export const REGISTRY_CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
export const ISSUES_CACHE_TTL_MS = 5 * 60 * 1000;        // 5 minutes (issues change frequently)

// Local storage paths (relative to app data dir)
export const SYMPHONY_STATE_PATH = 'symphony-state.json';
export const SYMPHONY_CACHE_PATH = 'symphony-cache.json';
export const SYMPHONY_REPOS_DIR = 'symphony-repos';

// Branch naming
export const BRANCH_TEMPLATE = 'symphony/issue-{issue}-{timestamp}';

// PR templates
export const DRAFT_PR_TITLE_TEMPLATE = '[WIP] Symphony: {issue-title} (#{issue})';
export const DRAFT_PR_BODY_TEMPLATE = `## Maestro Symphony Contribution

Working on #{issue} via [Maestro Symphony](https://runmaestro.ai).

**Status:** In Progress
**Started:** {timestamp}

---

This PR will be updated automatically when the Auto Run completes.`;

export const READY_PR_BODY_TEMPLATE = `## Maestro Symphony Contribution

Closes #{issue}

**Documents Processed:** {docs}
**Tasks Completed:** {tasks}
**Time Spent:** {time}
**Tokens Used:** {tokens}

---

*Contributed via [Maestro Symphony](https://runmaestro.ai)*`;

// Categories with display info
export const SYMPHONY_CATEGORIES: Record<string, { label: string; emoji: string }> = {
  'ai-ml': { label: 'AI & ML', emoji: '🤖' },
  'developer-tools': { label: 'Developer Tools', emoji: '🛠️' },
  'infrastructure': { label: 'Infrastructure', emoji: '🏗️' },
  'documentation': { label: 'Documentation', emoji: '📚' },
  'web': { label: 'Web', emoji: '🌐' },
  'mobile': { label: 'Mobile', emoji: '📱' },
  'data': { label: 'Data', emoji: '📊' },
  'security': { label: 'Security', emoji: '🔒' },
  'other': { label: 'Other', emoji: '📦' },
};

// Document path regex patterns (to extract from issue body)
// Note: These patterns are designed to prevent ReDoS attacks by:
// 1. Using bounded repetition where possible
// 2. Avoiding nested quantifiers
// 3. Limiting whitespace matching
export const DOCUMENT_PATH_PATTERNS = [
  // Markdown list items: - `path/to/doc.md` or - path/to/doc.md
  // Limited leading whitespace to 20 chars to prevent ReDoS
  /^[ \t]{0,20}[-*][ \t]{1,4}`?([^\s`]+\.md)`?[ \t]*$/gm,
  // Numbered list: 1. `path/to/doc.md`
  /^[ \t]{0,20}\d{1,4}\.[ \t]{1,4}`?([^\s`]+\.md)`?[ \t]*$/gm,
  // Bare paths on their own line
  /^[ \t]{0,20}([a-zA-Z0-9_\-./]{1,200}\.md)[ \t]*$/gm,
];

// Default stats for new users
export const DEFAULT_CONTRIBUTOR_STATS: ContributorStats = {
  totalContributions: 0,
  totalMerged: 0,
  totalIssuesResolved: 0,
  totalDocumentsProcessed: 0,
  totalTasksCompleted: 0,
  totalTokensUsed: 0,
  totalTimeSpent: 0,
  estimatedCostDonated: 0,
  repositoriesContributed: [],
  uniqueMaintainersHelped: 0,
  currentStreak: 0,
  longestStreak: 0,
};
