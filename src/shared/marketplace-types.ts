/**
 * Marketplace Types
 *
 * Type definitions for the Playbook Exchange feature.
 * These types define the structure of marketplace data fetched from GitHub
 * and the local cache.
 */

import type { TaskSelectionMode } from './types';

// ============================================================================
// Marketplace Manifest Types (fetched from GitHub)
// ============================================================================

/**
 * Root manifest structure fetched from the GitHub repository.
 * URL: https://raw.githubusercontent.com/RunMaestro/Maestro-Playbooks/main/manifest.json
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
type PlaybookSource = 'official' | 'local';

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
	 * Fresh agent session per unchecked `task` (the default) or per `document`. Optional: absent,
	 * or any other value, runs per task, which is what every playbook before this field was
	 * written against. Carried onto the imported playbook, where Auto Run reads it.
	 */
	taskSelectionMode?: TaskSelectionMode;
	/**
	 * Optional list of asset files in the assets/ subfolder.
	 * These are non-markdown files like config files, YAML, Dockerfiles, etc.
	 * that are bundled with the playbook.
	 */
	assets?: string[];
	/** Source of the playbook - official (from GitHub) or local (from local-manifest.json) */
	source?: PlaybookSource;
	/**
	 * Minimum Maestro version required to install this playbook (semver).
	 * If the running version is older, the playbook is shown but install is blocked.
	 * Absent or invalid → no minimum (treated as compatible with any version).
	 */
	minMaestroVersion?: string;
	/**
	 * Beta flag - soft signal that the playbook is still maturing.
	 * Strictly checked: only the boolean literal `true` counts as beta. Any other
	 * value (false, "yes", 1, absent) is treated as not-beta. Does not affect install.
	 */
	beta?: boolean;
	/**
	 * Optional Launch block: the typed questions, preconditions and outro that let the Playbook
	 * Exchange offer a one-click Launch next to Download. Builds that predate the field ignore it,
	 * so the playbook keeps Download everywhere. The block carries its own minMaestroVersion;
	 * never raise the top-level one for it. An invalid block is dropped (with a logged warning)
	 * and the playbook stays download-only.
	 */
	launch?: PlaybookLaunchSpec;
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
// Playbook Launch Types (the optional `launch` block on a manifest entry)
// ============================================================================

/**
 * Typed questions, preconditions and an outro that turn an Exchange playbook into a one-click
 * Launch. Each input's `name` matches a `**NAME:** value` line in the playbook's `prompt` (the
 * value sits between backticks); launching rewrites only that value, never the task documents.
 */
export interface PlaybookLaunchSpec {
	/**
	 * Lowest Maestro version whose launch flow understands this block.
	 * Older builds show Download only.
	 */
	minMaestroVersion?: string;
	/** Markdown shown at the top of the launch modal. */
	intro?: string;
	preconditions?: {
		/** Launch is disabled on other platforms, with the reason shown. */
		platforms?: Array<'darwin' | 'linux' | 'win32'>;
		/** Human-readable needs, shown as a list ("gh logged in", "React web project"). */
		requires?: string[];
		/**
		 * Text of a checkbox the user must tick before Launch enables
		 * (security-sensitive playbooks).
		 */
		confirm?: string;
		/** The playbook's tasks call maestro-cli from the agent's shell. */
		maestroCli?: 'required' | 'optional';
	};
	/** May be empty: launch is then "pick agent and go". */
	inputs: PlaybookLaunchInput[];
	/** Overrides the playbook's maxLoops for launched runs. */
	maxLoops?: number | null;
	/** What happens to the imported task documents once the run finishes. Default 'remove-docs'. */
	cleanup?: 'remove-docs' | 'keep';
	outro: {
		title?: string;
		/** Markdown. `{{INPUT_NAME}}` and built-in template variables are substituted. */
		summary: string;
		/** Markdown bullets, same substitution as `summary`. */
		nextSteps: string[];
		/** Outputs to offer as "Open" buttons. Same substitution as `summary`. */
		files?: Array<{ label: string; path: string }>;
		/** A file the run writes; its first heading section is shown as the verdict. */
		reportFile?: string;
	};
}

