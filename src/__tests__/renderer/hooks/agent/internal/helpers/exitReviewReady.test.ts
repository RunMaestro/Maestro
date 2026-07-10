import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	buildReviewReadySpec,
	getReviewReadyMovementId,
	refreshReviewReadyMovement,
	shouldSurfaceReviewReady,
} from '../../../../../../renderer/hooks/agent/internal/helpers/exitReviewReady';
import { gitService } from '../../../../../../renderer/services/git';
import { useMovementStore } from '../../../../../../renderer/stores/movementStore';
import { useSettingsStore } from '../../../../../../renderer/stores/settingsStore';
import type { GitChangeBrief } from '../../../../../../renderer/utils/gitReview';

vi.mock('../../../../../../renderer/services/git', () => ({
	gitService: {
		getDiff: vi.fn(),
	},
}));

const SECURITY_DIFF = `diff --git a/src/main/security/auth.ts b/src/main/security/auth.ts
index 1111111..2222222 100644
--- a/src/main/security/auth.ts
+++ b/src/main/security/auth.ts
@@ -1 +1,2 @@
-export const allowed = false;
+export const allowed = true;
+export const audited = true;
`;

function createBrief(overrides: Partial<GitChangeBrief> = {}): GitChangeBrief {
	return {
		files: [],
		areas: [],
		attentionFiles: [],
		largestFiles: [],
		observations: [],
		totalAdditions: 0,
		totalDeletions: 0,
		highRiskFiles: 0,
		mediumRiskFiles: 0,
		testFiles: 0,
		implementationFiles: 0,
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	useSettingsStore.setState({
		encoreFeatures: {
			...useSettingsStore.getState().encoreFeatures,
			concerto: true,
		},
	});
	useMovementStore.setState({
		items: [],
		viewportWidth: 0,
		viewportHeight: 0,
		hidden: false,
		flashedId: null,
	});
});

describe('review-ready Movement', () => {
	it('surfaces risk, broad changes, large diffs, and untested multi-file work', () => {
		expect(shouldSurfaceReviewReady(createBrief({ highRiskFiles: 1 }))).toBe(true);
		expect(shouldSurfaceReviewReady(createBrief({ files: Array(10).fill({}) as never[] }))).toBe(
			true
		);
		expect(shouldSurfaceReviewReady(createBrief({ totalAdditions: 200 }))).toBe(true);
		expect(shouldSurfaceReviewReady(createBrief({ implementationFiles: 3, testFiles: 0 }))).toBe(
			true
		);
		expect(
			shouldSurfaceReviewReady(createBrief({ implementationFiles: 1, totalAdditions: 20 }))
		).toBe(false);
	});

	it('builds a concise summary using needs-attention language', () => {
		const spec = buildReviewReadySpec(
			createBrief({
				files: [{}] as never[],
				highRiskFiles: 1,
				totalAdditions: 30,
				totalDeletions: 4,
			})
		);
		expect(JSON.stringify(spec)).toContain('Needs attention');
		expect(JSON.stringify(spec)).toContain('Open Rehearsal');
	});

	it('adds a stable Maestro-owned action and preserves user placement on update', async () => {
		vi.mocked(gitService.getDiff).mockResolvedValue({ diff: SECURITY_DIFF } as never);
		useMovementStore.getState().setViewport(1200, 800);

		await refreshReviewReadyMovement({
			sessionId: 'session-1',
			tabId: 'tab-1',
			projectName: 'Maestro',
			cwd: '/repo',
		});

		const id = getReviewReadyMovementId('session-1');
		const first = useMovementStore.getState().items[0];
		expect(first).toMatchObject({
			id,
			x: 796,
			y: 64,
			width: 380,
			title: 'Review ready: Maestro',
			action: { kind: 'open-git-review', sessionId: 'session-1', tabId: 'tab-1' },
		});

		useMovementStore.getState().moveItem(id, 100, 120);
		useMovementStore.getState().setHidden(true);
		await refreshReviewReadyMovement({
			sessionId: 'session-1',
			tabId: 'tab-1',
			projectName: 'Maestro',
			cwd: '/repo',
		});

		expect(useMovementStore.getState().items[0]).toMatchObject({ x: 100, y: 120 });
		expect(useMovementStore.getState().hidden).toBe(true);
	});

	it('removes a stale card when the working tree becomes clean', async () => {
		useMovementStore.getState().upsertItem({
			id: getReviewReadyMovementId('session-1'),
			x: 0,
			y: 0,
			width: 380,
			spec: { blocks: [] },
			timestamp: 1,
		});
		vi.mocked(gitService.getDiff).mockResolvedValue({ diff: '' } as never);

		await refreshReviewReadyMovement({
			sessionId: 'session-1',
			projectName: 'Maestro',
			cwd: '/repo',
		});

		expect(useMovementStore.getState().items).toHaveLength(0);
	});

	it('does not queue a card when Concerto is disabled during diff inspection', async () => {
		let resolveDiff: ((value: { diff: string }) => void) | undefined;
		vi.mocked(gitService.getDiff).mockReturnValue(
			new Promise((resolve) => {
				resolveDiff = resolve;
			}) as never
		);
		const refresh = refreshReviewReadyMovement({
			sessionId: 'session-1',
			projectName: 'Maestro',
			cwd: '/repo',
		});
		useSettingsStore.setState({
			encoreFeatures: {
				...useSettingsStore.getState().encoreFeatures,
				concerto: false,
			},
		});
		resolveDiff?.({ diff: SECURITY_DIFF });

		await refresh;

		expect(useMovementStore.getState().items).toHaveLength(0);
	});
});
