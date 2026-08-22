/**
 * providerAuthStore - identity resolution, snapshot lookup, the blocked-agent
 * roll-up, the reactive `auth_expired` marking, and the throttled startup toast.
 *
 * The thing under test throughout is the identity model paying off: fifteen
 * agents on one Anthropic login are ONE problem, so they share one snapshot,
 * one toast, and one recovery - and a sibling account on the same machine is
 * untouched by any of it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useNotificationStore } from '../../../renderer/stores/notificationStore';
import {
	getIdentityForAgentType,
	getSessionsForIdentity,
	markSessionAuthFailure,
	selectAuthSnapshotForSession,
	selectKnownIdentities,
	selectKnownIdentity,
	selectLoggedOutIdentities,
	useProviderAuthStore,
} from '../../../renderer/stores/providerAuthStore';
import { describeAuthIndicator } from '../../../renderer/components/SessionList/AuthIndicator';
import type { CredentialIdentity, ProviderAuthSnapshot } from '../../../shared/providerAuth';
import { createMockSession } from '../../helpers/mockSession';
import type { Session } from '../../../renderer/types';

const HOME = '/Users/x';
const DEFAULT_KEY = `claude-code::oauth::${HOME}/.claude::local`;
const SIBLING_DIR = `${HOME}/.claude-smash`;
const SIBLING_KEY = `claude-code::oauth::${SIBLING_DIR}::local`;

const makeSession = (id: string, env?: Record<string, string>): Session =>
	createMockSession({
		id,
		name: id,
		...(env ? { customEnvVars: env } : {}),
	});

const identity = (key: string, label: string): CredentialIdentity => ({
	key,
	provider: 'claude-code',
	kind: 'oauth',
	scope: key.split('::')[2],
	host: 'local',
	label,
});

const snapshotFor = (
	key: string,
	label: string,
	status: ProviderAuthSnapshot['status'],
	checkedAt = 1
): ProviderAuthSnapshot => ({
	identity: identity(key, label),
	status,
	checkedAt,
	source: 'probe',
});

/**
 * The announcement pass runs off a store subscription, not off the call that
 * triggered it, so tests have to let the queued pass finish before asserting on
 * the toast queue. A macrotask drains the promise chain it is serialized on.
 */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function installBridge(overrides: Record<string, unknown> = {}): {
	mark: ReturnType<typeof vi.fn>;
	getAll: ReturnType<typeof vi.fn>;
} {
	const mark = vi.fn().mockResolvedValue(null);
	const getAll = vi.fn().mockResolvedValue({});
	(window as unknown as { maestro: unknown }).maestro = {
		providerAuth: { getAll, onChange: () => () => {}, mark, ...overrides },
		agents: { getCustomEnvVars: vi.fn().mockResolvedValue({}) },
		fs: { homeDir: vi.fn().mockResolvedValue(HOME) },
	};
	return { mark, getAll };
}

async function resetStores(): Promise<void> {
	useProviderAuthStore.getState().__resetForTests();
	useSessionStore.setState({ sessions: [] });
	// An announcement pass queued by a previous test can still be in flight; let
	// it finish against the now-empty state before clearing the toast queue.
	await flush();
	useNotificationStore.setState({ toasts: [] });
	useNotificationStore.getState().setDefaultDuration(20);
}

