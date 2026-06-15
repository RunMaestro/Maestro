/**
 * Usage Refresh Scheduler
 *
 * Background, window-independent driver for the Usage Dashboard's provider
 * quota auto-refresh. The dashboard's "Auto refresh" dropdown persists a
 * per-provider interval into `settingsStore.usageRefreshIntervals`
 * (`{ 'claude-code': ms, codex: ms }`, 0 = off). This module reads that map and
 * runs the existing samplers (`runStartupUsageSampling` in 'manual' mode for
 * Claude, `runCodexUsageSampling` for Codex) on each provider's cadence - so the
 * on-disk snapshots stay fresh even when the dashboard is closed, and the user
 * sees up-to-date numbers the moment they open it.
 *
 * Why here and not in the renderer: the old `setInterval` lived inside the
 * `useQuotaRefresh` React hook, so it was torn down the instant the panel
 * unmounted (closing the dashboard or switching the Anthropic/OpenAI tab). It
 * could never run "every 15 minutes in the background". Moving the timer to main
 * decouples the cadence from any window lifecycle.
 *
 * Lifecycle:
 *   - `start()` reads the persisted intervals and arms one timer per provider
 *     with a positive interval, then subscribes to `usageRefreshIntervals`
 *     changes to re-arm. Idempotent.
 *   - Each tick fires the provider's sampler fire-and-forget; the sampler never
 *     throws (failures are warn-logged), and overlapping ticks are guarded so a
 *     slow `--status` spawn can't stack.
 *   - `stop()` clears all timers and the change subscription (used on quit).
 */

import type Store from 'electron-store';

import type { AgentDetector } from './detector';
import type { AgentConfigsData, MaestroSettings, SessionsData } from '../stores/types';
import { logger } from '../utils/logger';
import { runStartupUsageSampling } from './claude-usage-startup';
import { runCodexUsageSampling } from './codex-usage-startup';

const LOG_CONTEXT = '[UsageRefreshScheduler]';

/** Provider ids that have a quota panel + sampler. Mirrors the renderer keys. */
const CLAUDE_PROVIDER_ID = 'claude-code';
const CODEX_PROVIDER_ID = 'codex';

/**
 * Floor on the persisted interval. The dropdown's smallest non-off option is
 * 1 min; this clamps any hand-edited settings value so a stray small number
 * can't spin a tight `--status` loop.
 */
const MIN_INTERVAL_MS = 60_000;

export interface UsageRefreshSchedulerDeps {
	sessionsStore: Pick<Store<SessionsData>, 'get'>;
	agentConfigsStore: Store<AgentConfigsData>;
	settingsStore: Store<MaestroSettings>;
	agentDetector: AgentDetector;
}

export class UsageRefreshScheduler {
	private readonly deps: UsageRefreshSchedulerDeps;
	private readonly timers = new Map<string, NodeJS.Timeout>();
	/** Guards against overlapping ticks while a sampler is still running. */
	private readonly inFlight = new Set<string>();
	private unsubscribe: (() => void) | null = null;
	private started = false;

	constructor(deps: UsageRefreshSchedulerDeps) {
		this.deps = deps;
	}

	/** Arm timers from persisted settings and watch for changes. Idempotent. */
	start(): void {
		if (this.started) return;
		this.started = true;
		this.reschedule();
		this.unsubscribe = this.deps.settingsStore.onDidChange('usageRefreshIntervals', () =>
			this.reschedule()
		);
	}

	/** Tear down all timers and the settings subscription. */
	stop(): void {
		for (const timer of this.timers.values()) clearInterval(timer);
		this.timers.clear();
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.started = false;
	}

	/** Re-read intervals and (re)arm exactly the providers that want refreshing. */
	private reschedule(): void {
		const intervals = this.readIntervals();
		this.applyProvider(CLAUDE_PROVIDER_ID, intervals[CLAUDE_PROVIDER_ID] ?? 0);
		this.applyProvider(CODEX_PROVIDER_ID, intervals[CODEX_PROVIDER_ID] ?? 0);
	}

	private readIntervals(): Record<string, number> {
		const raw = this.deps.settingsStore.get('usageRefreshIntervals');
		return raw && typeof raw === 'object' ? (raw as Record<string, number>) : {};
	}

	private applyProvider(providerId: string, rawMs: number): void {
		const existing = this.timers.get(providerId);
		if (existing) {
			clearInterval(existing);
			this.timers.delete(providerId);
		}

		const ms = Number(rawMs);
		if (!Number.isFinite(ms) || ms <= 0) return; // off
		const intervalMs = Math.max(MIN_INTERVAL_MS, ms);

		const timer = setInterval(() => {
			void this.tick(providerId);
		}, intervalMs);
		// Don't let the timer hold the process open on quit.
		timer.unref?.();
		this.timers.set(providerId, timer);
		logger.info(
			`Armed background quota refresh for ${providerId} every ${intervalMs}ms`,
			LOG_CONTEXT
		);
	}

	private async tick(providerId: string): Promise<void> {
		if (this.inFlight.has(providerId)) return; // previous sample still running
		this.inFlight.add(providerId);
		try {
			if (providerId === CLAUDE_PROVIDER_ID) {
				await runStartupUsageSampling({
					sessionsStore: this.deps.sessionsStore,
					agentConfigsStore: this.deps.agentConfigsStore,
					settingsStore: this.deps.settingsStore,
					agentDetector: this.deps.agentDetector,
					// 'manual': sample every configured account, not just maestro-p
					// sessions in the 7-day window. The user asked for live data.
					mode: 'manual',
				});
			} else if (providerId === CODEX_PROVIDER_ID) {
				await runCodexUsageSampling({
					sessionsStore: this.deps.sessionsStore,
					agentConfigsStore: this.deps.agentConfigsStore,
					agentDetector: this.deps.agentDetector,
				});
			}
		} catch (err) {
			// Samplers warn-log their own failures; this is a belt-and-suspenders
			// guard so a throw can't kill the interval.
			logger.warn(`Background quota refresh failed for ${providerId}`, LOG_CONTEXT, {
				error: err instanceof Error ? err.message : String(err),
			});
		} finally {
			this.inFlight.delete(providerId);
		}
	}
}
