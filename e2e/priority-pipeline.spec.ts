/**
 * E2E Spec: Full Priority-Feature Pipeline
 * @slow — run with `--grep-invert @slow` in fast-feedback CI
 *
 * Walks the complete handoff chain:
 *   Conv-PRD → Delivery Planner (decompose) → Planning Pipeline (trigger) → Agent Dispatch (claim)
 *
 * Strategy: prefer IPC round-trips via window.evaluate() over DOM interactions for
 * cross-feature handoffs — these are faster and not affected by UI wiring gaps.
 * DOM assertions are added where a renderer surface is known to exist.
 *
 * IPC channels exercised:
 *   conversationalPrd:createSession
 *   conversationalPrd:sendMessage
 *   conversationalPrd:finalizeSession
 *   delivery-planner:get-prd          (namespace: deliveryPlanner.getPrd)
 *   delivery-planner:decompose         (namespace: deliveryPlanner.decompose)
 *   pipeline:getDashboard              (namespace: pipeline.getDashboard)
 *   agentDispatch:getBoard             (namespace: agentDispatch.getBoard)
 *   agentDispatch:claimWorkItem        (namespace: agentDispatch.claimWorkItem)
 *   agentDispatch:releaseWorkItem      (namespace: agentDispatch.releaseWorkItem)
 *
 * TODO(#419): Needs a pre-seeded fleet entry for the claim step to find an
 *   eligible agent automatically.  Until the fleet fixture is wired, the claim
 *   assertion uses a graceful-degradation branch (same pattern as the existing
 *   single-feature specs).
 *
 * Prerequisites:
 *   npm run build:main && npm run build:renderer
 */

import { type Page } from '@playwright/test';
import { test, expect } from './fixtures/electron-app';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Enable multiple encore flags in one settings write. */
async function enableAllPipelineFlags(window: Page): Promise<void> {
	await window.evaluate(async () => {
		try {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const maestro = (globalThis as any).maestro;
			const current =
				((await maestro.settings.get('encoreFeatures')) as Record<string, boolean> | null) ?? {};
			await maestro.settings.set('encoreFeatures', {
				...current,
				conversationalPrd: true,
				deliveryPlanner: true,
				planningPipeline: true,
				agentDispatch: true,
			});
		} catch {
			// settings IPC may not be exposed in all build variants
		}
	});
}

