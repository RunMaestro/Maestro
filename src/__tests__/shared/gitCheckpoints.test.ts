/**
 * Tests for the shared worktree-checkpoint vocabulary.
 *
 * These cover the parts that are pure data: the commit-message round trip that
 * a restore depends on, the id/label sanitizing that keeps a checkpoint from
 * minting an invalid ref, and the worktree scoping that keeps a sibling
 * worktree's snapshots out of this one's list.
 */

import {
	CHECKPOINT_FORMAT_VERSION,
	CHECKPOINT_REF_PREFIX,
	buildCheckpointId,
	checkpointRef,
	defaultCheckpointLabel,
	describeCheckpointOrigin,
	filterCheckpointsForWorktree,
	formatCheckpointCommitMessage,
	isValidCheckpointId,
	normalizeWorktreePath,
	parseCheckpointRef,
	sanitizeCheckpointLabel,
	type GitCheckpoint,
} from '../../shared/gitCheckpoints';

const BASE = {
	label: 'Before the refactor',
	id: '20260901T120000Z-abc123',
	indexTreeSha: '1111111111111111111111111111111111111111',
	headSha: '2222222222222222222222222222222222222222',
	branch: 'feature/thing',
	worktreePath: '/Users/dev/project',
	includesIgnored: false,
	origin: 'manual' as const,
	createdAt: 1_756_728_000_123,
};

function parse(message: string, overrides: Partial<Parameters<typeof parseCheckpointRef>[0]> = {}) {
	return parseCheckpointRef({
		ref: `${CHECKPOINT_REF_PREFIX}/${BASE.id}`,
		commitSha: '3333333333333333333333333333333333333333',
		treeSha: '4444444444444444444444444444444444444444',
		message,
		committedAtSeconds: 1_756_728_000,
		...overrides,
	});
}

describe('checkpointRef', () => {
	it('namespaces ids under refs/maestro/checkpoints', () => {
		expect(checkpointRef('abc')).toBe('refs/maestro/checkpoints/abc');
	});
});

describe('isValidCheckpointId', () => {
	it('accepts generated ids', () => {
		expect(isValidCheckpointId(buildCheckpointId(Date.now(), 'ab12cd'))).toBe(true);
	});

	it.each([
		['empty', ''],
		['a slash, which would nest a new ref level', 'a/b'],
		['a space', 'a b'],
		// git rejects these outright; catching them here turns an unreadable
		// "not a valid ref name" from git into a message naming the input.
		['a leading dot', '.hidden'],
		['a trailing dot', 'trailing.'],
		['a double dot, which git reserves for ranges', 'a..b'],
		['a control-ish shell character', 'a;rm -rf'],
	])('rejects %s', (_label, id) => {
		expect(isValidCheckpointId(id)).toBe(false);
	});
});

describe('buildCheckpointId', () => {
	it('sorts lexically in creation order, so a ref listing needs no second pass', () => {
		const earlier = buildCheckpointId(Date.parse('2026-09-01T10:00:00Z'), 'aaaaaa');
		const later = buildCheckpointId(Date.parse('2026-09-01T11:00:00Z'), 'aaaaaa');
		expect(earlier < later).toBe(true);
	});

	it('distinguishes two checkpoints taken in the same second', () => {
		const at = Date.parse('2026-09-01T10:00:00Z');
		expect(buildCheckpointId(at, 'aaaaaa')).not.toBe(buildCheckpointId(at, 'bbbbbb'));
	});
});

describe('sanitizeCheckpointLabel', () => {
	it('collapses newlines so the label cannot leak into the trailer block', () => {
		// A label with a newline would push the rest of it into the commit BODY,
		// where the trailer parser would read the user's prose as metadata.
		const label = sanitizeCheckpointLabel('first line\nMaestro-Checkpoint-Id: evil');
		expect(label).not.toContain('\n');
		expect(label).toBe('first line Maestro-Checkpoint-Id: evil');
	});

	it('caps the length so a pasted paragraph cannot become a commit subject', () => {
		expect(sanitizeCheckpointLabel('x'.repeat(500))).toHaveLength(200);
	});
});

