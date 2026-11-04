// Consolidated from current rc sources; per-source hooks and state stay in an unnamed suite.
// Source: src/__tests__/shared/feedbackAccounts.test.ts
// Source: src/__tests__/shared/sleepTracking.test.ts
// Source: src/__tests__/shared/envVarCatalog.test.ts
// Source: src/__tests__/shared/shortcutKeys.normalize.test.ts
// Source: src/__tests__/shared/shortcutKeys.test.ts
// Source: src/__tests__/shared/sshConnection.test.ts
// Source: src/__tests__/shared/directorNotesGrouping.test.ts
// Source: src/__tests__/shared/colorContrast.test.ts
// Source: src/__tests__/shared/groupChatActivity.test.ts
// Source: src/__tests__/shared/toastClickAction.test.ts
// Source: src/__tests__/shared/typographySnapshot.test.ts
// Source: src/__tests__/shared/fontStack.test.ts
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import {
	buildFeedbackAccountCandidates,
	isFeedbackAccountUsable,
	orderFeedbackAccounts,
	type FeedbackAccount,
	type FeedbackAccountCandidate,
} from '../../shared/feedbackAccounts';
import { createSleepTracker } from '../../shared/sleepTracking';
import {
	BLANK_ENV_VAR_KEY,
	COMMON_ENV_VAR_SUGGESTIONS,
	PROVIDER_ENV_VAR_SUGGESTIONS,
	rememberableEnvVarKeys,
	suggestEnvVarKeys,
	withBlankEnvVarRow,
	type KnownEnvVarKeys,
} from '../../shared/envVarCatalog';
import { normalizeShortcutKeys, shortcutKeysEqual } from '../../shared/shortcutKeys';
import {
	formatKeyFor,
	formatShortcutKeysFor,
	findReservedShortcutCombo,
} from '../../shared/shortcutKeys';
import {
	SSH_PROBE_AGENT_MISSING,
	SSH_PROBE_MARKER,
	buildSshConnectionArgs,
	buildSshProbeCommand,
	describeSshConnectionError,
	readSshProbeOutput,
} from '../../shared/sshConnection';
import type { SshRemoteConfig } from '../../shared/types';
import {
	bucketNarrativeItems,
	buildNarrativeGroupLookup,
	normalizeAgentKey,
	shouldRenderBuckets,
	UNATTRIBUTED_BUCKET_LABEL,
} from '../../shared/directorNotesGrouping';
import type { NarrativeItem } from '../../shared/directorNotesNarrative';
import {
	AA_CONTRAST,
	AA_LARGE_CONTRAST,
	adjustBrightness,
	blendColors,
	contrastRatio,
	cssColorToHex,
	hexToRgb,
	isReadableOn,
	readableTextOn,
	relativeLuminance,
	transparentize,
} from '../../shared/colorContrast';
import {
	computeGroupChatActivity,
	GROUP_CHAT_ACTIVITY_STITCH_MS,
} from '../../shared/groupChatActivity';
import type { GroupChatHistoryEntry } from '../../shared/group-chat-types';
import { parseToastClickAction, TOAST_CLICK_ACTION_KINDS } from '../../shared/toastClickAction';
import {
	captureTypographySnapshot,
	parseTypographySnapshot,
	typographySnapshotMatches,
	typographySnapshotPatch,
} from '../../shared/typographySnapshot';
import { TYPOGRAPHY_SURFACE_LIST, INHERIT_TERMINAL } from '../../shared/typography';
import {
	withMonoFallback,
	resolveSurfaceFont,
	displayFontLabel,
	MONO_FALLBACK_STACK,
} from '../../shared/fontStack';
import { DEFAULT_INTERFACE_FONT } from '../../shared/typographyPresets';
// Source: src/__tests__/shared/feedbackAccounts.test.ts
describe('', () => {
	const HOME = '/home/me';
	function checked(
		candidate: FeedbackAccountCandidate,
		status: FeedbackAccount['status']
	): FeedbackAccount {
		return { ...candidate, status };
	}
	describe('buildFeedbackAccountCandidates', () => {
		it('runs as each agent account, deduped, most-used first, with the provider defaults after', () => {
			const candidates = buildFeedbackAccountCandidates({
				agents: [
					{
						name: 'Solo',
						toolType: 'claude-code',
						customEnvVars: { CLAUDE_CONFIG_DIR: '/home/me/.claude-solo' },
					},
					{
						name: 'Work A',
						toolType: 'claude-code',
						customEnvVars: { CLAUDE_CONFIG_DIR: '/home/me/.claude-work' },
					},
					{
						name: 'Work B',
						toolType: 'claude-code',
						customEnvVars: { CLAUDE_CONFIG_DIR: '/home/me/.claude-work/' },
					},
					{ name: 'Terminal', toolType: 'terminal' },
				],
				providerEnvByToolType: {},
				homeDir: HOME,
			});
			expect(candidates.map((c) => c.key)).toEqual([
				'claude-code::/home/me/.claude-work',
				'claude-code::/home/me/.claude-solo',
				'claude-code::/home/me/.claude',
				'codex::/home/me/.codex',
				'opencode',
			]);
			expect(candidates[0].agentNames).toEqual(['Work A', 'Work B']);
			expect(candidates[0].env).toEqual({ CLAUDE_CONFIG_DIR: '/home/me/.claude-work' });
			expect(candidates[2].source).toBe('provider-default');
		});
		it('gives an agent without its own env the provider-level env, which replaces rather than layers', () => {
			const providerEnv = { CODEX_HOME: '/home/me/.codex-team' };
			const candidates = buildFeedbackAccountCandidates({
				agents: [
					{ name: 'Inherits', toolType: 'codex' },
					{ name: 'Own key', toolType: 'codex', customEnvVars: { OPENAI_API_KEY: 'sk-abcd1234' } },
				],
				providerEnvByToolType: { codex: providerEnv },
				homeDir: HOME,
			});
			const inherits = candidates.find((c) => c.agentNames.includes('Inherits'))!;
			expect(inherits.env).toEqual(providerEnv);
			const ownKey = candidates.find((c) => c.agentNames.includes('Own key'))!;
			expect(ownKey.env).toEqual({ OPENAI_API_KEY: 'sk-abcd1234' });
			// The bare default login is still offered, with an explicit empty env so
			// the provider-level CODEX_HOME does not leak back in.
			const bare = candidates.find((c) => c.key === 'codex::/home/me/.codex')!;
			expect(bare.env).toEqual({});
		});
		it('keeps an SSH agent account apart from the local one with the same dir', () => {
			const candidates = buildFeedbackAccountCandidates({
				agents: [
					{
						name: 'Remote',
						toolType: 'claude-code',
						cwd: '/srv/app',
						sshRemote: { id: 'r1', name: 'box' },
					},
				],
				providerEnvByToolType: {},
				homeDir: HOME,
			});
			const remote = candidates.find((c) => c.sshRemoteId === 'r1')!;
			expect(remote.remoteCwd).toBe('/srv/app');
			expect(remote.label).toContain('@ box');
			expect(
				candidates.some((c) => c.key === 'claude-code::/home/me/.claude' && !c.sshRemoteId)
			).toBe(true);
		});
	});
	describe('orderFeedbackAccounts', () => {
		const all = buildFeedbackAccountCandidates({
			agents: [
				{ name: 'W', toolType: 'claude-code', customEnvVars: { CLAUDE_CONFIG_DIR: '/a' } },
				{ name: 'W2', toolType: 'claude-code', customEnvVars: { CLAUDE_CONFIG_DIR: '/a' } },
				{ name: 'S', toolType: 'claude-code', customEnvVars: { CLAUDE_CONFIG_DIR: '/b' } },
				{ name: 'R', toolType: 'claude-code', sshRemote: { id: 'r1' } },
			],
			providerEnvByToolType: {},
			homeDir: HOME,
		});
		const byKey = (key: string) => all.find((c) => c.key === key)!;
		const work = byKey('claude-code::/a');
		const solo = byKey('claude-code::/b');
		const local = byKey('claude-code::/home/me/.claude');
		const remote = all.find((c) => c.sshRemoteId === 'r1')!;
		it('puts signed-in local accounts first, guesses after, and SSH accounts last', () => {
			const ordered = orderFeedbackAccounts(
				[
					checked(remote, 'unknown'),
					checked(work, 'not-logged-in'),
					checked(solo, 'ready'),
					checked(local, 'not-installed'),
				],
				null
			);
			expect(ordered.map((a) => a.key)).toEqual([solo.key, work.key, local.key, remote.key]);
			expect(ordered.filter(isFeedbackAccountUsable).map((a) => a.key)).toEqual([
				solo.key,
				work.key,
				remote.key,
			]);
		});
		it('tries the last account that worked first, unless it is no longer installed', () => {
			const accounts = [checked(solo, 'ready'), checked(work, 'not-logged-in')];
			expect(orderFeedbackAccounts(accounts, work.key)[0].key).toBe(work.key);
			const gone = [checked(solo, 'ready'), checked(work, 'not-installed')];
			expect(orderFeedbackAccounts(gone, work.key)[0].key).toBe(solo.key);
		});
	});
});
// Source: src/__tests__/shared/sleepTracking.test.ts
describe('', () => {
	describe('sleepTracking', () => {
		beforeEach(() => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
		});
		afterEach(() => {
			vi.useRealTimers();
		});
		/** Advance both the fake timers and the wall clock, as a real sleep would. */
		const advance = (ms: number) => vi.advanceTimersByTime(ms);
		describe('span elapsed time', () => {
			it('measures wall clock when the machine never slept', () => {
				const tracker = createSleepTracker();
				const span = tracker.beginSpan();
				advance(90000);
				expect(tracker.elapsedMs(span)).toBe(90000);
			});
			it('excludes a sleep that happened inside the span', () => {
				const tracker = createSleepTracker();
				const span = tracker.beginSpan();
				advance(60000);
				// The wall clock runs through the sleep; the measured gap arrives on wake.
				advance(8 * 60 * 60 * 1000);
				tracker.recordSleep(8 * 60 * 60 * 1000);
				advance(30000);
				expect(tracker.elapsedMs(span)).toBe(90000);
			});
			it('ignores sleep that happened before the span started', () => {
				const tracker = createSleepTracker();
				tracker.recordSleep(3600000);
				const span = tracker.beginSpan();
				advance(45000);
				expect(tracker.elapsedMs(span)).toBe(45000);
			});
			it('never returns a negative duration', () => {
				const tracker = createSleepTracker();
				const span = tracker.beginSpan();
				// A gap reported longer than the span itself (duplicate resume events,
				// clock adjustment) must clamp to zero rather than go negative.
				tracker.recordSleep(10000);
				expect(tracker.elapsedMs(span)).toBe(0);
			});
		});
		describe('recordSleep', () => {
			it('accumulates across several sleeps', () => {
				const tracker = createSleepTracker();
				tracker.recordSleep(1000);
				tracker.recordSleep(2000);
				expect(tracker.getTotalSleepMs()).toBe(3000);
			});
			it('ignores non-positive and non-finite gaps', () => {
				const tracker = createSleepTracker();
				tracker.recordSleep(0);
				tracker.recordSleep(-5000);
				tracker.recordSleep(Number.NaN);
				tracker.recordSleep(Number.POSITIVE_INFINITY);
				expect(tracker.getTotalSleepMs()).toBe(0);
			});
			it('notifies subscribers and the onRecord option', () => {
				const onRecord = vi.fn();
				const tracker = createSleepTracker({ onRecord });
				const handler = vi.fn();
				const unsubscribe = tracker.onSleep(handler);
				tracker.recordSleep(5000);
				expect(onRecord).toHaveBeenCalledWith(5000);
				expect(handler).toHaveBeenCalledWith(5000);
				unsubscribe();
				tracker.recordSleep(1000);
				expect(handler).toHaveBeenCalledTimes(1);
			});
		});
		describe('sleepMsSince', () => {
			it('sums only the wakes after the given timestamp', () => {
				const tracker = createSleepTracker();
				tracker.recordSleep(1000);
				advance(10000);
				const startedAt = Date.now();
				advance(10000);
				tracker.recordSleep(2000);
				advance(10000);
				tracker.recordSleep(4000);
				expect(tracker.sleepMsSince(startedAt)).toBe(6000);
			});
			it('returns zero when nothing slept since the timestamp', () => {
				const tracker = createSleepTracker();
				tracker.recordSleep(1000);
				advance(1000);
				expect(tracker.sleepMsSince(Date.now())).toBe(0);
			});
		});
		describe('reset', () => {
			it('drops the counter, the wake log, and subscribers', () => {
				const tracker = createSleepTracker();
				const handler = vi.fn();
				tracker.onSleep(handler);
				const since = Date.now();
				tracker.recordSleep(5000);
				tracker.reset();
				expect(tracker.getTotalSleepMs()).toBe(0);
				expect(tracker.sleepMsSince(since)).toBe(0);
				tracker.recordSleep(1000);
				expect(handler).toHaveBeenCalledTimes(1);
			});
		});
	});
});
// Source: src/__tests__/shared/envVarCatalog.test.ts
describe('', () => {
	const known: KnownEnvVarKeys = {
		byProvider: {
			'claude-code': ['ANTHROPIC_MODEL', 'MY_TEAM_TOKEN'],
			codex: ['CODEX_ONLY_VAR'],
		},
		global: ['HTTPS_PROXY', 'COMPANY_CA_PATH'],
	};
	describe('suggestEnvVarKeys', () => {
		it("leads with the provider's own catalog", () => {
			const keys = suggestEnvVarKeys({ toolType: 'claude-code' }).map((entry) => entry.key);
			expect(keys[0]).toBe('CLAUDE_CONFIG_DIR');
			expect(keys).toContain('ANTHROPIC_BASE_URL');
			expect(keys).not.toContain('CODEX_HOME');
		});
		it('offers names the user set before, and marks them as remembered', () => {
			const suggestions = suggestEnvVarKeys({ toolType: 'claude-code', known });
			const remembered = suggestions.find((entry) => entry.key === 'MY_TEAM_TOKEN');
			expect(remembered?.origin).toBe('remembered');
			// Global names apply to every provider, so they come along.
			expect(suggestions.map((entry) => entry.key)).toContain('COMPANY_CA_PATH');
			// Another provider's name is noise here.
			expect(suggestions.map((entry) => entry.key)).not.toContain('CODEX_ONLY_VAR');
		});
		it('keeps a catalog name catalogued even when the user has also set it', () => {
			const suggestions = suggestEnvVarKeys({ toolType: 'claude-code', known });
			const matches = suggestions.filter((entry) => entry.key === 'ANTHROPIC_MODEL');
			expect(matches).toHaveLength(1);
			expect(matches[0].origin).toBe('provider');
		});
		it('drops names already used by another row', () => {
			const keys = suggestEnvVarKeys({
				toolType: 'claude-code',
				exclude: ['CLAUDE_CONFIG_DIR'],
			}).map((entry) => entry.key);
			expect(keys).not.toContain('CLAUDE_CONFIG_DIR');
		});
		it('ranks a prefix match above a match in the middle of a name', () => {
			const keys = suggestEnvVarKeys({ toolType: 'claude-code', query: 'claude' }).map(
				(entry) => entry.key
			);
			expect(keys[0]).toBe('CLAUDE_CONFIG_DIR');
			expect(keys).toContain('CLAUDE_CODE_USE_BEDROCK');
			// Matching is case-insensitive but the suggestion keeps its own spelling.
			expect(keys.every((key) => key === key.toUpperCase())).toBe(true);
		});
		it('offers every provider catalog when no provider is named', () => {
			const keys = suggestEnvVarKeys({ query: 'HOME', limit: 50 }).map((entry) => entry.key);
			expect(keys).toContain('CODEX_HOME');
			expect(keys).toContain('COPILOT_HOME');
		});
		it('falls back to the common set for a provider with no catalog', () => {
			const suggestions = suggestEnvVarKeys({ toolType: 'terminal' });
			expect(suggestions.map((entry) => entry.key)).toEqual(
				COMMON_ENV_VAR_SUGGESTIONS.map((entry) => entry.key)
			);
			expect(suggestions.every((entry) => entry.origin === 'common')).toBe(true);
		});
		it('honors the limit', () => {
			expect(suggestEnvVarKeys({ toolType: 'claude-code', known, limit: 3 })).toHaveLength(3);
		});
	});
	describe('PROVIDER_ENV_VAR_SUGGESTIONS', () => {
		it('names every entry in env-var form and describes it', () => {
			for (const entries of Object.values(PROVIDER_ENV_VAR_SUGGESTIONS)) {
				for (const entry of entries) {
					expect(entry.key).toMatch(/^[A-Z][A-Z0-9_]*$/);
					expect(entry.description.length).toBeGreaterThan(0);
				}
			}
		});
	});
	describe('withBlankEnvVarRow', () => {
		it('adds an UNNAMED row, not a placeholder name', () => {
			expect(withBlankEnvVarRow({ A: '1' })).toEqual({ A: '1', [BLANK_ENV_VAR_KEY]: '' });
		});
		it('cannot produce two unnamed rows', () => {
			// The record is keyed by name, so pressing Add twice is idempotent.
			expect(withBlankEnvVarRow(withBlankEnvVarRow({ A: '1' }))).toEqual({
				A: '1',
				[BLANK_ENV_VAR_KEY]: '',
			});
		});
		it("leaves the caller's record untouched", () => {
			const original = { A: '1' };
			withBlankEnvVarRow(original);
			expect(original).toEqual({ A: '1' });
		});
	});
	describe('rememberableEnvVarKeys', () => {
		it('keeps names that carry a value', () => {
			expect(rememberableEnvVarKeys({ A: '1', B: 'x' })).toEqual(['A', 'B']);
		});
		it('drops blank and non-string values, which are unfinished rows', () => {
			expect(rememberableEnvVarKeys({ A: '', B: '   ', C: 42 as unknown as string })).toEqual([]);
		});
		it('drops the unnamed row even once it carries a value', () => {
			expect(
				rememberableEnvVarKeys({ [BLANK_ENV_VAR_KEY]: 'typed the value first', A: '1' })
			).toEqual(['A']);
		});
		it('tolerates a missing record', () => {
			expect(rememberableEnvVarKeys(undefined)).toEqual([]);
			expect(rememberableEnvVarKeys(null)).toEqual([]);
		});
	});
});
// Source: src/__tests__/shared/shortcutKeys.normalize.test.ts
describe('', () => {
	describe('normalizeShortcutKeys', () => {
		it('is order-independent', () => {
			expect(normalizeShortcutKeys(['Meta', 'Shift', 'k'])).toBe(
				normalizeShortcutKeys(['Shift', 'Meta', 'k'])
			);
		});
		it('preserves case, because k and K are different chords', () => {
			expect(normalizeShortcutKeys(['Meta', 'k'])).not.toBe(normalizeShortcutKeys(['Meta', 'K']));
		});
		it('does not mutate its input', () => {
			const keys = ['Shift', 'Meta', 'k'];
			normalizeShortcutKeys(keys);
			expect(keys).toEqual(['Shift', 'Meta', 'k']);
		});
	});
	describe('shortcutKeysEqual', () => {
		it('matches a reordered duplicate - the case an ordered compare misses', () => {
			expect(shortcutKeysEqual(['Meta', 'Shift', 'k'], ['Shift', 'Meta', 'k'])).toBe(true);
		});
		it('rejects a different chord', () => {
			expect(shortcutKeysEqual(['Meta', 'k'], ['Meta', 'j'])).toBe(false);
		});
		it('rejects a superset', () => {
			expect(shortcutKeysEqual(['Meta', 'k'], ['Meta', 'Shift', 'k'])).toBe(false);
		});
		it('treats two empty combinations as equal', () => {
			expect(shortcutKeysEqual([], [])).toBe(true);
		});
		it('rejects an empty combination against a real one', () => {
			expect(shortcutKeysEqual([], ['Meta', 'k'])).toBe(false);
		});
	});
});
// Source: src/__tests__/shared/shortcutKeys.test.ts
describe('', () => {
	describe('formatKeyFor', () => {
		it('maps modifiers to macOS symbols', () => {
			expect(formatKeyFor('Meta', true)).toBe('⌘');
			expect(formatKeyFor('Alt', true)).toBe('⌥');
			expect(formatKeyFor('Shift', true)).toBe('⇧');
			expect(formatKeyFor('Control', true)).toBe('⌃');
		});
		it('maps modifiers to readable text elsewhere', () => {
			expect(formatKeyFor('Meta', false)).toBe('Ctrl');
			expect(formatKeyFor('Alt', false)).toBe('Alt');
			expect(formatKeyFor('Shift', false)).toBe('Shift');
		});
		it('uppercases single characters on both platforms', () => {
			expect(formatKeyFor('j', true)).toBe('J');
			expect(formatKeyFor('j', false)).toBe('J');
		});
		it('passes through names it has no mapping for', () => {
			expect(formatKeyFor('F12', true)).toBe('F12');
			expect(formatKeyFor('F12', false)).toBe('F12');
		});
		it('uses glyphs for named keys on macOS and words elsewhere', () => {
			expect(formatKeyFor('Backspace', true)).toBe('⌫');
			expect(formatKeyFor('Backspace', false)).toBe('Backspace');
			expect(formatKeyFor('Escape', true)).toBe('⎋');
			expect(formatKeyFor('Escape', false)).toBe('Esc');
		});
	});
	describe('formatShortcutKeysFor', () => {
		it('separates with a space on macOS and a plus elsewhere', () => {
			expect(formatShortcutKeysFor(['Meta', 'Shift', 'k'], true)).toBe('⌘ ⇧ K');
			expect(formatShortcutKeysFor(['Meta', 'Shift', 'k'], false)).toBe('Ctrl+Shift+K');
		});
		it('honors an explicit separator', () => {
			// The macOS app menu packs the glyphs with no separator at all, the way
			// a native accelerator column renders them.
			expect(formatShortcutKeysFor(['Meta', 'Shift', 'k'], true, '')).toBe('⌘⇧K');
			expect(formatShortcutKeysFor(['Alt', 'Meta', 'ArrowLeft'], true, '')).toBe('⌥⌘←');
		});
		it('returns an empty string for an empty binding', () => {
			expect(formatShortcutKeysFor([], true)).toBe('');
		});
	});
	describe('findReservedShortcutCombo', () => {
		it('flags Cmd+Shift+Down, which the OS uses to extend a text selection', () => {
			expect(findReservedShortcutCombo(['Meta', 'Shift', 'ArrowDown'])?.reason).toContain(
				'text selection'
			);
		});
		it('flags the Ctrl spelling too, since Meta and Ctrl are one modifier when matching', () => {
			expect(findReservedShortcutCombo(['Ctrl', 'Shift', 'ArrowDown'])).not.toBeNull();
		});
		it('ignores key order, matching how a chord is compared everywhere else', () => {
			expect(findReservedShortcutCombo(['Shift', 'ArrowDown', 'Meta'])).not.toBeNull();
		});
		it('leaves Opt+Cmd+Down free - it is the default for Next Unread / Draft Tab', () => {
			expect(findReservedShortcutCombo(['Alt', 'Meta', 'ArrowDown'])).toBeNull();
		});
		it('returns null for an unbound action rather than treating [] as a chord', () => {
			expect(findReservedShortcutCombo([])).toBeNull();
			expect(findReservedShortcutCombo(undefined)).toBeNull();
		});
	});
});
// Source: src/__tests__/shared/sshConnection.test.ts
describe('', () => {
	const base = (overrides: Partial<SshRemoteConfig> = {}): SshRemoteConfig => ({
		id: 'r1',
		name: 'Remote',
		host: 'example.internal',
		port: 22,
		username: 'pedram',
		privateKeyPath: '',
		enabled: true,
		...overrides,
	});
	describe('buildSshConnectionArgs', () => {
		it('disables TTY and targets user@host', () => {
			const args = buildSshConnectionArgs(base());
			expect(args[0]).toBe('-T');
			expect(args[args.length - 1]).toBe('pedram@example.internal');
		});
		it('omits the user when none is configured', () => {
			const args = buildSshConnectionArgs(base({ username: '   ' }));
			expect(args[args.length - 1]).toBe('example.internal');
		});
		// A tunnelled remote authenticates through its transport and configures no
		// key. Passing `-i ''` would override ssh-agent and ~/.ssh/config with
		// nothing, so an empty path must not produce the flag at all.
		it('passes no identity flag when no key is configured', () => {
			expect(buildSshConnectionArgs(base({ privateKeyPath: '' }))).not.toContain('-i');
			expect(buildSshConnectionArgs(base({ privateKeyPath: '  ' }))).not.toContain('-i');
		});
		it('expands a tilde in the key path', () => {
			const args = buildSshConnectionArgs(base({ privateKeyPath: '~/.ssh/id_ed25519' }));
			const key = args[args.indexOf('-i') + 1];
			expect(key.startsWith('~')).toBe(false);
			expect(key.endsWith('/.ssh/id_ed25519')).toBe(true);
		});
		// The whole point of the feature: an arbitrary transport rides through as
		// -o pairs, with no per-transport field anywhere in the config.
		it('carries a ProxyCommand through as an -o pair', () => {
			const args = buildSshConnectionArgs(
				base({ sshOptions: { ProxyCommand: '/usr/local/bin/tailcat blob 22' } })
			);
			expect(args).toContain('-o');
			expect(args.join(' ')).toContain('ProxyCommand=/usr/local/bin/tailcat blob 22');
		});
		// An ssh-config remote resolves its port from the Host block. Emitting a
		// default -p 22 would shadow a non-default port the config had set.
		it('omits the default port for an ssh-config remote but keeps an override', () => {
			expect(buildSshConnectionArgs(base({ useSshConfig: true, port: 22 }))).not.toContain('-p');
			expect(buildSshConnectionArgs(base({ useSshConfig: true, port: 2222 }))).toContain('-p');
			expect(buildSshConnectionArgs(base({ port: 22 }))).toContain('-p');
		});
	});
	describe('buildSshProbeCommand', () => {
		it('echoes the marker first so a banner cannot be mistaken for success', () => {
			expect(buildSshProbeCommand().startsWith(`echo "${SSH_PROBE_MARKER}"`)).toBe(true);
		});
		// `which` is an external binary absent from minimal images, where its own
		// failure would read as the agent being missing.
		it('probes an agent with the POSIX builtin, not which', () => {
			const cmd = buildSshProbeCommand('claude');
			expect(cmd).toContain('command -v claude');
			expect(cmd).not.toContain('which claude');
		});
	});
	describe('readSshProbeOutput', () => {
		it('reads hostname when the marker leads', () => {
			expect(readSshProbeOutput('SSH_OK\nbuild-box\n', false)).toEqual({
				ok: true,
				hostname: 'build-box',
			});
		});
		// A remote whose rc file prints a banner answers, but not with our command.
		it('rejects output that does not lead with the marker', () => {
			expect(readSshProbeOutput('Welcome!\nSSH_OK\nbuild-box\n', false).ok).toBe(false);
			expect(readSshProbeOutput('', false).ok).toBe(false);
		});
		it('reports an agent found or missing only when one was probed', () => {
			expect(readSshProbeOutput('SSH_OK\nbox\n/usr/bin/claude\n', true).agentFound).toBe(true);
			expect(readSshProbeOutput(`SSH_OK\nbox\n${SSH_PROBE_AGENT_MISSING}\n`, true).agentFound).toBe(
				false
			);
			expect(readSshProbeOutput('SSH_OK\nbox\n', false).agentFound).toBeUndefined();
		});
		// The sentinel is printed by an `||` branch, so a shell that produced nothing
		// on that line means the same thing: not found, never "found".
		it('treats a missing third line as not found', () => {
			expect(readSshProbeOutput('SSH_OK\nbox\n', true).agentFound).toBe(false);
		});
	});
	describe('describeSshConnectionError', () => {
		it('names the thing to change for known failures', () => {
			expect(describeSshConnectionError('Permission denied (publickey).')).toMatch(
				/Authentication/
			);
			expect(describeSshConnectionError('ssh: connect to host: Connection refused')).toMatch(
				/Connection refused/
			);
			expect(describeSshConnectionError('Could not resolve hostname foo')).toMatch(/resolve/);
		});
		// An exotic transport reports failures this function has never heard of, and
		// that raw text is the only diagnostic there is. Replacing it with a generic
		// message would throw away the tunnel's own explanation.
		it('returns unrecognized transport errors verbatim', () => {
			const raw = 'tailcat Ping: context deadline exceeded';
			expect(describeSshConnectionError(raw)).toBe(raw);
		});
		it('returns undefined for empty stderr', () => {
			expect(describeSshConnectionError('   \n ')).toBeUndefined();
		});
	});
});
// Source: src/__tests__/shared/directorNotesGrouping.test.ts
describe('', () => {
	const CORE_LOOKUP = buildNarrativeGroupLookup([
		{ agent: 'Maestro', group: 'Maestro Core', emoji: '🎬' },
		{ agent: 'rc', group: 'Maestro Core', emoji: '🎬' },
		{ agent: 'acappella', group: 'Voice' },
		// Ungrouped agents are legal input and simply never match.
		{ agent: 'scratch' },
	]);
	const item = (text: string, agent?: string): NarrativeItem =>
		agent ? { text, agent } : { text };
	describe('bucketNarrativeItems', () => {
		it('collapses agents that share a group into one bucket', () => {
			const buckets = bucketNarrativeItems(
				[item('a', 'Maestro'), item('b', 'rc'), item('c', 'acappella')],
				CORE_LOOKUP
			);
			expect(buckets).toHaveLength(2);
			expect(buckets[0]).toMatchObject({ label: 'Maestro Core', emoji: '🎬', isGroup: true });
			expect(buckets[0].items.map((i) => i.text)).toEqual(['a', 'b']);
			expect(buckets[1]).toMatchObject({ label: 'Voice', isGroup: true });
		});
		it('buckets an agent with no group under its own name', () => {
			const buckets = bucketNarrativeItems(
				[item('a', 'scratch'), item('b', 'scratch')],
				CORE_LOOKUP
			);
			expect(buckets).toHaveLength(1);
			expect(buckets[0]).toMatchObject({ label: 'scratch', isGroup: false, isUnattributed: false });
		});
		it('buckets by agent when no lookup is supplied at all', () => {
			const buckets = bucketNarrativeItems([item('a', 'Maestro'), item('b', 'rc')]);
			expect(buckets.map((b) => b.label)).toEqual(['Maestro', 'rc']);
			expect(buckets.every((b) => !b.isGroup)).toBe(true);
		});
		it('preserves first-appearance order but sinks the unattributed bucket last', () => {
			const buckets = bucketNarrativeItems(
				[item('a'), item('b', 'acappella'), item('c', 'Maestro'), item('d')],
				CORE_LOOKUP
			);
			expect(buckets.map((b) => b.label)).toEqual([
				'Voice',
				'Maestro Core',
				UNATTRIBUTED_BUCKET_LABEL,
			]);
			expect(buckets[2].isUnattributed).toBe(true);
			expect(buckets[2].items.map((i) => i.text)).toEqual(['a', 'd']);
		});
		it('treats a blank agent string the same as no agent', () => {
			// An empty label would render as a headerless bucket that reads as a
			// rendering fault rather than as "unattributed".
			const buckets = bucketNarrativeItems([{ text: 'a', agent: '   ' }], CORE_LOOKUP);
			expect(buckets[0].label).toBe(UNATTRIBUTED_BUCKET_LABEL);
			expect(buckets[0].isUnattributed).toBe(true);
		});
		it('matches an agent name through case and stripped punctuation', () => {
			// The manifest hands the model a sanitized display name, so what comes
			// back rarely matches the stored name byte for byte.
			const buckets = bucketNarrativeItems(
				[item('a', '  MAESTRO  '), item('b', '*rc*')],
				CORE_LOOKUP
			);
			expect(buckets).toHaveLength(1);
			expect(buckets[0].label).toBe('Maestro Core');
		});
		it('returns nothing for an empty section', () => {
			expect(bucketNarrativeItems([], CORE_LOOKUP)).toEqual([]);
		});
	});
	describe('shouldRenderBuckets', () => {
		it('is false when every bullet shares one owner', () => {
			expect(shouldRenderBuckets(bucketNarrativeItems([item('a', 'rc')], CORE_LOOKUP))).toBe(false);
		});
		it('is true once a section spans two owners', () => {
			expect(
				shouldRenderBuckets(bucketNarrativeItems([item('a', 'rc'), item('b')], CORE_LOOKUP))
			).toBe(true);
		});
	});
	describe('buildNarrativeGroupLookup', () => {
		it('resolves null for an unknown or ungrouped agent', () => {
			expect(CORE_LOOKUP('nobody')).toBeNull();
			expect(CORE_LOOKUP('scratch')).toBeNull();
		});
		it('ignores a blank group name', () => {
			const lookup = buildNarrativeGroupLookup([{ agent: 'a', group: '   ' }]);
			expect(lookup('a')).toBeNull();
		});
	});
	describe('normalizeAgentKey', () => {
		it('folds case, collapses whitespace, and strips markdown punctuation', () => {
			expect(normalizeAgentKey('  **Maestro   Cue**  Main ')).toBe('maestro cue main');
		});
	});
});
// Source: src/__tests__/shared/colorContrast.test.ts
describe('', () => {
	describe('colorContrast', () => {
		describe('hexToRgb', () => {
			it('parses 6-digit hex with and without the leading hash', () => {
				expect(hexToRgb('#ff8000')).toEqual({ r: 255, g: 128, b: 0 });
				expect(hexToRgb('ff8000')).toEqual({ r: 255, g: 128, b: 0 });
			});
			it('returns null for forms it cannot measure', () => {
				expect(hexToRgb('#fff')).toBeNull();
				expect(hexToRgb('rgb(255, 128, 0)')).toBeNull();
				expect(hexToRgb('rebeccapurple')).toBeNull();
			});
		});
		describe('relativeLuminance', () => {
			it('anchors black at 0 and white at 1', () => {
				expect(relativeLuminance('#000000')).toBe(0);
				expect(relativeLuminance('#ffffff')).toBe(1);
			});
			it('returns null for unparseable colors', () => {
				expect(relativeLuminance('not-a-color')).toBeNull();
			});
		});
		describe('contrastRatio', () => {
			it('reports 21:1 for black on white and 1:1 for a color on itself', () => {
				expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
				expect(contrastRatio('#bd93f9', '#bd93f9')).toBeCloseTo(1, 5);
			});
			it('is symmetric', () => {
				expect(contrastRatio('#282a36', '#f8f8f2')).toBeCloseTo(
					contrastRatio('#f8f8f2', '#282a36'),
					10
				);
			});
			it('treats an unmeasurable color as passing rather than guessing', () => {
				// A custom theme may ship rgb()/hsl()/named colors. We must not
				// "correct" a color we cannot actually evaluate.
				expect(contrastRatio('var(--whatever)', '#000000')).toBe(21);
			});
		});
		describe('adjustBrightness / blendColors / transparentize', () => {
			it('clamps at both ends of the channel range', () => {
				expect(adjustBrightness('#ffffff', 50)).toBe('#ffffff');
				expect(adjustBrightness('#000000', -50)).toBe('#000000');
			});
			it('leaves unparseable colors untouched', () => {
				expect(adjustBrightness('teal', 20)).toBe('teal');
				expect(blendColors('teal', '#ffffff', 0.5)).toBe('teal');
			});
			it('blends toward the second color by ratio', () => {
				expect(blendColors('#000000', '#ffffff', 0)).toBe('#000000');
				expect(blendColors('#000000', '#ffffff', 1)).toBe('#ffffff');
				expect(blendColors('#000000', '#ffffff', 0.5)).toBe('#808080');
			});
			it('flattens a tint over a background', () => {
				// 20% white over black is the same as blending black -> white at 0.2.
				expect(transparentize('#ffffff', '#000000', 0.2)).toBe(
					blendColors('#000000', '#ffffff', 0.2)
				);
			});
		});
		describe('cssColorToHex', () => {
			it('normalizes the hex forms to #rrggbb', () => {
				expect(cssColorToHex('#F9E79F')).toBe('#f9e79f');
				expect(cssColorToHex('#fe9')).toBe('#ffee99');
				expect(cssColorToHex('#f9e79fff')).toBe('#f9e79f');
			});
			it('reads what getComputedStyle reports, in comma and space syntax', () => {
				expect(cssColorToHex('rgb(249, 231, 159)')).toBe('#f9e79f');
				expect(cssColorToHex('rgb(249 231 159)')).toBe('#f9e79f');
				expect(cssColorToHex('rgba(249, 231, 159, 1)')).toBe('#f9e79f');
				expect(cssColorToHex('rgb(249 231 159 / 100%)')).toBe('#f9e79f');
			});
			it('refuses translucent colors, whose effective color depends on the backdrop', () => {
				expect(cssColorToHex('rgba(0, 0, 0, 0)')).toBeNull();
				expect(cssColorToHex('rgba(249, 231, 159, 0.5)')).toBeNull();
				expect(cssColorToHex('#f9e79f80')).toBeNull();
			});
			it('refuses everything it cannot measure', () => {
				for (const value of ['none', 'url(#grad)', 'red', 'hsl(0, 0%, 0%)', '', undefined, null]) {
					expect(cssColorToHex(value)).toBeNull();
				}
			});
		});
		describe('readableTextOn', () => {
			it('returns the preferred color untouched when it already clears AA', () => {
				// Dracula foreground on Dracula background.
				expect(readableTextOn('#f8f8f2', ['#282a36'])).toBe('#f8f8f2');
			});
			it('is a no-op when there are no backgrounds to measure against', () => {
				expect(readableTextOn('#808080', [])).toBe('#808080');
			});
			it('rescues text placed on a near-identical background', () => {
				// The reported bug: near-white text on a near-white fill.
				const rescued = readableTextOn('#f8f8f2', ['#f2f2f2']);
				expect(contrastRatio(rescued, '#f2f2f2')).toBeGreaterThanOrEqual(AA_CONTRAST);
			});
			it('clears AA against every background, not just the first', () => {
				const backgrounds = ['#282a36', '#3a3f52', '#4a4f66'];
				const fg = readableTextOn('#6272a4', backgrounds);
				expect(isReadableOn(fg, backgrounds)).toBe(true);
			});
			it('nudges the theme color instead of snapping to pure black or white', () => {
				const rescued = readableTextOn('#839496', ['#7a8a8a']);
				expect(rescued).not.toBe('#ffffff');
				expect(rescued).not.toBe('#000000');
				expect(contrastRatio(rescued, '#7a8a8a')).toBeGreaterThanOrEqual(AA_CONTRAST);
			});
			it('falls back to the better endpoint when backgrounds span both extremes', () => {
				// No single color can clear AA against both near-black and near-white.
				const fg = readableTextOn('#808080', ['#111111', '#eeeeee']);
				expect(['#ffffff', '#000000']).toContain(fg);
			});
			it('honors a custom threshold', () => {
				// Large-text AA (3:1) accepts a pairing that normal-text AA rejects.
				const bg = '#8a8a8a';
				const preferred = '#ffffff';
				expect(contrastRatio(preferred, bg)).toBeGreaterThan(AA_LARGE_CONTRAST);
				expect(contrastRatio(preferred, bg)).toBeLessThan(AA_CONTRAST);
				expect(readableTextOn(preferred, [bg], AA_LARGE_CONTRAST)).toBe(preferred);
				expect(readableTextOn(preferred, [bg])).not.toBe(preferred);
			});
		});
	});
});
// Source: src/__tests__/shared/groupChatActivity.test.ts
describe('', () => {
	const T0 = 1700000000000;
	function entry(overrides: Partial<GroupChatHistoryEntry> = {}): GroupChatHistoryEntry {
		return {
			id: `e${Math.round(overrides.timestamp ?? 0)}`,
			timestamp: T0,
			summary: 'did a thing',
			participantName: 'rc',
			participantColor: '#fff',
			type: 'response',
			...overrides,
		};
	}
	const MIN = 60000;
	describe('computeGroupChatActivity', () => {
		it('reports zeros for an empty history', () => {
			const totals = computeGroupChatActivity([]);
			expect(totals.workingTimeMs).toBe(0);
			expect(totals.totalTurns).toBe(0);
			expect(totals.turnsWithTokens).toBe(0);
		});
		it('measures a single turn by its own duration, not by its timestamp', () => {
			const totals = computeGroupChatActivity([
				entry({ timestamp: T0 + 10 * MIN, elapsedTimeMs: 3 * MIN }),
			]);
			expect(totals.workingTimeMs).toBe(3 * MIN);
			expect(totals.measuredTurns).toBe(1);
		});
		it('collapses parallel turns instead of summing them', () => {
			// Three agents each work the same 10 minutes. That is ten minutes of
			// chat time, not thirty.
			const totals = computeGroupChatActivity([
				entry({ participantName: 'a', timestamp: T0 + 10 * MIN, elapsedTimeMs: 10 * MIN }),
				entry({ participantName: 'b', timestamp: T0 + 10 * MIN, elapsedTimeMs: 10 * MIN }),
				entry({ participantName: 'c', timestamp: T0 + 10 * MIN, elapsedTimeMs: 10 * MIN }),
			]);
			expect(totals.workingTimeMs).toBe(10 * MIN);
		});
		it('excludes an idle gap between two work blocks', () => {
			const dayLater = T0 + 24 * 60 * MIN;
			const totals = computeGroupChatActivity([
				entry({ timestamp: T0, elapsedTimeMs: 2 * MIN }),
				entry({ timestamp: dayLater, elapsedTimeMs: 2 * MIN }),
			]);
			expect(totals.workingTimeMs).toBe(4 * MIN);
		});
		it('stitches turns that land closer together than the idle gap', () => {
			// Untimed turns are points. Without stitching a whole chat reports 0m.
			const totals = computeGroupChatActivity([
				entry({ timestamp: T0 }),
				entry({ timestamp: T0 + 1 * MIN }),
				entry({ timestamp: T0 + 2 * MIN }),
			]);
			expect(totals.workingTimeMs).toBe(2 * MIN);
			expect(totals.measuredTurns).toBe(0);
			expect(totals.totalTurns).toBe(3);
		});
		it('splits blocks when the gap exceeds the stitch window', () => {
			const gap = GROUP_CHAT_ACTIVITY_STITCH_MS + MIN;
			const totals = computeGroupChatActivity([
				entry({ timestamp: T0 }),
				entry({ timestamp: T0 + MIN }),
				entry({ timestamp: T0 + MIN + gap }),
			]);
			expect(totals.workingTimeMs).toBe(MIN);
		});
		it('sorts entries itself, since the history log reads newest first', () => {
			const newestFirst = [
				entry({ timestamp: T0 + 4 * MIN, elapsedTimeMs: MIN }),
				entry({ timestamp: T0 + 2 * MIN, elapsedTimeMs: MIN }),
			];
			expect(computeGroupChatActivity(newestFirst).workingTimeMs).toBe(3 * MIN);
		});
		it('ignores a negative or missing duration rather than shrinking the union', () => {
			const totals = computeGroupChatActivity([
				entry({ timestamp: T0 + 5 * MIN, elapsedTimeMs: -1000 }),
				entry({ timestamp: T0 + 6 * MIN }),
			]);
			expect(totals.workingTimeMs).toBe(MIN);
			expect(totals.measuredTurns).toBe(0);
		});
		it('sums tokens and cost only from turns that reported them', () => {
			const totals = computeGroupChatActivity([
				entry({ timestamp: T0, tokenCount: 1000, cost: 0.25 }),
				entry({ timestamp: T0 + MIN, tokenCount: 500 }),
				entry({ timestamp: T0 + 2 * MIN }),
			]);
			expect(totals.tokenCount).toBe(1500);
			expect(totals.turnsWithTokens).toBe(2);
			expect(totals.costUsd).toBeCloseTo(0.25);
			expect(totals.turnsWithCost).toBe(1);
			expect(totals.totalTurns).toBe(3);
		});
		it('reports no token coverage when nothing recorded usage', () => {
			const totals = computeGroupChatActivity([entry({ timestamp: T0 }), entry({ timestamp: T0 })]);
			expect(totals.turnsWithTokens).toBe(0);
			expect(totals.tokenCount).toBe(0);
		});
	});
});
// Source: src/__tests__/shared/toastClickAction.test.ts
describe('', () => {
	describe('parseToastClickAction', () => {
		it('returns nothing for an absent action', () => {
			expect(parseToastClickAction(undefined)).toEqual({});
			expect(parseToastClickAction(null)).toEqual({});
		});
		it('rejects a non-object', () => {
			expect(parseToastClickAction('jump-session').error).toBe('clickAction must be an object');
		});
		it('rejects an unknown kind and lists the valid ones', () => {
			const { error } = parseToastClickAction({ kind: 'open-modal' });
			expect(error).toContain('Invalid clickAction kind: open-modal');
			for (const kind of TOAST_CLICK_ACTION_KINDS) {
				expect(error).toContain(kind);
			}
		});
		describe('jump-session', () => {
			it('accepts a sessionId with an optional tabId', () => {
				expect(parseToastClickAction({ kind: 'jump-session', sessionId: 's1' }).action).toEqual({
					kind: 'jump-session',
					sessionId: 's1',
					tabId: undefined,
				});
				expect(
					parseToastClickAction({ kind: 'jump-session', sessionId: 's1', tabId: 't1' }).action
				).toEqual({ kind: 'jump-session', sessionId: 's1', tabId: 't1' });
			});
			it('requires sessionId', () => {
				expect(parseToastClickAction({ kind: 'jump-session' }).error).toContain(
					'requires sessionId'
				);
				expect(parseToastClickAction({ kind: 'jump-session', sessionId: '' }).error).toContain(
					'requires sessionId'
				);
			});
		});
		describe('open-file', () => {
			it('accepts a sessionId and path', () => {
				expect(
					parseToastClickAction({ kind: 'open-file', sessionId: 's1', path: '/tmp/a.ts' }).action
				).toEqual({ kind: 'open-file', sessionId: 's1', path: '/tmp/a.ts' });
			});
			it('requires both sessionId and path', () => {
				expect(parseToastClickAction({ kind: 'open-file', path: '/tmp/a.ts' }).error).toContain(
					'requires sessionId'
				);
				expect(parseToastClickAction({ kind: 'open-file', sessionId: 's1' }).error).toContain(
					'requires path'
				);
			});
		});
		describe('open-terminal', () => {
			it('accepts a bare agent target (active terminal tab)', () => {
				expect(parseToastClickAction({ kind: 'open-terminal', sessionId: 's1' }).action).toEqual({
					kind: 'open-terminal',
					sessionId: 's1',
					tabRef: undefined,
				});
			});
			it('accepts a tab ref', () => {
				expect(
					parseToastClickAction({
						kind: 'open-terminal',
						sessionId: 's1',
						tabRef: 'Dev server',
					}).action
				).toEqual({ kind: 'open-terminal', sessionId: 's1', tabRef: 'Dev server' });
			});
			it('requires sessionId', () => {
				expect(parseToastClickAction({ kind: 'open-terminal' }).error).toContain(
					'requires sessionId'
				);
			});
		});
		describe('open-browser', () => {
			it('accepts a url', () => {
				expect(
					parseToastClickAction({ kind: 'open-browser', sessionId: 's1', url: 'https://a.dev' })
						.action
				).toEqual({
					kind: 'open-browser',
					sessionId: 's1',
					url: 'https://a.dev',
					tabId: undefined,
				});
			});
			it('accepts a tabId', () => {
				expect(
					parseToastClickAction({ kind: 'open-browser', sessionId: 's1', tabId: 'b1' }).action
				).toEqual({ kind: 'open-browser', sessionId: 's1', tabId: 'b1', url: undefined });
			});
			it('requires sessionId, and one of tabId / url', () => {
				expect(
					parseToastClickAction({ kind: 'open-browser', url: 'https://a.dev' }).error
				).toContain('requires sessionId');
				expect(parseToastClickAction({ kind: 'open-browser', sessionId: 's1' }).error).toContain(
					'requires tabId or url'
				);
			});
		});
		describe('open-url', () => {
			it('accepts a url', () => {
				expect(parseToastClickAction({ kind: 'open-url', url: 'https://a.dev' }).action).toEqual({
					kind: 'open-url',
					url: 'https://a.dev',
				});
			});
			it('requires url', () => {
				expect(parseToastClickAction({ kind: 'open-url' }).error).toContain('requires url');
			});
		});
	});
});
// Source: src/__tests__/shared/typographySnapshot.test.ts
describe('', () => {
	const LIVE = {
		fontFamily: 'Inter',
		terminalFontFamily: 'JetBrains Mono',
		chatFontFamily: '',
		filePreviewFontFamily: INHERIT_TERMINAL,
		fileEditorFontFamily: 'Fira Code',
		documentGraphFontFamily: '',
		fontSize: 15,
		terminalFontSize: 13,
		chatFontSize: 0,
		filePreviewFontSize: 0,
		fileEditorFontSize: 12,
		documentGraphFontSize: 0,
	};
	describe('captureTypographySnapshot', () => {
		it('captures every registered surface, so a new surface cannot be silently dropped', () => {
			const snapshot = captureTypographySnapshot(LIVE, 1000);
			expect(snapshot.savedAt).toBe(1000);
			for (const spec of TYPOGRAPHY_SURFACE_LIST) {
				expect(snapshot.fonts).toHaveProperty(spec.fontKey);
				expect(snapshot.sizes).toHaveProperty(spec.sizeKey);
			}
		});
		it('preserves the inherit sentinels rather than resolving them', () => {
			const snapshot = captureTypographySnapshot(LIVE);
			expect(snapshot.fonts.chatFontFamily).toBe('');
			expect(snapshot.fonts.filePreviewFontFamily).toBe(INHERIT_TERMINAL);
			expect(snapshot.sizes.chatFontSize).toBe(0);
		});
		it('never captures a zero interface size, which would mean "inherit from myself"', () => {
			const snapshot = captureTypographySnapshot({ ...LIVE, fontSize: 0 });
			expect(snapshot.sizes.fontSize).toBe(14);
		});
		it('round-trips through the restore patch unchanged', () => {
			const snapshot = captureTypographySnapshot(LIVE);
			expect(typographySnapshotPatch(snapshot)).toMatchObject({
				fontFamily: 'Inter',
				terminalFontFamily: 'JetBrains Mono',
				filePreviewFontFamily: INHERIT_TERMINAL,
				fontSize: 15,
				fileEditorFontSize: 12,
			});
			expect(typographySnapshotMatches(snapshot, LIVE)).toBe(true);
		});
	});
	describe('parseTypographySnapshot', () => {
		it('rejects values that are not a snapshot', () => {
			expect(parseTypographySnapshot(null)).toBeNull();
			expect(parseTypographySnapshot('hacker')).toBeNull();
			expect(parseTypographySnapshot({})).toBeNull();
			expect(parseTypographySnapshot({ fonts: {}, sizes: {} })).toBeNull();
		});
		it('drops unknown keys and non-string families a hand-edited file could carry', () => {
			const parsed = parseTypographySnapshot({
				savedAt: 5,
				fonts: { fontFamily: 'Inter', bogusFontFamily: 'Nope', terminalFontFamily: 42 },
				sizes: { fontSize: 15, bogusFontSize: 9, chatFontSize: 'big' },
			});
			expect(parsed).toEqual({
				savedAt: 5,
				fonts: { fontFamily: 'Inter' },
				sizes: { fontSize: 15 },
			});
		});
		it('defaults a missing savedAt rather than rejecting an otherwise usable save', () => {
			const parsed = parseTypographySnapshot({ fonts: { fontFamily: 'Inter' }, sizes: {} });
			expect(parsed?.savedAt).toBe(0);
			expect(parsed?.fonts.fontFamily).toBe('Inter');
		});
	});
	describe('typographySnapshotPatch', () => {
		it('writes only the surfaces the save knows about', () => {
			// A snapshot taken before the document graph surface existed must not
			// blank that surface's font on restore.
			const parsed = parseTypographySnapshot({
				savedAt: 1,
				fonts: { fontFamily: 'Inter' },
				sizes: { fontSize: 15 },
			});
			expect(typographySnapshotPatch(parsed!)).toEqual({ fontFamily: 'Inter', fontSize: 15 });
		});
		it('clamps a size that was persisted out of range', () => {
			const parsed = parseTypographySnapshot({
				savedAt: 1,
				fonts: { fontFamily: 'Inter' },
				sizes: { fontSize: 999, chatFontSize: 999 },
			});
			expect(typographySnapshotPatch(parsed!)).toMatchObject({
				fontSize: 32,
				chatFontSize: 32,
			});
		});
	});
	describe('typographySnapshotMatches', () => {
		it('is false with nothing saved', () => {
			expect(typographySnapshotMatches(null, LIVE)).toBe(false);
		});
		it('notices a single changed family or size', () => {
			const snapshot = captureTypographySnapshot(LIVE);
			expect(typographySnapshotMatches(snapshot, { ...LIVE, chatFontFamily: 'Georgia' })).toBe(
				false
			);
			expect(typographySnapshotMatches(snapshot, { ...LIVE, fileEditorFontSize: 13 })).toBe(false);
		});
		it('ignores settings the snapshot does not cover, such as zoom', () => {
			const snapshot = captureTypographySnapshot(LIVE);
			expect(typographySnapshotMatches(snapshot, { ...LIVE, fontZoom: 1.4 })).toBe(true);
		});
	});
});
// Source: src/__tests__/shared/fontStack.test.ts
describe('', () => {
	describe('withMonoFallback', () => {
		it('appends the monospace fallback chain to a bare font name', () => {
			// The font picker stores bare names like "Roboto Mono" with no generic
			// family, which resolve to serif on iOS. The tail must end in monospace.
			const result = withMonoFallback('Roboto Mono');
			expect(result).toBe(`Roboto Mono, ${MONO_FALLBACK_STACK}`);
			expect(result.endsWith('monospace')).toBe(true);
		});
		it('leaves a value that already ends in a generic family unchanged', () => {
			const value = 'Roboto Mono, Menlo, "Courier New", monospace';
			expect(withMonoFallback(value)).toBe(value);
		});
		it('does not append when a non-monospace generic is present', () => {
			const value = 'Comic Sans MS, sans-serif';
			expect(withMonoFallback(value)).toBe(value);
		});
		it('returns the fallback stack for empty, whitespace, null, and undefined', () => {
			expect(withMonoFallback('')).toBe(MONO_FALLBACK_STACK);
			expect(withMonoFallback('   ')).toBe(MONO_FALLBACK_STACK);
			expect(withMonoFallback(null)).toBe(MONO_FALLBACK_STACK);
			expect(withMonoFallback(undefined)).toBe(MONO_FALLBACK_STACK);
		});
		it('trims surrounding whitespace before wrapping a bare name', () => {
			expect(withMonoFallback('  JetBrains Mono  ')).toBe(`JetBrains Mono, ${MONO_FALLBACK_STACK}`);
		});
		it('matches "monospace" only as a whole word, not as a substring', () => {
			// A hypothetical family whose name merely contains the substring should
			// still get a real generic fallback appended.
			const result = withMonoFallback('Monospacewannabe');
			expect(result).toBe(`Monospacewannabe, ${MONO_FALLBACK_STACK}`);
		});
	});
	describe('resolveSurfaceFont', () => {
		const INTERFACE = 'Roboto Mono';
		it('falls back to the interface font when the surface has no font of its own', () => {
			// Empty is the stored value for "Same as interface font", so every surface
			// keeps following the UI until the user picks something for it.
			expect(resolveSurfaceFont('', INTERFACE)).toBe(`${INTERFACE}, ${MONO_FALLBACK_STACK}`);
			expect(resolveSurfaceFont(undefined, INTERFACE)).toBe(`${INTERFACE}, ${MONO_FALLBACK_STACK}`);
			expect(resolveSurfaceFont(null, INTERFACE)).toBe(`${INTERFACE}, ${MONO_FALLBACK_STACK}`);
		});
		it('treats a whitespace-only surface font as unset', () => {
			// A blank family resolves to nothing and drops the pane to the browser
			// default, so it must reach the interface font rather than be applied.
			expect(resolveSurfaceFont('   ', INTERFACE)).toBe(`${INTERFACE}, ${MONO_FALLBACK_STACK}`);
		});
		it('prefers the surface font over the interface font', () => {
			expect(resolveSurfaceFont('Verdana', INTERFACE)).toBe(`Verdana, ${MONO_FALLBACK_STACK}`);
		});
		it('still guarantees a generic fallback when neither is set', () => {
			expect(resolveSurfaceFont('', '')).toBe(MONO_FALLBACK_STACK);
		});
	});
	describe('displayFontLabel', () => {
		it('reduces a full CSS stack to its leading family', () => {
			// The Default typography preset stores a whole fallback chain, and the
			// picker rendered every comma-separated entry as the font's name.
			expect(displayFontLabel(DEFAULT_INTERFACE_FONT)).toBe('Inter');
			expect(displayFontLabel('Roboto Mono, Menlo, "Courier New", monospace')).toBe('Roboto Mono');
		});
		it('strips the quotes a CSS stack puts around a multi-word family', () => {
			expect(displayFontLabel('"Segoe UI", Roboto, sans-serif')).toBe('Segoe UI');
			expect(displayFontLabel("'JetBrains Mono', 'Fira Code', monospace")).toBe('JetBrains Mono');
		});
		it('leaves a bare font name alone', () => {
			// The picker and the custom-font input both store bare names, which are
			// already the label.
			expect(displayFontLabel('Berkeley Mono')).toBe('Berkeley Mono');
			expect(displayFontLabel('  Berkeley Mono  ')).toBe('Berkeley Mono');
		});
		it('returns an empty string for empty, whitespace, null, and undefined', () => {
			// Empty is the stored value for "inherit", which the picker labels with
			// its own inherit option rather than this.
			expect(displayFontLabel('')).toBe('');
			expect(displayFontLabel('   ')).toBe('');
			expect(displayFontLabel(null)).toBe('');
			expect(displayFontLabel(undefined)).toBe('');
		});
		it('leaves an unbalanced quote in place rather than half-trimming it', () => {
			expect(displayFontLabel('"Segoe UI, Roboto')).toBe('"Segoe UI');
		});
	});
});
