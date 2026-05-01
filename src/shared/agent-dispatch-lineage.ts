/**
 * agent-dispatch-lineage.ts
 *
 * Helpers that extract Delivery Planner PRD/epic/task lineage and Living Wiki
 * doc references from a WorkItem's metadata field.
 *
 * Agent Dispatch never writes metadata — it only reads what Delivery Planner
 * and Living Wiki have already stored in the Work Graph. This module is a
 * thin read-only lens; no side effects, no imports from planner or wiki
 * internals.
 */

import type { WorkItem } from './work-graph-types';

// ---------------------------------------------------------------------------
// Delivery Planner lineage
// ---------------------------------------------------------------------------

/**
 * PRD/epic/task lineage extracted from a WorkItem written by Delivery Planner.
 *
 * All fields are optional — a task might belong to an epic without a PRD, an
 * epic might not yet be linked to a PRD, and a PRD item itself has no parent
 * IDs.
 */
export interface DeliveryPlannerLineage {
	/**
	 * The Delivery Planner concept kind for this item.
	 * Present when `metadata.kind` is one of 'prd' | 'epic' | 'task'.
	 */
	kind: 'prd' | 'epic' | 'task' | undefined;
	/** Work Graph ID of the owning PRD, if any. */
	prdWorkItemId: string | undefined;
	/** Work Graph ID of the owning epic, if any. */
	epicWorkItemId: string | undefined;
}

/**
 * Extract Delivery Planner lineage from a WorkItem's metadata.
 *
 * Returns `{ kind: undefined, prdWorkItemId: undefined, epicWorkItemId: undefined }`
 * for items that were not created by Delivery Planner.
 */
export function extractDeliveryPlannerLineage(item: WorkItem): DeliveryPlannerLineage {
	const meta = item.metadata;

	const rawKind = meta?.kind;
	const kind: DeliveryPlannerLineage['kind'] =
		rawKind === 'prd' || rawKind === 'epic' || rawKind === 'task' ? rawKind : undefined;

	const prdWorkItemId =
		typeof meta?.prdWorkItemId === 'string' && meta.prdWorkItemId ? meta.prdWorkItemId : undefined;

	const epicWorkItemId =
		typeof meta?.epicWorkItemId === 'string' && meta.epicWorkItemId
			? meta.epicWorkItemId
			: undefined;

	return { kind, prdWorkItemId, epicWorkItemId };
}

/**
 * Returns true when the item was created by Delivery Planner (i.e. it carries
 * a recognised `metadata.kind` of 'prd', 'epic', or 'task').
 */
export function isDeliveryPlannerItem(item: WorkItem): boolean {
	return extractDeliveryPlannerLineage(item).kind !== undefined;
}

// ---------------------------------------------------------------------------
// Living Wiki references
// ---------------------------------------------------------------------------

/**
 * Living Wiki context extracted from a WorkItem's metadata.
 *
 * A WorkItem may reference a wiki document in two ways:
 *
 * 1. The item IS a Living Wiki document (`metadata.kind === 'living-wiki-doc'`).
 * 2. The item is a Living Wiki doc-gap candidate
 *    (`metadata.kind === 'living-wiki-doc-gap'`) that links back to the
 *    source file that needs documentation.
 */
export interface LivingWikiReference {
	/**
	 * The Living Wiki kind for this item, if present.
	 * 'living-wiki-doc' means the item represents a wiki document.
	 * 'living-wiki-doc-gap' means the item is a doc-gap candidate.
	 */
	kind: 'living-wiki-doc' | 'living-wiki-doc-gap' | undefined;
	/** slug of the wiki document (present on 'living-wiki-doc' items). */
	docSlug: string | undefined;
	/** area identifier of the wiki document (present on 'living-wiki-doc' items). */
	docArea: string | undefined;
	/**
	 * Repository-relative git path of the source file that needs documentation
	 * (present on 'living-wiki-doc-gap' items).
	 */
	sourceGitPath: string | undefined;
	/**
	 * Work Graph ID of the Delivery Planner PRD/epic that owns this gap
	 * (present on 'living-wiki-doc-gap' items when set by Living Wiki).
	 */
	plannerWorkItemId: string | undefined;
}

/**
 * Extract Living Wiki references from a WorkItem's metadata.
 *
 * Returns all-`undefined` fields for items that are not Living Wiki items.
 */
export function extractLivingWikiReference(item: WorkItem): LivingWikiReference {
	const meta = item.metadata;
	const rawKind = meta?.kind;

	const kind: LivingWikiReference['kind'] =
		rawKind === 'living-wiki-doc' || rawKind === 'living-wiki-doc-gap' ? rawKind : undefined;

	const docSlug =
		kind === 'living-wiki-doc' && typeof meta?.slug === 'string' && meta.slug
			? meta.slug
			: undefined;

	const docArea =
		kind === 'living-wiki-doc' && typeof meta?.area === 'string' && meta.area
			? meta.area
			: undefined;

	const sourceGitPath =
		kind === 'living-wiki-doc-gap' && typeof meta?.sourceGitPath === 'string' && meta.sourceGitPath
			? meta.sourceGitPath
			: undefined;

	const plannerWorkItemId =
		kind === 'living-wiki-doc-gap' &&
		typeof meta?.plannerWorkItemId === 'string' &&
		meta.plannerWorkItemId
			? meta.plannerWorkItemId
			: undefined;

	return { kind, docSlug, docArea, sourceGitPath, plannerWorkItemId };
}

/**
 * Returns true when the item is a Living Wiki document or doc-gap candidate.
 */
export function isLivingWikiItem(item: WorkItem): boolean {
	return extractLivingWikiReference(item).kind !== undefined;
}
