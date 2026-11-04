// Consolidated from current rc sources; per-source hooks and state stay in an unnamed suite.
// Source: src/__tests__/shared/groupAppearance.test.ts
// Source: src/__tests__/shared/showcaseSeed.test.ts
// Source: src/__tests__/shared/providerAuthIdentity.test.ts
// Source: src/__tests__/shared/snoozeCommands.test.ts
// Source: src/__tests__/shared/claudeAccountIdentity.test.ts
// Source: src/__tests__/shared/toastWidth.test.ts
// Source: src/__tests__/shared/platformDetection.test.ts
// Source: src/__tests__/shared/cue-path-utils.test.ts
// Source: src/__tests__/shared/parkedRecords.test.ts
// Source: src/__tests__/shared/theme-types.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import {
	GROUP_ICON_CATALOG,
	GROUP_ICON_IDS,
	GROUP_LABEL_COLORS,
	normalizeGroupColor,
	normalizeGroupIconId,
	validateGroupAppearance,
	validateGroupUpdate,
} from '../../shared/groupAppearance';
import { readFileSync } from 'node:fs';
import s2_path from 'node:path';
import {
	providerAuthKey,
	classifyCredentialKind,
	credentialKindBlocksLogin,
} from '../../shared/providerAuthIdentity';
import {
	SNOOZE_COMMAND_ACTIONS,
	isSnoozeCommandAction,
	normalizeSnoozeCommandResult,
	parseSnoozeCommandRequest,
} from '../../shared/snoozeCommands';
import {
	accountIdentityFingerprint,
	groupAccountKeysByIdentity,
	parseClaudeAccountIdentity,
} from '../../shared/claudeAccountIdentity';
import {
	TOAST_VIEWPORT_GUTTER,
	TOAST_WIDTHS,
	TOAST_WIDTH_DIMENSIONS,
	TOAST_WIDTH_LABELS,
	describeToastWidth,
	getToastWidthDimensions,
	isToastWidth,
	type StaticToastWidth,
	type ToastWidth,
} from '../../shared/toastWidth';
import { isWindows, isMacOS, isLinux, getWhichCommand } from '../../shared/platformDetection';
import * as fs from 'fs';
import * as s8_path from 'path';
import { computeCommonAncestorPath, isDescendantOrEqual } from '../../shared/cue-path-utils';
import {
	parkedPairKeys,
	setKeysParked,
	splitParkedEntries,
	type ParkedRecordPair,
} from '../../shared/parkedRecords';
import {
	isValidThemeId,
	resolveThemeId,
	RETIRED_THEME_IDS,
	type ThemeId,
} from '../../shared/theme-types';
import { THEMES } from '../../shared/themes';
// Source: src/__tests__/shared/groupAppearance.test.ts
describe('', () => {
	describe('group appearance catalog', () => {
		it('exposes the documented built-in icon ids', () => {
			expect(GROUP_ICON_IDS).toEqual([
				'folder',
				'briefcase',
				'rocket',
				'code',
				'star',
				'heart',
				'lightbulb',
				'target',
				'calendar',
				'book',
				'layers',
				'shield',
				'wrench',
				'palette',
				'archive',
				'zap',
			]);
		});
		it('labels every icon', () => {
			expect(GROUP_ICON_CATALOG.every((entry) => entry.label.length > 0)).toBe(true);
		});
		it('stores every built-in color as an uppercase hex value', () => {
			for (const color of GROUP_LABEL_COLORS) {
				expect(color.value).toMatch(/^#[0-9A-F]{6}$/);
			}
		});
	});
	describe('normalizeGroupIconId', () => {
		it('accepts a built-in id regardless of case or padding', () => {
			expect(normalizeGroupIconId('  Rocket ')).toBe('rocket');
		});
		it('accepts a plugin-namespaced id', () => {
			expect(normalizeGroupIconId('my-plugin/my-pack/my-icon')).toBe('my-plugin/my-pack/my-icon');
		});
		it('rejects an unknown bare id', () => {
			expect(normalizeGroupIconId('sparkle-pony')).toBeNull();
		});
		it('rejects a namespaced id with an empty segment', () => {
			expect(normalizeGroupIconId('my-plugin//my-icon')).toBeNull();
		});
		it('rejects an empty string', () => {
			expect(normalizeGroupIconId('   ')).toBeNull();
		});
	});
	describe('normalizeGroupColor', () => {
		it('uppercases a hex value', () => {
			expect(normalizeGroupColor('#ef4444')).toBe('#EF4444');
		});
		it('accepts a plugin-namespaced color id', () => {
			expect(normalizeGroupColor('my-plugin/my-pack/brand')).toBe('my-plugin/my-pack/brand');
		});
		it('rejects a three-digit hex value', () => {
			expect(normalizeGroupColor('#f44')).toBeNull();
		});
		it('rejects a CSS color name', () => {
			expect(normalizeGroupColor('red')).toBeNull();
		});
	});
	describe('validateGroupAppearance', () => {
		it('returns only the supplied fields', () => {
			const result = validateGroupAppearance({ icon: 'star' });
			expect(result).toEqual({ ok: true, value: { icon: 'star' } });
		});
		it('rejects emoji and icon together', () => {
			const result = validateGroupAppearance({ emoji: '🚀', icon: 'rocket' });
			expect(result.ok).toBe(false);
		});
		it('allows a color alongside an emoji', () => {
			const result = validateGroupAppearance({ emoji: '🚀', color: '#22c55e' });
			expect(result).toEqual({ ok: true, value: { emoji: '🚀', color: '#22C55E' } });
		});
		it('allows a color alongside an icon', () => {
			const result = validateGroupAppearance({ icon: 'shield', color: '#22c55e' });
			expect(result).toEqual({ ok: true, value: { icon: 'shield', color: '#22C55E' } });
		});
		it('names the offending value in an icon error', () => {
			const result = validateGroupAppearance({ icon: 'nope' });
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error).toContain('"nope"');
		});
	});
	describe('validateGroupUpdate', () => {
		it('rejects an update with nothing in it', () => {
			const result = validateGroupUpdate({});
			expect(result).toEqual({ ok: false, error: 'Nothing to update' });
		});
		it('rejects setting and clearing the same field', () => {
			const result = validateGroupUpdate({ icon: 'star', clear: ['icon'] });
			expect(result).toEqual({ ok: false, error: 'Cannot both set and clear icon' });
		});
		it('allows clearing an emoji while setting an icon', () => {
			const result = validateGroupUpdate({ icon: 'star', clear: ['emoji'] });
			expect(result).toEqual({ ok: true, value: { icon: 'star', clear: ['emoji'] } });
		});
		it('rejects an explicitly empty name', () => {
			const result = validateGroupUpdate({ name: '   ' });
			expect(result).toEqual({ ok: false, error: 'Group name must not be empty' });
		});
		it('rejects an explicitly empty parent', () => {
			const result = validateGroupUpdate({ parentGroupId: '' });
			expect(result).toEqual({ ok: false, error: 'Parent group ID must not be empty' });
		});
		it('rejects an unknown clear target', () => {
			const result = validateGroupUpdate({ clear: ['collapsed' as never] });
			expect(result.ok).toBe(false);
		});
		it('normalizes appearance values it passes through', () => {
			const result = validateGroupUpdate({ icon: 'Rocket', color: '#a855f7' });
			expect(result).toEqual({ ok: true, value: { icon: 'rocket', color: '#A855F7' } });
		});
		it('trims a name but leaves its case to the desktop', () => {
			const result = validateGroupUpdate({ name: '  Team Alpha  ' });
			expect(result).toEqual({ ok: true, value: { name: 'Team Alpha' } });
		});
		it('carries a clear-parent request through', () => {
			const result = validateGroupUpdate({ clear: ['parent'] });
			expect(result).toEqual({ ok: true, value: { clear: ['parent'] } });
		});
		it('carries a hide request through on its own', () => {
			expect(validateGroupUpdate({ hidden: true })).toEqual({
				ok: true,
				value: { hidden: true },
			});
		});
		// `false` is a real instruction (show the group), not an absent field, so it
		// must not be mistaken for an update that changes nothing.
		it('treats showing a group as a change', () => {
			expect(validateGroupUpdate({ hidden: false })).toEqual({
				ok: true,
				value: { hidden: false },
			});
		});
		it('rejects a hidden value that is not a boolean', () => {
			const result = validateGroupUpdate({ hidden: 'yes' as never });
			expect(result).toEqual({ ok: false, error: 'hidden must be true or false' });
		});
	});
});
// Source: src/__tests__/shared/showcaseSeed.test.ts
describe('', () => {
	const REPO_ROOT = s2_path.join(__dirname, '../../..');
	const SEED_DIR = s2_path.join(REPO_ROOT, 'scripts/showcase/seed/data');
	const SESSIONS_SEED = s2_path.join(SEED_DIR, 'maestro-sessions.json');
	interface SeedQueueItem {
		id: string;
		timestamp: number;
		tabId: string;
		type: string;
		tabName?: string;
		paused?: boolean;
		text?: string;
		command?: string;
	}
	interface SeedAiTab {
		id: string;
		name?: string;
		hidden?: boolean;
		hasUnread?: boolean;
	}
	interface SeedSession {
		id: string;
		name: string;
		activeTabId?: string;
		executionQueue?: SeedQueueItem[];
		aiTabs?: SeedAiTab[];
	}
	const seedRaw = readFileSync(SESSIONS_SEED, 'utf8');
	const seed = JSON.parse(seedRaw) as {
		sessions: SeedSession[];
		activeSessionId?: string;
	};
	const sessionsWithQueue = seed.sessions.filter((s) => (s.executionQueue ?? []).length > 0);
	const allQueued = seed.sessions.flatMap((s) => s.executionQueue ?? []);
	describe('showcase seed: execution queue', () => {
		it('seeds a queue at all', () => {
			// The Execution Queue shot has nothing to photograph without one.
			expect(allQueued.length).toBeGreaterThan(0);
		});
		it('holds every queued item', () => {
			// All-or-nothing: `nextRunnableQueueItem` returns the first item that is
			// not paused, so a single unheld item is enough to start a real spawn.
			const unheld = allQueued.filter((item) => item.paused !== true);
			expect(unheld.map((item) => `${item.id} (${item.tabName ?? item.tabId})`)).toEqual([]);
		});
		it('spreads the queue across more than one agent', () => {
			// The shot exists to show `Current Agent (n)` against `All Agents (m)`
			// with n !== m. One agent owning everything makes both counts the same
			// number and the surface stops demonstrating anything.
			expect(sessionsWithQueue.length).toBeGreaterThan(1);
			const largest = Math.max(...sessionsWithQueue.map((s) => (s.executionQueue ?? []).length));
			expect(largest).toBeLessThan(allQueued.length);
		});
		it('points every item at a real AI tab on its own agent', () => {
			// A dangling tabId falls back to the snapshotted `tabName`, so the card
			// renders under a label no live tab answers to.
			const dangling: string[] = [];
			for (const session of sessionsWithQueue) {
				const tabIds = new Set((session.aiTabs ?? []).map((tab) => tab.id));
				for (const item of session.executionQueue ?? []) {
					if (!tabIds.has(item.tabId))
						dangling.push(`${session.name}: ${item.id} -> ${item.tabId}`);
				}
			}
			expect(dangling).toEqual([]);
		});
		it('gives every item the body its type is rendered from', () => {
			const malformed = allQueued.filter((item) =>
				item.type === 'command' ? !item.command : !item.text
			);
			expect(malformed.map((item) => `${item.id} (${item.type})`)).toEqual([]);
		});
		it('uses unique item ids', () => {
			const ids = allQueued.map((item) => item.id);
			expect(new Set(ids).size).toBe(ids.length);
		});
	});
	describe('showcase seed: unread tabs', () => {
		const unreadTabs = seed.sessions.flatMap((session) =>
			(session.aiTabs ?? [])
				.filter((tab) => tab.hasUnread === true)
				.map((tab) => ({ session, tab }))
		);
		it('seeds unread somewhere', () => {
			// Session restoration resets `state`, `thinkingStartTime` and
			// `isGeneratingName` but never touches `hasUnread`, which is what makes
			// this the one live-looking marker the rig can stage. With none of it the
			// Left Bar dots, the tab-strip bell and the unread filter all photograph
			// as a product nobody is using.
			expect(unreadTabs.length).toBeGreaterThan(0);
		});
		it('never marks a hidden tab unread', () => {
			// A hidden tab draws no chip, so a badge lit by one can never be cleared:
			// the agent opens, every visible tab is already read, and the dot stays.
			// `hasUnreadVisibleTab` filters these out anyway, so the flag is pure
			// noise here - but it is noise that reads as a real state in review.
			const hidden = unreadTabs.filter(({ tab }) => tab.hidden === true);
			expect(hidden.map(({ session, tab }) => `${session.name}: ${tab.name ?? tab.id}`)).toEqual(
				[]
			);
		});
		it('keeps unread off the tab the shutter is pointed at', () => {
			// The active agent's active tab is rendered before the shutter fires, and
			// rendering it is what clears its unread. Seeding the flag there stages a
			// badge that is gone by the time the image is taken, so the shot silently
			// loses what it was seeded for. Background tabs on the same agent, and
			// the active tab of any OTHER agent, are both safe and both in use here.
			const active = seed.sessions.find((session) => session.id === seed.activeSessionId);
			expect(active).toBeDefined();
			const doomed = (active?.aiTabs ?? []).filter(
				(tab) => tab.hasUnread === true && tab.id === active?.activeTabId
			);
			expect(doomed.map((tab) => tab.name ?? tab.id)).toEqual([]);
		});
	});
	describe('showcase seed: published copy', () => {
		it('contains no em or en dashes', () => {
			// Both the literal characters and the \u escapes JSON.stringify emits for
			// them, since the seed is rewritten by tooling as well as by hand.
			const offenders = [...seedRaw.matchAll(/—|–|\\u201[34]/g)].map((match) => {
				const start = Math.max(0, match.index - 40);
				return seedRaw.slice(start, match.index + 40).replace(/\n/g, ' ');
			});
			expect(offenders).toEqual([]);
		});
	});
});
// Source: src/__tests__/shared/providerAuthIdentity.test.ts
describe('', () => {
	describe('providerAuthKey', () => {
		it('scopes a local agent to its binary alone', () => {
			expect(providerAuthKey('claude-code')).toBe('claude-code');
		});
		// A remote has its own credential store: the same agent can be signed in here
		// and expired there, and fixing one does nothing for the other.
		it('separates the same agent on different hosts', () => {
			expect(providerAuthKey('claude-code', 'remote-a')).not.toBe(
				providerAuthKey('claude-code', 'remote-b')
			);
			expect(providerAuthKey('claude-code', 'remote-a')).not.toBe(providerAuthKey('claude-code'));
		});
		it('treats an absent remote and a null remote as the same local scope', () => {
			expect(providerAuthKey('codex', null)).toBe(providerAuthKey('codex'));
		});
	});
	describe('classifyCredentialKind', () => {
		it('defaults to oauth, which is every provider out of the box', () => {
			expect(classifyCredentialKind('claude-code', {}).kind).toBe('oauth');
			expect(classifyCredentialKind('codex', {}).kind).toBe('oauth');
			expect(classifyCredentialKind('opencode', {}).kind).toBe('oauth');
			expect(classifyCredentialKind('copilot-cli', {}).kind).toBe('oauth');
		});
		it('falls back to oauth for an agent it has no table for', () => {
			expect(classifyCredentialKind('factory-droid', { SOMETHING: 'x' }).kind).toBe('oauth');
		});
		it('names the API-key variable that decided the answer', () => {
			expect(classifyCredentialKind('claude-code', { ANTHROPIC_API_KEY: 'sk-x' })).toMatchObject({
				kind: 'api-key',
				envVarName: 'ANTHROPIC_API_KEY',
			});
		});
		// The gateway token is the more specific of the two, so it wins.
		it('prefers the gateway token over the plain API key', () => {
			expect(
				classifyCredentialKind('claude-code', {
					ANTHROPIC_API_KEY: 'sk-x',
					ANTHROPIC_AUTH_TOKEN: 'gw-x',
				}).envVarName
			).toBe('ANTHROPIC_AUTH_TOKEN');
		});
		// A base URL outranks any token: whatever failed belongs to the operator it
		// points at, and no provider login reaches them.
		it('reads a base-URL override as a gateway even when a token is set', () => {
			expect(
				classifyCredentialKind('claude-code', {
					ANTHROPIC_BASE_URL: 'https://api.z.ai/v1',
					ANTHROPIC_AUTH_TOKEN: 'gw-x',
				})
			).toMatchObject({ kind: 'gateway', label: 'api.z.ai' });
		});
		it('keeps an unparseable base URL rather than dropping the label', () => {
			expect(
				classifyCredentialKind('claude-code', { ANTHROPIC_BASE_URL: 'not a url' })
			).toMatchObject({ kind: 'gateway', label: 'not a url' });
		});
		// Bedrock and Vertex ignore the config dir AND the Anthropic vars, so they
		// have to be checked before anything else.
		it('reads a cloud-provider flag ahead of every other signal', () => {
			expect(
				classifyCredentialKind('claude-code', {
					CLAUDE_CODE_USE_BEDROCK: '1',
					ANTHROPIC_BASE_URL: 'https://api.z.ai/v1',
					ANTHROPIC_API_KEY: 'sk-x',
				})
			).toMatchObject({ kind: 'cloud-provider', label: 'AWS Bedrock' });
			expect(
				classifyCredentialKind('claude-code', { CLAUDE_CODE_USE_VERTEX: 'true' })
			).toMatchObject({ kind: 'cloud-provider', label: 'Google Vertex AI' });
		});
		it.each(['', '   ', '0', 'false', 'no', 'off', 'OFF'])(
			'treats the cloud flag value %o as off',
			(value) => {
				expect(classifyCredentialKind('claude-code', { CLAUDE_CODE_USE_BEDROCK: value }).kind).toBe(
					'oauth'
				);
			}
		);
		// An emptied row is how a user turns an inherited variable off, so a blank
		// value must not invent a credential.
		it('treats a whitespace-only secret as unset', () => {
			expect(classifyCredentialKind('claude-code', { ANTHROPIC_API_KEY: '  ' }).kind).toBe('oauth');
			expect(classifyCredentialKind('codex', { OPENAI_API_KEY: '' }).kind).toBe('oauth');
		});
		it('does not read one provider variables for another', () => {
			expect(classifyCredentialKind('codex', { ANTHROPIC_API_KEY: 'sk-x' }).kind).toBe('oauth');
			expect(classifyCredentialKind('claude-code', { OPENAI_API_KEY: 'sk-x' }).kind).toBe('oauth');
		});
		it('uses the Copilot CLI token precedence order', () => {
			expect(
				classifyCredentialKind('copilot-cli', { GH_TOKEN: 'a', COPILOT_GITHUB_TOKEN: 'b' })
			).toMatchObject({ kind: 'api-key', envVarName: 'COPILOT_GITHUB_TOKEN' });
			expect(classifyCredentialKind('copilot-cli', { GITHUB_TOKEN: 'a' }).kind).toBe('api-key');
		});
		// OpenCode keeps every provider in one auth.json, so a key set for ANY of
		// them changes what the agent presents. Matched by shape, not by a list that
		// goes stale on each release.
		it('matches any provider key variable for opencode', () => {
			expect(classifyCredentialKind('opencode', { GROQ_API_KEY: 'x' }).kind).toBe('api-key');
			expect(classifyCredentialKind('opencode', { MOONSHOT_API_KEY: 'x' }).kind).toBe('api-key');
			expect(classifyCredentialKind('opencode', { ANTHROPIC_AUTH_TOKEN: 'x' }).kind).toBe(
				'api-key'
			);
			expect(classifyCredentialKind('opencode', { NOT_A_KEY: 'x' }).kind).toBe('oauth');
		});
		it('reports opencode keys in a stable order regardless of env ordering', () => {
			const forward = classifyCredentialKind('opencode', {
				ZED_API_KEY: 'x',
				ALPHA_API_KEY: 'y',
			});
			const reverse = classifyCredentialKind('opencode', {
				ALPHA_API_KEY: 'y',
				ZED_API_KEY: 'x',
			});
			expect(forward.envVarName).toBe(reverse.envVarName);
		});
	});
	describe('credentialKindBlocksLogin', () => {
		it('lets an OAuth agent through', () => {
			expect(credentialKindBlocksLogin({ kind: 'oauth' }, 'Claude Code')).toBeNull();
		});
		it.each(['api-key', 'gateway', 'cloud-provider'] as const)('blocks a %s agent', (kind) => {
			const reason = credentialKindBlocksLogin({ kind, envVarName: 'SOME_VAR' }, 'Claude Code');
			expect(reason).toContain('Claude Code');
			expect(reason).toContain('SOME_VAR');
		});
		it('still explains itself when no variable named the credential', () => {
			expect(credentialKindBlocksLogin({ kind: 'api-key' }, 'Codex')).toContain('its environment');
		});
	});
});
// Source: src/__tests__/shared/snoozeCommands.test.ts
describe('', () => {
	describe('parseSnoozeCommandRequest', () => {
		it('rejects an unknown or missing action', () => {
			expect(parseSnoozeCommandRequest({})).toEqual({
				ok: false,
				error: expect.stringContaining('Invalid or missing snooze action'),
			});
			expect(parseSnoozeCommandRequest({ action: 'nap' }).ok).toBe(false);
		});
		it('accepts every action it advertises', () => {
			// The list is what the error message offers the caller, so a verb missing
			// from it is a verb the CLI can send and nothing will run.
			for (const action of SNOOZE_COMMAND_ACTIONS) {
				expect(isSnoozeCommandAction(action), action).toBe(true);
			}
		});
		it('requires both ids on every write', () => {
			for (const action of ['snooze', 'wake', 'dismiss', 'reschedule']) {
				expect(parseSnoozeCommandRequest({ action, targetId: 't1' }).ok, action).toBe(false);
				expect(parseSnoozeCommandRequest({ action, sessionId: 's1' }).ok, action).toBe(false);
			}
		});
		it('requires a numeric wakeAt on snooze and reschedule', () => {
			// The failure being blocked: a tab parked at NaN is invisible AND never
			// due, so it cannot be found or restored from any surface.
			const base = { sessionId: 's1', targetId: 't1' };
			expect(parseSnoozeCommandRequest({ ...base, action: 'snooze' }).ok).toBe(false);
			expect(parseSnoozeCommandRequest({ ...base, action: 'snooze', wakeAt: 'tomorrow' }).ok).toBe(
				false
			);
			expect(parseSnoozeCommandRequest({ ...base, action: 'reschedule', wakeAt: NaN }).ok).toBe(
				false
			);
			const ok = parseSnoozeCommandRequest({ ...base, action: 'snooze', wakeAt: 1800000000500 });
			expect(ok).toEqual({
				ok: true,
				request: { action: 'snooze', sessionId: 's1', targetId: 't1', wakeAt: 1800000000500 },
			});
		});
		it('does not ask a read for an agent', () => {
			expect(parseSnoozeCommandRequest({ action: 'list' })).toEqual({
				ok: true,
				request: { action: 'list' },
			});
			expect(parseSnoozeCommandRequest({ action: 'history', limit: 5 })).toEqual({
				ok: true,
				request: { action: 'history', limit: 5 },
			});
		});
		it('keeps an empty note, because empty is the way a note is cleared', () => {
			// An absent field means "leave it alone" on a reschedule and an empty one
			// means "clear it". Collapsing the two would make the note unclearable.
			const parsed = parseSnoozeCommandRequest({
				action: 'reschedule',
				sessionId: 's1',
				targetId: 'sn1',
				wakeAt: 1800000000000,
				note: '',
			});
			expect(parsed.ok && parsed.request.note).toBe('');
			const untouched = parseSnoozeCommandRequest({
				action: 'reschedule',
				sessionId: 's1',
				targetId: 'sn1',
				wakeAt: 1800000000000,
			});
			expect(untouched.ok && 'note' in untouched.request).toBe(false);
		});
		it('treats background as an opt-in, never as an absent-means-true', () => {
			const args = { action: 'snooze', sessionId: 's1', targetId: 't1', wakeAt: 1800000000000 };
			const absent = parseSnoozeCommandRequest({ ...args });
			expect(absent.ok && 'background' in absent.request).toBe(false);
			for (const value of [false, 'true', 1, null]) {
				const parsed = parseSnoozeCommandRequest({ ...args, background: value });
				expect(parsed.ok && parsed.request.background, String(value)).toBeUndefined();
			}
			const opted = parseSnoozeCommandRequest({ ...args, background: true });
			expect(opted.ok && opted.request.background).toBe(true);
		});
		it('trims ids so a shell-quoted argument still resolves', () => {
			const parsed = parseSnoozeCommandRequest({
				action: 'wake',
				sessionId: ' s1 ',
				targetId: ' sn1 ',
			});
			expect(parsed.ok && parsed.request).toMatchObject({ sessionId: 's1', targetId: 'sn1' });
		});
	});
	describe('normalizeSnoozeCommandResult', () => {
		it('turns a non-result into a failure rather than a silent success', () => {
			// The reply crosses IPC from a renderer that can be a different build, and
			// `success: undefined` read as done reports a snooze that never happened.
			for (const raw of [null, undefined, 'ok', 42, {}, { success: 'yes' }]) {
				expect(normalizeSnoozeCommandResult(raw).success, String(raw)).toBe(false);
			}
		});
		it('keeps the failure message the renderer supplied', () => {
			expect(
				normalizeSnoozeCommandResult({ success: false, error: 'No snooze with id x' })
			).toEqual({
				success: false,
				error: 'No snooze with id x',
			});
		});
		it('passes a well-formed success through with its payload', () => {
			const snooze = {
				snoozeId: 'sn1',
				agentId: 'a1',
				agentName: 'Agent',
				type: 'ai' as const,
				label: 'Tab',
				tabId: 't1',
				snoozedAt: 1,
				wakeAt: 2,
			};
			expect(
				normalizeSnoozeCommandResult({ success: true, snooze, tabId: 't1', wasDuplicate: true })
			).toEqual({ success: true, snooze, tabId: 't1', wasDuplicate: true });
		});
		it('drops a wasDuplicate that is not literally true', () => {
			const result = normalizeSnoozeCommandResult({ success: true, wasDuplicate: 'yes' });
			expect(result.wasDuplicate).toBeUndefined();
		});
	});
});
// Source: src/__tests__/shared/claudeAccountIdentity.test.ts
describe('', () => {
	describe('parseClaudeAccountIdentity', () => {
		it('extracts email, uuid, and org name from a real-shaped oauthAccount', () => {
			const identity = parseClaudeAccountIdentity({
				userID: 'abc123',
				oauthAccount: {
					accountUuid: '2acf84ae-d765-4a12-ae90-296b9f903018',
					emailAddress: 'pedram@smashlabs.com',
					organizationName: "pedram@smashlabs.com's Organization",
					organizationUuid: '69e417ec-08ca-417c-a435-0ae061aee8b3',
				},
			});
			expect(identity).toEqual({
				email: 'pedram@smashlabs.com',
				accountUuid: '2acf84ae-d765-4a12-ae90-296b9f903018',
				organizationName: "pedram@smashlabs.com's Organization",
			});
		});
		it('returns a partial identity when only some fields are present', () => {
			// Older `.claude.json` blobs can carry the email without the uuid.
			// Half an identity still labels the row better than the directory name.
			expect(parseClaudeAccountIdentity({ oauthAccount: { emailAddress: 'a@b.com' } })).toEqual({
				email: 'a@b.com',
			});
		});
		it.each([
			['null', null],
			['undefined', undefined],
			['a string', 'not an object'],
			['an object with no oauthAccount', { userID: 'abc' }],
			['a non-object oauthAccount', { oauthAccount: 'nope' }],
			['an oauthAccount with no readable fields', { oauthAccount: { seatTier: null } }],
			['an oauthAccount with empty-string fields', { oauthAccount: { emailAddress: '' } }],
			['an oauthAccount with wrong-typed fields', { oauthAccount: { emailAddress: 42 } }],
		])('returns null for %s', (_label, input) => {
			expect(parseClaudeAccountIdentity(input)).toBeNull();
		});
	});
	describe('accountIdentityFingerprint', () => {
		it('prefers the uuid over the email', () => {
			expect(accountIdentityFingerprint({ accountUuid: 'u1', email: 'a@b.com' })).toBe('uuid:u1');
		});
		it('falls back to a case-folded email when there is no uuid', () => {
			expect(accountIdentityFingerprint({ email: 'A@B.com' })).toBe('email:a@b.com');
		});
		it('returns null when there is nothing to match on', () => {
			// Two unknowns are not evidence of a match, so they must not group.
			expect(accountIdentityFingerprint({ organizationName: 'Some Org' })).toBeNull();
			expect(accountIdentityFingerprint(null)).toBeNull();
			expect(accountIdentityFingerprint(undefined)).toBeNull();
		});
	});
	describe('groupAccountKeysByIdentity', () => {
		it('pairs two config dirs logged into the same account', () => {
			// The real case that started this: ~/.claude-gmail was re-logged into
			// the smashlabs account, so both dirs draw on one quota.
			const shared = groupAccountKeysByIdentity({
				'/Users/pedram/.claude-gmail': { accountUuid: 'smash-uuid', email: 'p@smashlabs.com' },
				'/Users/pedram/.claude-smash': { accountUuid: 'smash-uuid', email: 'p@smashlabs.com' },
				'/Users/pedram/.claude-banaco': { accountUuid: 'banaco-uuid', email: 'p@banaco.com' },
			});
			expect(shared).toEqual({
				'/Users/pedram/.claude-gmail': ['/Users/pedram/.claude-smash'],
				'/Users/pedram/.claude-smash': ['/Users/pedram/.claude-gmail'],
			});
		});
		it('groups three or more dirs and lists every sibling but the key itself', () => {
			const shared = groupAccountKeysByIdentity({
				a: { accountUuid: 'u' },
				b: { accountUuid: 'u' },
				c: { accountUuid: 'u' },
			});
			expect(shared.a).toEqual(['b', 'c']);
			expect(shared.b).toEqual(['a', 'c']);
			expect(shared.c).toEqual(['a', 'b']);
		});
		it('preserves input key order in the sibling lists so rendering is stable', () => {
			const shared = groupAccountKeysByIdentity({
				zeta: { accountUuid: 'u' },
				alpha: { accountUuid: 'u' },
				mid: { accountUuid: 'u' },
			});
			expect(shared.mid).toEqual(['zeta', 'alpha']);
		});
		it('matches on email when the uuid is missing on both sides', () => {
			const shared = groupAccountKeysByIdentity({
				a: { email: 'Same@Example.com' },
				b: { email: 'same@example.com' },
			});
			expect(shared).toEqual({ a: ['b'], b: ['a'] });
		});
		it('does not match a uuid-bearing identity to an email-only one', () => {
			// A uuid fingerprint and an email fingerprint live in different
			// namespaces on purpose - when the uuid exists it is the answer, and
			// silently downgrading to email matching would invent groupings.
			const shared = groupAccountKeysByIdentity({
				a: { accountUuid: 'u', email: 'x@y.com' },
				b: { email: 'x@y.com' },
			});
			expect(shared).toEqual({});
		});
		it('omits keys with no siblings, unknown identities, and null identities', () => {
			const shared = groupAccountKeysByIdentity({
				solo: { accountUuid: 'only-me' },
				unknown: { organizationName: 'No ids here' },
				missing: null,
				absent: undefined,
			});
			expect(shared).toEqual({});
		});
		it('returns an empty map for an empty input', () => {
			expect(groupAccountKeysByIdentity({})).toEqual({});
		});
	});
});
// Source: src/__tests__/shared/toastWidth.test.ts
describe('', () => {
	/** The fixed presets - everything except the runtime-computed 'dynamic'. */
	const STATIC_WIDTHS: StaticToastWidth[] = ['small', 'medium', 'large'];
	describe('toastWidth', () => {
		describe('isToastWidth', () => {
			it.each(TOAST_WIDTHS)('accepts the valid preset "%s"', (preset) => {
				expect(isToastWidth(preset)).toBe(true);
			});
			it('accepts the dynamic preset', () => {
				expect(isToastWidth('dynamic')).toBe(true);
			});
			it('rejects unknown strings', () => {
				expect(isToastWidth('huge')).toBe(false);
				expect(isToastWidth('')).toBe(false);
			});
			it('rejects non-string values', () => {
				expect(isToastWidth(undefined)).toBe(false);
				expect(isToastWidth(null)).toBe(false);
				expect(isToastWidth(400)).toBe(false);
				expect(isToastWidth({ minWidth: 320 })).toBe(false);
			});
		});
		describe('TOAST_WIDTH_DIMENSIONS', () => {
			it('defines dimensions for every fixed preset', () => {
				for (const preset of STATIC_WIDTHS) {
					expect(TOAST_WIDTH_DIMENSIONS[preset]).toBeDefined();
				}
			});
			it('preserves the legacy 320-400px sizing for "small" (the default)', () => {
				expect(TOAST_WIDTH_DIMENSIONS.small).toEqual({ minWidth: 320, maxWidth: 400 });
			});
			it('scales min and max monotonically up across the fixed presets', () => {
				for (let i = 1; i < STATIC_WIDTHS.length; i++) {
					const prev = TOAST_WIDTH_DIMENSIONS[STATIC_WIDTHS[i - 1]];
					const curr = TOAST_WIDTH_DIMENSIONS[STATIC_WIDTHS[i]];
					expect(curr.minWidth).toBeGreaterThan(prev.minWidth);
					expect(curr.maxWidth).toBeGreaterThan(prev.maxWidth);
				}
			});
			it('keeps minWidth <= maxWidth for every fixed preset', () => {
				for (const preset of STATIC_WIDTHS) {
					const { minWidth, maxWidth } = TOAST_WIDTH_DIMENSIONS[preset];
					expect(minWidth).toBeLessThanOrEqual(maxWidth);
				}
			});
		});
		describe('getToastWidthDimensions', () => {
			it('returns the fixed dimensions for static presets, ignoring the panel width', () => {
				for (const preset of STATIC_WIDTHS) {
					expect(getToastWidthDimensions(preset, 999)).toEqual(TOAST_WIDTH_DIMENSIONS[preset]);
				}
			});
			it('pins both bounds to the right-panel width less a gutter on each side for "dynamic"', () => {
				const expected = 384 - 2 * TOAST_VIEWPORT_GUTTER;
				expect(getToastWidthDimensions('dynamic', 384)).toEqual({
					minWidth: expected,
					maxWidth: expected,
				});
			});
			it('tracks a resized right panel for "dynamic"', () => {
				expect(getToastWidthDimensions('dynamic', 360).minWidth).toBe(
					360 - 2 * TOAST_VIEWPORT_GUTTER
				);
				expect(getToastWidthDimensions('dynamic', 640).maxWidth).toBe(
					640 - 2 * TOAST_VIEWPORT_GUTTER
				);
			});
			it('leaves even left/right padding so the dynamic toast sits centered in the column', () => {
				// Full panel width would push the left edge past the column; reserving
				// a gutter on each side keeps the toast inside with matching padding.
				expect(getToastWidthDimensions('dynamic', 400).maxWidth).toBe(
					400 - 2 * TOAST_VIEWPORT_GUTTER
				);
			});
			it('produces an exact (non-flexible) width for "dynamic" so the toast fills the column', () => {
				const dims = getToastWidthDimensions('dynamic', 512);
				expect(dims.minWidth).toBe(dims.maxWidth);
			});
			it('never returns a negative width for an absurdly narrow panel', () => {
				expect(getToastWidthDimensions('dynamic', 8).minWidth).toBe(0);
			});
		});
		describe('TOAST_WIDTH_LABELS', () => {
			it('labels every preset', () => {
				for (const preset of TOAST_WIDTHS) {
					expect(TOAST_WIDTH_LABELS[preset]).toBeTruthy();
				}
			});
		});
		describe('describeToastWidth', () => {
			it('quotes the min-max pair for a fixed preset', () => {
				expect(describeToastWidth('large', 384)).toContain('480-720px');
			});
			it('ignores the panel width for a fixed preset', () => {
				expect(describeToastWidth('small', 999)).toBe(describeToastWidth('small', 320));
			});
			it('quotes the tracked Right Bar width for dynamic', () => {
				expect(describeToastWidth('dynamic', 500)).toContain(
					`${500 - 2 * TOAST_VIEWPORT_GUTTER}px`
				);
			});
			it('names the Left Bar when a left-corner toast tracks it', () => {
				expect(describeToastWidth('dynamic', 300, 'Left Bar')).toContain('Left Bar width (268px)');
			});
			it('describes every preset without an empty string', () => {
				for (const preset of TOAST_WIDTHS) {
					expect(describeToastWidth(preset, 384).length).toBeGreaterThan(0);
				}
			});
		});
		it('lists dynamic as the final width option', () => {
			const widths: readonly ToastWidth[] = TOAST_WIDTHS;
			expect(widths[widths.length - 1]).toBe('dynamic');
		});
	});
});
// Source: src/__tests__/shared/platformDetection.test.ts
describe('', () => {
	describe('platformDetection', () => {
		const originalPlatform = process.platform;
		afterEach(() => {
			Object.defineProperty(process, 'platform', {
				value: originalPlatform,
				configurable: true,
			});
		});
		describe('isWindows', () => {
			it('returns true on win32', () => {
				Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
				expect(isWindows()).toBe(true);
			});
			it('returns false on darwin', () => {
				Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
				expect(isWindows()).toBe(false);
			});
			it('returns false on linux', () => {
				Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
				expect(isWindows()).toBe(false);
			});
		});
		describe('isMacOS', () => {
			it('returns true on darwin', () => {
				Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
				expect(isMacOS()).toBe(true);
			});
			it('returns false on win32', () => {
				Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
				expect(isMacOS()).toBe(false);
			});
			it('returns false on linux', () => {
				Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
				expect(isMacOS()).toBe(false);
			});
		});
		describe('isLinux', () => {
			it('returns true on linux', () => {
				Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
				expect(isLinux()).toBe(true);
			});
			it('returns false on darwin', () => {
				Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
				expect(isLinux()).toBe(false);
			});
			it('returns false on win32', () => {
				Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
				expect(isLinux()).toBe(false);
			});
		});
		describe('getWhichCommand', () => {
			it('returns "where" on Windows', () => {
				Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
				expect(getWhichCommand()).toBe('where');
			});
			it('returns "which" on macOS', () => {
				Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
				expect(getWhichCommand()).toBe('which');
			});
			it('returns "which" on Linux', () => {
				Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
				expect(getWhichCommand()).toBe('which');
			});
		});
		describe('renderer (browser) fallback', () => {
			// In a renderer, `process` is undefined and `globalThis.maestro.platform`
			// is provided by the preload bridge. Simulate the no-process case by
			// blanking process.platform; the fallback should pick up maestro.platform.
			const g = globalThis as unknown as {
				maestro?: {
					platform?: string;
				};
			};
			it('reads platform from globalThis.maestro.platform when process.platform is empty', () => {
				Object.defineProperty(process, 'platform', { value: '', configurable: true });
				const savedMaestro = g.maestro;
				try {
					g.maestro = { platform: 'darwin' };
					expect(isMacOS()).toBe(true);
					expect(isWindows()).toBe(false);
					expect(isLinux()).toBe(false);
				} finally {
					g.maestro = savedMaestro;
				}
			});
			it('falls back to linux when neither process.platform nor maestro is defined', () => {
				Object.defineProperty(process, 'platform', { value: '', configurable: true });
				const savedMaestro = g.maestro;
				try {
					g.maestro = undefined;
					expect(() => isMacOS()).not.toThrow();
					expect(isLinux()).toBe(true);
					expect(isMacOS()).toBe(false);
					expect(isWindows()).toBe(false);
				} finally {
					g.maestro = savedMaestro;
				}
			});
			// Regression: the renderer loads process-shim.js, which defines
			// `process.platform = 'browser'`. Reading that before the preload bridge
			// made every macOS renderer look non-Mac, so shortcut hints in Settings
			// rendered "Ctrl+0" instead of "Command+0".
			it('prefers the preload bridge over the renderer process shim', () => {
				Object.defineProperty(process, 'platform', { value: 'browser', configurable: true });
				const savedMaestro = g.maestro;
				try {
					g.maestro = { platform: 'darwin' };
					expect(isMacOS()).toBe(true);
					expect(isWindows()).toBe(false);
					expect(isLinux()).toBe(false);
				} finally {
					g.maestro = savedMaestro;
				}
			});
			it('never treats the shim sentinel "browser" as a real platform', () => {
				Object.defineProperty(process, 'platform', { value: 'browser', configurable: true });
				const savedMaestro = g.maestro;
				try {
					g.maestro = undefined;
					expect(isLinux()).toBe(true);
					expect(isMacOS()).toBe(false);
					expect(isWindows()).toBe(false);
				} finally {
					g.maestro = savedMaestro;
				}
			});
		});
	});
});
// Source: src/__tests__/shared/cue-path-utils.test.ts
describe('', () => {
	describe('computeCommonAncestorPath', () => {
		it('returns null for empty input', () => {
			expect(computeCommonAncestorPath([])).toBeNull();
		});
		it('returns the path itself for a single-element array', () => {
			expect(computeCommonAncestorPath(['/a/b/c'])).toBe('/a/b/c');
		});
		it('returns the common parent for sibling directories', () => {
			expect(computeCommonAncestorPath(['/a/b/c', '/a/b/d'])).toBe('/a/b');
		});
		it('returns the parent when one path is a child of the other', () => {
			expect(computeCommonAncestorPath(['/project', '/project/sub'])).toBe('/project');
		});
		it('returns the parent for deeply nested children', () => {
			expect(computeCommonAncestorPath(['/project', '/project/sub/deep', '/project/other'])).toBe(
				'/project'
			);
		});
		it('returns filesystem root for completely unrelated paths', () => {
			expect(computeCommonAncestorPath(['/a/b', '/c/d'])).toBe('/');
		});
		it('handles identical paths', () => {
			expect(computeCommonAncestorPath(['/a/b', '/a/b'])).toBe('/a/b');
		});
		it('handles three paths with a shared prefix', () => {
			expect(
				computeCommonAncestorPath([
					'/home/user/project/A',
					'/home/user/project/B',
					'/home/user/project/C',
				])
			).toBe('/home/user/project');
		});
	});
	describe('isDescendantOrEqual', () => {
		it('returns true when paths are identical', () => {
			expect(isDescendantOrEqual('/a/b', '/a/b')).toBe(true);
		});
		it('returns true when child is a subdirectory of parent', () => {
			expect(isDescendantOrEqual('/a/b/c', '/a/b')).toBe(true);
		});
		it('returns true for deeply nested descendant', () => {
			expect(isDescendantOrEqual('/project/sub/deep/nested', '/project')).toBe(true);
		});
		it('returns false when child is not under parent', () => {
			expect(isDescendantOrEqual('/a/b', '/c/d')).toBe(false);
		});
		it('returns false when parent is a subdirectory of child (reversed)', () => {
			expect(isDescendantOrEqual('/a', '/a/b')).toBe(false);
		});
		it('returns false for partial prefix match that is not a directory boundary', () => {
			// /a/bar is NOT a descendant of /a/b - the prefix match is not at a separator
			expect(isDescendantOrEqual('/a/bar', '/a/b')).toBe(false);
		});
		it('handles trailing separators via normalization', () => {
			expect(isDescendantOrEqual('/a/b/c', '/a/b/')).toBe(true);
			expect(isDescendantOrEqual('/a/b/', '/a/b')).toBe(true);
		});
	});
	// Regression: this utility is imported by the renderer pipeline save flow.
	// Do NOT let anyone reintroduce a Node `path` dependency - the renderer
	// strips it and saves fail with "path.resolve is not a function".
	describe('cue-path-utils (renderer-safe)', () => {
		it('does not reference Node built-in modules at import time', async () => {
			// A pure-JS module imports and evaluates without `require`/`import` of
			// Node built-ins. Dynamic import alone only catches crashes - a silent
			// tree-shake could still hide a `path` reference the renderer rejects
			// at runtime. Assert against the source too so a review can't miss it.
			const sourcePath = s8_path.resolve(__dirname, '../../shared/cue-path-utils.ts');
			const source = fs.readFileSync(sourcePath, 'utf-8');
			// Matches:  from 'path' | from "path" | from 'node:path' | require('path')
			// Does NOT match comments / strings that happen to include the word `path`.
			const nodePathImport =
				/(?:require\(\s*['"]|from\s+['"])(?:node:)?(?:path|fs|os|child_process|stream|zlib|crypto|http|https|net|dns|url)['"]/;
			expect(source).not.toMatch(nodePathImport);
			// Still import the module so a parse/eval regression surfaces here.
			await expect(import('../../shared/cue-path-utils')).resolves.toBeDefined();
		});
		describe('Windows paths', () => {
			it('computes common ancestor for sibling Windows directories', () => {
				expect(computeCommonAncestorPath(['C:\\proj\\a', 'C:\\proj\\b'])).toBe('C:\\proj');
			});
			it('detects descendant under a Windows project root', () => {
				expect(isDescendantOrEqual('C:\\proj\\sub', 'C:\\proj')).toBe(true);
			});
			it('rejects non-boundary Windows prefix matches', () => {
				expect(isDescendantOrEqual('C:\\proj2', 'C:\\proj')).toBe(false);
			});
		});
		// Regression: the original normalize() used /\\+/g which collapsed the
		// leading `\\` of UNC paths down to `\`, breaking every downstream
		// comparison for network shares. The fix preserves the UNC prefix.
		describe('UNC paths', () => {
			it('preserves the `\\\\` UNC prefix through normalize', () => {
				// A path that equals itself is the cheapest proof the prefix
				// didn't get collapsed - if normalize mangled `\\\\`, this
				// isDescendantOrEqual call would return false.
				expect(isDescendantOrEqual('\\\\server\\share\\path', '\\\\server\\share\\path')).toBe(
					true
				);
			});
			it('detects descendant under a UNC share', () => {
				expect(isDescendantOrEqual('\\\\server\\share\\sub', '\\\\server\\share')).toBe(true);
			});
			it('rejects descendant check across different UNC shares', () => {
				expect(isDescendantOrEqual('\\\\server\\other\\sub', '\\\\server\\share')).toBe(false);
			});
			it('computes common ancestor for UNC siblings', () => {
				expect(computeCommonAncestorPath(['\\\\server\\share\\a', '\\\\server\\share\\b'])).toBe(
					'\\\\server\\share'
				);
			});
			it('treats a bare UNC root as its own common ancestor', () => {
				expect(computeCommonAncestorPath(['\\\\server\\share'])).toBe('\\\\server\\share');
			});
		});
	});
});
// Source: src/__tests__/shared/parkedRecords.test.ts
describe('', () => {
	describe('splitParkedEntries', () => {
		it('returns undefined for both halves when there is nothing to store', () => {
			expect(splitParkedEntries([])).toEqual({ active: undefined, parked: undefined });
		});
		it('sorts entries by their enabled flag', () => {
			expect(
				splitParkedEntries([
					{ key: 'ConnectTimeout', value: '45', enabled: true },
					{ key: 'ProxyCommand', value: 'tailcat tcABC 22', enabled: false },
				])
			).toEqual({
				active: { ConnectTimeout: '45' },
				parked: { ProxyCommand: 'tailcat tcABC 22' },
			});
		});
		it('drops a blank key and trims the rest', () => {
			expect(
				splitParkedEntries([
					{ key: '  ProxyJump  ', value: 'bastion', enabled: true },
					{ key: '   ', value: 'orphan', enabled: true },
				]).active
			).toEqual({ ProxyJump: 'bastion' });
		});
		it('keeps a blank value, which is meaningful for some options', () => {
			expect(
				splitParkedEntries([{ key: 'ProxyCommand', value: '', enabled: true }]).active
			).toEqual({
				ProxyCommand: '',
			});
		});
		it('gives a live row the key outright when both spellings are present', () => {
			// Two rows can share a key mid-edit. Landing in both records would make
			// the parked copy invisible but resurrectable, so the live row wins.
			const { active, parked } = splitParkedEntries([
				{ key: 'ConnectTimeout', value: '10', enabled: false },
				{ key: 'ConnectTimeout', value: '45', enabled: true },
			]);
			expect(active).toEqual({ ConnectTimeout: '45' });
			expect(parked).toBeUndefined();
		});
		it('holds that rule whichever order the rows are in', () => {
			const { active, parked } = splitParkedEntries([
				{ key: 'ConnectTimeout', value: '45', enabled: true },
				{ key: 'ConnectTimeout', value: '10', enabled: false },
			]);
			expect(active).toEqual({ ConnectTimeout: '45' });
			expect(parked).toBeUndefined();
		});
	});
	describe('setKeysParked', () => {
		const pair: ParkedRecordPair = {
			active: { ConnectTimeout: '45', ProxyJump: 'bastion' },
			parked: { ProxyCommand: 'tailcat tcABC 22' },
		};
		it('moves a key out of the active record, keeping its value', () => {
			const next = setKeysParked(pair, ['ProxyJump'], true);
			expect(next.active).toEqual({ ConnectTimeout: '45' });
			expect(next.parked).toEqual({
				ProxyCommand: 'tailcat tcABC 22',
				ProxyJump: 'bastion',
			});
		});
		it('moves a key back into the active record', () => {
			const next = setKeysParked(pair, ['ProxyCommand'], false);
			expect(next.active).toEqual({
				ConnectTimeout: '45',
				ProxyJump: 'bastion',
				ProxyCommand: 'tailcat tcABC 22',
			});
			expect(next.parked).toBeUndefined();
		});
		it('ignores a key that is in neither record rather than inventing it', () => {
			// Disabling something already deleted must be a no-op, not a resurrection
			// of an empty value under that name.
			const next = setKeysParked(pair, ['NoSuchOption'], true);
			expect(next).toEqual(pair);
		});
		it('is a no-op when the key is already on the requested side', () => {
			expect(setKeysParked(pair, ['ProxyCommand'], true)).toEqual(pair);
		});
		it('does not mutate the pair it was given', () => {
			const original = JSON.parse(JSON.stringify(pair));
			setKeysParked(pair, ['ProxyJump'], true);
			expect(pair).toEqual(original);
		});
		it('collapses an emptied record to undefined', () => {
			const next = setKeysParked({ active: { ProxyJump: 'bastion' } }, ['ProxyJump'], true);
			expect(next.active).toBeUndefined();
			expect(next.parked).toEqual({ ProxyJump: 'bastion' });
		});
		it('handles several keys in one call', () => {
			const next = setKeysParked(pair, ['ConnectTimeout', 'ProxyJump'], true);
			expect(next.active).toBeUndefined();
			expect(Object.keys(next.parked ?? {}).sort()).toEqual([
				'ConnectTimeout',
				'ProxyCommand',
				'ProxyJump',
			]);
		});
	});
	describe('parkedPairKeys', () => {
		it('lists active keys before parked ones', () => {
			expect(parkedPairKeys({ active: { A: '1', B: '2' }, parked: { C: '3' } })).toEqual([
				'A',
				'B',
				'C',
			]);
		});
		it('returns nothing for an empty pair', () => {
			expect(parkedPairKeys({})).toEqual([]);
		});
	});
});
// Source: src/__tests__/shared/theme-types.test.ts
describe('', () => {
	describe('isValidThemeId', () => {
		// Sample of valid theme IDs (not exhaustive - that would couple tests to implementation)
		const sampleValidIds = [
			'dracula',
			'monokai',
			'github-light',
			'nord',
			'olive-nights',
			'indigo-blue',
			'pedurple',
		];
		it('should return true for valid theme IDs', () => {
			for (const id of sampleValidIds) {
				expect(isValidThemeId(id)).toBe(true);
			}
		});
		it('should return false for invalid theme IDs', () => {
			const invalidIds = ['', 'invalid', 'not-a-theme', 'Dracula', 'NORD'];
			for (const id of invalidIds) {
				expect(isValidThemeId(id)).toBe(false);
			}
		});
		it('should work as a type guard for filtering', () => {
			const mixedIds = ['dracula', 'invalid', 'nord', 'fake'];
			const validIds = mixedIds.filter(isValidThemeId);
			expect(validIds).toEqual(['dracula', 'nord']);
			// TypeScript should now know validIds is ThemeId[]
			const _typeCheck: ThemeId[] = validIds;
			expect(_typeCheck).toBe(validIds);
		});
	});
	describe('resolveThemeId', () => {
		it('passes a live theme id through untouched', () => {
			expect(resolveThemeId('nord')).toBe('nord');
			expect(resolveThemeId('winamp')).toBe('winamp');
		});
		// A user who picked a theme before it was retired still has that id on disk.
		// App.tsx looks the theme up bare, so an unmapped id renders the app unstyled.
		it('maps a retired theme id to its replacement', () => {
			expect(resolveThemeId('inquest')).toBe('dracula');
		});
		it('falls back for anything unrecognized, including non-strings', () => {
			expect(resolveThemeId('not-a-theme')).toBe('dracula');
			expect(resolveThemeId(undefined)).toBe('dracula');
			expect(resolveThemeId(null)).toBe('dracula');
			expect(resolveThemeId(42)).toBe('dracula');
			expect(resolveThemeId('not-a-theme', 'nord')).toBe('nord');
		});
		it('never maps a retired id onto another retired or missing theme', () => {
			for (const [retired, replacement] of Object.entries(RETIRED_THEME_IDS)) {
				expect(isValidThemeId(retired)).toBe(false);
				expect(THEMES[replacement]).toBeDefined();
			}
		});
	});
});
