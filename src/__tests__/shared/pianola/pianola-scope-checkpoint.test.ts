/** Persistence contracts: corruption must never be interpreted as fresh enrollment. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { createPianolaFsStore, type PianolaFsStore } from '../../../shared/pianola/fs-store';
import {
	validatePianolaScopeCheckpoint,
	type PianolaScopeCheckpoint,
} from '../../../shared/pianola/pianola-scope-checkpoint';
import { initialWatchState } from '../../../shared/pianola/pianola-watcher';

const scopeId = '11111111-1111-4111-8111-111111111111';
const otherScopeId = '22222222-2222-4222-8222-222222222222';
const fixtureRoot = path.resolve('.maestro/pianola-project-watchers-20261028/auto-run/Working');
let directory: string;
let store: PianolaFsStore;

beforeEach(() => {
	fs.mkdirSync(fixtureRoot, { recursive: true });
	directory = fs.mkdtempSync(path.join(fixtureRoot, 'scope-checkpoint-'));
	store = createPianolaFsStore({ resolveDir: () => directory, indent: 2, trailingNewline: true });
});

afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

function checkpoint(): PianolaScopeCheckpoint {
	return {
		version: 1,
		scopeId,
		configurationFingerprint: 'a'.repeat(64),
		activatedAt: 100,
		lastSnapshotAt: 110,
		status: 'armed',
		tabs: [
			{
				agentId: 'owner',
				tabId: 'tab',
				bindingFingerprint: 'b'.repeat(64),
				baseline: { id: 'old', count: 1, textLength: 20 },
				lastSeen: { id: 'new', count: 2, textLength: 30 },
				state: initialWatchState(),
				status: 'active',
				unresolvedIntent: null,
			},
		],
	};
}

function checkpointPath(id = scopeId): string {
	return path.join(directory, `maestro-pianola-scope-${id}.json`);
}

describe('scope checkpoint validation', () => {
	it('accepts old schema-v1 checkpoints without optional census and binding fields', () => {
		const value = checkpoint();
		delete value.lastSnapshotAt;
		delete value.tabs[0].bindingFingerprint;
		expect(validatePianolaScopeCheckpoint(value, scopeId)).toEqual(value);
	});

	it.each([
		['schema', (value: PianolaScopeCheckpoint) => ({ ...value, version: 2 })],
		['wrong scope', (value: PianolaScopeCheckpoint) => ({ ...value, scopeId: otherScopeId })],
		[
			'fingerprint',
			(value: PianolaScopeCheckpoint) => ({ ...value, configurationFingerprint: 'bad' }),
		],
		['negative activation', (value: PianolaScopeCheckpoint) => ({ ...value, activatedAt: -1 })],
		['fractional activation', (value: PianolaScopeCheckpoint) => ({ ...value, activatedAt: 1.5 })],
		['earlier census', (value: PianolaScopeCheckpoint) => ({ ...value, lastSnapshotAt: 99 })],
		['unknown status', (value: PianolaScopeCheckpoint) => ({ ...value, status: 'ready' })],
		[
			'duplicate membership',
			(value: PianolaScopeCheckpoint) => ({ ...value, tabs: [value.tabs[0], value.tabs[0]] }),
		],
		[
			'too many members',
			(value: PianolaScopeCheckpoint) => ({
				...value,
				tabs: Array.from({ length: 10001 }, (_, index) => ({
					...value.tabs[0],
					tabId: `tab-${index}`,
				})),
			}),
		],
	])('rejects %s rather than partially restoring a checkpoint', (_name, mutate) => {
		expect(validatePianolaScopeCheckpoint(mutate(checkpoint()), scopeId)).toBeNull();
	});

	it.each([
		['empty owner', { agentId: '' }],
		['missing tab', { tabId: undefined }],
		['bad binding', { bindingFingerprint: 'x' }],
		['invalid busy baseline', { baselineBusy: 'true' }],
		['zero cursor count', { baseline: { id: 'old', count: 0, textLength: 1 } }],
		['negative cursor length', { lastSeen: { id: 'old', count: 1, textLength: -1 } }],
		[
			'unsafe cursor count',
			{ lastSeen: { id: 'old', count: Number.MAX_SAFE_INTEGER + 1, textLength: 1 } },
		],
		['missing watcher state', { state: {} }],
		[
			'invalid retry',
			{ state: { ...initialWatchState(), pendingRetry: { messageId: 'ask', attempts: -1 } } },
		],
		[
			'invalid handoff',
			{
				state: {
					...initialWatchState(),
					pendingHandoff: { messageId: 'ask', polls: 0, classification: {} },
				},
			},
		],
		['unknown tab status', { status: 'ready' }],
		['incomplete intent', { unresolvedIntent: { decisionId: 'decision' } }],
	])('rejects a member with %s', (_name, fields) => {
		const value = checkpoint();
		const raw = { ...value, tabs: [{ ...value.tabs[0], ...fields }] };
		expect(validatePianolaScopeCheckpoint(raw, scopeId)).toBeNull();
	});

	it('keeps composite membership identities distinct even when their delimiters overlap', () => {
		const value = checkpoint();
		value.tabs = [
			{ ...value.tabs[0], agentId: 'a/b', tabId: 'c' },
			{ ...value.tabs[0], agentId: 'a', tabId: 'b/c' },
		];
		expect(validatePianolaScopeCheckpoint(value, scopeId)).toEqual(value);
	});
});

describe('scope checkpoint filesystem storage', () => {
	it('retains enrollment revision CAS and bounds the locked writer lifetime and scope', async () => {
		const stale = checkpoint();
		const current = { ...checkpoint(), enrollmentRevision: 2 };
		let escaped: PianolaFsStore['writeScopeCheckpoint'] | undefined;
		await store.withScopeCheckpointLockAsync(scopeId, (write) => {
			escaped = write;
			expect(() => write({ ...current, scopeId: otherScopeId })).toThrow('lock unavailable');
			write(current, true);
		});
		expect(() => escaped!(stale)).toThrow('lock unavailable');
		await expect(
			store.withScopeCheckpointLockAsync(scopeId, (write) => write(stale, true))
		).rejects.toThrow('enrollment changed');
		expect(store.readScopeCheckpoint(scopeId)).toEqual(current);
		const receipts: unknown[] = [];
		await store.withScopeCheckpointLockAsync(scopeId, (write) => {
			write({ ...current, status: 'suspended' }, true, (receipt) => {
				expect(fs.existsSync(checkpointPath() + '.lock')).toBe(true);
				expect(JSON.parse(receipt.after!).status).toBe('suspended');
				receipts.push(receipt);
			});
		});
		expect(receipts).toHaveLength(1);
		expect(fs.existsSync(checkpointPath() + '.lock')).toBe(false);
	});

	it('ignores absent optional tab fields but persists real authority and ordered membership changes', () => {
		const value = checkpoint();
		store.writeScopeCheckpoint(value);
		const inode = fs.statSync(checkpointPath(), { bigint: true }).ino;
		const passive = structuredClone(value);
		passive.lastSnapshotAt = 120;
		passive.tabs[0].nextWatchAt = undefined;
		passive.tabs[0].emptyEnrollment = undefined;
		store.writeScopeCheckpoint(passive);
		expect(fs.statSync(checkpointPath(), { bigint: true }).ino).toBe(inode);
		passive.tabs[0].nextWatchAt = 150;
		store.writeScopeCheckpoint(passive);
		expect(store.readScopeCheckpoint(scopeId)?.tabs[0].nextWatchAt).toBe(150);
		passive.tabs[0].unresolvedIntent = { decisionId: 'decision', messageId: 'ask' };
		store.writeScopeCheckpoint(passive);
		expect(store.readScopeCheckpoint(scopeId)?.tabs[0].unresolvedIntent?.decisionId).toBe(
			'decision'
		);
		passive.tabs.push({ ...structuredClone(passive.tabs[0]), tabId: 'other' });
		store.writeScopeCheckpoint(passive);
		passive.tabs.reverse();
		store.writeScopeCheckpoint(passive);
		expect(store.readScopeCheckpoint(scopeId)?.tabs.map((tab) => tab.tabId)).toEqual([
			'other',
			'tab',
		]);
	});

	it('persists cursor, ownership, pause, and unknown-delivery changes within the observation window', () => {
		const value = checkpoint();
		store.writeScopeCheckpoint(value);
		const changes = [
			() => (value.tabs[0].lastSeen = { id: 'later', count: 3, textLength: 40 }),
			() => (value.tabs[0].bindingFingerprint = 'c'.repeat(64)),
			() => (value.tabs[0].status = 'suspended'),
			() =>
				(value.tabs[0].unresolvedIntent = {
					decisionId: 'unknown',
					messageId: 'ask',
					admitted: true,
				}),
		];
		for (const change of changes) {
			const before = fs.statSync(checkpointPath(), { bigint: true }).ino;
			change();
			value.lastSnapshotAt!++;
			value.tabs[0].nextWatchAt = undefined;
			store.writeScopeCheckpoint(value);
			expect(fs.statSync(checkpointPath(), { bigint: true }).ino).not.toBe(before);
			expect(store.readScopeCheckpoint(scopeId)).toEqual(JSON.parse(JSON.stringify(value)));
		}
	});

	it('skips passive clocks but persists retry authority and durable clocks', () => {
		const value = checkpoint();
		store.writeScopeCheckpoint(value);
		const before = fs.readFileSync(checkpointPath(), 'utf8');
		const inode = fs.statSync(checkpointPath(), { bigint: true }).ino;
		// A caller's property insertion order must not force an otherwise equal write.
		const { tabs, ...rest } = value;
		const reordered = { tabs, ...rest, lastSnapshotAt: 120, nextTabIndex: 1 };
		store.writeScopeCheckpoint(reordered);
		expect(fs.readFileSync(checkpointPath(), 'utf8')).toBe(before);
		expect(fs.statSync(checkpointPath(), { bigint: true }).ino).toBe(inode);
		reordered.tabs[0].state.pendingRetry = { messageId: 'ask', attempts: 1 };
		store.writeScopeCheckpoint(reordered);
		expect(store.readScopeCheckpoint(scopeId)?.tabs[0].state.pendingRetry).toEqual({
			messageId: 'ask',
			attempts: 1,
		});
		store.writeScopeCheckpoint({ ...reordered, lastSnapshotAt: 130 }, true);
		expect(store.readScopeCheckpoint(scopeId)?.lastSnapshotAt).toBe(130);
	});

	it('distinguishes a missing checkpoint from invalid JSON and invalid schema', () => {
		expect(store.readScopeCheckpoint(scopeId)).toBeNull();
		fs.writeFileSync(checkpointPath(), '{broken');
		expect(() => store.readScopeCheckpoint(scopeId)).toThrow('checkpoint JSON');
		fs.writeFileSync(checkpointPath(), JSON.stringify({ ...checkpoint(), version: 2 }));
		expect(() => store.readScopeCheckpoint(scopeId)).toThrow('Invalid Pianola scope checkpoint');
	});

	it('round trips retry state, suspended membership and an unresolved delivery intent through restart', () => {
		const value = checkpoint();
		value.status = 'suspended';
		value.tabs[0].status = 'closed';
		value.tabs[0].baselineBusy = true;
		value.tabs[0].state.pendingRetry = { messageId: 'ask', attempts: 2 };
		value.tabs[0].unresolvedIntent = { decisionId: 'decision', messageId: 'ask' };
		store.writeScopeCheckpoint(value);
		const restarted = createPianolaFsStore({
			resolveDir: () => directory,
			indent: '\t',
			trailingNewline: false,
		});
		expect(restarted.readScopeCheckpoint(scopeId)).toEqual(value);
		expect(fs.readdirSync(directory)).toEqual([path.basename(checkpointPath())]);
	});

	it('persists a pending handoff classification and its accumulated timeout polls', () => {
		const value = checkpoint();
		value.tabs[0].state.pendingHandoff = {
			messageId: 'ask',
			polls: 7,
			classification: {
				kind: 'question',
				risk: 'low',
				topic: 'naming',
				confidence: 'high',
				evidence: { messageId: 'ask', reason: 'explicit question', structured: false },
			},
		};
		store.writeScopeCheckpoint(value);
		expect(store.readScopeCheckpoint(scopeId)).toEqual(value);
	});

	it('refuses an invalid replacement while preserving the last valid checkpoint', () => {
		const value = checkpoint();
		store.writeScopeCheckpoint(value);
		expect(() =>
			store.writeScopeCheckpoint({ ...value, configurationFingerprint: 'invalid' })
		).toThrow();
		expect(store.readScopeCheckpoint(scopeId)).toEqual(value);
	});

	it.each(['../outside', '/absolute', '', 'not-a-uuid'])(
		'rejects path-like or malformed scope ID %j before any write',
		(id) => {
			expect(() => store.readScopeCheckpoint(id)).toThrow('Invalid Pianola scope ID');
			expect(() => store.writeScopeCheckpoint({ ...checkpoint(), scopeId: id })).toThrow(
				'Invalid Pianola scope ID'
			);
			expect(fs.readdirSync(directory)).toEqual([]);
		}
	);

	it('rejects an oversized checkpoint on read', () => {
		const file = fs.openSync(checkpointPath(), 'w');
		try {
			fs.ftruncateSync(file, 20 * 1024 * 1024 + 1);
		} finally {
			fs.closeSync(file);
		}
		expect(() => store.readScopeCheckpoint(scopeId)).toThrow('checkpoint too large');
	});

	it('preserves the previous file if an atomic replacement cannot write its temporary file', () => {
		const value = checkpoint();
		store.writeScopeCheckpoint(value);
		const now = vi.spyOn(Date, 'now').mockReturnValue(123);
		const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
		try {
			fs.mkdirSync(`${checkpointPath()}.${process.pid}.123.i.tmp`);
			expect(() => store.writeScopeCheckpoint({ ...value, status: 'suspended' })).toThrow();
			expect(store.readScopeCheckpoint(scopeId)).toEqual(value);
		} finally {
			now.mockRestore();
			random.mockRestore();
		}
	});
});

describe('current coverage persistence contract', () => {
	it('round trips coverage failures and census metadata with an admitted unknown intent', () => {
		const value = checkpoint();
		value.coverageRegistryFingerprint = 'c'.repeat(64);
		value.lastCycleError = { observedAt: 120, reason: 'Native census unavailable' };
		value.tabs[0].unresolvedIntent = { decisionId: 'decision', messageId: 'ask', admitted: true };
		value.tabs[0].coverage = {
			observedAt: 110,
			status: 'blocked',
			ownerScopeId: scopeId,
			reason: 'Transcript cursor unavailable',
			nextActor: 'operator',
			nextAction: 'Restore native cursor access',
		};
		store.writeScopeCheckpoint(value);
		const restarted = createPianolaFsStore({
			resolveDir: () => directory,
			indent: 2,
			trailingNewline: true,
		});
		expect(restarted.readScopeCheckpoint(scopeId)).toEqual(value);
	});

	it.each([
		{ observedAt: -1 },
		{ observedAt: '2026-10-28' },
		{ status: 'healthy' },
		{ ownerScopeId: 'invalid' },
		{ nextActor: 'manager' },
		{ reason: 1 },
		{ nextAction: undefined },
	])('rejects malformed per-tab coverage %j', (fields) => {
		const value = checkpoint();
		const coverage = {
			observedAt: 110,
			status: 'blocked',
			ownerScopeId: scopeId,
			reason: 'Cursor unavailable',
			nextActor: 'operator',
			nextAction: 'Restore cursor',
			...fields,
		};
		expect(
			validatePianolaScopeCheckpoint({ ...value, tabs: [{ ...value.tabs[0], coverage }] }, scopeId)
		).toBeNull();
	});

	it.each([
		{ coverageRegistryFingerprint: 'invalid' },
		{ lastCycleError: { observedAt: -1, reason: 'failure' } },
		{ lastCycleError: { observedAt: '2026-10-28', reason: 'failure' } },
		{ lastCycleError: { observedAt: 120, reason: 42 } },
	])('rejects malformed current census metadata %j', (fields) => {
		expect(validatePianolaScopeCheckpoint({ ...checkpoint(), ...fields }, scopeId)).toBeNull();
	});
});