describe('providerAuthStore smoke', () => {
	beforeEach(async () => {
		await resetStores();
	});

	// A `providerAuth:changed` can land while `getAll()` is still in flight - a
	// startup probe finishing, or the user marking a credential. Replacing the map
	// with the resolved read rolled that newer record back, and the badge stayed
	// stale until something else happened to touch the same credential.
	it('keeps an update that lands mid-hydration', async () => {
		let releaseGetAll: (value: Record<string, ProviderAuthSnapshot>) => void = () => {};
		const pending = new Promise<Record<string, ProviderAuthSnapshot>>((resolve) => {
			releaseGetAll = resolve;
		});
		installBridge({ getAll: vi.fn().mockReturnValue(pending) });

		const hydrating = useProviderAuthStore.getState().hydrate();

		// Newer than the read below, and arriving before it resolves.
		const fresh = snapshotFor(DEFAULT_KEY, '.claude', 'authenticated', 200);
		useProviderAuthStore.getState().applyChange(DEFAULT_KEY, fresh);

		releaseGetAll({ [DEFAULT_KEY]: snapshotFor(DEFAULT_KEY, '.claude', 'logged-out', 100) });
		await hydrating;

		expect(useProviderAuthStore.getState().snapshots[DEFAULT_KEY]).toEqual(fresh);
	});

	// Two writers race, and the clock cannot always tell them apart. On a tie the
	// live event wins: it arrived while the read was in flight, so it is the later
	// of the two even when both stamp the same millisecond.
	it('keeps the live event when both records stamp the same millisecond', async () => {
		const stale = snapshotFor(DEFAULT_KEY, '.claude', 'logged-out', 500);
		installBridge({ getAll: vi.fn().mockResolvedValue({ [DEFAULT_KEY]: stale }) });

		const live = snapshotFor(DEFAULT_KEY, '.claude', 'authenticated', 500);
		useProviderAuthStore.getState().applyChange(DEFAULT_KEY, live);
		await useProviderAuthStore.getState().hydrate();

		expect(useProviderAuthStore.getState().snapshots[DEFAULT_KEY]).toEqual(live);
	});

	it('takes the stored record when the read is the newer of the two', async () => {
		const stored = snapshotFor(DEFAULT_KEY, '.claude', 'logged-out', 300);
		installBridge({ getAll: vi.fn().mockResolvedValue({ [DEFAULT_KEY]: stored }) });

		useProviderAuthStore
			.getState()
			.applyChange(DEFAULT_KEY, snapshotFor(DEFAULT_KEY, '.claude', 'authenticated', 100));
		await useProviderAuthStore.getState().hydrate();

		expect(useProviderAuthStore.getState().snapshots[DEFAULT_KEY]).toEqual(stored);
	});

	it('resolves sessions onto one shared identity', async () => {
		installBridge();

		useSessionStore.setState({
			sessions: [makeSession('a'), makeSession('b'), makeSession('c', { CLAUDE_CONFIG_DIR: '/o' })],
		});
		await useProviderAuthStore.getState().hydrate();
		expect(useProviderAuthStore.getState().homeDir).toBe(HOME);

		const snapshot = snapshotFor(DEFAULT_KEY, '.claude', 'logged-out');
		useProviderAuthStore.getState().applyChange(snapshot.identity.key, snapshot);

		expect(selectAuthSnapshotForSession('a')(useProviderAuthStore.getState())).toEqual(snapshot);
		expect(selectAuthSnapshotForSession('c')(useProviderAuthStore.getState())).toBeNull();

		const blocked = selectLoggedOutIdentities()(useProviderAuthStore.getState());
		expect(blocked).toHaveLength(1);
		expect(blocked[0].sessionIds).toEqual(['a', 'b']);
		// Reference-stable across an unrelated session-object churn.
		useSessionStore.setState({ sessions: [...useSessionStore.getState().sessions] });
		expect(selectLoggedOutIdentities()(useProviderAuthStore.getState())).toBe(blocked);
	});
});

/**
 * Fail-closed identity resolution.
 *
 * An identity is only as good as the env it was resolved from, and half that env
 * (the agent-level half) arrives over IPC. Guessing at it produces a key that is
 * wrong in the worst possible way: it names a real account, just not the one the
 * agent presents.
 */
describe('unreadable agent-level env', () => {
	beforeEach(async () => {
		await resetStores();
	});

	it('resolves no identity for the provider rather than one built without it', async () => {
		installBridge();
		// An agent-level ANTHROPIC_API_KEY would make this an api-key credential,
		// not the default config directory - so a failed read cannot be treated as
		// "no vars set".
		(
			window as unknown as { maestro: { agents: { getCustomEnvVars: unknown } } }
		).maestro.agents.getCustomEnvVars = vi.fn().mockRejectedValue(new Error('ipc down'));

		useSessionStore.setState({ sessions: [makeSession('a')] });
		await useProviderAuthStore.getState().hydrate();
		await flush();

		expect(useProviderAuthStore.getState().agentEnvFailures['claude-code']).toBe(true);
		expect(getSessionsForIdentity(DEFAULT_KEY)).toEqual([]);
		expect(selectAuthSnapshotForSession('a')(useProviderAuthStore.getState())).toBeNull();
		expect(getIdentityForAgentType('claude-code')).toBeNull();
	});

	it('resolves normally again once a later read succeeds', async () => {
		installBridge();
		const getCustomEnvVars = vi
			.fn()
			.mockRejectedValueOnce(new Error('ipc down'))
			.mockResolvedValue({});
		(
			window as unknown as { maestro: { agents: { getCustomEnvVars: unknown } } }
		).maestro.agents.getCustomEnvVars = getCustomEnvVars;

		useSessionStore.setState({ sessions: [makeSession('a')] });
		await useProviderAuthStore.getState().hydrate();
		await flush();
		expect(getIdentityForAgentType('claude-code')).toBeNull();

		// A change to WHICH agents exist is what retries the fetch.
		useSessionStore.setState({ sessions: [makeSession('a'), makeSession('b')] });
		await flush();

		expect(useProviderAuthStore.getState().agentEnvFailures['claude-code']).toBeUndefined();
		expect(getIdentityForAgentType('claude-code')?.key).toBe(DEFAULT_KEY);
	});
});