/**
 * One typed question in a launch modal.
 */
export interface PlaybookLaunchInput {
	/** UPPER_SNAKE_CASE. Must not collide with any built-in in TEMPLATE_VARIABLES. */
	name: string;
	label: string;
	type: 'text' | 'textarea' | 'url' | 'path' | 'number' | 'boolean' | 'select' | 'multiselect';
	default?: string | number | boolean | string[];
	required?: boolean;
	help?: string;
	placeholder?: string;
	/** `select` and `multiselect` only. */
	options?: Array<{ value: string; label?: string }>;
	/**
	 * `number` only. Appended when written (80 with unit "%" is written "80%"). Set it only where
	 * the shipped value carries the unit.
	 */
	unit?: string;
	/** `multiselect` only. Written when nothing is picked (for example "none"). */
	emptyValue?: string;
	/** `number` only. */
	min?: number;
	/** `number` only. */
	max?: number;
	/** `text` and `url` only. A JS regex source. */
	pattern?: string;
	/** Rendered inside a collapsed "Advanced" section. */
	advanced?: boolean;
}

/**
 * Answers to a playbook's launch inputs, keyed by input `name`. An optional input the user left
 * empty has no key.
 */
export type PlaybookLaunchValues = Record<string, string | number | boolean | string[]>;

// ============================================================================
// Playbook Launch Records (persisted in userData/playbook-launches.json)
// ============================================================================

/**
 * How a launched Auto Run ended. Mirrors the fields of the renderer's BatchCompleteInfo that a
 * launch record keeps.
 */
export interface PlaybookLaunchCompletion {
	completedTasks: number;
	totalTasks: number;
	elapsedTimeMs: number;
	/** Total estimated cost in USD across all tasks, when the run reported one. */
	totalCostUsd?: number;
	/** True when the user stopped the run before it finished. */
	wasStopped: boolean;
}

/**
 * One launch of a marketplace playbook. Persisted in main so the CLI can read status, and the
 * outro can be shown, after a restart.
 */
export interface PlaybookLaunchRecord {
	/** Unique id of this launch */
	launchId: string;
	/** Id of the marketplace playbook that was launched */
	playbookId: string;
	/** Title of the playbook at launch time, so the outro survives a later manifest change */
	playbookTitle: string;
	/** Id of the agent the Auto Run executes in */
	sessionId: string;
	/**
	 * Name of the launch folder inside the agent's Auto Run folder. Cleanup may delete this one
	 * folder and nothing else.
	 */
	folderRelativePath: string;
	/** Id of the saved-playbook record the import created */
	savedPlaybookId: string;
	/** True when the user chose to save the playbook as reusable; cleanup then keeps the record */
	keepSavedPlaybook: boolean;
	/** The answers the user gave */
	values: PlaybookLaunchValues;
	status: 'running' | 'completed' | 'stopped' | 'failed';
	/** Epoch milliseconds (Date.now()) when the launch started */
	startedAt: number;
	/** Epoch milliseconds (Date.now()) when the launch ended */
	finishedAt?: number;
	completion?: PlaybookLaunchCompletion;
	/**
	 * What cleanup did: removed the launch folder ('done'), kept it because the spec says to
	 * ('kept'), or left it because the run was stopped ('skipped-stopped').
	 */
	cleanup?: 'done' | 'kept' | 'skipped-stopped';
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

/**
 * Launch values that failed `validateLaunchValues` (`src/shared/playbookLaunch.ts`). It is an import
 * error, so a caller that handles `MarketplaceImportError` keeps working. `fieldErrors` holds the
 * message for each failing input, keyed by input name. The error message lists them too, so a
 * caller that shows only `message` (IPC, the web bridge, the CLI) still names every field.
 */
export class MarketplaceLaunchValuesError extends MarketplaceImportError {
	constructor(public readonly fieldErrors: Readonly<Record<string, string>>) {
		super(
			`Launch values are not valid: ${Object.entries(fieldErrors)
				.map(([name, message]) => `${name}: ${message}`)
				.join('; ')}`
		);
		this.name = 'MarketplaceLaunchValuesError';
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
