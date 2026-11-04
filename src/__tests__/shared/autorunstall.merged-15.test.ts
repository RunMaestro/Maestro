// Consolidated from current rc sources; per-source hooks and state stay in an unnamed suite.
// Source: src/__tests__/shared/autorunStall.test.ts
// Source: src/__tests__/shared/opencodeAgentArg.test.ts
// Source: src/__tests__/shared/groupHierarchy.test.ts
// Source: src/__tests__/shared/sessionPersistenceMerge.test.ts
// Source: src/__tests__/shared/sshRemoteShell.test.ts
// Source: src/__tests__/shared/onboardingSeries.test.ts
// Source: src/__tests__/shared/codexTokenUsage.test.ts
// Source: src/__tests__/shared/fileCategories.test.ts
// Source: src/__tests__/shared/marketplace-compatibility.test.ts
// Source: src/__tests__/shared/uiSurfaces.test.ts
// Source: src/__tests__/shared/buildProvenance.test.ts
// Source: src/__tests__/shared/bundledFonts.test.ts
// Source: src/__tests__/shared/agentDelegation.test.ts
// Source: src/__tests__/shared/processErrors.test.ts
import { describe, it, expect } from 'vitest';
import {
	MAX_CONSECUTIVE_NO_CHANGES,
	describeStall,
	evaluateStall,
} from '../../shared/autorunStall';
import { readOpenCodeAgentArg, writeOpenCodeAgentArg } from '../../shared/opencodeAgentArg';
import type { Group } from '../../shared/types';
import {
	canCreateGroupInside,
	canSetGroupParent,
	normalizeGroupHierarchy,
	removeGroupAndPromoteChildren,
	setGroupCollapsed,
	setGroupHidden,
	setGroupParent,
} from '../../shared/groupHierarchy';
import { mergeSessionPersistenceChanges } from '../../shared/sessionPersistenceMerge';
import {
	detectNonPosixRemoteShell,
	nonPosixRemoteShellMessage,
	nonPosixRemoteShellName,
	nonPosixRemoteShellRemediation,
} from '../../shared/sshRemoteShell';
import { getSshErrorPatterns, matchErrorPattern } from '../../shared/agentErrorPatterns';
import {
	DEFAULT_THEME_ID,
	ONBOARDING_STEPS,
	ONBOARDING_STEP_FLAGS,
	isThemeStepEligible,
	planOnboardingSeries,
} from '../../shared/onboardingSeries';
import { CodexTokenCounts } from '../../shared/codexTokenUsage';
import {
	FILE_CATEGORIES,
	getFileCategory,
	getFileExtension,
	isPreviewableFile,
	matchesFileCategory,
} from '../../shared/fileCategories';
import { isCompatible, isBeta } from '../../shared/marketplace-compatibility';
import type { MarketplacePlaybook } from '../../shared/marketplace-types';
import {
	UI_SURFACES,
	describeSurfaceAccess,
	resolveUiSurface,
	resolveUiSurfaceTab,
	surfaceTabIds,
	uiSurfaceRefusal,
} from '../../shared/uiSurfaces';
import { formatShortcutKeysFor } from '../../shared/shortcutKeys';
import { DEFAULT_SHORTCUTS, FIXED_SHORTCUTS } from '../../renderer/constants/shortcuts';
import { parseBuildProvenance, UNOFFICIAL_BUILD } from '../../shared/buildProvenance';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import {
	BUNDLED_FONTS,
	BUNDLED_FONT_NAMES,
	bundledSubstituteFor,
	getBundledFont,
	isBundledFont,
} from '../../shared/bundledFonts';
import {
	CALLER_AGENT_ID_ENV_VAR,
	CALLER_TAB_ID_ENV_VAR,
	buildCallerIdentityEnv,
	callerMessageFields,
	isSelfDispatch,
	readCallerIdentity,
	readCallerMessageFields,
	withoutCallerIdentityEnv,
} from '../../shared/agentDelegation';
import {
	AGENT_ALREADY_RUNNING_PREFIX,
	agentAlreadyRunningMessage,
	isAgentAlreadyRunningError,
} from '../../shared/processErrors';
// Source: src/__tests__/shared/autorunStall.test.ts
describe('', () => {
	const counts = (checked: number, unchecked: number) => ({ checked, unchecked });
	describe('evaluateStall', () => {
		it('resets the counter when a task gets checked off', () => {
			const result = evaluateStall({
				before: counts(0, 3),
				after: counts(1, 2),
				consecutiveNoChangeCount: 2,
			});
			expect(result).toMatchObject({
				consecutiveNoChangeCount: 0,
				stalled: false,
				taskSetChanged: true,
			});
		});
		it('resets when the agent adds tasks without finishing one', () => {
			// Decomposing a task into subtasks is real work, even though nothing got
			// ticked. Counting it as a stall would punish the correct behavior.
			const result = evaluateStall({
				before: counts(0, 1),
				after: counts(0, 4),
				consecutiveNoChangeCount: 2,
			});
			expect(result.consecutiveNoChangeCount).toBe(0);
			expect(result.stalled).toBe(false);
		});
		it('increments when nothing about the task set moved', () => {
			const result = evaluateStall({
				before: counts(2, 3),
				after: counts(2, 3),
				consecutiveNoChangeCount: 0,
			});
			expect(result).toMatchObject({
				consecutiveNoChangeCount: 1,
				stalled: false,
				taskSetChanged: false,
			});
		});
		it('trips only on the third consecutive no-progress run', () => {
			let count = 0;
			const step = () =>
				(count = evaluateStall({
					before: counts(1, 2),
					after: counts(1, 2),
					consecutiveNoChangeCount: count,
				}).consecutiveNoChangeCount);
			step();
			step();
			expect(
				evaluateStall({
					before: counts(1, 2),
					after: counts(1, 2),
					consecutiveNoChangeCount: count,
				}).stalled
			).toBe(true);
			expect(MAX_CONSECUTIVE_NO_CHANGES).toBe(3);
		});
		it('trips immediately on a watchdog failure', () => {
			// The agent hung. Two more dispatches would reach the same conclusion and
			// cost two more turns to get there.
			const result = evaluateStall({
				before: counts(0, 2),
				after: counts(0, 2),
				consecutiveNoChangeCount: 0,
				watchdogFailure: true,
			});
			expect(result.stalled).toBe(true);
			expect(result.reason).toBe('agent hung or exceeded its time budget');
		});
		it('ignores prose churn: only the task set counts as progress', () => {
			// The failure this heuristic exists for. An agent that cannot do the work
			// writes "here is why I could not" into the document. A byte comparison
			// would call that progress and let the loop run forever.
			const result = evaluateStall({
				before: counts(0, 1),
				after: counts(0, 1),
				consecutiveNoChangeCount: MAX_CONSECUTIVE_NO_CHANGES - 1,
			});
			expect(result.stalled).toBe(true);
			expect(result.reason).toBe('3 consecutive runs with no progress');
		});
		it('does not count an UNCHECKED task as progress', () => {
			// Someone unticking a box is not the agent completing work.
			const result = evaluateStall({
				before: counts(2, 1),
				after: counts(1, 2),
				consecutiveNoChangeCount: 0,
			});
			expect(result.taskSetChanged).toBe(true);
			expect(result.consecutiveNoChangeCount).toBe(0);
		});
		it('leaves reason unset while the document is still healthy', () => {
			expect(
				evaluateStall({ before: counts(0, 2), after: counts(1, 1), consecutiveNoChangeCount: 0 })
					.reason
			).toBeUndefined();
		});
	});
	describe('describeStall', () => {
		it('names the count for an ordinary stall', () => {
			expect(describeStall(3)).toBe('3 consecutive runs with no progress');
		});
		it('names the hang for a watchdog stall', () => {
			expect(describeStall(3, true)).toBe('agent hung or exceeded its time budget');
		});
	});
});
// Source: src/__tests__/shared/opencodeAgentArg.test.ts
describe('', () => {
	describe('readOpenCodeAgentArg', () => {
		it('returns empty string for undefined or empty input', () => {
			expect(readOpenCodeAgentArg(undefined)).toBe('');
			expect(readOpenCodeAgentArg('')).toBe('');
		});
		it('returns empty string when no --agent flag is present', () => {
			expect(readOpenCodeAgentArg('--model anthropic/claude-sonnet-4-20250514')).toBe('');
		});
		it('reads the `--agent name` form', () => {
			expect(readOpenCodeAgentArg('--agent prometheus')).toBe('prometheus');
		});
		it('reads the `--agent=name` form', () => {
			expect(readOpenCodeAgentArg('--agent=prometheus')).toBe('prometheus');
		});
		it('reads the value from the middle of a longer arg string', () => {
			expect(readOpenCodeAgentArg('--foo bar --agent sisyphus --baz')).toBe('sisyphus');
		});
		it('unquotes a quoted value', () => {
			expect(readOpenCodeAgentArg('--agent "my agent"')).toBe('my agent');
			expect(readOpenCodeAgentArg("--agent='my agent'")).toBe('my agent');
		});
		it('ignores a dangling --agent with no value', () => {
			expect(readOpenCodeAgentArg('--agent')).toBe('');
			expect(readOpenCodeAgentArg('--agent --verbose')).toBe('');
		});
	});
	describe('writeOpenCodeAgentArg', () => {
		it('appends the flag when the arg string is empty', () => {
			expect(writeOpenCodeAgentArg('', 'prometheus')).toBe('--agent prometheus');
			expect(writeOpenCodeAgentArg(undefined, 'prometheus')).toBe('--agent prometheus');
		});
		it('appends the flag while preserving existing args', () => {
			expect(writeOpenCodeAgentArg('--verbose --foo bar', 'plan')).toBe(
				'--verbose --foo bar --agent plan'
			);
		});
		it('replaces an existing value in place', () => {
			expect(writeOpenCodeAgentArg('--foo --agent build --bar', 'plan')).toBe(
				'--foo --agent plan --bar'
			);
		});
		it('normalizes the `--agent=name` form when replacing', () => {
			expect(writeOpenCodeAgentArg('--agent=build --bar', 'plan')).toBe('--agent plan --bar');
		});
		it('removes the flag when the name is empty or whitespace', () => {
			expect(writeOpenCodeAgentArg('--foo --agent build --bar', '')).toBe('--foo --bar');
			expect(writeOpenCodeAgentArg('--agent build', '   ')).toBe('');
		});
		it('collapses duplicate --agent flags down to the first position', () => {
			expect(writeOpenCodeAgentArg('--agent build --foo --agent other', 'plan')).toBe(
				'--agent plan --foo'
			);
		});
		it('drops a dangling --agent with no value', () => {
			expect(writeOpenCodeAgentArg('--foo --agent', 'plan')).toBe('--foo --agent plan');
		});
		it('quotes values containing whitespace', () => {
			expect(writeOpenCodeAgentArg('', 'my agent')).toBe('--agent "my agent"');
		});
		it('trims the provided name', () => {
			expect(writeOpenCodeAgentArg('', '  plan  ')).toBe('--agent plan');
		});
		it('round-trips through read', () => {
			const written = writeOpenCodeAgentArg('--model gpt-5.2', 'oracle');
			expect(readOpenCodeAgentArg(written)).toBe('oracle');
		});
		// tokenize() has no escape syntax, so a quote in the name cannot round-trip.
		// Stripping keeps the argument list well-formed; emitting it raw split the
		// name in two and turned the tail into a separate argument.
		it('strips quote characters instead of corrupting the argument list', () => {
			const written = writeOpenCodeAgentArg('--print', 'my"agent');
			expect(readOpenCodeAgentArg(written)).toBe('myagent');
			expect(written).toContain('--print');
		});
		it('strips single quotes too', () => {
			const written = writeOpenCodeAgentArg('--print', "o'brien");
			expect(readOpenCodeAgentArg(written)).toBe('obrien');
		});
		it('still quotes a name containing whitespace', () => {
			const written = writeOpenCodeAgentArg('', 'my agent');
			expect(readOpenCodeAgentArg(written)).toBe('my agent');
		});
		it('leaves a plain name unquoted', () => {
			expect(writeOpenCodeAgentArg('', 'build')).toBe('--agent build');
		});
	});
});
// Source: src/__tests__/shared/groupHierarchy.test.ts
describe('', () => {
	const group = (id: string, parentGroupId?: string): Group => ({
		id,
		name: id.toUpperCase(),
		emoji: '📁',
		collapsed: false,
		...(parentGroupId ? { parentGroupId } : {}),
	});
	describe('group hierarchy', () => {
		it('nests a root group below another root group', () => {
			const groups = [group('company'), group('project')];
			expect(setGroupParent(groups, 'project', 'company')).toEqual([
				group('company'),
				group('project', 'company'),
			]);
		});
		it('moves a child group back to the top level', () => {
			const groups = [group('company'), group('project', 'company')];
			expect(setGroupParent(groups, 'project', undefined)).toEqual([
				group('company'),
				group('project'),
			]);
		});
		it('rejects adding a third hierarchy level', () => {
			const groups = [group('company'), group('project', 'company'), group('service')];
			expect(canSetGroupParent(groups, 'service', 'project')).toBe(false);
			expect(setGroupParent(groups, 'service', 'project')).toBe(groups);
		});
		it('rejects nesting a group that already has children', () => {
			const groups = [group('company'), group('project', 'company'), group('portfolio')];
			expect(canSetGroupParent(groups, 'company', 'portfolio')).toBe(false);
			expect(setGroupParent(groups, 'company', 'portfolio')).toBe(groups);
		});
		it('rejects a group becoming its own ancestor', () => {
			const groups = [group('company'), group('project', 'company')];
			expect(canSetGroupParent(groups, 'company', 'project')).toBe(false);
			expect(setGroupParent(groups, 'company', 'project')).toBe(groups);
		});
		it('allows creating a child only inside an existing root group', () => {
			const groups = [group('company'), group('project', 'company')];
			expect(canCreateGroupInside(groups, 'company')).toBe(true);
			expect(canCreateGroupInside(groups, 'project')).toBe(false);
		});
		it('promotes direct children when deleting their parent', () => {
			const groups = [group('company'), group('project', 'company'), group('personal')];
			expect(removeGroupAndPromoteChildren(groups, 'company')).toEqual([
				group('project'),
				group('personal'),
			]);
		});
		it('normalizes invalid persisted parent relationships without changing valid children', () => {
			const groups = [
				group('company'),
				group('project', 'company'),
				group('orphan', 'missing'),
				group('self', 'self'),
				group('grandchild', 'project'),
			];
			expect(normalizeGroupHierarchy(groups)).toEqual([
				group('company'),
				group('project', 'company'),
				group('orphan'),
				group('self'),
				group('grandchild'),
			]);
		});
		it('promotes every member of a persisted parent cycle to root', () => {
			expect(normalizeGroupHierarchy([group('a', 'b'), group('b', 'a')])).toEqual([
				group('a'),
				group('b'),
			]);
		});
		it('promotes every invalid link in chains longer than one parent-child edge', () => {
			expect(
				normalizeGroupHierarchy([
					group('root'),
					group('level-one', 'root'),
					group('level-two', 'level-one'),
					group('level-three', 'level-two'),
				])
			).toEqual([
				group('root'),
				group('level-one', 'root'),
				group('level-two'),
				group('level-three'),
			]);
		});
		it('parks a group and leaves the others untouched', () => {
			const groups = [group('company'), group('project')];
			const next = setGroupHidden(groups, 'project', true);
			expect(next).toEqual([group('company'), { ...group('project'), hidden: true }]);
			expect(next[0]).toBe(groups[0]);
		});
		// A visible group stores no key at all, the way every group written before
		// the field existed reads back.
		it('drops the key when a group is shown again', () => {
			const groups = [{ ...group('project'), hidden: true }];
			const next = setGroupHidden(groups, 'project', false);
			expect(next[0]).not.toHaveProperty('hidden');
		});
		it('returns the same list when the group already reads that way', () => {
			const groups = [group('company'), { ...group('project'), hidden: true }];
			expect(setGroupHidden(groups, 'project', true)).toBe(groups);
			expect(setGroupHidden(groups, 'company', false)).toBe(groups);
		});
		it('returns the same list for a group that does not exist', () => {
			const groups = [group('company')];
			expect(setGroupHidden(groups, 'missing', true)).toBe(groups);
		});
		it('folds and unfolds a group, leaving the others untouched', () => {
			const groups = [group('company'), group('project')];
			const folded = setGroupCollapsed(groups, 'project', true);
			expect(folded).toEqual([group('company'), { ...group('project'), collapsed: true }]);
			expect(folded[0]).toBe(groups[0]);
			expect(setGroupCollapsed(folded, 'project', false)[1].collapsed).toBe(false);
		});
		it('folds a nested group through the same flag', () => {
			const groups = [group('company'), group('project', 'company')];
			const next = setGroupCollapsed(groups, 'project', true);
			expect(next[1]).toMatchObject({ parentGroupId: 'company', collapsed: true });
		});
		it('returns the same list when collapse is a no-op', () => {
			const groups = [{ ...group('project'), collapsed: true }];
			expect(setGroupCollapsed(groups, 'project', true)).toBe(groups);
			expect(setGroupCollapsed(groups, 'missing', false)).toBe(groups);
		});
	});
});
// Source: src/__tests__/shared/sessionPersistenceMerge.test.ts
describe('', () => {
	describe('observed session changes', () => {
		it('preserves only unchanged Host-observed human queue origins on remote saves', () => {
			const item = { id: 'human', type: 'message', text: 'Read mail', querySource: 'user' };
			const stored = { executionQueue: [item] };
			expect(
				mergeSessionPersistenceChanges(stored, stored, stored, true, false, true).executionQueue[0]
			).toEqual(item);
			for (const changed of [
				{ ...item, text: 'Different operation' },
				{ ...item, tabId: 'other-tab' },
				{ ...item, id: 'new-item' },
			]) {
				const incoming = { executionQueue: [changed] };
				const merged = mergeSessionPersistenceChanges(incoming, stored, stored, true, false, true);
				expect(merged.executionQueue[0].querySource).toBe('auto');
			}
			const incoming = { executionQueue: [item] };
			expect(
				mergeSessionPersistenceChanges(incoming, undefined, undefined, true, false, true)
					.executionQueue[0].querySource
			).toBe('auto');
			expect(
				mergeSessionPersistenceChanges(incoming, undefined, undefined).executionQueue[0].querySource
			).toBe('user');
			expect(
				mergeSessionPersistenceChanges(incoming, undefined, undefined, true).executionQueue[0]
					.querySource
			).toBe('user');
		});
		it('does not accept a remote user claim for existing automatic or legacy queue items', () => {
			for (const querySource of ['auto', undefined]) {
				const stored = { executionQueue: [{ id: 'item', text: 'Read mail', querySource }] };
				const incoming = { executionQueue: [{ ...stored.executionQueue[0], querySource: 'user' }] };
				expect(
					mergeSessionPersistenceChanges(incoming, stored, stored, true, false, true)
						.executionQueue[0].querySource
				).toBe('auto');
			}
		});
		it('accepts tab and queue drag order and new-tab insertion without stealing host group focus', () => {
			const baseline = {
				id: 'shared',
				activeGroupId: 'host-group',
				aiTabs: [
					{ id: 'a', inputValue: 'host draft' },
					{ id: 'b', inputValue: '' },
				],
				unifiedTabOrder: [
					{ id: 'a', type: 'ai' },
					{ id: 'b', type: 'ai' },
				],
				executionQueue: [{ id: 'first' }, { id: 'second' }],
			};
			const incoming = {
				...baseline,
				activeGroupId: 'remote-group',
				aiTabs: [{ id: 'new', inputValue: 'remote draft' }, ...[...baseline.aiTabs].reverse()],
				unifiedTabOrder: [{ id: 'new', type: 'ai' }, ...[...baseline.unifiedTabOrder].reverse()],
				executionQueue: [...baseline.executionQueue].reverse(),
			};
			const remote = mergeSessionPersistenceChanges(incoming, baseline, baseline, true);
			expect(remote.aiTabs.map((tab) => tab.id)).toEqual(['new', 'b', 'a']);
			expect(remote.unifiedTabOrder.map((tab) => tab.id)).toEqual(['new', 'b', 'a']);
			expect(remote.executionQueue.map((item) => item.id)).toEqual(['second', 'first']);
			expect(remote.activeGroupId).toBe('host-group');
			expect(remote.aiTabs[0].inputValue).toBe('');
			expect(remote.aiTabs[2].inputValue).toBe('host draft');
			const desktop = mergeSessionPersistenceChanges(incoming, baseline, baseline);
			expect(desktop.aiTabs.map((tab) => tab.id)).toEqual(['new', 'b', 'a']);
			expect(desktop.activeGroupId).toBe('remote-group');
		});
		it('retains peer-only tabs and does not revive removed tabs during a stale drag', () => {
			const baseline = { aiTabs: [{ id: 'a' }, { id: 'b' }, { id: 'removed' }] };
			const stored = { aiTabs: [{ id: 'a' }, { id: 'peer' }, { id: 'b' }] };
			const incoming = { aiTabs: [{ id: 'new' }, ...[...baseline.aiTabs].reverse()] };
			const merged = mergeSessionPersistenceChanges(incoming, stored, baseline);
			expect(merged.aiTabs.map((tab) => tab.id)).toEqual(['new', 'peer', 'b', 'a']);
		});
		it('keeps the host order when another client already reordered the same queue', () => {
			const baseline = { executionQueue: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] };
			const stored = { executionQueue: [{ id: 'b' }, { id: 'a' }, { id: 'c' }] };
			const incoming = { executionQueue: [...baseline.executionQueue].reverse() };
			expect(mergeSessionPersistenceChanges(incoming, stored, baseline).executionQueue).toEqual(
				stored.executionQueue
			);
		});
		it('preserves an owning ConPTY terminal with PID zero across stale remote saves and live peer reconciliation', () => {
			const baseline = {
				terminalTabs: [{ id: 'owned', pid: 0, ptyInitialized: true, name: 'Terminal' }],
			};
			const incoming = {
				terminalTabs: [
					{ ...baseline.terminalTabs[0], ptyInitialized: false, name: 'Renamed' },
					{ id: 'new', pid: 0, ptyInitialized: true, name: 'New' },
				],
			};
			const saved = mergeSessionPersistenceChanges(incoming, baseline, baseline, true);
			expect(saved.terminalTabs.find((tab) => tab.id === 'owned')).toMatchObject({
				pid: 0,
				ptyInitialized: true,
				name: 'Renamed',
			});
			expect(saved.terminalTabs.find((tab) => tab.id === 'new')).not.toHaveProperty(
				'ptyInitialized'
			);
			const firstTerminal = mergeSessionPersistenceChanges<{
				terminalTabs?: typeof incoming.terminalTabs;
			}>(incoming, {}, {}, true);
			expect(firstTerminal.terminalTabs?.[0]).not.toHaveProperty('ptyInitialized');
			const live = mergeSessionPersistenceChanges(incoming, baseline, baseline, true, true);
			expect(live.terminalTabs.find((tab) => tab.id === 'owned')).toMatchObject({
				pid: 0,
				ptyInitialized: true,
				name: 'Renamed',
			});
			expect(live.terminalTabs.find((tab) => tab.id === 'new')?.ptyInitialized).toBe(true);
		});
		it('retains live incognito tabs and client focus across persisted normal-tab updates and closure', () => {
			const normal = { id: 'normal', title: 'Before', url: 'https://example.test/' };
			const privateTab = {
				id: 'private',
				title: 'Private',
				url: 'https://private.test/',
				ephemeral: true,
			};
			const baseline = { browserTabs: [normal], activeBrowserTabId: 'normal' };
			const local = { browserTabs: [normal, privateTab], activeBrowserTabId: 'private' };
			const updated = mergeSessionPersistenceChanges(
				{ ...baseline, browserTabs: [{ ...normal, title: 'After' }] },
				local,
				baseline,
				true,
				true
			);
			expect(updated.browserTabs).toEqual([{ ...normal, title: 'After' }, privateTab]);
			expect(updated.activeBrowserTabId).toBe('private');
			const closedNormal = mergeSessionPersistenceChanges(
				{ ...baseline, browserTabs: [] },
				local,
				baseline,
				true,
				true
			);
			expect(closedNormal.browserTabs).toEqual([privateTab]);
			expect(closedNormal.activeBrowserTabId).toBe('private');
		});
	});
	describe('consumed execution queue entries', () => {
		it.each([{ waitingForConnection: undefined }, { paused: true }, { text: 'edited' }])(
			'does not retain a consumed ID after a local metadata edit %j',
			(edit) => {
				const item = {
					id: 'consumed',
					type: 'message',
					text: 'Ja bitte',
					waitingForConnection: true,
				};
				const baseline = { executionQueue: [item] };
				const unsent = { id: 'unsent', type: 'message', text: 'new work' };
				const client = { executionQueue: [{ ...item, ...edit }, unsent] };
				expect(
					mergeSessionPersistenceChanges({ executionQueue: [] }, client, baseline, true, true)
						.executionQueue
				).toEqual([unsent]);
			}
		);
		it('persists a host dequeue even if a browser updated the stored queued item', () => {
			const item = { id: 'consumed', text: 'Ja bitte' };
			const baseline = { executionQueue: [item] };
			const stored = { executionQueue: [{ ...item, paused: true }] };
			expect(
				mergeSessionPersistenceChanges({ executionQueue: [] }, stored, baseline).executionQueue
			).toEqual([]);
		});
		it('still retains edited rows in other collections', () => {
			const baseline = { aiTabs: [{ id: 'edited', name: 'before' }] };
			const stored = { aiTabs: [{ id: 'edited', name: 'after' }] };
			expect(mergeSessionPersistenceChanges({ aiTabs: [] }, stored, baseline).aiTabs).toEqual(
				stored.aiTabs
			);
		});
	});
	describe('queue recovery generations', () => {
		it('does not resurrect an already consumed recovery from an older peer baseline', () => {
			const item = { id: 'recovered', dispatchRecoveryGeneration: 1 };
			expect(
				mergeSessionPersistenceChanges(
					{ executionQueue: [item] },
					{ executionQueue: [] },
					{ executionQueue: [{ id: item.id }] },
					true,
					true
				).executionQueue
			).toEqual([]);
		});
		it('does not restore an older recovered attempt after its removal', () => {
			const item = { id: 'recovered', dispatchRecoveryGeneration: 1 };
			expect(
				mergeSessionPersistenceChanges(
					{ executionQueue: [{ ...item, dispatchRecoveryGeneration: 0 }] },
					{ executionQueue: [] },
					{ executionQueue: [item] },
					true,
					true
				).executionQueue
			).toEqual([]);
		});
	});
});
// Source: src/__tests__/shared/sshRemoteShell.test.ts
describe('', () => {
	describe('detectNonPosixRemoteShell', () => {
		it('identifies the PowerShell 5.1 rejection of &&', () => {
			expect(
				detectNonPosixRemoteShell(
					"The token '&&' is not a valid statement separator in this version."
				)
			).toBe('powershell');
		});
		it('identifies a bare PowerShell error record', () => {
			expect(detectNonPosixRemoteShell('+ FullyQualifiedErrorId : InvalidEndOfLine')).toBe(
				'powershell'
			);
		});
		it('identifies PowerShell failing to find /bin/bash', () => {
			expect(
				detectNonPosixRemoteShell(
					"The term '/bin/bash' is not recognized as the name of a cmdlet, function, script file, or operable program."
				)
			).toBe('powershell');
		});
		it('identifies cmd.exe syntax complaints', () => {
			expect(detectNonPosixRemoteShell('hostname was unexpected at this time.')).toBe('cmd');
		});
		it('identifies cmd.exe failing to find /bin/bash', () => {
			expect(
				detectNonPosixRemoteShell(
					"'/bin/bash' is not recognized as an internal or external command, operable program or batch file."
				)
			).toBe('cmd');
		});
		it('leaves ordinary SSH failures alone', () => {
			expect(detectNonPosixRemoteShell('Permission denied (publickey).')).toBeUndefined();
			expect(detectNonPosixRemoteShell('bash: claude: command not found')).toBeUndefined();
			expect(detectNonPosixRemoteShell('')).toBeUndefined();
		});
	});
	describe('nonPosixRemoteShellRemediation', () => {
		it('names the host and the shell, and hands over a fix command', () => {
			const remediation = nonPosixRemoteShellRemediation('powershell', 'PEDSIM');
			expect(remediation.code).toBe('non-posix-remote-shell');
			expect(remediation.title).toContain('Windows PowerShell');
			expect(remediation.detail).toContain('PEDSIM');
			expect(remediation.command).toContain('DefaultShell');
			expect(remediation.command).toContain('bash.exe');
			expect(remediation.docsUrl).toContain('windows-remote-hosts');
		});
		it('stays readable when no hostname was recovered', () => {
			const remediation = nonPosixRemoteShellRemediation('cmd');
			expect(remediation.detail).toContain('The remote answers');
			expect(remediation.detail).toContain('cmd.exe');
		});
		it('flattens to the same prose for surfaces with no panel', () => {
			expect(nonPosixRemoteShellMessage('cmd', 'WINBOX')).toBe(
				nonPosixRemoteShellRemediation('cmd', 'WINBOX').detail
			);
		});
		it('names each shell family', () => {
			expect(nonPosixRemoteShellName('powershell')).toBe('Windows PowerShell');
			expect(nonPosixRemoteShellName('cmd')).toBe('cmd.exe');
		});
	});
	describe('SSH error patterns for a Windows remote', () => {
		// A run against a Windows remote dies inside the agent process, not in the
		// connection test, so the streaming bank has to recognize it too.
		const patterns = getSshErrorPatterns();
		it('classifies PowerShell rejecting /bin/bash as a crash with the shell fix', () => {
			const match = matchErrorPattern(
				patterns,
				"The term '/bin/bash' is not recognized as the name of a cmdlet, function, script file, or operable program."
			);
			expect(match?.type).toBe('agent_crashed');
			expect(match?.message).toContain('DefaultShell');
			expect(match?.recoverable).toBe(false);
		});
		it('classifies cmd.exe rejecting /bin/bash the same way', () => {
			const match = matchErrorPattern(
				patterns,
				"'/bin/bash' is not recognized as an internal or external command, operable program or batch file."
			);
			expect(match?.type).toBe('agent_crashed');
			expect(match?.message).toContain('DefaultShell');
		});
		it('does not claim a POSIX command-not-found is a Windows shell', () => {
			const match = matchErrorPattern(patterns, 'bash: claude: command not found');
			expect(match?.message).not.toContain('DefaultShell');
		});
	});
});
// Source: src/__tests__/shared/onboardingSeries.test.ts
describe('', () => {
	describe('onboarding step registry', () => {
		it('gives every step its own seen flag', () => {
			// One flag per step is what lets a later release add a fourth step
			// without re-showing the three a user already answered.
			const flags = ONBOARDING_STEPS.map((step) => ONBOARDING_STEP_FLAGS[step]);
			expect(flags.every(Boolean)).toBe(true);
			expect(new Set(flags).size).toBe(flags.length);
		});
		it('keeps typography first', () => {
			// It decides what every later surface is DRAWN in, so asking about
			// themes first would preview the wrong app.
			expect(ONBOARDING_STEPS[0]).toBe('typography');
		});
	});
	describe('isThemeStepEligible', () => {
		it('always offers a theme to a new user', () => {
			expect(isThemeStepEligible('new', DEFAULT_THEME_ID)).toBe(true);
			expect(isThemeStepEligible('new', 'nord')).toBe(true);
		});
		it('offers it to a returning user only while still on the default', () => {
			expect(isThemeStepEligible('returning', DEFAULT_THEME_ID)).toBe(true);
		});
		it('leaves a returning user who already picked a theme alone', () => {
			// They found the picker on their own. Reopening that decision uninvited
			// would be presumptuous.
			expect(isThemeStepEligible('returning', 'nord')).toBe(false);
			expect(isThemeStepEligible('returning', 'github-light')).toBe(false);
		});
	});
	describe('planOnboardingSeries', () => {
		const base = { seen: {}, activeThemeId: DEFAULT_THEME_ID };
		it('runs every step for a fresh install', () => {
			expect(planOnboardingSeries({ ...base, audience: 'new' })).toEqual([
				'typography',
				'theme',
				'updates',
				'agentPowers',
			]);
		});
		it('skips a step the user has already been shown', () => {
			expect(
				planOnboardingSeries({ ...base, audience: 'new', seen: { typography: true } })
			).toEqual(['theme', 'updates', 'agentPowers']);
		});
		it('shows only the updates step to a user who finished the series before it existed', () => {
			// The reason every step has its own flag: an existing user sees the new
			// step once, and nothing they already answered.
			expect(
				planOnboardingSeries({
					audience: 'returning',
					seen: { typography: true, theme: true, agentPowers: true },
					activeThemeId: 'nord',
				})
			).toEqual(['updates']);
		});
		it('drops the theme step for a returning user who has chosen one', () => {
			expect(
				planOnboardingSeries({ audience: 'returning', seen: {}, activeThemeId: 'nord' })
			).toEqual(['typography', 'updates', 'agentPowers']);
		});
		it('returns nothing once every step has been seen', () => {
			expect(
				planOnboardingSeries({
					...base,
					audience: 'new',
					seen: { typography: true, theme: true, updates: true, agentPowers: true },
				})
			).toEqual([]);
		});
		it('keeps the declared order regardless of which steps survive', () => {
			const plan = planOnboardingSeries({ ...base, audience: 'new', seen: { theme: true } });
			expect(plan).toEqual(['typography', 'updates', 'agentPowers']);
		});
		it('force ignores both the seen flags and the theme gate', () => {
			// The debug entries exist to replay a series that has, by definition,
			// already been seen.
			expect(
				planOnboardingSeries({
					audience: 'returning',
					seen: { typography: true, theme: true, agentPowers: true },
					activeThemeId: 'nord',
					force: true,
				})
			).toEqual([...ONBOARDING_STEPS]);
		});
	});
});
// Source: src/__tests__/shared/codexTokenUsage.test.ts
describe('', () => {
	/** One `token_count` event's `info`, in the shape Codex writes it. */
	function info(
		total: {
			input: number;
			cached: number;
			output: number;
			reasoning?: number;
		},
		last?: {
			input: number;
			cached: number;
			output: number;
			reasoning?: number;
		}
	) {
		const shape = (u: { input: number; cached: number; output: number; reasoning?: number }) => ({
			input_tokens: u.input,
			cached_input_tokens: u.cached,
			output_tokens: u.output,
			reasoning_output_tokens: u.reasoning ?? 0,
		});
		return {
			total_token_usage: shape(total),
			...(last ? { last_token_usage: shape(last) } : {}),
		};
	}
	describe('CodexTokenCounts', () => {
		it('starts empty', () => {
			const counts = new CodexTokenCounts();
			expect(counts.isEmpty).toBe(true);
			expect(counts.inputTokens).toBe(0);
		});
		it('sums last_token_usage rather than the cumulative total', () => {
			const counts = new CodexTokenCounts();
			// Three turns of 100 input each. Summing total_token_usage would give 600.
			counts.addTokenCountEvent(
				info({ input: 100, cached: 50, output: 10 }, { input: 100, cached: 50, output: 10 })
			);
			counts.addTokenCountEvent(
				info({ input: 200, cached: 120, output: 20 }, { input: 100, cached: 70, output: 10 })
			);
			counts.addTokenCountEvent(
				info({ input: 300, cached: 190, output: 30 }, { input: 100, cached: 70, output: 10 })
			);
			expect(counts.inputTokens).toBe(300);
			expect(counts.outputTokens).toBe(30);
			expect(counts.cachedTokens).toBe(190);
			expect(counts.isEmpty).toBe(false);
		});
		it('falls back to the cumulative delta when last_token_usage is absent', () => {
			const counts = new CodexTokenCounts();
			counts.addTokenCountEvent(info({ input: 100, cached: 50, output: 10 }));
			counts.addTokenCountEvent(info({ input: 250, cached: 120, output: 25 }));
			expect(counts.inputTokens).toBe(250);
			expect(counts.outputTokens).toBe(25);
			expect(counts.cachedTokens).toBe(120);
		});
		it('treats a total that moves backwards as a restarted counter', () => {
			const counts = new CodexTokenCounts();
			counts.addTokenCountEvent(info({ input: 500, cached: 400, output: 50 }));
			// Resume: Codex starts a fresh running total rather than continuing.
			counts.addTokenCountEvent(info({ input: 80, cached: 60, output: 5 }));
			counts.addTokenCountEvent(info({ input: 160, cached: 130, output: 12 }));
			expect(counts.inputTokens).toBe(500 + 160);
			expect(counts.outputTokens).toBe(50 + 12);
		});
		it('folds reasoning tokens into output', () => {
			const counts = new CodexTokenCounts();
			counts.addTokenCountEvent(
				info(
					{ input: 10, cached: 0, output: 4, reasoning: 6 },
					{ input: 10, cached: 0, output: 4, reasoning: 6 }
				)
			);
			expect(counts.outputTokens).toBe(10);
		});
		it('sums turn.completed usage, which is already per-turn', () => {
			const counts = new CodexTokenCounts();
			counts.addTurn({ input_tokens: 100, output_tokens: 10, cached_input_tokens: 40 });
			counts.addTurn({ input_tokens: 120, output_tokens: 12, cached_input_tokens: 90 });
			expect(counts.inputTokens).toBe(220);
			expect(counts.outputTokens).toBe(22);
			expect(counts.cachedTokens).toBe(130);
		});
		it('ignores null info and null usage', () => {
			const counts = new CodexTokenCounts();
			counts.addTokenCountEvent(null);
			counts.addTokenCountEvent({ total_token_usage: null, last_token_usage: null });
			counts.addTurn(undefined);
			expect(counts.isEmpty).toBe(true);
		});
		it('keeps the cumulative baseline current across a mixed event stream', () => {
			const counts = new CodexTokenCounts();
			// Turn 1 reports both shapes, turn 2 only the cumulative one.
			counts.addTokenCountEvent(
				info({ input: 100, cached: 50, output: 10 }, { input: 100, cached: 50, output: 10 })
			);
			counts.addTokenCountEvent(info({ input: 250, cached: 120, output: 25 }));
			expect(counts.inputTokens).toBe(250);
			expect(counts.cachedTokens).toBe(120);
		});
	});
});
// Source: src/__tests__/shared/fileCategories.test.ts
describe('', () => {
	describe('getFileExtension', () => {
		it('lowercases the extension', () => {
			expect(getFileExtension('Report.PDF')).toBe('pdf');
		});
		it('ignores dots in parent directories', () => {
			expect(getFileExtension('/a.b.c/dir/Makefile')).toBe('');
		});
		it('treats a leading dot as part of the name, not a separator', () => {
			expect(getFileExtension('.gitignore')).toBe('');
		});
		it('takes the last extension of a multi-part name', () => {
			expect(getFileExtension('archive.tar.gz')).toBe('gz');
		});
	});
	describe('getFileCategory', () => {
		it.each([
			['App.tsx', 'code'],
			['main.py', 'code'],
			['styles.scss', 'code'],
			['deploy.sh', 'code'],
			['Dockerfile', 'code'],
			['Makefile', 'code'],
			['README.md', 'docs'],
			['spec.rst', 'docs'],
			['contract.pdf', 'docs'],
			['LICENSE', 'docs'],
			['package.json', 'data'],
			['cue.yaml', 'data'],
			['rows.csv', 'data'],
			['events.parquet', 'data'],
			['app.log', 'data'],
			['.gitignore', 'data'],
			['.env', 'data'],
			['diagram.svg', 'media'],
			['shot.PNG', 'media'],
			['theme.mp3', 'media'],
			['demo.mp4', 'media'],
		])('classifies %s as %s', (name, expected) => {
			expect(getFileCategory(name)).toBe(expected);
		});
		it.each(['program.exe', 'data.bin', 'archive.zip', 'raw.mkv', 'lib.so'])(
			'returns null for %s, which Maestro cannot open',
			(name) => {
				expect(getFileCategory(name)).toBeNull();
			}
		);
		it('classifies by basename, not by the path around it', () => {
			expect(getFileCategory('/Users/x/notes.md/actually.ts')).toBe('code');
		});
	});
	describe('isPreviewableFile', () => {
		it('agrees with getFileCategory on every sample', () => {
			const samples = [
				'App.tsx',
				'README.md',
				'package.json',
				'shot.png',
				'theme.mp3',
				'program.exe',
				'archive.zip',
			];
			for (const name of samples) {
				expect(isPreviewableFile(name)).toBe(getFileCategory(name) !== null);
			}
		});
	});
	describe('matchesFileCategory', () => {
		it('passes everything under "all"', () => {
			expect(matchesFileCategory('program.exe', 'all')).toBe(true);
			expect(matchesFileCategory('App.tsx', 'all')).toBe(true);
		});
		it('passes only the file’s own bucket', () => {
			const matched = FILE_CATEGORIES.filter((key) => matchesFileCategory('App.tsx', key));
			expect(matched).toEqual(['code']);
		});
	});
});
// Source: src/__tests__/shared/marketplace-compatibility.test.ts
describe('', () => {
	function makePlaybook(overrides: Partial<MarketplacePlaybook>): MarketplacePlaybook {
		return {
			id: 'test',
			title: 'Test',
			description: 'Test playbook',
			category: 'Development',
			author: 'Test',
			lastUpdated: '2026-01-01',
			path: 'test',
			documents: [],
			loopEnabled: false,
			prompt: null,
			...overrides,
		};
	}
	describe('isCompatible', () => {
		it('returns true when minMaestroVersion is absent', () => {
			expect(isCompatible(makePlaybook({}), '0.1.0')).toBe(true);
		});
		it('returns true when minMaestroVersion is invalid semver (treats as no minimum)', () => {
			expect(isCompatible(makePlaybook({ minMaestroVersion: 'not-a-version' }), '1.0.0')).toBe(
				true
			);
		});
		it('returns true when running version is invalid (defensive fallback)', () => {
			expect(isCompatible(makePlaybook({ minMaestroVersion: '1.0.0' }), 'unknown')).toBe(true);
		});
		// Documented edge cases from the spec
		it('final release ≥ its own prerelease', () => {
			expect(isCompatible(makePlaybook({ minMaestroVersion: '0.16.17-rc' }), '0.16.17')).toBe(true);
		});
		it('exact prerelease match', () => {
			expect(isCompatible(makePlaybook({ minMaestroVersion: '0.16.17-rc' }), '0.16.17-rc')).toBe(
				true
			);
		});
		it('newer prerelease ≥ older prerelease', () => {
			expect(
				isCompatible(makePlaybook({ minMaestroVersion: '0.16.17-rc.1' }), '0.16.17-rc.2')
			).toBe(true);
		});
		it('older release < newer prerelease', () => {
			expect(isCompatible(makePlaybook({ minMaestroVersion: '0.16.17-rc' }), '0.16.16')).toBe(
				false
			);
		});
		it('newer minor (even prerelease) ≥ older final', () => {
			expect(isCompatible(makePlaybook({ minMaestroVersion: '0.16.17' }), '0.17.0-alpha.1')).toBe(
				true
			);
		});
		// Case-insensitivity for prerelease tags - addresses the package.json
		// using "0.16.17-RC" (uppercase) while playbook manifests pin "0.16.17-rc".
		it('treats uppercase and lowercase prerelease tags as equivalent', () => {
			expect(isCompatible(makePlaybook({ minMaestroVersion: '0.16.17-rc' }), '0.16.17-RC')).toBe(
				true
			);
			expect(isCompatible(makePlaybook({ minMaestroVersion: '0.16.17-RC' }), '0.16.17-rc')).toBe(
				true
			);
		});
		it('older release blocked by newer min', () => {
			expect(isCompatible(makePlaybook({ minMaestroVersion: '99.0.0' }), '0.16.0')).toBe(false);
		});
	});
	describe('isBeta', () => {
		it('returns true only for the strict boolean true', () => {
			expect(isBeta(makePlaybook({ beta: true }))).toBe(true);
		});
		it('returns false when absent', () => {
			expect(isBeta(makePlaybook({}))).toBe(false);
		});
		it('returns false for false', () => {
			expect(isBeta(makePlaybook({ beta: false }))).toBe(false);
		});
		it('returns false for truthy non-boolean values', () => {
			// Cast through unknown to simulate manifest data that didn't validate.
			expect(isBeta(makePlaybook({ beta: 'yes' as unknown as boolean }))).toBe(false);
			expect(isBeta(makePlaybook({ beta: 1 as unknown as boolean }))).toBe(false);
			expect(isBeta(makePlaybook({ beta: 'true' as unknown as boolean }))).toBe(false);
		});
	});
});
// Source: src/__tests__/shared/uiSurfaces.test.ts
describe('', () => {
	describe('UI surface registry', () => {
		it('has unique ids and aliases across every surface', () => {
			const names = UI_SURFACES.flatMap((surface) => [surface.id, ...(surface.aliases ?? [])]);
			expect(new Set(names).size).toBe(names.length);
		});
		it('references only shortcut ids that actually exist', () => {
			for (const surface of UI_SURFACES) {
				if (!surface.shortcutId) continue;
				const shortcut =
					DEFAULT_SHORTCUTS[surface.shortcutId] ?? FIXED_SHORTCUTS[surface.shortcutId];
				expect(shortcut, `missing shortcut for ${surface.id}`).toBeDefined();
			}
		});
		it('gives every surface a unique set of tab ids', () => {
			for (const surface of UI_SURFACES) {
				const ids = surfaceTabIds(surface);
				expect(new Set(ids).size).toBe(ids.length);
			}
		});
	});
	describe('resolveUiSurface', () => {
		it('resolves by id, by alias, and case-insensitively', () => {
			expect(resolveUiSurface('cue')?.id).toBe('cue');
			expect(resolveUiSurface('maestro-cue')?.id).toBe('cue');
			expect(resolveUiSurface('  Usage  ')?.id).toBe('usage-dashboard');
		});
		it('resolves the Send Feedback modal so `open feedback` works', () => {
			const feedback = resolveUiSurface('feedback');
			expect(feedback?.modal).toBe('feedback');
			expect(resolveUiSurface('bug-report')?.id).toBe('feedback');
		});
		it('resolves the Throughput Gauge by id and by every alias', () => {
			for (const name of ['throughput-gauge', 'gauge', 'tokens-per-second', 'tps']) {
				expect(resolveUiSurface(name)?.id, name).toBe('throughput-gauge');
			}
			expect(resolveUiSurface('gauge')?.encore).toBe('throughputGauge');
		});
		it('points the Notification Center at the Left Bar bell, with no Encore gate', () => {
			const surface = resolveUiSurface('inbox');
			expect(surface?.id).toBe('notification-center');
			expect(surface?.encore).toBeUndefined();
			expect(surface?.click).toContain('the bell in the Left Bar header');
		});
		it('returns null for an unknown or empty name', () => {
			expect(resolveUiSurface('nope')).toBeNull();
			expect(resolveUiSurface('')).toBeNull();
		});
	});
	describe('resolveUiSurfaceTab', () => {
		const cue = resolveUiSurface('cue')!;
		it('resolves a tab by id and by its display label', () => {
			expect(resolveUiSurfaceTab(cue, 'scheduled')?.id).toBe('scheduled');
			expect(resolveUiSurfaceTab(cue, 'Scheduled Tasks')?.id).toBe('scheduled');
		});
		it('no longer has the Bundles or Readiness tabs', () => {
			expect(resolveUiSurfaceTab(cue, 'bundles')).toBeNull();
			expect(resolveUiSurfaceTab(cue, 'readiness')).toBeNull();
		});
		it('returns null for a tab the surface does not have', () => {
			expect(resolveUiSurfaceTab(cue, 'nope')).toBeNull();
			const about = resolveUiSurface('about')!;
			expect(resolveUiSurfaceTab(about, 'anything')).toBeNull();
		});
	});
	describe('uiSurfaceRefusal', () => {
		it('refuses a surface whose Encore Feature is off, and allows it when on', () => {
			const notes = resolveUiSurface('director-notes')!;
			expect(uiSurfaceRefusal(notes, null, { directorNotes: false })).toContain(
				'Settings → Plugins'
			);
			expect(uiSurfaceRefusal(notes, null, { directorNotes: true })).toBeNull();
		});
		it("refuses the Usage Dashboard's Cue tab while Cue is off, but not the dashboard", () => {
			const dashboard = resolveUiSurface('usage-dashboard')!;
			const cueTab = resolveUiSurfaceTab(dashboard, 'cue');
			const flags = { usageStats: true, maestroCue: false };
			expect(uiSurfaceRefusal(dashboard, null, flags)).toBeNull();
			expect(uiSurfaceRefusal(dashboard, cueTab, flags)).toContain('Cue');
			expect(uiSurfaceRefusal(dashboard, cueTab, { ...flags, maestroCue: true })).toBeNull();
		});
		it('never refuses an ungated surface', () => {
			expect(uiSurfaceRefusal(resolveUiSurface('about')!, null, {})).toBeNull();
		});
	});
	describe('describeSurfaceAccess', () => {
		it('lists every manual path so an agent can teach the user', () => {
			const cue = resolveUiSurface('cue')!;
			const keys = DEFAULT_SHORTCUTS[cue.shortcutId!].keys;
			const hint = describeSurfaceAccess(cue, formatShortcutKeysFor(keys, false, '+'));
			expect(hint).toContain('Alt+Q');
			expect(hint).toContain('command palette');
			expect(hint).toContain(cue.click!);
		});
		it('omits the hotkey clause when the surface has none', () => {
			const marketplace = resolveUiSurface('marketplace')!;
			const hint = describeSurfaceAccess(marketplace);
			expect(hint).not.toContain('press');
			expect(hint).toContain('command palette');
		});
	});
	describe('formatShortcutKeysFor', () => {
		it('uses macOS symbols with spaces and text with plus signs elsewhere', () => {
			expect(formatShortcutKeysFor(['Meta', 'Shift', 'k'], true)).toBe('⌘ ⇧ K');
			expect(formatShortcutKeysFor(['Meta', 'Shift', 'k'], false)).toBe('Ctrl+Shift+K');
		});
	});
});
// Source: src/__tests__/shared/buildProvenance.test.ts
describe('', () => {
	const DSN = 'https://abc123@o1.ingest.us.sentry.io/456';
	describe('parseBuildProvenance', () => {
		it('accepts a well-formed official provenance file', () => {
			const result = parseBuildProvenance(
				JSON.stringify({ official: true, sentryDsn: DSN, generatedAt: '2026-09-21T00:00:00.000Z' })
			);
			expect(result.official).toBe(true);
			expect(result.sentryDsn).toBe(DSN);
			expect(result.generatedAt).toBe('2026-09-21T00:00:00.000Z');
		});
		it('accepts a fork build that supplied its own DSN but does not mark it official', () => {
			const result = parseBuildProvenance(JSON.stringify({ official: false, sentryDsn: DSN }));
			expect(result.official).toBe(false);
			expect(result.sentryDsn).toBe(DSN);
		});
		it('treats a missing file as unofficial with no DSN', () => {
			expect(parseBuildProvenance(null)).toEqual(UNOFFICIAL_BUILD);
			expect(parseBuildProvenance(undefined)).toEqual(UNOFFICIAL_BUILD);
			expect(parseBuildProvenance('')).toEqual(UNOFFICIAL_BUILD);
		});
		it('treats unparseable JSON as unofficial rather than throwing', () => {
			expect(parseBuildProvenance('{ not json')).toEqual(UNOFFICIAL_BUILD);
			// A torn write is the realistic corruption mode, not random bytes.
			expect(parseBuildProvenance('{"official": true, "sentryDsn": "https://abc')).toEqual(
				UNOFFICIAL_BUILD
			);
		});
		it('treats non-object JSON as unofficial', () => {
			expect(parseBuildProvenance('null')).toEqual(UNOFFICIAL_BUILD);
			expect(parseBuildProvenance('"a string"')).toEqual(UNOFFICIAL_BUILD);
			expect(parseBuildProvenance('42')).toEqual(UNOFFICIAL_BUILD);
		});
		it('refuses to report official when no DSN came with the claim', () => {
			// A file that says official but carries no address reports nowhere anyway.
			// Returning official:true there would tell callers reporting is live when it
			// is not, which is the one lie that makes this gate useless.
			expect(parseBuildProvenance(JSON.stringify({ official: true }))).toEqual(UNOFFICIAL_BUILD);
			expect(parseBuildProvenance(JSON.stringify({ official: true, sentryDsn: '' }))).toEqual(
				UNOFFICIAL_BUILD
			);
			expect(parseBuildProvenance(JSON.stringify({ official: true, sentryDsn: '   ' }))).toEqual(
				UNOFFICIAL_BUILD
			);
		});
		it('ignores a non-string DSN', () => {
			expect(parseBuildProvenance(JSON.stringify({ official: true, sentryDsn: 42 }))).toEqual(
				UNOFFICIAL_BUILD
			);
			expect(
				parseBuildProvenance(JSON.stringify({ official: true, sentryDsn: { url: DSN } }))
			).toEqual(UNOFFICIAL_BUILD);
		});
		it('requires `official` to be exactly true, not merely truthy', () => {
			// JSON from a hand-edited file could carry "true" or 1. Neither is our
			// pipeline's output, so neither earns the official tag.
			expect(
				parseBuildProvenance(JSON.stringify({ official: 'true', sentryDsn: DSN })).official
			).toBe(false);
			expect(parseBuildProvenance(JSON.stringify({ official: 1, sentryDsn: DSN })).official).toBe(
				false
			);
		});
		it('trims surrounding whitespace off the DSN', () => {
			expect(
				parseBuildProvenance(JSON.stringify({ official: true, sentryDsn: ` ${DSN}\n` })).sentryDsn
			).toBe(DSN);
		});
		it('drops a non-string generatedAt instead of passing it through', () => {
			const result = parseBuildProvenance(
				JSON.stringify({ official: true, sentryDsn: DSN, generatedAt: 1758412800000 })
			);
			expect(result.generatedAt).toBeUndefined();
		});
	});
});
// Source: src/__tests__/shared/bundledFonts.test.ts
describe('', () => {
	const REPO_ROOT = path.join(__dirname, '../../..');
	const GENERATED_CSS = path.join(REPO_ROOT, 'src/renderer/generated-fonts.css');
	const FONTS_DIR = path.join(REPO_ROOT, 'src/renderer/public/fonts');
	const FETCH_SCRIPT = path.join(REPO_ROOT, 'scripts/fetch-webfonts.mjs');
	describe('bundled font catalog', () => {
		it('has no duplicate families', () => {
			expect(new Set(BUNDLED_FONT_NAMES).size).toBe(BUNDLED_FONT_NAMES.length);
		});
		it('matches a name case-insensitively but never a non-bundled one', () => {
			expect(isBundledFont('jetbrains mono')).toBe(true);
			expect(isBundledFont('  Inter  ')).toBe(true);
			expect(isBundledFont('Menlo')).toBe(false);
			expect(isBundledFont('')).toBe(false);
			expect(isBundledFont(undefined)).toBe(false);
		});
		it('maps a proprietary face to its metric-compatible substitute', () => {
			// Metric-compatible means identical advance widths, so swapping it into
			// a layout built for the original reflows nothing.
			expect(bundledSubstituteFor('Arial')?.name).toBe('Arimo');
			expect(bundledSubstituteFor('Courier New')?.name).toBe('Cousine');
			expect(bundledSubstituteFor('Georgia')?.name).toBe('Gelasio');
			expect(bundledSubstituteFor('Comic Sans MS')).toBeUndefined();
		});
		it('never claims a proprietary face is itself bundled', () => {
			// These are licensed to the OS and cannot be redistributed. Listing one
			// here would promise a font the app cannot ship.
			for (const proprietary of [
				'Menlo',
				'SF Mono',
				'Consolas',
				'Segoe UI',
				'Arial',
				'Helvetica',
				'Verdana',
				'Tahoma',
				'Georgia',
				'Avenir Next',
			]) {
				expect(isBundledFont(proprietary)).toBe(false);
			}
		});
		it('exposes the full record for a bundled name', () => {
			expect(getBundledFont('Arimo')?.substituteFor).toBe('Arial');
			expect(getBundledFont('Nonesuch')).toBeUndefined();
		});
	});
	describe('bundled fonts are actually present', () => {
		it('generated the @font-face stylesheet', () => {
			expect(existsSync(GENERATED_CSS)).toBe(true);
		});
		it('declares an @font-face for every catalogued family', () => {
			// A name in the catalog with no face behind it is a font the picker
			// promises and the app cannot deliver.
			const css = readFileSync(GENERATED_CSS, 'utf8');
			for (const font of BUNDLED_FONTS) {
				expect(css).toContain(`font-family: '${font.name}'`);
			}
		});
		it('ships a woff2 file for every declared face', () => {
			const css = readFileSync(GENERATED_CSS, 'utf8');
			const referenced = [...css.matchAll(/url\('\/fonts\/([^']+)'\)/g)].map((m) => m[1]);
			expect(referenced.length).toBeGreaterThan(0);
			const present = new Set(readdirSync(FONTS_DIR));
			for (const file of referenced) {
				expect(present.has(file)).toBe(true);
			}
		});
		it('keeps the catalog and the download script in sync', () => {
			// The script decides what is fetched; the catalog decides what is
			// offered. A family in one and not the other is a broken promise in
			// whichever direction it drifts.
			const script = readFileSync(FETCH_SCRIPT, 'utf8');
			const fetched = [...script.matchAll(/\{ name: '([^']+)', axis:/g)].map((m) => m[1]);
			expect(new Set(fetched)).toEqual(new Set(BUNDLED_FONT_NAMES));
		});
	});
});
// Source: src/__tests__/shared/agentDelegation.test.ts
describe('', () => {
	describe('caller identity env', () => {
		it('round-trips the agent and tab through the environment', () => {
			const env = buildCallerIdentityEnv('agent-1', 'tab-1');
			expect(env).toEqual({
				[CALLER_AGENT_ID_ENV_VAR]: 'agent-1',
				[CALLER_TAB_ID_ENV_VAR]: 'tab-1',
			});
			expect(readCallerIdentity(env)).toEqual({ agentId: 'agent-1', tabId: 'tab-1' });
		});
		it('omits the tab when the spawn had none', () => {
			const env = buildCallerIdentityEnv('agent-1');
			expect(env).not.toHaveProperty(CALLER_TAB_ID_ENV_VAR);
			expect(readCallerIdentity(env)).toEqual({ agentId: 'agent-1' });
		});
		it('treats a blank agent as no caller and drops a tab that has no agent', () => {
			expect(readCallerIdentity({})).toBeUndefined();
			expect(readCallerIdentity({ [CALLER_AGENT_ID_ENV_VAR]: '  ' })).toBeUndefined();
			expect(readCallerIdentity({ [CALLER_TAB_ID_ENV_VAR]: 'tab-1' })).toBeUndefined();
			expect(
				readCallerIdentity({
					[CALLER_AGENT_ID_ENV_VAR]: 'agent-1',
					[CALLER_TAB_ID_ENV_VAR]: '',
				})
			).toEqual({ agentId: 'agent-1' });
		});
		it('never reuses MAESTRO_AGENT_ID, which tells a pianola watch it is Pianola', () => {
			expect(CALLER_AGENT_ID_ENV_VAR).not.toBe('MAESTRO_AGENT_ID');
		});
	});
	describe('withoutCallerIdentityEnv', () => {
		it('collapses an identity-only record to undefined, like an agent with no overrides', () => {
			expect(withoutCallerIdentityEnv(buildCallerIdentityEnv('agent-1', 'tab-1'))).toBeUndefined();
			expect(withoutCallerIdentityEnv(undefined)).toBeUndefined();
		});
		it('keeps real configuration and leaves the input untouched', () => {
			const env = { ...buildCallerIdentityEnv('agent-1'), CLAUDE_CONFIG_DIR: '/cfg' };
			expect(withoutCallerIdentityEnv(env)).toEqual({ CLAUDE_CONFIG_DIR: '/cfg' });
			expect(env).toHaveProperty(CALLER_AGENT_ID_ENV_VAR, 'agent-1');
		});
	});
	describe('caller wire fields', () => {
		it('spreads nothing when there is no caller', () => {
			expect(callerMessageFields(undefined)).toEqual({});
		});
		it('round-trips a caller through a message', () => {
			const fields = callerMessageFields({ agentId: 'agent-1', tabId: 'tab-1' });
			expect(fields).toEqual({ fromSessionId: 'agent-1', fromTabId: 'tab-1' });
			expect(readCallerMessageFields({ type: 'send_command', ...fields })).toEqual(fields);
		});
		it('rejects blank and non-string fields from an untrusted message', () => {
			expect(readCallerMessageFields({})).toBeUndefined();
			expect(readCallerMessageFields({ fromSessionId: 42 })).toBeUndefined();
			expect(readCallerMessageFields({ fromSessionId: ' ' })).toBeUndefined();
			expect(readCallerMessageFields({ fromSessionId: 'agent-1', fromTabId: 7 })).toEqual({
				fromSessionId: 'agent-1',
			});
		});
	});
	describe('isSelfDispatch', () => {
		const caller = { fromSessionId: 'agent-1', fromTabId: 'tab-1' };
		it('is false for a different agent', () => {
			expect(isSelfDispatch(caller, 'agent-2')).toBe(false);
			expect(isSelfDispatch(caller, 'agent-2', 'tab-1')).toBe(false);
		});
		it('is true for the caller own tab, named or implied by the active tab', () => {
			expect(isSelfDispatch(caller, 'agent-1', 'tab-1')).toBe(true);
			expect(isSelfDispatch(caller, 'agent-1')).toBe(true);
		});
		it('is false for another tab in the same agent, which is a real hand-off', () => {
			expect(isSelfDispatch(caller, 'agent-1', 'tab-2')).toBe(false);
		});
	});
});
// Source: src/__tests__/shared/processErrors.test.ts
describe('', () => {
	describe('isAgentAlreadyRunningError', () => {
		it('matches the message ProcessManager actually throws', () => {
			expect(isAgentAlreadyRunningError(new Error(agentAlreadyRunningMessage('abc-ai-def')))).toBe(
				true
			);
		});
		it('matches it after Electron re-wraps it as an IPC rejection', () => {
			// Verbatim shape from the MAESTRO-ZS event.
			const wrapped = new Error(
				"Error invoking remote method 'process:spawn': Error: Agent process already running for " +
					'session d9f165e2-4254-4ec8-a614-8735878ee831-ai-f192f4eb-bc4f-4122-8f69-8b9e0c122691'
			);
			expect(isAgentAlreadyRunningError(wrapped)).toBe(true);
		});
		it('does not match other spawn failures', () => {
			expect(isAgentAlreadyRunningError(new Error('spawn ENOENT: claude'))).toBe(false);
			expect(isAgentAlreadyRunningError(new Error('Agent claude-code is not available'))).toBe(
				false
			);
		});
		it('handles non-Error values safely', () => {
			expect(isAgentAlreadyRunningError(null)).toBe(false);
			expect(isAgentAlreadyRunningError(undefined)).toBe(false);
			expect(isAgentAlreadyRunningError(AGENT_ALREADY_RUNNING_PREFIX)).toBe(true);
		});
	});
});