/**
 * The fan-out. One credential, many agents: the roll-up has to name every agent
 * the dead login costs, leave every agent on a different account alone, and
 * release all of them together when the login comes back.
 */
describe('blocked roll-up across agents sharing one credential', () => {
	beforeEach(async () => {
		await resetStores();
	});

	const fifteen = (): Session[] => Array.from({ length: 15 }, (_, i) => makeSession(`agent-${i}`));

	it('reports all fifteen agents blocked when the single shared identity goes logged out', async () => {
		installBridge();
		useSessionStore.setState({ sessions: fifteen() });
		await useProviderAuthStore.getState().hydrate();

		useProviderAuthStore
			.getState()
			.applyChange(DEFAULT_KEY, snapshotFor(DEFAULT_KEY, '.claude', 'logged-out'));

		const blocked = selectLoggedOutIdentities()(useProviderAuthStore.getState());
		// One problem, not fifteen.
		expect(blocked).toHaveLength(1);
		expect(blocked[0].identity.key).toBe(DEFAULT_KEY);
		expect(blocked[0].sessionIds).toHaveLength(15);

		// ...and every row shows it.
		const state = useProviderAuthStore.getState();
		for (const session of useSessionStore.getState().sessions) {
			const snapshot = selectAuthSnapshotForSession(session.id)(state);
			expect(snapshot?.status).toBe('logged-out');
			expect(describeAuthIndicator(snapshot)).toEqual({
				tooltip: 'Claude Code (.claude) needs re-authentication',
				canSignIn: true,
			});
		}
	});

	it('leaves an agent on a different account untouched when its sibling logs out', async () => {
		installBridge();
		useSessionStore.setState({
			sessions: [
				makeSession('shared-1'),
				makeSession('shared-2'),
				makeSession('other', { CLAUDE_CONFIG_DIR: SIBLING_DIR }),
			],
		});
		await useProviderAuthStore.getState().hydrate();

		useProviderAuthStore
			.getState()
			.applyChange(DEFAULT_KEY, snapshotFor(DEFAULT_KEY, '.claude', 'logged-out'));
		useProviderAuthStore
			.getState()
			.applyChange(SIBLING_KEY, snapshotFor(SIBLING_KEY, '.claude-smash', 'authenticated'));

		const state = useProviderAuthStore.getState();
		expect(selectAuthSnapshotForSession('other')(state)?.status).toBe('authenticated');
		expect(describeAuthIndicator(selectAuthSnapshotForSession('other')(state))).toBeNull();

		const blocked = selectLoggedOutIdentities()(state);
		expect(blocked).toHaveLength(1);
		expect(blocked[0].sessionIds).toEqual(['shared-1', 'shared-2']);
	});

	it('lists every agent on a credential regardless of what its snapshot says', async () => {
		installBridge();
		useSessionStore.setState({
			sessions: [
				makeSession('shared-1'),
				makeSession('shared-2'),
				makeSession('other', { CLAUDE_CONFIG_DIR: SIBLING_DIR }),
			],
		});
		await useProviderAuthStore.getState().hydrate();

		// No snapshot at all, then a healthy one: the recovery flow has to reach
		// these agents AFTER the login flipped the status, which is exactly when
		// `selectLoggedOutIdentities` stops naming them.
		expect(getSessionsForIdentity(DEFAULT_KEY).map((s) => s.id)).toEqual(['shared-1', 'shared-2']);
		useProviderAuthStore
			.getState()
			.applyChange(DEFAULT_KEY, snapshotFor(DEFAULT_KEY, '.claude', 'authenticated'));
		expect(getSessionsForIdentity(DEFAULT_KEY).map((s) => s.id)).toEqual(['shared-1', 'shared-2']);
		expect(getSessionsForIdentity('claude-code::oauth::/gone::local')).toEqual([]);
	});

	it('clears the indicator for every session on an identity when the probe comes back authenticated', async () => {
		installBridge();
		useSessionStore.setState({ sessions: fifteen() });
		await useProviderAuthStore.getState().hydrate();
		useProviderAuthStore
			.getState()
			.applyChange(DEFAULT_KEY, snapshotFor(DEFAULT_KEY, '.claude', 'logged-out'));
		expect(selectLoggedOutIdentities()(useProviderAuthStore.getState())).toHaveLength(1);

		useProviderAuthStore
			.getState()
			.applyChange(DEFAULT_KEY, snapshotFor(DEFAULT_KEY, '.claude', 'authenticated', 2));

		const state = useProviderAuthStore.getState();
		expect(selectLoggedOutIdentities()(state)).toEqual([]);
		for (const session of useSessionStore.getState().sessions) {
			expect(describeAuthIndicator(selectAuthSnapshotForSession(session.id)(state))).toBeNull();
		}
	});
});