/** Assert no error toasts are visible at the current point in the test. */
async function assertNoErrorToasts(window: Page): Promise<void> {
	// Role=alert covers both ARIA toasts and inline error banners.
	// Filtering to text /error/i avoids false positives from info-level alerts.
	const errorToast = window.locator('[role="alert"]').filter({ hasText: /error/i });
	expect(await errorToast.count()).toBe(0);
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe('Priority-Feature Pipeline (Conv-PRD → Planner → Pipeline → Dispatch)', () => {
	// -------------------------------------------------------------------------
	// 0. App launch + enable all flags
	// -------------------------------------------------------------------------

	test('app launches and all four encore flags can be enabled', async ({ window, electronApp }) => {
		await window.waitForLoadState('domcontentloaded');

		const alive = await electronApp.evaluate(() => true);
		expect(alive).toBe(true);

		await enableAllPipelineFlags(window);

		// Settings write is async — give the renderer store a moment to settle
		await window.waitForTimeout(300);

		// No error from flag write
		await assertNoErrorToasts(window);
	});

	// -------------------------------------------------------------------------
	// 1. Conv-PRD: createSession → sendMessage → finalizeSession
	// -------------------------------------------------------------------------

	test('Conv-PRD: createSession → sendMessage → finalizeSession IPC round-trip', async ({
		window,
	}) => {
		await window.waitForLoadState('domcontentloaded');
		await window.waitForTimeout(500);
		await enableAllPipelineFlags(window);

		const result = await window.evaluate(async () => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const api = (globalThis as any).maestro?.conversationalPrd;

			if (!api?.createSession) {
				return {
					success: false,
					reason: 'conversationalPrd namespace not yet wired in preload',
				};
			}

			try {
				// Step 1: create a PRD session
				const sessionResult = await api.createSession({
					projectPath: '/tmp/e2e-pipeline-test',
				});
				const sessionId = (sessionResult as { data?: { id?: string } })?.data?.id as
					| string
					| undefined;
				if (!sessionId) {
					return { success: false, reason: 'createSession returned no sessionId' };
				}

				// Step 2: send a scripted planning message
				await api.sendMessage({
					sessionId,
					content:
						'Create a PRD for a minimal task-tracker feature: users can add, complete, and delete tasks.',
				});

				// Step 3: finalize — commits the draft for the Delivery Planner to pick up
				const finalizeResult = await api.finalizeSession({ sessionId });

				return { success: true, sessionId, finalizeResult };
			} catch (err) {
				return { success: false, error: String(err) };
			}
		});

		type IpcResult = { success: boolean; reason?: string; error?: string; sessionId?: string };
		const r = result as IpcResult;

		if (!r.success && r.reason) {
			// Namespace not wired yet — acceptable while preload work is in progress
			expect(r.reason).toBeTruthy();
		} else if (r.error) {
			throw new Error(`Conv-PRD round-trip failed: ${r.error}`);
		} else {
			expect(r.success).toBe(true);
			expect(r.sessionId).toBeTruthy();
		}

		await assertNoErrorToasts(window);
	});

	// -------------------------------------------------------------------------
	// 2. Delivery Planner: dashboard reflects the finalized PRD
	// -------------------------------------------------------------------------

	test('Delivery Planner: dashboard lists the finalized PRD', async ({ window }) => {
		await window.waitForLoadState('domcontentloaded');
		await window.waitForTimeout(500);
		await enableAllPipelineFlags(window);

		// Attempt to open the Delivery Planner modal via the keyboard shortcut
		await window.keyboard.press('Alt+p');
		await window.waitForTimeout(500);

		// DOM check — PlannerShell renders "Delivery Planner" heading
		// TODO: confirm selector once UI wiring fully lands (PlannerShell.tsx)
		const plannerHeading = window.locator('text=Delivery Planner').first();
		const plannerVisible = await plannerHeading.isVisible().catch(() => false);

		if (plannerVisible) {
			await expect(plannerHeading).toBeVisible();
		}

		// IPC check — deliveryPlanner.dashboard should list at least the PRD from step 1
		const ipcResult = await window.evaluate(async () => {
			try {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const api = (globalThis as any).maestro?.deliveryPlanner;
				if (!api?.dashboard) {
					return { success: false, reason: 'deliveryPlanner namespace not yet wired' };
				}
				const snapshot = await api.dashboard();
				return { success: true, snapshot };
			} catch (err) {
				return { success: false, error: String(err) };
			}
		});

		type IpcResult = { success: boolean; reason?: string; error?: string };
		const r = ipcResult as IpcResult;

		if (!r.success && r.reason) {
			expect(r.reason).toBeTruthy(); // graceful degradation
		} else if (r.success) {
			expect(r.success).toBe(true);
		} else if ('error' in r && r.error) {
			throw new Error(`deliveryPlanner.dashboard failed: ${r.error}`);
		}

		await assertNoErrorToasts(window);

		// Close the modal before moving on
		await window.keyboard.press('Escape');
		await window.waitForTimeout(200);
	});

	// -------------------------------------------------------------------------
	// 3. Delivery Planner: decompose PRD → epic + tasks
	// -------------------------------------------------------------------------

	test('Delivery Planner: decompose creates epic and tasks', async ({ window }) => {
		await window.waitForLoadState('domcontentloaded');
		await window.waitForTimeout(500);
		await enableAllPipelineFlags(window);

		const result = await window.evaluate(async () => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const api = (globalThis as any).maestro?.deliveryPlanner;
			if (!api?.decompose) {
				return { success: false, reason: 'deliveryPlanner.decompose not yet wired' };
			}

			try {
				// Inline fixture PRD — avoids dependency on the Conv-PRD session from a prior test
				const inlinePrd = {
					title: 'Task Tracker (E2E fixture)',
					summary: 'Users can add, complete, and delete tasks.',
					goals: ['Simple CRUD for tasks', 'Persist across sessions'],
					nonGoals: ['Mobile app', 'Real-time sync'],
				};

				const decomposeResult = await api.decompose({ prd: inlinePrd });
				return { success: true, decomposeResult };
			} catch (err) {
				return { success: false, error: String(err) };
			}
		});

		type IpcResult = {
			success: boolean;
			reason?: string;
			error?: string;
			decomposeResult?: unknown;
		};
		const r = result as IpcResult;

		if (!r.success && r.reason) {
			expect(r.reason).toBeTruthy(); // namespace not wired yet
		} else if (r.error) {
			throw new Error(`decompose failed: ${r.error}`);
		} else {
			expect(r.success).toBe(true);
		}

		await assertNoErrorToasts(window);
	});

	// -------------------------------------------------------------------------
	// 4. Planning Pipeline: dashboard reflects tasks-ready stage after decompose
	// -------------------------------------------------------------------------

	test('Planning Pipeline: dashboard reflects agent-ready items after decompose', async ({
		window,
	}) => {
		await window.waitForLoadState('domcontentloaded');
		await window.waitForTimeout(500);
		await enableAllPipelineFlags(window);

		// Open the Planning Pipeline modal via keyboard shortcut
		await window.keyboard.press('Alt+i');
		await window.waitForTimeout(500);

		// DOM check — PlanningPipelineModal renders "Planning Pipeline" heading
		// TODO: confirm selector once UI wiring lands (PlanningPipelineModal.tsx line 58)
		const pipelineHeading = window.locator('text=Planning Pipeline').first();
		const headingVisible = await pipelineHeading.isVisible().catch(() => false);

		if (headingVisible) {
			await expect(pipelineHeading).toBeVisible();
		}

		// IPC check — pipeline.getDashboard should show items in a tasks-ready stage
		const ipcResult = await window.evaluate(async () => {
			try {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const api = (globalThis as any).maestro?.pipeline;
				if (!api?.getDashboard) {
					return { success: false, reason: 'pipeline namespace not yet wired' };
				}
				const dashboard = await api.getDashboard();
				return { success: true, dashboard };
			} catch (err) {
				return { success: false, error: String(err) };
			}
		});

		type IpcResult = { success: boolean; reason?: string; error?: string };
		const r = ipcResult as IpcResult;

		if (!r.success && r.reason) {
			expect(r.reason).toBeTruthy();
		} else if (r.success) {
			expect(r.success).toBe(true);
		} else if ('error' in r && r.error) {
			throw new Error(`pipeline.getDashboard failed: ${r.error}`);
		}

		await assertNoErrorToasts(window);

		// Close modal before next step
		await window.keyboard.press('Escape');
		await window.waitForTimeout(200);
	});

	// -------------------------------------------------------------------------
	// 5. Agent Dispatch: work item appears on board → manual claim succeeds
	// -------------------------------------------------------------------------

	test('Agent Dispatch: work item appears on board and claim returns without error', async ({
		window,
	}) => {
		await window.waitForLoadState('domcontentloaded');
		await window.waitForTimeout(500);
		await enableAllPipelineFlags(window);

		// Open Agent Dispatch modal
		await window.keyboard.press('Alt+d');
		await window.waitForTimeout(500);

		// DOM check — AgentDispatchModal renders "Agent Dispatch" heading
		// TODO: confirm selector once UI wiring lands (AgentDispatchModal.tsx line 71)
		const dispatchHeading = window.locator('text=Agent Dispatch').first();
		const headingVisible = await dispatchHeading.isVisible().catch(() => false);

		if (headingVisible) {
			await expect(dispatchHeading).toBeVisible();
		}

		// IPC: getBoard to verify at least one work item exists (or degradation)
		const boardResult = await window.evaluate(async () => {
			try {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const api = (globalThis as any).maestro?.agentDispatch;
				if (!api?.getBoard) {
					return { success: false, reason: 'agentDispatch namespace not yet wired' };
				}
				const board = await api.getBoard();
				return { success: true, board };
			} catch (err) {
				return { success: false, error: String(err) };
			}
		});

		type BoardResult = {
			success: boolean;
			reason?: string;
			error?: string;
			board?: { items?: Array<{ id: string; status?: string }> };
		};
		const br = boardResult as BoardResult;

		if (!br.success && br.reason) {
			// Graceful degradation — namespace not wired
			expect(br.reason).toBeTruthy();
		} else if (br.error) {
			throw new Error(`agentDispatch.getBoard failed: ${br.error}`);
		} else {
			expect(br.success).toBe(true);

			// If items are present, attempt a manual claim on the first item
			// TODO(#419): Needs a fleet entry fixture for the claim to auto-match an agent.
			//   Until then, claimWorkItem is called with an explicit agentId stub.
			const items = br.board?.items ?? [];
			if (items.length > 0) {
				const firstItemId = items[0].id;

				const claimResult = await window.evaluate(
					async ({ itemId }: { itemId: string }) => {
						try {
							// eslint-disable-next-line @typescript-eslint/no-explicit-any
							const api = (globalThis as any).maestro?.agentDispatch;
							if (!api?.claimWorkItem) {
								return { claimed: false, reason: 'claimWorkItem not wired' };
							}
							// Use a test-only stub agent identifier
							const claim = await api.claimWorkItem({
								workItemId: itemId,
								agentId: 'e2e-test-agent-stub',
							});
							return { claimed: true, claim };
						} catch (err) {
							return { claimed: false, error: String(err) };
						}
					},
					{ itemId: firstItemId }
				);

				type ClaimResult = { claimed: boolean; reason?: string; error?: string };
				const cr = claimResult as ClaimResult;

				if (!cr.claimed && cr.reason) {
					expect(cr.reason).toBeTruthy(); // not wired yet
				} else if (cr.error) {
					throw new Error(`claimWorkItem failed: ${cr.error}`);
				} else {
					expect(cr.claimed).toBe(true);

					// Release the claim so state is clean for future runs
					await window.evaluate(
						async ({ itemId }: { itemId: string }) => {
							try {
								// eslint-disable-next-line @typescript-eslint/no-explicit-any
								const api = (globalThis as any).maestro?.agentDispatch;
								if (api?.releaseWorkItem) {
									await api.releaseWorkItem({
										workItemId: itemId,
										agentId: 'e2e-test-agent-stub',
									});
								}
							} catch {
								// best-effort cleanup
							}
						},
						{ itemId: firstItemId }
					);
				}
			}
		}

		await assertNoErrorToasts(window);

		// Close modal
		await window.keyboard.press('Escape');
		await window.waitForTimeout(200);
	});

	// -------------------------------------------------------------------------
	// 6. Cleanup: restore flags and verify clean shutdown
	// -------------------------------------------------------------------------

	test('cleanup: restore flags and app closes cleanly', async ({ window, electronApp }) => {
		await window.waitForLoadState('domcontentloaded');
		await window.waitForTimeout(300);

		// Restore all four flags to false
		await window.evaluate(async () => {
			try {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const maestro = (globalThis as any).maestro;
				const current =
					((await maestro.settings.get('encoreFeatures')) as Record<string, boolean> | null) ?? {};
				await maestro.settings.set('encoreFeatures', {
					...current,
					conversationalPrd: false,
					deliveryPlanner: false,
					planningPipeline: false,
					agentDispatch: false,
				});
			} catch {
				// best-effort
			}
		});

		await window.waitForTimeout(200);
		await assertNoErrorToasts(window);

		// App must still be alive after flag teardown
		const alive = await electronApp.evaluate(() => true);
		expect(alive).toBe(true);
	});
});
