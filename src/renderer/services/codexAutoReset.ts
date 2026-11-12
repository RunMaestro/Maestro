/**
 * codexAutoReset - spend a Codex reset credit automatically when an agent the
 * user opted in hits its plan-quota wall.
 *
 * The manual path is the Usage Dashboard's "Reset now" button. This is the same
 * WRITE primitive fired without a click, for an agent whose
 * `codexAutoResetOnExhaustion` is explicitly on.
 *
 * It is written to refuse far more often than it fires, because the thing it
 * spends is finite, expires, and cannot be refunded. Every gate below is a
 * separate reason to do nothing:
 *
 *  1. **Codex only, opted in only.** No other provider has reset credits, and
 *     the flag defaults off, so an agent that never asked for this can never
 *     reach the spend.
 *  2. **Only a real limit.** A crash, an auth failure, or an availability blip
 *     is not a quota wall, and resetting the window would fix none of them
 *     while costing a credit. A limit is recognised by its type OR by its text
 *     (see `isQuotaWall`), because a wording the pattern bank has not learned
 *     yet arrives typed `unknown`.
 *  3. **Never on an SSH-backed agent.** The credit would be read and spent
 *     against THIS machine's account while the agent runs as the remote's, so
 *     the spend lands on the wrong account entirely. Same reason the usage
 *     probe skips them.
 *  4. **Freshly confirmed, never assumed.** The credits are re-read immediately
 *     before spending and the verdict must come back `effective` - see
 *     `shouldAutoSpendCredit`, which refuses `wasteful` AND `unknown`. A stale
 *     snapshot is not consent.
 *  5. **Once per outage.** An outage that re-fails after a reset must not walk
 *     the account's whole credit balance one error at a time.
 *
 * On success the agent is left for the existing auto-retry / auto-resume
 * machinery to pick up: the window is open again, so the next scheduled probe
 * succeeds. This deliberately does NOT resend the prompt itself - that is the
 * retry engine's job and duplicating it here would double-send the turn.
 */

import type { AgentError, Session } from '../types';
import { isLimitError } from '../../shared/types';
import { classifyRetryableError } from '../../shared/retryClassification';
import { shouldAutoSpendCredit } from '../../shared/codexResetCredits';
import { effectiveAgentCustomEnvVars, resolveAgentAccountKey } from '../../shared/providerProfiles';
import { useCodexResetCreditsStore } from '../stores/codexResetCreditsStore';
import { notifyToast } from '../stores/notificationStore';
import { getHomeDir, getHomeDirAsync } from '../utils/homeDir';
import { logger } from '../utils/logger';

const LOG_CONTEXT = '[CodexAutoReset]';

/**
 * Outages already acted on, keyed by `${sessionId}:${error.timestamp}`.
 *
 * Module scope on purpose: the listener that calls this is re-registered
 * whenever its effect re-runs, and a ref rebuilt alongside it would forget that
 * this outage was already paid for - which is exactly how one wall could spend
 * every credit on the account.
 */
const handledOutages = new Set<string>();

/** Bounded so a long-running app cannot grow this set without limit. */
const MAX_TRACKED_OUTAGES = 200;

function markHandled(key: string): void {
	handledOutages.add(key);
	if (handledOutages.size > MAX_TRACKED_OUTAGES) {
		// Ids are timestamped and never reused, so the oldest entry has nothing
		// left to guard.
		const oldest = handledOutages.values().next().value;
		if (oldest !== undefined) handledOutages.delete(oldest);
	}
}

/**
 * Whether this error is the account's plan quota running out.
 *
 * The type alone is not enough. Codex's "Your workspace is out of credits" had
 * no pattern in the bank, so it arrived typed `unknown` and this service
 * declined every outage it was built for, with credits sitting unspent. The
 * retry scheduler never had that problem because it reads the provider's own
 * text, so ask it too. Only its `token-exhaustion` verdict counts: an
 * availability blip clears on its own and a credit would be wasted on it.
 */
function isQuotaWall(error: AgentError): boolean {
	return isLimitError(error) || classifyRetryableError(error) === 'token-exhaustion';
}