/**
 * The known-credential roll-up behind the Provider Accounts settings section.
 *
 * Unlike the blocked roll-up this one has to answer when NOTHING is wrong -
 * that is the whole point of a manual entry point - and it has to answer for a
 * credential the startup pass never probed, which is the normal state of an SSH
 * agent or one nobody opened this week.
 */
describe('known-identity roll-up', () => {
	beforeEach(async () => {
		await resetStores();
	});

	it('lists a healthy account, a never-probed one, and one whose agents are gone', async () => {
		installBridge();
		useSessionStore.setState({
			sessions: [
				makeSession('shared-1'),
				makeSession('shared-2'),
				makeSession('other', { CLAUDE_CONFIG_DIR: SIBLING_DIR }),
			],
		});
		await useProviderAuthStore.getState().hydrate();

		// Only one of the two live credentials has ever been probed...
		useProviderAuthStore
			.getState()
			.applyChange(DEFAULT_KEY, snapshotFor(DEFAULT_KEY, '.claude', 'authenticated'));
		// ...and a third is stored with no agent left referencing it.
		const orphanKey = 'codex::oauth::/Users/x/.codex::local';
		useProviderAuthStore.getState().applyChange(orphanKey, {
			...snapshotFor(orphanKey, '.codex', 'logged-out'),
			identity: { ...identity(orphanKey, '.codex'), provider: 'codex' },
		});

		const known = selectKnownIdentities()(useProviderAuthStore.getState());
		const byKey = new Map(known.map((entry) => [entry.identity.key, entry]));

		expect(known).toHaveLength(3);
		// Signed out sorts first: the row that needs the user leads the list.
		expect(known[0].identity.key).toBe(orphanKey);
		expect(byKey.get(orphanKey)?.sessionIds).toEqual([]);
		expect(byKey.get(DEFAULT_KEY)?.sessionIds).toEqual(['shared-1', 'shared-2']);
		expect(byKey.get(DEFAULT_KEY)?.snapshot?.status).toBe('authenticated');
		// The never-probed credential is listed anyway, with an honest null.
		expect(byKey.get(SIBLING_KEY)?.snapshot).toBeNull();
		expect(byKey.get(SIBLING_KEY)?.sessionIds).toEqual(['other']);
	});

	it('is reference-stable across unrelated session churn', async () => {
		installBridge();
		useSessionStore.setState({ sessions: [makeSession('a')] });
		await useProviderAuthStore.getState().hydrate();

		const first = selectKnownIdentities()(useProviderAuthStore.getState());
		useSessionStore.setState({ sessions: [...useSessionStore.getState().sessions] });
		expect(selectKnownIdentities()(useProviderAuthStore.getState())).toBe(first);

		// A real change to the answer does produce a new array.
		useProviderAuthStore
			.getState()
			.applyChange(DEFAULT_KEY, snapshotFor(DEFAULT_KEY, '.claude', 'logged-out'));
		expect(selectKnownIdentities()(useProviderAuthStore.getState())).not.toBe(first);
	});

	it('resolves a never-probed credential by key, so the recovery modal can name it', async () => {
		installBridge();
		useSessionStore.setState({ sessions: [makeSession('a')] });
		await useProviderAuthStore.getState().hydrate();

		const state = useProviderAuthStore.getState();
		expect(state.snapshots[DEFAULT_KEY]).toBeUndefined();
		expect(selectKnownIdentity(DEFAULT_KEY)(state)?.label).toBe('.claude');
		expect(selectKnownIdentity('claude-code::oauth::/gone::local')(state)).toBeNull();
	});
});

