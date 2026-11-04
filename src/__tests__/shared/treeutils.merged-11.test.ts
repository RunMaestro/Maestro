// Consolidated from current rc sources; per-source hooks and state stay in an unnamed suite.
// Source: src/__tests__/shared/treeUtils.test.ts
// Source: src/__tests__/shared/groupChatQueueModel.test.ts
// Source: src/__tests__/shared/focusPlacement.test.ts
// Source: src/__tests__/shared/agentEnvironment.test.ts
// Source: src/__tests__/shared/additionalDirectories.test.ts
// Source: src/__tests__/shared/usageStats.test.ts
// Source: src/__tests__/shared/hostLocalPreview.test.ts
import { describe, expect, it } from 'vitest';
/**
 * Tests for shared tree traversal utilities
 */
import {
	TreeNode,
	walkTreePartitioned,
	getAllFilePaths,
	getAllFolderPaths,
	buildFileIndex,
} from '../../shared/treeUtils';
import {
	canDrain,
	completeHead,
	emptyQueueState,
	enqueueMessage,
	failHead,
	markSending,
	mustQueue,
	parseQueueState,
	pauseQueue,
	removeItem,
	reorderItem,
	requeueAtFront,
	requeueFailedAtFront,
	resumeQueue,
	unmarkSending,
} from '../../shared/groupChatQueueModel';
import type { GroupChatQueuedItem } from '../../shared/group-chat-types';
import {
	ALREADY_QUIET_VERBS,
	CLI_BACKGROUND_DEFAULTS,
	isAlreadyQuietVerb,
	resolveBackgroundFlag,
	readBackgroundField,
	readSwitchToAgentField,
	type BackgroundCapableVerb,
} from '../../shared/focusPlacement';
import {
	envSourceLabel,
	isSecretEnvKey,
	maskEnvValue,
	resolveAgentEnvironment,
	isBlankEnvValue,
	isBlankEnvKey,
	stripBlankEnvVars,
} from '../../shared/agentEnvironment';
import {
	normalizeAdditionalDirectories,
	formatAdditionalDirectoriesForPrompt,
} from '../../shared/additionalDirectories';
import { substituteTemplateVariables } from '../../shared/templateVariables';
import type { AdditionalDirectory } from '../../shared/types';
import type { UsageStats } from '../../shared/types';
import type { SessionTokenTotals } from '../../shared/stats-types';
import {
	sumUsageTokens,
	hasUsage,
	resolveUsageCost,
	aggregateRangeUsage,
	aggregateUsage,
} from '../../shared/usageStats';
import { calculateModelCost } from '../../shared/modelPricing';
import { isHostLocalPreviewUrl } from '../../shared/hostLocalPreview';
// Source: src/__tests__/shared/treeUtils.test.ts
describe('', () => {
	describe('treeUtils', () => {
		// Sample tree structure for tests
		const sampleTree: TreeNode[] = [
			{
				name: 'src',
				type: 'folder',
				children: [
					{ name: 'index.ts', type: 'file' },
					{ name: 'utils.ts', type: 'file' },
					{
						name: 'components',
						type: 'folder',
						children: [
							{ name: 'Button.tsx', type: 'file' },
							{ name: 'Modal.tsx', type: 'file' },
						],
					},
				],
			},
			{ name: 'README.md', type: 'file' },
			{ name: 'package.json', type: 'file' },
			{
				name: 'docs',
				type: 'folder',
				children: [{ name: 'guide.md', type: 'file' }],
			},
		];
		describe('walkTreePartitioned', () => {
			it('returns empty sets for empty tree', () => {
				const result = walkTreePartitioned([]);
				expect(result.files.size).toBe(0);
				expect(result.folders.size).toBe(0);
			});
			it('separates files and folders correctly', () => {
				const result = walkTreePartitioned(sampleTree);
				// Check files
				expect(result.files.has('src/index.ts')).toBe(true);
				expect(result.files.has('src/utils.ts')).toBe(true);
				expect(result.files.has('src/components/Button.tsx')).toBe(true);
				expect(result.files.has('README.md')).toBe(true);
				expect(result.files.size).toBe(7);
				// Check folders
				expect(result.folders.has('src')).toBe(true);
				expect(result.folders.has('src/components')).toBe(true);
				expect(result.folders.has('docs')).toBe(true);
				expect(result.folders.size).toBe(3);
			});
			it('respects basePath', () => {
				const result = walkTreePartitioned(sampleTree, 'root');
				expect(result.files.has('root/src/index.ts')).toBe(true);
				expect(result.folders.has('root/src')).toBe(true);
			});
			it('files and folders are mutually exclusive', () => {
				const result = walkTreePartitioned(sampleTree);
				// No path should be in both sets
				for (const path of result.files) {
					expect(result.folders.has(path)).toBe(false);
				}
				for (const path of result.folders) {
					expect(result.files.has(path)).toBe(false);
				}
			});
		});
		describe('getAllFilePaths', () => {
			it('returns empty array for empty tree', () => {
				expect(getAllFilePaths([])).toEqual([]);
			});
			it('returns all file paths in order', () => {
				const result = getAllFilePaths(sampleTree);
				expect(result).toEqual([
					'src/index.ts',
					'src/utils.ts',
					'src/components/Button.tsx',
					'src/components/Modal.tsx',
					'README.md',
					'package.json',
					'docs/guide.md',
				]);
			});
			it('respects basePath', () => {
				const result = getAllFilePaths(sampleTree, 'prefix');
				expect(result[0]).toBe('prefix/src/index.ts');
			});
			it('excludes folders', () => {
				const result = getAllFilePaths(sampleTree);
				expect(result).not.toContain('src');
				expect(result).not.toContain('src/components');
				expect(result).not.toContain('docs');
			});
		});
		describe('getAllFolderPaths', () => {
			it('returns empty array for empty tree', () => {
				expect(getAllFolderPaths([])).toEqual([]);
			});
			it('returns all folder paths in order', () => {
				const result = getAllFolderPaths(sampleTree);
				expect(result).toEqual(['src', 'src/components', 'docs']);
			});
			it('respects basePath', () => {
				const result = getAllFolderPaths(sampleTree, 'prefix');
				expect(result[0]).toBe('prefix/src');
			});
			it('excludes files', () => {
				const result = getAllFolderPaths(sampleTree);
				expect(result).not.toContain('README.md');
				expect(result).not.toContain('src/index.ts');
			});
			it('returns empty array for tree with only files', () => {
				const flatTree: TreeNode[] = [
					{ name: 'file1.txt', type: 'file' },
					{ name: 'file2.txt', type: 'file' },
				];
				expect(getAllFolderPaths(flatTree)).toEqual([]);
			});
		});
		describe('buildFileIndex', () => {
			it('returns empty array for empty tree', () => {
				expect(buildFileIndex([])).toEqual([]);
			});
			it('returns entries with relativePath and filename', () => {
				const result = buildFileIndex(sampleTree);
				const indexEntry = result.find((e) => e.filename === 'index.ts');
				expect(indexEntry).toEqual({
					relativePath: 'src/index.ts',
					filename: 'index.ts',
				});
				const buttonEntry = result.find((e) => e.filename === 'Button.tsx');
				expect(buttonEntry).toEqual({
					relativePath: 'src/components/Button.tsx',
					filename: 'Button.tsx',
				});
			});
			it('respects basePath', () => {
				const result = buildFileIndex(sampleTree, 'project');
				const indexEntry = result.find((e) => e.filename === 'index.ts');
				expect(indexEntry?.relativePath).toBe('project/src/index.ts');
			});
			it('excludes folders', () => {
				const result = buildFileIndex(sampleTree);
				const folderEntry = result.find((e) => e.filename === 'src');
				expect(folderEntry).toBeUndefined();
			});
			it('can be used to build lookup sets', () => {
				const entries = buildFileIndex(sampleTree);
				const allPaths = new Set(entries.map((e) => e.relativePath));
				expect(allPaths.has('src/index.ts')).toBe(true);
				expect(allPaths.has('README.md')).toBe(true);
				expect(allPaths.has('src')).toBe(false); // folders not included
			});
			it('handles files with same name in different folders', () => {
				const tree: TreeNode[] = [
					{
						name: 'a',
						type: 'folder',
						children: [{ name: 'index.ts', type: 'file' }],
					},
					{
						name: 'b',
						type: 'folder',
						children: [{ name: 'index.ts', type: 'file' }],
					},
				];
				const result = buildFileIndex(tree);
				expect(result.length).toBe(2);
				expect(result.filter((e) => e.filename === 'index.ts').length).toBe(2);
				const paths = result.map((e) => e.relativePath);
				expect(paths).toContain('a/index.ts');
				expect(paths).toContain('b/index.ts');
			});
		});
		describe('generic type support', () => {
			interface ExtendedNode extends TreeNode {
				size?: number;
				lastModified?: Date;
			}
			it('getAllFilePaths works with extended node types', () => {
				const extTree: ExtendedNode[] = [{ name: 'file.txt', type: 'file', size: 1024 }];
				const result = getAllFilePaths<ExtendedNode>(extTree);
				expect(result).toEqual(['file.txt']);
			});
		});
	});
});
// Source: src/__tests__/shared/groupChatQueueModel.test.ts
describe('', () => {
	const item = (id: string, text = `msg-${id}`): GroupChatQueuedItem => ({
		id,
		timestamp: Number(id.replace(/\D/g, '')) || 1,
		text,
	});
	const queueOf = (...ids: string[]) => ({ items: ids.map((id) => item(id)), paused: false });
	describe('queueing rather than sending', () => {
		it('sends directly only when the moderator is idle and nothing is waiting', () => {
			expect(mustQueue(emptyQueueState(), true)).toBe(false);
		});
		it('queues while the moderator is busy', () => {
			expect(mustQueue(emptyQueueState(), false)).toBe(true);
		});
		// Without this a message typed now would overtake messages typed earlier,
		// which defeats the only thing a queue is for.
		it('queues when anything is already waiting, even if the moderator is idle', () => {
			expect(mustQueue(queueOf('1'), true)).toBe(true);
		});
		it('queues while paused, even if the moderator is idle and the queue is empty', () => {
			expect(mustQueue({ items: [], paused: true }, true)).toBe(true);
		});
	});
	describe('T5: Stop All pauses rather than sending the next item', () => {
		// Before this, `stopAll` emitted idle after killing the moderator, the drain
		// fired on that idle, and the send auto-restarted the moderator that Stop All
		// had just killed. Pressing stop restarted the room.
		it('holds a populated queue and sends nothing', () => {
			const stopped = pauseQueue(queueOf('1', '2'));
			expect(stopped.paused).toBe(true);
			expect(stopped.items).toHaveLength(2);
			expect(canDrain(stopped, true)).toBe(false);
		});
	});
	describe('T6: a failed send is kept, marked, and never retried on its own', () => {
		it('keeps the item, marks it, and pauses', () => {
			const failed = failHead(queueOf('1', '2'), 'Encore Feature disabled');
			expect(failed.items).toHaveLength(2);
			expect(failed.items[0].failed).toBe(true);
			expect(failed.items[0].failureReason).toBe('Encore Feature disabled');
			expect(failed.items[0].text).toBe('msg-1');
			expect(failed.paused).toBe(true);
		});
		// A cause that does not clear itself would otherwise re-fire on every idle
		// forever. That is a loop, not a recovery.
		it('does not drain on the next idle', () => {
			expect(canDrain(failHead(queueOf('1'), 'boom'), true)).toBe(false);
		});
		// Refusing forever would make the resume control a dead button.
		it('drains again once the user resumes, with the mark cleared', () => {
			const resumed = resumeQueue(failHead(queueOf('1', '2'), 'boom'));
			expect(resumed.paused).toBe(false);
			expect(resumed.items[0].failed).toBeUndefined();
			expect(resumed.items[0].failureReason).toBeUndefined();
			expect(canDrain(resumed, true)).toBe(true);
		});
	});
	describe('T7: a new message while paused appends and resumes', () => {
		it('goes to the end, resumes, and preserves order', () => {
			const paused = pauseQueue(queueOf('1', '2'));
			const next = enqueueMessage(paused, item('3'));
			expect(next.paused).toBe(false);
			expect(next.items.map((i) => i.id)).toEqual(['1', '2', '3']);
			expect(canDrain(next, true)).toBe(true);
		});
		// F16: adding a message must leave the queue genuinely runnable. Un-pausing
		// while the head still carries a `failed` mark produces a queue that reports
		// itself as running, offers no Resume control, and sends nothing - a worse
		// stall than a visible pause, because there is no affordance to clear it.
		// The old version of this test only passed because it called `resumeQueue`
		// itself, which hid exactly that gap.
		it('clears a failed head so the queue can actually move, with no Resume needed', () => {
			const stuck = failHead(queueOf('1'), 'boom');
			const next = enqueueMessage(stuck, item('2'));
			expect(next.paused).toBe(false);
			expect(next.items.map((i) => i.id)).toEqual(['1', '2']);
			expect(next.items[0].failed).toBeUndefined();
			expect(next.items[0].failureReason).toBeUndefined();
			// No `resumeQueue` here on purpose: that is the point.
			expect(canDrain(next, true)).toBe(true);
		});
		// F15: a direct send that failed was handed over BEFORE anything queued while
		// it ran, so it goes back to the front rather than behind them.
		it('puts a failed direct send at the front, paused', () => {
			const queuedDuringSend = queueOf('later-1', 'later-2');
			const next = requeueFailedAtFront(queuedDuringSend, item('original'), 'boom');
			expect(next.items.map((i) => i.id)).toEqual(['original', 'later-1', 'later-2']);
			expect(next.items[0].failed).toBe(true);
			expect(next.paused).toBe(true);
			// Resume clears only the head, so the failed item must BE the head or it
			// stops the queue again later while showing as running.
			expect(canDrain(resumeQueue(next), true)).toBe(true);
		});
	});
	describe('draining', () => {
		it('will not drain an empty or paused queue', () => {
			expect(canDrain(emptyQueueState(), true)).toBe(false);
			expect(canDrain(pauseQueue(queueOf('1')), true)).toBe(false);
		});
		it('will not drain while the moderator is busy', () => {
			expect(canDrain(queueOf('1'), false)).toBe(false);
		});
		it('removes the head once delivered and leaves the rest in order', () => {
			const after = completeHead(queueOf('1', '2', '3'));
			expect(after.items.map((i) => i.id)).toEqual(['2', '3']);
		});
		it('keeps a pause across a completed send', () => {
			expect(completeHead(pauseQueue(queueOf('1', '2'))).paused).toBe(true);
		});
	});
	describe('editing the queue', () => {
		it('removes by id', () => {
			expect(removeItem(queueOf('1', '2', '3'), '2').items.map((i) => i.id)).toEqual(['1', '3']);
		});
		it('reorders and clamps an out-of-range index instead of dropping the move', () => {
			expect(reorderItem(queueOf('1', '2', '3'), '3', 0).items.map((i) => i.id)).toEqual([
				'3',
				'1',
				'2',
			]);
			expect(reorderItem(queueOf('1', '2', '3'), '1', 99).items.map((i) => i.id)).toEqual([
				'2',
				'3',
				'1',
			]);
		});
		it('ignores a reorder for an item that is gone', () => {
			const state = queueOf('1', '2');
			expect(reorderItem(state, 'missing', 0)).toBe(state);
		});
	});
	describe('steering: a message the running round never took', () => {
		it('requeueAtFront puts it first, live, without pausing or marking it', () => {
			const state = queueOf('1', '2');
			const next = requeueAtFront(state, item('9', 'steered'));
			expect(next.items.map((i) => i.id)).toEqual(['9', '1', '2']);
			expect(next.paused).toBe(false);
			expect(next.items[0]).toEqual(item('9', 'steered'));
			expect(state.items.map((i) => i.id)).toEqual(['1', '2']);
		});
		it('requeueAtFront leaves a paused queue paused', () => {
			const paused = { ...queueOf('1'), paused: true };
			expect(requeueAtFront(paused, item('9')).paused).toBe(true);
		});
		it('unmarkSending clears only the named item, in place', () => {
			const state = markSending(markSending(queueOf('1', '2', '3'), '2'), '3');
			const next = unmarkSending(state, '2');
			expect(next.items.map((i) => i.id)).toEqual(['1', '2', '3']);
			expect(next.items[1].sending).toBeUndefined();
			expect(next.items[2].sending).toBe(true);
			expect(next.paused).toBe(state.paused);
		});
		it('unmarkSending is a no-op for an item that is gone', () => {
			const state = markSending(queueOf('1'), '1');
			expect(unmarkSending(state, 'missing').items).toEqual(state.items);
		});
	});
	describe('reading a queue off disk', () => {
		// F10: a file that parses as JSON but is the wrong SHAPE is just as damaged as
		// one that does not parse. Degrading to an empty queue lets the next save
		// overwrite it, so the caller can quarantine the bytes only if this throws.
		it('rejects a top level that is not an object', () => {
			expect(() => parseQueueState(null)).toThrow();
			expect(() => parseQueueState('nonsense')).toThrow();
			expect(() => parseQueueState([])).toThrow();
		});
		it('rejects a missing or non-array items field', () => {
			expect(() => parseQueueState({})).toThrow();
			expect(() => parseQueueState({ items: 5 })).toThrow();
			expect(() => parseQueueState({ items: 'not-an-array' })).toThrow();
		});
		// Dropping one bad entry silently is the same loss one element down.
		it('rejects a malformed item rather than dropping it', () => {
			expect(() => parseQueueState({ items: [item('1'), null] })).toThrow();
			expect(() => parseQueueState({ items: [{ noId: true }] })).toThrow();
		});
		it('round-trips a paused queue', () => {
			const saved = pauseQueue(queueOf('1'));
			expect(parseQueueState(JSON.parse(JSON.stringify(saved)))).toEqual(saved);
		});
		it('accepts a well-formed empty queue', () => {
			expect(parseQueueState({ items: [], paused: false })).toEqual({
				items: [],
				paused: false,
			});
		});
	});
});
// Source: src/__tests__/shared/focusPlacement.test.ts
describe('', () => {
	const ALL_VERBS = Object.keys(CLI_BACKGROUND_DEFAULTS) as BackgroundCapableVerb[];
	/** Every verb that focuses today and must keep focusing. */
	const FOCUSING_TODAY: BackgroundCapableVerb[] = [
		'open-file',
		'open-terminal',
		'open-browser',
		'tab-new',
		// Reopening a closed tab focuses it, as Cmd+Shift+T does.
		'tab-reopen',
		'dispatch',
		'create-agent',
		'create-worktree',
		'switch-mode',
		// The two snooze verbs that announce. `--background` suppresses the notice;
		// absent, they flash/toast exactly as the click paths do.
		'snooze',
		'snooze-dismiss',
		// Sending a steering note flashes "Steering note queued", as the click does.
		'steer-auto-run',
		// The overlay menu's Context items: Compact selects the compacted tab, Merge
		// Into and Send to Agent jump to the tab that receives the context.
		'tab-compact',
		'tab-merge',
		'tab-transfer',
	];
	describe('no verb changes its default', () => {
		it('keeps every verb that focuses today focusing when the flag is absent', () => {
			// The whole point of the amendment: existing scripts, playbooks and Cue
			// prompts must behave exactly as they do now.
			for (const verb of FOCUSING_TODAY) {
				expect(CLI_BACKGROUND_DEFAULTS[verb], verb).toBe(false);
				expect(resolveBackgroundFlag({}, verb), verb).toBe(false);
			}
		});
		it('leaves dispatch --new-tab background, which is what it already does', () => {
			// Not an exception to the rule - it IS the rule. dispatch shipped
			// background-by-default with --focus to opt out, so leaving it alone is the
			// same "keep today's behaviour" call as every row above.
			expect(CLI_BACKGROUND_DEFAULTS['dispatch-new-tab']).toBe(true);
			expect(resolveBackgroundFlag({}, 'dispatch-new-tab')).toBe(true);
		});
		it('flips refresh-auto-run to background, the one deliberate default change', () => {
			// Its focusing default only switched agents when the target was off screen,
			// so it fired exactly when the user was looking elsewhere: every Cue script
			// or agent turn ending in an unflagged refresh yanked the user away.
			expect(CLI_BACKGROUND_DEFAULTS['refresh-auto-run']).toBe(true);
			expect(resolveBackgroundFlag({}, 'refresh-auto-run')).toBe(true);
			expect(resolveBackgroundFlag({ focus: true }, 'refresh-auto-run')).toBe(false);
		});
		it('keys defaults by verb, since two verbs share one message and disagree', () => {
			// `tab new --prompt` and `dispatch --new-tab` both send
			// new_ai_tab_with_prompt. Keying by message would force one of them to
			// change behaviour.
			expect(resolveBackgroundFlag({}, 'tab-new')).toBe(false);
			expect(resolveBackgroundFlag({}, 'dispatch-new-tab')).toBe(true);
		});
		it('splits dispatch in two, because one command name holds two defaults', () => {
			// Creating a tab the caller will address by id is background; writing into
			// an existing conversation selects the agent, as it does today. Collapsing
			// these onto one key would change one of them.
			expect(resolveBackgroundFlag({}, 'dispatch-new-tab')).toBe(true);
			expect(resolveBackgroundFlag({}, 'dispatch')).toBe(false);
		});
	});
	describe('verbs that accept the flag and ignore it', () => {
		it('recognises refresh-files as already quiet', () => {
			expect(isAlreadyQuietVerb('refresh-files')).toBe(true);
		});
		it('recognises the four silent snooze verbs as already quiet', () => {
			// `wake` restores a tab WITHOUT focusing it - unlike the Snoozed Tabs list,
			// which jumps to the tab it brought back - so there is nothing for the flag
			// to suppress on any of these.
			for (const verb of ['snooze-list', 'snooze-wake', 'snooze-reschedule', 'snooze-history']) {
				expect(isAlreadyQuietVerb(verb), verb).toBe(true);
			}
		});
		it('recognises reading and cancelling steering notes as already quiet', () => {
			for (const verb of ['steer-auto-run-list', 'steer-auto-run-cancel']) {
				expect(isAlreadyQuietVerb(verb), verb).toBe(true);
			}
			// `send` flashes a confirmation, so the flag means something there.
			expect(isAlreadyQuietVerb('steer-auto-run')).toBe(false);
		});
		it('does not claim a verb that really can move the view', () => {
			// The list is "nothing to suppress", not "we have not wired it yet". A verb
			// that focuses must live in CLI_BACKGROUND_DEFAULTS so the flag DOES
			// something, or `--background` is accepted and silently ignored on a verb
			// that steals the viewport - worse than rejecting it.
			for (const verb of Object.keys(CLI_BACKGROUND_DEFAULTS)) {
				expect(isAlreadyQuietVerb(verb), verb).toBe(false);
			}
		});
		it('rejects anything not on the list', () => {
			expect(isAlreadyQuietVerb('open-file')).toBe(false);
			expect(isAlreadyQuietVerb('')).toBe(false);
			expect(isAlreadyQuietVerb('refresh')).toBe(false);
		});
		it('keeps the two lists disjoint', () => {
			// A verb in both would have a resolved default AND be documented as a
			// no-op, which is a contradiction the CLI help would inherit.
			const negotiable = new Set<string>(Object.keys(CLI_BACKGROUND_DEFAULTS));
			for (const verb of ALREADY_QUIET_VERBS) {
				expect(negotiable.has(verb), verb).toBe(false);
			}
		});
	});
	describe('resolveBackgroundFlag (CLI side)', () => {
		it('opts into background on every verb', () => {
			for (const verb of ALL_VERBS) {
				expect(resolveBackgroundFlag({ background: true }, verb), verb).toBe(true);
			}
		});
		it('opts into foreground on every verb', () => {
			// A no-op on most verbs today. It ships anyway because a future default
			// flip needs the escape hatch to already exist.
			for (const verb of ALL_VERBS) {
				expect(resolveBackgroundFlag({ focus: true }, verb), verb).toBe(false);
			}
		});
		it('lets --focus win when a script somehow passes both', () => {
			expect(resolveBackgroundFlag({ background: true, focus: true }, 'open-file')).toBe(false);
			expect(resolveBackgroundFlag({ background: true, focus: true }, 'dispatch-new-tab')).toBe(
				false
			);
		});
		it('treats an unset commander option as no preference, not as an opt-out', () => {
			// commander leaves an unset boolean undefined and only sets false for a
			// negated option. Neither may flip a verb off its default.
			for (const verb of ALL_VERBS) {
				const expected = CLI_BACKGROUND_DEFAULTS[verb];
				expect(resolveBackgroundFlag({ background: undefined }, verb), verb).toBe(expected);
				expect(resolveBackgroundFlag({ background: false }, verb), verb).toBe(expected);
				expect(resolveBackgroundFlag({ focus: false }, verb), verb).toBe(expected);
			}
		});
	});
	describe('readBackgroundField (protocol side)', () => {
		it('is an opt-in: only a literal true counts', () => {
			expect(readBackgroundField({ background: true })).toBe(true);
		});
		it('reads an absent field as today s behaviour', () => {
			// The regression this guards: an older client, the web UI, or any in-app
			// caller that never sets the field must keep focusing. Writing `!== false`
			// here would invert it and silently break every one of them.
			expect(readBackgroundField({})).toBe(false);
			expect(readBackgroundField({ background: undefined })).toBe(false);
		});
		it('reads a non-boolean as no preference rather than guessing', () => {
			for (const value of ['yes', 'true', 'false', 1, 0, null, {}, []]) {
				expect(readBackgroundField({ background: value }), String(value)).toBe(false);
			}
		});
	});
	describe('readSwitchToAgentField (open_file_tab only)', () => {
		it('defaults to switching, which is the historical behaviour', () => {
			expect(readSwitchToAgentField({})).toBe(true);
			expect(readSwitchToAgentField({ switchToAgent: true })).toBe(true);
		});
		it('honours an explicit false, the --no-switch ask', () => {
			expect(readSwitchToAgentField({ switchToAgent: false })).toBe(false);
		});
		it('is a DIFFERENT question from background, and both survive', () => {
			// --no-switch stays on the current agent but still activates the tab in the
			// target. --background changes nothing rendered anywhere. Folding the first
			// into the second would silently change behaviour for callers already
			// passing it, which is precisely what the no-default-changes rule forbids.
			const noSwitch = { switchToAgent: false };
			expect(readSwitchToAgentField(noSwitch)).toBe(false);
			expect(readBackgroundField(noSwitch)).toBe(false);
		});
	});
	describe('the two entry points agree', () => {
		it('round-trips whatever the CLI resolved', () => {
			// CLI resolves flags -> puts the bit on the wire -> handler reads it back.
			// A divergence here is a flag that looks accepted and does the opposite.
			for (const verb of ALL_VERBS) {
				for (const flags of [{}, { background: true }, { focus: true }]) {
					const onTheWire = resolveBackgroundFlag(flags, verb);
					expect(readBackgroundField({ background: onTheWire }), verb).toBe(onTheWire);
				}
			}
		});
	});
});
// Source: src/__tests__/shared/agentEnvironment.test.ts
describe('', () => {
	describe('resolveAgentEnvironment', () => {
		it('returns an empty list when no layer sets anything', () => {
			expect(resolveAgentEnvironment({})).toEqual([]);
		});
		it('applies precedence: session over global, with the provider layer replaced', () => {
			const resolved = resolveAgentEnvironment({
				global: { MODEL: 'global' },
				agent: { MODEL: 'provider' },
				session: { MODEL: 'session' },
			});
			expect(resolved).toEqual([
				{ key: 'MODEL', value: 'session', source: 'session', shadowedBy: ['global'] },
			]);
		});
		it('lets a lower layer win when higher layers are silent', () => {
			const resolved = resolveAgentEnvironment({ global: { A: '1' }, session: {} });
			expect(resolved).toEqual([{ key: 'A', value: '1', source: 'global', shadowedBy: [] }]);
		});
		it('reports the provider layer when only global is overridden', () => {
			const [entry] = resolveAgentEnvironment({
				global: { URL: 'a' },
				agent: { URL: 'b' },
			});
			expect(entry).toMatchObject({ value: 'b', source: 'agent', shadowedBy: ['global'] });
		});
		// The spawner hands a process the agent's own vars OR the provider's, never
		// both, so a provider key the agent does not set must not appear.
		it('drops the provider layer once the agent has a vars record, even an empty one', () => {
			const resolved = resolveAgentEnvironment({
				global: { A: '1' },
				agent: { B: '2' },
				session: { C: '3' },
			});
			expect(resolved.map((e) => e.key)).toEqual(['A', 'C']);
			expect(resolveAgentEnvironment({ agent: { B: '2' }, session: {} })).toEqual([]);
		});
		it('layers the provider set over global when the agent has no vars record', () => {
			const resolved = resolveAgentEnvironment({ global: { A: '1' }, agent: { B: '2' } });
			expect(resolved.map((e) => e.key)).toEqual(['A', 'B']);
		});
		// `FOO=` is a real setting that blanks a lower layer, not an absent one.
		it('keeps an empty-string override', () => {
			const [entry] = resolveAgentEnvironment({
				global: { TOKEN: 'set' },
				session: { TOKEN: '' },
			});
			expect(entry).toMatchObject({ value: '', source: 'session', shadowedBy: ['global'] });
		});
		it('sorts by key so the list is stable between renders', () => {
			const resolved = resolveAgentEnvironment({ global: { Z: '1', A: '2', M: '3' } });
			expect(resolved.map((e) => e.key)).toEqual(['A', 'M', 'Z']);
		});
	});
	describe('isSecretEnvKey', () => {
		it('flags credential-shaped keys', () => {
			for (const key of [
				'ANTHROPIC_API_KEY',
				'OPENAI_TOKEN',
				'MY_SECRET',
				'DB_PASSWORD',
				'AWS_CREDENTIAL_FILE',
				'CLAUDE_CODE_OAUTH_TOKEN',
			]) {
				expect(isSecretEnvKey(key), key).toBe(true);
			}
		});
		it('leaves configuration keys visible', () => {
			for (const key of [
				'ANTHROPIC_BASE_URL',
				'NODE_ENV',
				'PATH',
				'MAESTRO_PROFILE',
				'HTTP_PROXY',
			]) {
				expect(isSecretEnvKey(key), key).toBe(false);
			}
		});
		// These match the secret pattern but name a mode or a path. Masking them
		// would hide exactly what the user opened this view to check.
		it('exempts keys that describe a credential rather than being one', () => {
			expect(isSecretEnvKey('CLAUDE_AUTH_TYPE')).toBe(false);
			expect(isSecretEnvKey('SSH_KEY_PATH')).toBe(false);
			expect(isSecretEnvKey('MY_TOKEN_PATH')).toBe(false);
			// ...but the token itself is still a secret.
			expect(isSecretEnvKey('MY_AUTH_TOKEN')).toBe(true);
		});
		it('is case-insensitive', () => {
			expect(isSecretEnvKey('anthropic_api_key')).toBe(true);
		});
	});
	describe('maskEnvValue', () => {
		it('keeps a distinguishing tail on a long value', () => {
			const masked = maskEnvValue('sk-ant-api03-abcdefghijklmnop');
			expect(masked.endsWith('mnop')).toBe(true);
			expect(masked).not.toContain('sk-ant');
		});
		it('masks a short value entirely', () => {
			expect(maskEnvValue('abc123')).toBe('••••••');
			expect(maskEnvValue('abc123')).not.toContain('a');
		});
		it('never renders as blank for an empty value', () => {
			expect(maskEnvValue('')).toBe('•');
		});
	});
	describe('envSourceLabel', () => {
		it('names each layer distinctly', () => {
			const labels = (['global', 'agent', 'session'] as const).map(envSourceLabel);
			expect(new Set(labels).size).toBe(3);
			expect(labels).toEqual(['Global', 'Provider', 'This agent']);
		});
	});
	describe('stripBlankEnvVars', () => {
		it('drops blank and whitespace-only values, keeps everything else', () => {
			expect(
				stripBlankEnvVars({
					CLAUDE_CONFIG_DIR: '',
					PADDED: '   ',
					KEPT: 'value',
					KEPT_WITH_SPACE: ' value ',
				})
			).toEqual({ KEPT: 'value', KEPT_WITH_SPACE: ' value ' });
		});
		it('returns an empty object for undefined input', () => {
			expect(stripBlankEnvVars(undefined)).toEqual({});
		});
		it('drops an UNNAMED row even when it carries a value', () => {
			// A row the user gave a value to before naming it. `env[''] = 'x'` is a
			// variable no child can read, and Windows rejects the empty name outright.
			expect(stripBlankEnvVars({ '': 'orphan', KEPT: 'value' })).toEqual({ KEPT: 'value' });
		});
		it('does not mutate its input', () => {
			const input = { A: '', B: 'b' };
			stripBlankEnvVars(input);
			expect(input).toEqual({ A: '', B: 'b' });
		});
		it('classifies blanks the same way isBlankEnvValue does', () => {
			expect(isBlankEnvValue('')).toBe(true);
			expect(isBlankEnvValue('\t ')).toBe(true);
			expect(isBlankEnvValue('0')).toBe(false);
		});
	});
	describe('resolveAgentEnvironment vs stripBlankEnvVars', () => {
		it('keeps blanks in the reported config even though the spawner drops them', () => {
			// The two answer different questions: what did the user CONFIGURE (shown in
			// the env viewer) versus what gets EXPORTED to the child.
			const resolved = resolveAgentEnvironment({ session: { CLAUDE_CONFIG_DIR: '' } });
			expect(resolved).toHaveLength(1);
			expect(resolved[0].value).toBe('');
			expect(stripBlankEnvVars({ CLAUDE_CONFIG_DIR: '' })).toEqual({});
		});
	});
	describe('isBlankEnvKey', () => {
		it('treats an empty or whitespace-only name as unnamed', () => {
			expect(isBlankEnvKey('')).toBe(true);
			expect(isBlankEnvKey('   ')).toBe(true);
		});
		it('treats any real name as named', () => {
			expect(isBlankEnvKey('A')).toBe(false);
			expect(isBlankEnvKey('CLAUDE_CONFIG_DIR')).toBe(false);
		});
	});
});
// Source: src/__tests__/shared/additionalDirectories.test.ts
describe('', () => {
	const session = {
		id: 'agent-1',
		name: 'Test Agent',
		toolType: 'claude-code',
		cwd: '/Users/test/project',
	};
	describe('normalizeAdditionalDirectories', () => {
		it('returns undefined for an empty or missing list', () => {
			expect(normalizeAdditionalDirectories(undefined)).toBeUndefined();
			expect(normalizeAdditionalDirectories([])).toBeUndefined();
		});
		it('trims paths and drops blank rows', () => {
			const result = normalizeAdditionalDirectories([
				{ path: '  /a/docs  ', read: true, write: false },
				{ path: '   ', read: true, write: true },
			]);
			expect(result).toEqual([{ path: '/a/docs', read: true, write: false }]);
		});
		it('returns undefined when every row is blank', () => {
			expect(
				normalizeAdditionalDirectories([{ path: '  ', read: true, write: true }])
			).toBeUndefined();
		});
		it('expands a leading tilde against the supplied home directory', () => {
			const result = normalizeAdditionalDirectories(
				[
					{ path: '~/notes', read: true, write: true },
					{ path: '~', read: true, write: false },
				],
				'/Users/test'
			);
			expect(result).toEqual([
				{ path: '/Users/test/notes', read: true, write: true },
				{ path: '/Users/test', read: true, write: false },
			]);
		});
		it('leaves the tilde alone when no home directory is known', () => {
			const result = normalizeAdditionalDirectories([
				{ path: '~/notes', read: true, write: false },
			]);
			expect(result).toEqual([{ path: '~/notes', read: true, write: false }]);
		});
		it("collapses duplicate paths, keeping the last row's permissions", () => {
			const result = normalizeAdditionalDirectories([
				{ path: '/a/docs', read: true, write: false },
				{ path: '/a/docs', read: false, write: true },
			]);
			expect(result).toEqual([{ path: '/a/docs', read: false, write: true }]);
		});
		it('keeps a row with no permissions so toggling off does not delete the path', () => {
			const result = normalizeAdditionalDirectories([
				{ path: '/a/docs', read: false, write: false },
			]);
			expect(result).toEqual([{ path: '/a/docs', read: false, write: false }]);
		});
		it('carries a trimmed description through', () => {
			const result = normalizeAdditionalDirectories([
				{ path: '/a/docs', read: true, write: false, description: '  API reference material  ' },
			]);
			expect(result).toEqual([
				{ path: '/a/docs', read: true, write: false, description: 'API reference material' },
			]);
		});
		it('omits the description field when it is blank', () => {
			const result = normalizeAdditionalDirectories([
				{ path: '/a/docs', read: true, write: false, description: '   ' },
			]);
			expect(result).toEqual([{ path: '/a/docs', read: true, write: false }]);
			expect(result?.[0]).not.toHaveProperty('description');
		});
	});
	describe('formatAdditionalDirectoriesForPrompt', () => {
		it('renders nothing when there are no grants', () => {
			expect(formatAdditionalDirectoriesForPrompt(undefined)).toBe('');
			expect(formatAdditionalDirectoriesForPrompt([])).toBe('');
		});
		it('omits the heading entirely when every row is inert', () => {
			// A bare "## Additional Directories" heading with no table under it reads
			// to the agent like a section that failed to load.
			expect(
				formatAdditionalDirectoriesForPrompt([{ path: '/a', read: false, write: false }])
			).toBe('');
		});
		it('labels each access combination distinctly', () => {
			const dirs: AdditionalDirectory[] = [
				{ path: '/rw', read: true, write: true },
				{ path: '/ro', read: true, write: false },
				{ path: '/wo', read: false, write: true },
			];
			const block = formatAdditionalDirectoriesForPrompt(dirs);
			expect(block).toContain('## Additional Directories');
			expect(block).toContain('| `/rw` | Read + Write |');
			expect(block).toContain('| `/ro` | Read only |');
			expect(block).toContain('| `/wo` | Write only |');
		});
		it('drops inert rows but keeps the granted ones', () => {
			const block = formatAdditionalDirectoriesForPrompt([
				{ path: '/granted', read: true, write: false },
				{ path: '/inert', read: false, write: false },
			]);
			expect(block).toContain('/granted');
			expect(block).not.toContain('/inert');
		});
		it('keeps the two-column table when no grant has a description', () => {
			const block = formatAdditionalDirectoriesForPrompt([
				{ path: '/ro', read: true, write: false },
			]);
			expect(block).toContain('| Directory | Access |');
			expect(block).not.toContain('| Notes |');
		});
		it('adds a Notes column carrying each description when any grant has one', () => {
			const block = formatAdditionalDirectoriesForPrompt([
				{ path: '/specs', read: true, write: false, description: 'API reference material' },
				{ path: '/drop', read: false, write: true },
			]);
			expect(block).toContain('| Directory | Access | Notes |');
			expect(block).toContain('| `/specs` | Read only | API reference material |');
			// A grant with no description still renders its (empty) cell.
			expect(block).toContain('| `/drop` | Write only |  |');
		});
		it('escapes pipes and collapses newlines in a description so the table survives', () => {
			const block = formatAdditionalDirectoriesForPrompt([
				{
					path: '/specs',
					read: true,
					write: false,
					description: 'read a | b\nthen stop',
				},
			]);
			expect(block).toContain('| `/specs` | Read only | read a \\| b then stop |');
		});
	});
	describe('{{ADDITIONAL_DIRECTORIES}} substitution', () => {
		it('renders the grants block into the template', () => {
			const result = substituteTemplateVariables('BEFORE\n{{ADDITIONAL_DIRECTORIES}}\nAFTER', {
				session: {
					...session,
					additionalDirectories: [{ path: '/shared/specs', read: true, write: false }],
				},
			});
			expect(result).toContain('BEFORE');
			expect(result).toContain('| `/shared/specs` | Read only |');
			expect(result).toContain('AFTER');
		});
		it('collapses to an empty string when the agent has no grants', () => {
			const result = substituteTemplateVariables('BEFORE\n{{ADDITIONAL_DIRECTORIES}}\nAFTER', {
				session,
			});
			expect(result).toBe('BEFORE\n\nAFTER');
		});
		it('inserts a path containing $ literally rather than as a replacement pattern', () => {
			const result = substituteTemplateVariables('{{ADDITIONAL_DIRECTORIES}}', {
				session: {
					...session,
					additionalDirectories: [{ path: '/tmp/$&cache', read: true, write: true }],
				},
			});
			expect(result).toContain('| `/tmp/$&cache` | Read + Write |');
		});
	});
});
// Source: src/__tests__/shared/usageStats.test.ts
describe('', () => {
	function usage(overrides: Partial<UsageStats> = {}): UsageStats {
		return {
			inputTokens: 0,
			outputTokens: 0,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
			totalCostUsd: 0,
			contextWindow: 0,
			...overrides,
		};
	}
	describe('sumUsageTokens', () => {
		it('sums all four token buckets', () => {
			expect(
				sumUsageTokens(
					usage({
						inputTokens: 10,
						outputTokens: 20,
						cacheReadInputTokens: 30,
						cacheCreationInputTokens: 40,
					})
				)
			).toBe(100);
		});
		it('returns 0 for null/undefined', () => {
			expect(sumUsageTokens(null)).toBe(0);
			expect(sumUsageTokens(undefined)).toBe(0);
		});
	});
	describe('hasUsage', () => {
		it('is false when there are no tokens', () => {
			expect(hasUsage(usage())).toBe(false);
			expect(hasUsage(undefined)).toBe(false);
		});
		it('is true once any bucket is non-zero', () => {
			expect(hasUsage(usage({ outputTokens: 1 }))).toBe(true);
		});
	});
	describe('resolveUsageCost', () => {
		it('trusts a positive provider-reported cost', () => {
			const result = resolveUsageCost(
				usage({ inputTokens: 100, totalCostUsd: 0.42 }),
				'claude-opus-4-8'
			);
			expect(result).toEqual({ costUsd: 0.42, estimated: false });
		});
		it('estimates from the rate table when no cost is reported', () => {
			const u = usage({ inputTokens: 1000, outputTokens: 500 });
			const result = resolveUsageCost(u, 'claude-opus-4-8');
			expect(result.estimated).toBe(true);
			expect(result.costUsd).toBeCloseTo(
				calculateModelCost(
					{ inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheCreationTokens: 0 },
					'claude-opus-4-8'
				),
				10
			);
		});
		it('returns zero cost for missing usage', () => {
			expect(resolveUsageCost(undefined, 'claude-opus-4-8')).toEqual({
				costUsd: 0,
				estimated: false,
			});
		});
	});
	describe('aggregateUsage', () => {
		it('sums tokens and cost across sessions, skipping empty ones', () => {
			const agg = aggregateUsage([
				{
					usageStats: usage({ inputTokens: 100, outputTokens: 50, totalCostUsd: 1 }),
					model: 'claude-opus-4-8',
				},
				{ usageStats: usage(), model: 'claude-opus-4-8' }, // empty - skipped
				{
					usageStats: usage({ inputTokens: 200, outputTokens: 100, totalCostUsd: 2 }),
					model: 'claude-opus-4-8',
				},
			]);
			expect(agg.count).toBe(2);
			expect(agg.inputTokens).toBe(300);
			expect(agg.outputTokens).toBe(150);
			expect(agg.totalTokens).toBe(450);
			expect(agg.costUsd).toBe(3);
			expect(agg.costEstimated).toBe(false);
		});
		it('flags the aggregate estimated when any session cost was rate-table derived', () => {
			const agg = aggregateUsage([
				{ usageStats: usage({ inputTokens: 100, totalCostUsd: 1 }), model: 'claude-opus-4-8' },
				{ usageStats: usage({ inputTokens: 1000, outputTokens: 500 }), model: 'claude-opus-4-8' }, // no cost -> estimated
			]);
			expect(agg.count).toBe(2);
			expect(agg.costEstimated).toBe(true);
			expect(agg.costUsd).toBeGreaterThan(1);
		});
		it('returns an empty aggregate for no sessions', () => {
			const agg = aggregateUsage([]);
			expect(agg.count).toBe(0);
			expect(agg.totalTokens).toBe(0);
			expect(agg.costUsd).toBe(0);
			expect(agg.costEstimated).toBe(false);
		});
	});
	describe('aggregateRangeUsage', () => {
		const totals = (over: Partial<SessionTokenTotals> = {}): SessionTokenTotals => ({
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheCreationTokens: 0,
			costUsd: 0,
			pricedQueries: 1,
			...over,
		});
		it('sums every bucket across the sessions in the range', () => {
			const agg = aggregateRangeUsage({
				s1: totals({ inputTokens: 100, outputTokens: 50, costUsd: 1, pricedQueries: 3 }),
				s2: totals({ cacheReadTokens: 200, cacheCreationTokens: 25, costUsd: 2, pricedQueries: 4 }),
			});
			expect(agg.count).toBe(2);
			expect(agg.inputTokens).toBe(100);
			expect(agg.outputTokens).toBe(50);
			expect(agg.cacheReadInputTokens).toBe(200);
			expect(agg.cacheCreationInputTokens).toBe(25);
			expect(agg.totalTokens).toBe(375);
			expect(agg.costUsd).toBe(3);
			expect(agg.pricedQueries).toBe(7);
			expect(agg.costEstimated).toBe(false);
		});
		it('leaves cost at the reported total when no model resolver is supplied', () => {
			const agg = aggregateRangeUsage({
				s1: totals({ inputTokens: 1000000, outputTokens: 1000000, costUsd: 0 }),
			});
			expect(agg.totalTokens).toBe(2000000);
			expect(agg.costUsd).toBe(0);
			expect(agg.costEstimated).toBe(false);
		});
		it('estimates cost from the rate table only for sessions that reported none', () => {
			const agg = aggregateRangeUsage(
				{
					reported: totals({ inputTokens: 100, costUsd: 5 }),
					unpriced: totals({ inputTokens: 1000000, outputTokens: 500000 }),
				},
				() => 'claude-opus-4-8'
			);
			expect(agg.costEstimated).toBe(true);
			expect(agg.costUsd).toBeGreaterThan(5);
		});
		it('returns an empty aggregate when the range holds nothing', () => {
			expect(aggregateRangeUsage(undefined).count).toBe(0);
			expect(aggregateRangeUsage({}).totalTokens).toBe(0);
			expect(aggregateRangeUsage({}).pricedQueries).toBe(0);
		});
	});
});
// Source: src/__tests__/shared/hostLocalPreview.test.ts
describe('', () => {
	describe('host-local preview classification', () => {
		it.each([
			'http://localhost:3000/app',
			'https://dev.localhost/',
			'http://127.2.3.4:4000/',
			'http://[::1]:8080/',
			'http://0.0.0.0:5000/',
			'http://2130706433:3000/',
		])('keeps %s on host execution', (url) => {
			expect(isHostLocalPreviewUrl(url)).toBe(true);
		});
		it.each([
			'https://localhost.example.com',
			'https://example.com/localhost',
			'https://localhost@evil.example/',
			'http://localhost:99999/',
			'file:///host/file.html',
			'mailto:user@example.com',
		])('does not treat %s as a localhost HTTP preview', (url) => {
			expect(isHostLocalPreviewUrl(url)).toBe(false);
		});
	});
});
