import type {
	WorkGraphActor,
	WorkItem,
	WorkItemEvent,
	WorkItemFilters,
	WorkItemStatus,
} from './work-graph-types';

/**
 * Living Wiki contracts.
 *
 * Living Wiki docs are Work Graph document items. Living Wiki owns feature IPC
 * and service naming under `livingWiki`, while shared work item access remains
 * under Work Graph's `workGraph` namespace.
 */

export const LIVING_WIKI_IPC_NAMESPACE = 'livingWiki' as const;
export const LIVING_WIKI_WORK_API_NAMESPACE = 'workGraph' as const;
export const LIVING_WIKI_AGENT_READY_NOTE =
	'agent-ready is for implementation work items ready for Agent Dispatch, not for Living Wiki auto-generation.';

/**
 * Tag applied to all Living Wiki doc gap candidates surfaced through Work Graph.
 * These items are NEVER tagged agent-ready by default; Delivery Planner or a
 * human must explicitly promote them to agent-ready when they become actionable.
 */
export const LIVING_WIKI_DOC_GAP_TAG = 'living-wiki-doc-gap' as const;
export type LivingWikiDocGapTag = typeof LIVING_WIKI_DOC_GAP_TAG;

export type LivingWikiIpcNamespace = typeof LIVING_WIKI_IPC_NAMESPACE;
export type LivingWikiWorkApiNamespace = typeof LIVING_WIKI_WORK_API_NAMESPACE;
export type LivingWikiWorkItemType = Extract<WorkItem['type'], 'document'>;
export type LivingWikiWorkItemSource = Extract<WorkItem['source'], 'living-wiki'>;

export type WikiAreaKind =
	| 'overview'
	| 'architecture'
	| 'feature'
	| 'api'
	| 'operations'
	| 'custom';

export interface LivingWikiProjectScope {
	/** Active Maestro project identifier. */
	activeProjectId: string;
	/** Absolute repository/worktree root. */
	repositoryRoot: string;
	/** Absolute root for the active project inside the repository. */
	projectRoot: string;
	/** Repository-relative active project root, or "." for repository root projects. */
	projectRootGitPath: string;
	/** Optional monorepo package or project segment name. */
	packageName?: string;
}

export interface LivingWikiConfig {
	/** Repository-relative directory containing wiki docs. */
	wikiRoot: string;
	/** Repository-relative directory for generated machine metadata. */
	metaRoot: string;
	/** Include globs resolved from the active project root. */
	include: string[];
	/** Exclude globs resolved from the active project root. */
	exclude: string[];
	/** Optional per-area config keyed by WikiArea.id. */
	areas?: Record<string, Partial<WikiArea>>;
	/**
	 * Fraction of source files that must be covered by wiki docs (0–1, default 0.5).
	 * When set, `runValidationPipeline` fails if coverage falls below this value.
	 * Pass 0 to disable the coverage gate.
	 */
	coverageThreshold?: number;
}

export interface LivingWikiProject {
	id: string;
	name: string;
	scope: LivingWikiProjectScope;
	config: LivingWikiConfig;
	updatedAt: string;
}

export interface WikiArea {
	id: string;
	name: string;
	kind: WikiAreaKind;
	rootGitPath: string;
	description?: string;
	tags?: string[];
}

export interface WikiMachineArtifact {
	/** Repository-relative path under LivingWikiConfig.metaRoot. */
	gitPath: string;
	kind: 'coverage' | 'mermaid' | 'index' | 'trace' | string;
	createdAt: string;
	updatedAt?: string;
	/**
	 * Machine artifacts are not user-facing Work Graph items unless Work Graph
	 * later adds an explicit artifact item type.
	 */
	workGraphItem?: never;
}

export interface LivingWikiFrontmatter {
	title?: string;
	description?: string;
	tags?: string[];
	area?: string;
	sourceFiles?: string[];
	[key: string]: unknown;
}

export interface LivingWikiDocMetadata {
	frontmatter: LivingWikiFrontmatter;
	body: string;
	areaId?: string;
	sourceGitPaths: string[];
	metaArtifacts: WikiMachineArtifact[];
}

export interface LivingWikiDoc extends WorkItem {
	type: LivingWikiWorkItemType;
	source: LivingWikiWorkItemSource;
	status: WorkItemStatus;
	metadata: LivingWikiDocMetadata & Record<string, unknown>;
	workGraphEvents: WorkItemEvent[];
}

export type WikiDiagnosticSeverity = 'info' | 'warning' | 'error';