/**
 * The reactive path: a live `auth_expired` marks the credential, and WHICH mark
 * it writes depends on the credential's kind. An OAuth login can be repaired by
 * signing in; a rejected API key cannot, so it must not land in the bucket the
 * login button reads from.
 */
describe('markSessionAuthFailure', () => {
	let mark: ReturnType<typeof vi.fn>;

	beforeEach(async () => {
		await resetStores();
		({ mark } = installBridge());
	});

	it('marks an oauth credential logged out, with the identity attached', async () => {
		useSessionStore.setState({ sessions: [makeSession('a')] });

		await markSessionAuthFailure('a', 'Invalid API key - please run /login');

		expect(mark).toHaveBeenCalledTimes(1);
		const [key, request] = mark.mock.calls[0];
		expect(key).toBe(DEFAULT_KEY);
		expect(request).toMatchObject({
			status: 'logged-out',
			source: 'error-pattern',
			detail: 'Invalid API key - please run /login',
		});
		// The identity rides along so a credential that was never probed still
		// gets a record instead of a silent no-op in main.
		expect(request.identity.key).toBe(key);
	});

	it('marks an api-key credential unsupported, not logged out', async () => {
		useSessionStore.setState({
			sessions: [makeSession('a', { ANTHROPIC_API_KEY: 'sk-ant-secret-value' })],
		});

		await markSessionAuthFailure('a', 'authentication_error');

		const [key, request] = mark.mock.calls[0];
		// A sign-in cannot repair a rejected key, so this must never reach the
		// bucket the recovery flow offers a login for.
		expect(request.status).toBe('unsupported');
		expect(request.status).not.toBe('logged-out');
		expect(request.detail).toContain('ANTHROPIC_API_KEY');
		expect(request.identity.kind).toBe('api-key');
		// The raw secret never leaves the identity resolver.
		expect(key).not.toContain('sk-ant-secret-value');
		expect(JSON.stringify(request)).not.toContain('sk-ant-secret-value');
	});

	it('renders a rejected api-key mark as unfixable-by-login in the Left Bar', () => {
		// The status alone is not the whole contract: `unsupported` from a PROBE is
		// a healthy agent whose provider has nothing to probe, and must not be
		// badged. The same status from a live failure must be.
		const rejected: ProviderAuthSnapshot = {
			identity: {
				key: 'claude-code::api-key::ANTHROPIC_API_KEY:abc123::local',
				provider: 'claude-code',
				kind: 'api-key',
				scope: 'ANTHROPIC_API_KEY:abc123',
				host: 'local',
				label: 'ANTHROPIC_API_KEY',
				envVarName: 'ANTHROPIC_API_KEY',
			},
			status: 'unsupported',
			checkedAt: 1,
			source: 'error-pattern',
			detail: 'ANTHROPIC_API_KEY was rejected.',
		};

		expect(describeAuthIndicator(rejected)).toEqual({
			tooltip: 'Claude Code (ANTHROPIC_API_KEY) rejected its credential',
			canSignIn: false,
		});
		expect(describeAuthIndicator({ ...rejected, source: 'probe' })).toBeNull();
	});

	it('does nothing for a session that resolves to no identity', async () => {
		const result = await markSessionAuthFailure('missing-session', 'expired');
		expect(result).toBeNull();
		expect(mark).not.toHaveBeenCalled();
	});
});

/**
 * The startup announcement. One toast per dead IDENTITY, never per agent, and
 * never twice for the same one - a user who has already been told is not told
 * again until the account actually changes state.
 */
