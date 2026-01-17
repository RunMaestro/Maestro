/**
 * Marketplace Types
 *
 * Type definitions for the Playbook Exchange feature.
 * These types define the structure of marketplace data fetched from GitHub
 * and the local cache.
 */

// ============================================================================
// Marketplace Manifest Types (fetched from GitHub)
// ============================================================================

/**
 * Root manifest structure fetched from the GitHub repository.
 * URL: https://raw.githubusercontent.com/pedramamini/Maestro-Playbooks/main/manifest.json
 */
export interface MarketplaceManifest {
  /** Last update date in YYYY-MM-DD format */
  lastUpdated: string;
  /** Array of available playbooks */
  playbooks: MarketplacePlaybook[];
}

/**
 * Playbook source type - distinguishes official GitHub playbooks from local ones.
 */
export type PlaybookSource = 'official' | 'local';

/**
 * Individual playbook entry in the marketplace manifest.
 */
export interface MarketplacePlaybook {
  /** Unique slug identifier (e.g., "development-security") */
  id: string;
  /** Display name for the playbook */
  title: string;
  /** Short description for tile display and search */
  description: string;
  /** Top-level category for tab filtering */
  category: string;
  /** Optional nested subcategory */
  subcategory?: string;
  /** Playbook creator name */
  author: string;
  /** Optional URL to author's website/profile */
  authorLink?: string;
  /** Optional searchable keyword tags */
  tags?: string[];
  /** Last update date in YYYY-MM-DD format */
  lastUpdated: string;
  /** Folder path in repo for fetching documents (GitHub path or local filesystem path) */
  path: string;
  /** Ordered list of documents in the playbook */
  documents: MarketplaceDocument[];
  /** Whether to loop through documents */
  loopEnabled: boolean;
  /** Maximum number of loops (null for unlimited) */
  maxLoops?: number | null;
  /** Custom prompt, or null to use Maestro's default Auto Run prompt */
  prompt: string | null;
  /**
   * Optional list of asset files in the assets/ subfolder.
   * These are non-markdown files like config files, YAML, Dockerfiles, etc.
   * that are bundled with the playbook.
   */
  assets?: string[];
  /** Source of the playbook - official (from GitHub) or local (from local-manifest.json) */
  source?: PlaybookSource;
}

/**
 * Document entry within a marketplace playbook.
 */
export interface MarketplaceDocument {
  /** Filename without .md extension */
  filename: string;
  /** Whether to reset checkboxes on completion */
  resetOnCompletion: boolean;
}

// ============================================================================
// Cache Types
// ============================================================================

/**
 * Cache structure stored in userData/marketplace-cache.json.
 */
export interface MarketplaceCache {
  /** Timestamp when data was fetched (Date.now()) */
  fetchedAt: number;
  /** The cached manifest data */
  manifest: MarketplaceManifest;
}

// ============================================================================
// Document Content Types
// ============================================================================

/**
 * Document content fetched on-demand from GitHub.
 */
export interface MarketplaceDocumentContent {
  /** Filename of the document */
  filename: string;
  /** Raw markdown content */
  content: string;
}

// ============================================================================
// Error Types
// ============================================================================

/**
 * Error types for marketplace operations.
 */
export type MarketplaceErrorType = 'network' | 'cache' | 'import' | 'not_found';

/**
 * Base marketplace error interface.
 */
export interface MarketplaceError {
  /** The error type category */
  type: MarketplaceErrorType;
  /** Human-readable error message */
  message: string;
  /** Original error details (if available) */
  cause?: unknown;
}

/**
 * Network/GitHub fetch errors.
 */
export class MarketplaceFetchError extends Error {
  readonly type = 'network' as const;
  constructor(
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'MarketplaceFetchError';
  }
}

/**
 * Cache read/write errors.
 */
export class MarketplaceCacheError extends Error {
  readonly type = 'cache' as const;
  constructor(
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'MarketplaceCacheError';
  }
}

/**
 * Import operation errors.
 */
export class MarketplaceImportError extends Error {
  readonly type = 'import' as const;
  constructor(
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'MarketplaceImportError';
  }
}

// ============================================================================
// API Response Types
// ============================================================================

/**
 * Response from marketplace:getManifest handler.
 */
export interface GetManifestResponse {
  /** The marketplace manifest */
  manifest: MarketplaceManifest;
  /** Whether the data was served from cache */
  fromCache: boolean;
  /** Cache age in milliseconds (if fromCache is true) */
  cacheAge?: number;
}

/**
 * Response from marketplace:getDocument handler.
 */
export interface GetDocumentResponse {
  /** Raw markdown content of the document */
  content: string;
}

/**
 * Response from marketplace:getReadme handler.
 */
export interface GetReadmeResponse {
  /** Raw markdown content of the README, or null if not found */
  content: string | null;
}

/**
 * Response from marketplace:importPlaybook handler.
 */
export interface ImportPlaybookResponse {
  /** The created playbook entry */
  playbook: {
    id: string;
    name: string;
    createdAt: number;
    updatedAt: number;
    documents: Array<{ filename: string; resetOnCompletion: boolean }>;
    loopEnabled: boolean;
    maxLoops?: number | null;
    prompt: string;
  };
  /** List of imported document filenames */
  importedDocs: string[];
  /** List of imported asset filenames (from assets/ subfolder) */
  importedAssets?: string[];
}

/**
 * Standard error response format for marketplace handlers.
 */
export interface MarketplaceErrorResponse {
  success: false;
  error: string;
  errorType: MarketplaceErrorType;
}
