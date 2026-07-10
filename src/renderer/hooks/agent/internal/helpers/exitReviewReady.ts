/**
 * Build and maintain the Maestro-owned Concerto Movement shown when a completed
 * write turn leaves a review-worthy Git diff. Agent-authored Movement payloads
 * cannot attach the internal action carried by this item.
 */

import type { BlockSpec } from '../../../../components/BlockView';
import { gitService } from '../../../../services/git';
import { useMovementStore, type MovementItem } from '../../../../stores/movementStore';
import { useSettingsStore } from '../../../../stores/settingsStore';
import { buildGitChangeBrief, type GitChangeBrief } from '../../../../utils/gitReview';
import { parseGitDiff } from '../../../../utils/gitDiffParser';

const REVIEW_READY_WIDTH = 380;
const REVIEW_READY_MARGIN = 24;

export interface ReviewReadyTarget {
	sessionId: string;
	tabId?: string;
	projectName: string;
	cwd: string;
	sshRemoteId?: string;
}

export function getReviewReadyMovementId(sessionId: string): string {
	return `maestro-review-ready-${sessionId}`;
}

export function shouldSurfaceReviewReady(brief: GitChangeBrief): boolean {
	const attentionCount = brief.highRiskFiles + brief.mediumRiskFiles;
	const changedLines = brief.totalAdditions + brief.totalDeletions;
	return (
		attentionCount > 0 ||
		brief.files.length >= 10 ||
		changedLines >= 200 ||
		(brief.implementationFiles >= 3 && brief.testFiles === 0)
	);
}

export function buildReviewReadySpec(brief: GitChangeBrief): BlockSpec {
	const attentionCount = brief.highRiskFiles + brief.mediumRiskFiles;
	const changedLines = brief.totalAdditions + brief.totalDeletions;
	const observation = brief.observations[0];

	return {
		blocks: [
			{
				kind: 'stats',
				minColumnWidth: 90,
				cards: [
					{ label: 'Files', value: brief.files.length },
					{
						label: 'Needs attention',
						value: attentionCount,
						color: attentionCount > 0 ? 'warning' : 'success',
					},
					{
						label: 'Changed lines',
						value: changedLines,
						displayValue: changedLines.toLocaleString(),
					},
				],
			},
			...(observation
				? [
						{
							kind: 'callout' as const,
							title: observation.title,
							text: observation.detail,
							color: observation.level === 'high' ? ('error' as const) : ('warning' as const),
						},
					]
				: []),
			{
				kind: 'text',
				content:
					'Open Rehearsal to inspect the change brief and focus only on files worth attention.',
			},
		],
	};
}

export async function refreshReviewReadyMovement(
	target: ReviewReadyTarget
): Promise<GitChangeBrief | null> {
	const id = getReviewReadyMovementId(target.sessionId);
	if (!useSettingsStore.getState().encoreFeatures.concerto) {
		useMovementStore.getState().removeItem(id);
		return null;
	}

	const diff = await gitService.getDiff(target.cwd, undefined, target.sshRemoteId);
	const store = useMovementStore.getState();
	if (!useSettingsStore.getState().encoreFeatures.concerto) {
		store.removeItem(id);
		return null;
	}

	if (!diff.diff) {
		store.removeItem(id);
		return null;
	}

	const brief = buildGitChangeBrief(parseGitDiff(diff.diff));
	if (!shouldSurfaceReviewReady(brief)) {
		store.removeItem(id);
		return null;
	}

	const existing = store.items.find((item) => item.id === id);
	const x =
		existing?.x ??
		(store.viewportWidth > 0
			? Math.max(
					REVIEW_READY_MARGIN,
					store.viewportWidth - REVIEW_READY_WIDTH - REVIEW_READY_MARGIN
				)
			: REVIEW_READY_MARGIN);
	const item: MovementItem = {
		id,
		x,
		y: existing?.y ?? 64,
		width: existing?.width ?? REVIEW_READY_WIDTH,
		height: existing?.height,
		title: `Review ready: ${target.projectName}`,
		spec: buildReviewReadySpec(brief),
		action: {
			kind: 'open-git-review',
			sessionId: target.sessionId,
			tabId: target.tabId,
		},
		measuredHeight: existing?.measuredHeight,
		timestamp: Date.now(),
	};

	if (!existing) store.setHidden(false);
	store.upsertItem(item);
	return brief;
}