describe('logged-out announcement', () => {
	beforeEach(async () => {
		await resetStores();
	});

	const toasts = () => useNotificationStore.getState().toasts;

	async function hydrateWith(sessions: Session[]): Promise<void> {
		installBridge();
		useSessionStore.setState({ sessions });
		await useProviderAuthStore.getState().hydrate();
		await flush();
	}

	it('fires exactly one toast for fifteen agents sharing the dead login', async () => {
		await hydrateWith(Array.from({ length: 15 }, (_, i) => makeSession(`agent-${i}`)));

		useProviderAuthStore
			.getState()
			.applyChange(DEFAULT_KEY, snapshotFor(DEFAULT_KEY, '.claude', 'logged-out'));
		await flush();

		expect(toasts()).toHaveLength(1);
		const toast = toasts()[0];
		// Names the ACCOUNT, since that is the one thing that is broken.
		expect(toast.title).toBe('Claude Code (.claude) is signed out');
		// ...and the body names what it costs.
		expect(toast.message).toContain('15 agents are blocked');
		expect(toast.message).toContain('agent-0');
		expect(toast.message).toContain('and 11 more');
		// Sticky and click-to-act: this phase surfaces and waits.
		expect(toast.color).toBe('orange');
		expect(toast.dismissible).toBe(true);
		expect(toast.duration).toBe(0);
		expect(toast.clickAction).toEqual({
			kind: 'provider-auth-recovery',
			identityKey: DEFAULT_KEY,
		});
		expect(useProviderAuthStore.getState().announcedIdentityKeys).toEqual({
			[DEFAULT_KEY]: true,
		});
	});

	it('does not re-fire for an already-announced identity that has not changed', async () => {
		await hydrateWith([makeSession('a'), makeSession('b')]);

		useProviderAuthStore
			.getState()
			.applyChange(DEFAULT_KEY, snapshotFor(DEFAULT_KEY, '.claude', 'logged-out'));
		await flush();
		expect(toasts()).toHaveLength(1);

		// A later probe re-confirms the same dead login. Same answer, no news.
		useProviderAuthStore
			.getState()
			.applyChange(DEFAULT_KEY, snapshotFor(DEFAULT_KEY, '.claude', 'logged-out', 999));
		await flush();
		expect(toasts()).toHaveLength(1);
	});

	it('announces again after the account recovers and later logs out a second time', async () => {
		await hydrateWith([makeSession('a')]);

		useProviderAuthStore
			.getState()
			.applyChange(DEFAULT_KEY, snapshotFor(DEFAULT_KEY, '.claude', 'logged-out'));
		await flush();
		expect(toasts()).toHaveLength(1);

		useProviderAuthStore
			.getState()
			.applyChange(DEFAULT_KEY, snapshotFor(DEFAULT_KEY, '.claude', 'authenticated', 2));
		await flush();
		expect(useProviderAuthStore.getState().announcedIdentityKeys).toEqual({});

		// A genuinely new event, so it earns a new toast.
		useProviderAuthStore
			.getState()
			.applyChange(DEFAULT_KEY, snapshotFor(DEFAULT_KEY, '.claude', 'logged-out', 3));
		await flush();
		expect(toasts()).toHaveLength(2);
	});

	it('fires one toast per distinct dead account, not one per agent', async () => {
		await hydrateWith([
			makeSession('a'),
			makeSession('b'),
			makeSession('c', { CLAUDE_CONFIG_DIR: SIBLING_DIR }),
		]);

		useProviderAuthStore
			.getState()
			.applyChange(DEFAULT_KEY, snapshotFor(DEFAULT_KEY, '.claude', 'logged-out'));
		useProviderAuthStore
			.getState()
			.applyChange(SIBLING_KEY, snapshotFor(SIBLING_KEY, '.claude-smash', 'logged-out'));
		await flush();

		expect(toasts()).toHaveLength(2);
		expect(
			toasts()
				.map((t) => t.title)
				.sort()
		).toEqual(['Claude Code (.claude) is signed out', 'Claude Code (.claude-smash) is signed out']);
	});

	it('stays silent when toasts are switched off, so an unattended run gets nothing', async () => {
		await hydrateWith([makeSession('a')]);
		// The app's toast kill switch. notifyToast honors it for the visible queue
		// but still fires audio and the OS notification, which a 3am Cue run must
		// not get for a login nobody is there to fix.
		useNotificationStore.getState().setDefaultDuration(-1);

		useProviderAuthStore
			.getState()
			.applyChange(DEFAULT_KEY, snapshotFor(DEFAULT_KEY, '.claude', 'logged-out'));
		await flush();

		expect(toasts()).toHaveLength(0);
		expect(useProviderAuthStore.getState().announcedIdentityKeys).toEqual({});
	});
});