/** Reason the automation declined, for logs. `null` means it may proceed. */
function declineReason(session: Session, error: AgentError): string | null {
	if (session.toolType !== 'codex') return 'not-codex';
	if (session.codexAutoResetOnExhaustion !== true) return 'not-enabled';
	if (!isQuotaWall(error)) return 'not-a-limit';
	// The credit read and the spend both run against the LOCAL auth.json, which
	// describes this machine's account rather than the remote's.
	if (session.sessionSshRemoteConfig?.enabled) return 'ssh-backed';
	return null;
}

/**
 * Consider spending a reset credit for a limit-paused Codex agent.
 *
 * Fire-and-forget: resolves to whether a credit was actually spent, and never
 * throws, so a failure here cannot disturb the pause/notification flow it hangs
 * off. Safe to call for every agent error - the gates do the filtering.
 */
export async function maybeAutoResetCodexUsage(
	session: Session,
	error: AgentError
): Promise<boolean> {
	const declined = declineReason(session, error);
	if (declined) return false;

	const outageKey = `${session.id}:${error.timestamp}`;
	if (handledOutages.has(outageKey)) return false;
	// Claim before any await: two errors arriving in the same tick for one
	// outage must not both get through.
	markHandled(outageKey);

	const homeDir = getHomeDir() ?? (await getHomeDirAsync());
	// The provider-level set is NOT optional here. An agent with no overrides of
	// its own still runs against whatever CODEX_HOME Settings -> Agents declares,
	// so skipping this layer resolves to the default `~/.codex` and would reset
	// an account the agent never touches - somebody else's quota, silently.
	// `null` (no provider-level set configured) collapses to `undefined`, since
	// `effectiveAgentCustomEnvVars` treats absence as "fall through", and a null
	// would instead be taken as an empty override.
	const providerEnv =
		(await window.maestro.agents.getCustomEnvVars('codex').catch(() => undefined)) ?? undefined;
	const codexHomeKey = resolveAgentAccountKey(
		'codex',
		// Env vars REPLACE rather than layer, so the agent's own set wins outright
		// when it has one. A merge would describe a process nobody is running.
		effectiveAgentCustomEnvVars(session.customEnvVars, providerEnv),
		homeDir
	);
	if (!codexHomeKey) {
		logger.warn('Could not resolve CODEX_HOME for auto reset', LOG_CONTEXT, {
			sessionId: session.id,
		});
		return false;
	}

	const store = useCodexResetCreditsStore.getState();
	// Re-read rather than trusting the cached entry: the snapshot may predate the
	// outage by hours, and both halves of the verdict (do credits exist, would
	// one take effect) have to describe the account as it is right now.
	await store.load(codexHomeKey);
	const entry = useCodexResetCreditsStore.getState().entries[codexHomeKey];
	if (!entry || !shouldAutoSpendCredit(entry.counts, entry.credits)) {
		logger.info('Auto reset declined - no effective credit', LOG_CONTEXT, {
			sessionId: session.id,
			codexHomeKey,
			available: entry?.counts.available,
			applicable: entry?.counts.applicable,
		});
		return false;
	}

	const result = await useCodexResetCreditsStore.getState().redeem(codexHomeKey);
	if (!result.attempted) return false;

	// Always tell the user: money-shaped, irreversible, and done without a click.
	// A silent spend is the one outcome that would make this feature untrustworthy.
	notifyToast(
		result.ok
			? {
					color: 'green',
					title: 'Usage limits reset automatically',
					message: `${session.name}: redeemed a Codex reset credit, ${result.windowsReset} ${
						result.windowsReset === 1 ? 'window' : 'windows'
					} reopened.`,
					sessionId: session.id,
				}
			: {
					color: 'yellow',
					title: 'Automatic reset failed',
					message: `${session.name}: ${result.message ?? 'Codex redeemed no usage windows.'}`,
					dismissible: true,
					sessionId: session.id,
				}
	);

	return result.ok;
}

/** Test seam: forget which outages have been acted on. */
export function __resetCodexAutoResetForTests(): void {
	handledOutages.clear();
}