export interface WikiDiagnostic {
	id: string;
	severity: WikiDiagnosticSeverity;
	message: string;
	gitPath?: string;
	sourceGitPath?: string;
	workGraphItem?: Pick<WorkItem, 'id' | 'type' | 'title' | 'gitPath'>;
}

export interface WikiCoverageReport {
	projectId: string;
	generatedAt: string;
	totalSourceFiles: number;
	coveredSourceFiles: number;
	uncoveredSourceGitPaths: string[];
	diagnostics: WikiDiagnostic[];
}

export interface WikiMermaidReport {
	projectId: string;
	generatedAt: string;
	diagrams: Array<{
		id: string;
		docGitPath: string;
		sourceGitPaths: string[];
		mermaid: string;
		diagnostics?: WikiDiagnostic[];
	}>;
}

export interface WikiRunResult {
	projectId: string;
	startedAt: string;
	finishedAt: string;
	docs: LivingWikiDoc[];
	coverage?: WikiCoverageReport;
	mermaid?: WikiMermaidReport;
	diagnostics: WikiDiagnostic[];
	workGraphEvents: WorkItemEvent[];
}

export interface WikiDocFilter extends Pick<
	WorkItemFilters,
	'ids' | 'tags' | 'anyTags' | 'excludeTags'
> {
	projectId?: string;
	areaId?: string;
	tags?: string[];
	gitPaths?: string[];
	sourceGitPaths?: string[];
	text?: string;
}

export interface WikiSearchQuery extends WikiDocFilter {
	projectPath?: string;
	query: string;
	limit?: number;
	offset?: number;
}

export interface WikiSearchResult {
	doc: LivingWikiDoc;
	score?: number;
	matches: Array<{
		field: 'title' | 'body' | 'frontmatter' | 'tag' | 'gitPath';
		excerpt: string;
	}>;
}

export interface LivingWikiProjectRequest {
	projectPath: string;
	projectId?: string;
}

export interface LivingWikiEnrollRequest extends LivingWikiProjectRequest {
	projectName?: string;
	projectRoot?: string;
	packageName?: string;
	actor?: WorkGraphActor;
}

export interface LivingWikiConfigUpdateRequest extends LivingWikiProjectRequest {
	config: Partial<LivingWikiConfig>;
}

export interface LivingWikiDocRequest extends LivingWikiProjectRequest {
	id?: string;
	gitPath?: string;
	relativePath?: string;
}

export interface LivingWikiDocSaveRequest extends LivingWikiProjectRequest {
	id?: string;
	relativePath: string;
	content: string;
	title?: string;
	tags?: string[];
	actor?: WorkGraphActor;
}

export interface LivingWikiRunRequest extends LivingWikiProjectRequest {
	include?: string[];
	exclude?: string[];
}

export interface LivingWikiWatchRequest extends LivingWikiProjectRequest {
	token?: string;
	/** SSH remote config for the project, if the project lives on a remote host. */
	sshRemoteConfig?: import('./types').AgentSshRemoteConfig;
}

export interface LivingWikiHistoryRequest extends LivingWikiProjectRequest {
	id?: string;
	limit?: number;
}

export interface LivingWikiChangedEvent {
	token: string;
	projectPath: string;
	projectId: string;
	relativePath?: string;
	gitPath?: string;
	eventType: string;
	timestamp: string;
}

export interface LivingWikiEnrollProjectRequest {
	workspaceRoot: string;
	projectId: string;
	projectName?: string;
	projectRoot?: string;
	owner?: string;
}

/**
 * Input for upserting a Living Wiki doc gap candidate into the Work Graph.
 *
 * Doc gap items are `task` items with `source: 'living-wiki'` that surface
 * uncovered source files from a WikiCoverageReport. They are NOT tagged
 * agent-ready — promotion to agent-ready is the responsibility of Delivery
 * Planner or a human, never of Living Wiki generation.
 */
export interface LivingWikiDocGapInput {
	/** Repository-relative path of the source file that lacks documentation. */
	sourceGitPath: string;
	/** Repository-relative project root used as the Work Graph projectPath. */
	projectRootGitPath: string;
	/**
	 * Optional Work Graph id of the PRD or epic that owns this gap.
	 * Living Wiki records the reference in metadata for Delivery Planner to
	 * read; it does not create a graph dependency edge.
	 */
	plannerWorkItemId?: string;
	/** Optional extra tags (must not include agent-ready). */
	tags?: string[];
}

/**
 * Result returned by upsertLivingWikiDocGapItem.
 */
export interface LivingWikiDocGapResult {
	item: WorkItem;
	created: boolean;
}