describe('formatCheckpointCommitMessage / parseCheckpointRef', () => {
	it('round-trips every field a restore depends on', () => {
		const parsed = parse(formatCheckpointCommitMessage(BASE));
		expect(parsed).toMatchObject({
			id: BASE.id,
			label: BASE.label,
			indexTreeSha: BASE.indexTreeSha,
			headSha: BASE.headSha,
			branch: BASE.branch,
			worktreePath: BASE.worktreePath,
			includesIgnored: false,
			origin: 'manual',
		});
	});

	it('round-trips an unborn HEAD and a detached head as nulls, not empty strings', () => {
		const parsed = parse(formatCheckpointCommitMessage({ ...BASE, headSha: null, branch: null }));
		expect(parsed?.headSha).toBeNull();
		expect(parsed?.branch).toBeNull();
	});

	it('round-trips the ignored-files flag', () => {
		// This flag decides whether a restore runs `git clean -fdx`, so losing it
		// would either strand files or delete a .env the snapshot cannot restore.
		const parsed = parse(formatCheckpointCommitMessage({ ...BASE, includesIgnored: true }));
		expect(parsed?.includesIgnored).toBe(true);
	});

	it('keeps millisecond precision, which the commit date cannot carry', () => {
		// Git commit timestamps are whole seconds, so two checkpoints taken in the
		// same second would tie and list in arbitrary order.
		const parsed = parse(formatCheckpointCommitMessage(BASE), {
			committedAtSeconds: 1_756_728_000,
		});
		expect(parsed?.createdAt).toBe(1_756_728_000_123);
	});

	it('falls back to the commit date when the created trailer is absent', () => {
		// Degrading to second precision keeps the checkpoint listable and
		// restorable; dropping it would hide it entirely.
		const message = formatCheckpointCommitMessage(BASE)
			.split('\n')
			.filter((line) => !line.startsWith('Maestro-Checkpoint-Created:'))
			.join('\n');
		expect(parse(message, { committedAtSeconds: 1_756_728_000 })?.createdAt).toBe(
			1_756_728_000_000
		);
	});

	it('skips a ref written by a newer format rather than half-reading it', () => {
		const message = formatCheckpointCommitMessage(BASE).replace(
			`Maestro-Checkpoint-Version: ${CHECKPOINT_FORMAT_VERSION}`,
			`Maestro-Checkpoint-Version: ${CHECKPOINT_FORMAT_VERSION + 1}`
		);
		expect(parse(message)).toBeNull();
	});

	it('skips a ref with no index tree, which could not be restored faithfully', () => {
		const message = formatCheckpointCommitMessage(BASE)
			.split('\n')
			.filter((line) => !line.startsWith('Maestro-Checkpoint-Index-Tree:'))
			.join('\n');
		expect(parse(message)).toBeNull();
	});

	it('skips an unrelated ref that happens to live in the namespace', () => {
		expect(parse('just a commit someone put here\n')).toBeNull();
	});

	it('falls back to manual for an unrecognized origin instead of trusting it', () => {
		const message = formatCheckpointCommitMessage(BASE).replace(
			'Maestro-Checkpoint-Origin: manual',
			'Maestro-Checkpoint-Origin: something-else'
		);
		expect(parse(message)?.origin).toBe('manual');
	});

	it('reads the trailer at the bottom, not a lookalike in the subject', () => {
		// An agent-written label can contain anything, including something that
		// looks exactly like a trailer.
		const message = formatCheckpointCommitMessage({
			...BASE,
			label: 'Maestro-Checkpoint-Origin: auto-run',
		});
		expect(parse(message)?.origin).toBe('manual');
	});
});

describe('normalizeWorktreePath', () => {
	it('ignores a trailing separator', () => {
		expect(normalizeWorktreePath('/a/b/')).toBe(normalizeWorktreePath('/a/b'));
	});

	it('ignores separator style and case, which Windows and macOS both vary on', () => {
		expect(normalizeWorktreePath('C:\\Dev\\Project')).toBe(normalizeWorktreePath('c:/dev/project'));
	});
});

describe('filterCheckpointsForWorktree', () => {
	const make = (id: string, worktreePath: string): GitCheckpoint => ({
		id,
		label: id,
		commitSha: 'c',
		treeSha: 't',
		indexTreeSha: 'i',
		headSha: null,
		branch: null,
		worktreePath,
		includesIgnored: false,
		origin: 'manual',
		createdAt: 0,
	});

	it('keeps only this working tree, since refs are shared across worktrees', () => {
		// The dangerous case: offering to restore a sibling worktree's snapshot
		// over the tree currently on screen.
		const result = filterCheckpointsForWorktree(
			[make('mine', '/repo/wt-a'), make('theirs', '/repo/wt-b')],
			'/repo/wt-a'
		);
		expect(result.map((c) => c.id)).toEqual(['mine']);
	});

	it('matches despite a trailing separator on either side', () => {
		const result = filterCheckpointsForWorktree([make('mine', '/repo/wt-a/')], '/repo/wt-a');
		expect(result).toHaveLength(1);
	});
});

describe('describeCheckpointOrigin', () => {
	it('names each origin', () => {
		expect(describeCheckpointOrigin('manual')).toBe('Manual');
		expect(describeCheckpointOrigin('auto-run')).toBe('Auto Run');
		expect(describeCheckpointOrigin('pre-restore')).toBe('Before restore');
	});
});

describe('defaultCheckpointLabel', () => {
	it('is a stable, sortable-looking timestamp', () => {
		expect(defaultCheckpointLabel(Date.parse('2026-09-01T12:34:56'))).toMatch(
			/^Checkpoint \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/
		);
	});
});
