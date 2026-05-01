/**
 * LineageChip — small read-only metadata chips that surface cross-major
 * provenance on Work Graph items.
 *
 * Renders 0–3 chips depending on what lineage signals are present on the item:
 *   • Delivery Planner kind (prd / epic / task)
 *   • Living Wiki doc or doc-gap indicator
 *   • "Promotable" hint when a doc-gap has no linked planner task yet
 *
 * Intentionally small and unobtrusive: 10 px text, semi-transparent backgrounds
 * using existing theme tokens. No new colours.
 */

import React from 'react';
import { BookOpen, Layers, ArrowUpFromLine } from 'lucide-react';
import type { Theme } from '../../types';
import type { WorkItem } from '../../../shared/work-graph-types';
import {
	extractDeliveryPlannerLineage,
	extractLivingWikiReference,
} from '../../../shared/agent-dispatch-lineage';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface LineageChipProps {
	workItem: WorkItem;
	theme: Theme;
}

// ---------------------------------------------------------------------------
// Internal chip primitive
// ---------------------------------------------------------------------------

interface ChipProps {
	icon: React.ReactNode;
	label: string;
	bgColor: string;
	textColor: string;
	title?: string;
}

function Chip({ icon, label, bgColor, textColor, title }: ChipProps) {
	return (
		<span
			className="inline-flex items-center gap-0.5 text-[10px] rounded px-1.5 py-0.5 font-medium"
			style={{ backgroundColor: bgColor, color: textColor }}
			title={title}
		>
			{icon}
			{label}
		</span>
	);
}

// ---------------------------------------------------------------------------
// LineageChip
// ---------------------------------------------------------------------------

/**
 * Renders lineage chips for a Work Graph item based on its metadata.
 * Returns `null` when the item has no recognised cross-major lineage.
 */
export function LineageChip({ workItem, theme }: LineageChipProps) {
	const plannerLineage = extractDeliveryPlannerLineage(workItem);
	const wikiRef = extractLivingWikiReference(workItem);

	const chips: React.ReactNode[] = [];

	// Delivery Planner kind chip
	if (plannerLineage.kind) {
		chips.push(
			<Chip
				key="planner-kind"
				icon={<Layers className="w-2.5 h-2.5" />}
				label={plannerLineage.kind}
				bgColor={`${theme.colors.accent}18`}
				textColor={theme.colors.accent}
				title={
					plannerLineage.epicWorkItemId
						? `Epic: ${plannerLineage.epicWorkItemId}`
						: plannerLineage.prdWorkItemId
							? `PRD: ${plannerLineage.prdWorkItemId}`
							: 'Delivery Planner'
				}
			/>
		);
	}

	// Living Wiki doc chip
	if (wikiRef.kind === 'living-wiki-doc') {
		chips.push(
			<Chip
				key="wiki-doc"
				icon={<BookOpen className="w-2.5 h-2.5" />}
				label={wikiRef.docArea ? `wiki · ${wikiRef.docArea}` : 'wiki doc'}
				bgColor={`${theme.colors.success}18`}
				textColor={theme.colors.success}
				title={wikiRef.docSlug ? `slug: ${wikiRef.docSlug}` : 'Living Wiki document'}
			/>
		);
	}

	// Living Wiki doc-gap chip — also shows "promotable" hint when no planner link
	if (wikiRef.kind === 'living-wiki-doc-gap') {
		const isPromotable = !wikiRef.plannerWorkItemId;
		chips.push(
			<Chip
				key="wiki-gap"
				icon={<BookOpen className="w-2.5 h-2.5" />}
				label="doc gap"
				bgColor={`${theme.colors.warning}18`}
				textColor={theme.colors.warning}
				title={
					wikiRef.sourceGitPath ? `Undocumented: ${wikiRef.sourceGitPath}` : 'Living Wiki doc gap'
				}
			/>
		);
		if (isPromotable) {
			chips.push(
				<Chip
					key="promotable"
					icon={<ArrowUpFromLine className="w-2.5 h-2.5" />}
					label="promotable"
					bgColor={`${theme.colors.warning}12`}
					textColor={theme.colors.warning}
					title="No Delivery Planner task linked — use Promote action"
				/>
			);
		} else {
			// Has a planner link — show "Tracked in Delivery Planner"
			chips.push(
				<Chip
					key="tracked"
					icon={<Layers className="w-2.5 h-2.5" />}
					label="tracked"
					bgColor={`${theme.colors.accent}12`}
					textColor={theme.colors.accent}
					title={`Delivery Planner task: ${wikiRef.plannerWorkItemId}`}
				/>
			);
		}
	}

	if (chips.length === 0) return null;

	return <div className="flex flex-wrap gap-1">{chips}</div>;
}
