import { describe, expect, test } from 'bun:test';
import {
	mergePlaybooks,
	resolveOmpSessionId,
	toCueEntries,
	toSessionList,
	toSessionListEntry,
} from '../host-mappers';

describe('toSessionListEntry', () => {
	test('maps stored session fields, defaulting title/status/projectPath', () => {
		expect(
			toSessionListEntry({ id: 'a', name: 'Build', state: 'busy', projectRoot: '/r', cwd: '/c' })
		).toEqual({ id: 'a', title: 'Build', status: 'busy', projectPath: '/r' });
		// defaults: title<-id, status<-unknown, projectPath<-cwd
		expect(toSessionListEntry({ id: 'b', cwd: '/c' })).toEqual({
			id: 'b',
			title: 'b',
			status: 'unknown',
			projectPath: '/c',
		});
	});

	test('carries engine + resume key for omp-native sessions', () => {
		expect(
			toSessionListEntry({ id: 'a', name: 'Build', toolType: 'pi', ompSessionId: '/s/a.jsonl' })
		).toEqual({
			id: 'a',
			title: 'Build',
			status: 'unknown',
			projectPath: '',
			engine: 'omp',
			ompSessionId: '/s/a.jsonl',
		});
		// 'mae' (branded TUI) is also omp-engine and carries its resume key
		const mae = toSessionListEntry({ id: 'm', toolType: 'mae', ompSessionId: '/s/m.jsonl' });
		expect(mae.engine).toBe('omp');
		expect(mae.ompSessionId).toBe('/s/m.jsonl');
		// non-omp session carries no engine/resume key
		const claude = toSessionListEntry({ id: 'c', toolType: 'claude-code' });
		expect(claude.engine).toBeUndefined();
		expect(claude.ompSessionId).toBeUndefined();
	});

	test('derives the omp resume key from the omp aiTab when not top-level', () => {
		const entry = toSessionListEntry({
			id: 'g',
			toolType: 'pi',
			activeTabId: 't2',
			aiTabs: [
				{ id: 't1', agentSessionId: null },
				{ id: 't2', agentSessionId: '/s/g.jsonl' },
			],
		});
		expect(entry.engine).toBe('omp');
		expect(entry.ompSessionId).toBe('/s/g.jsonl');
	});

	test('toSessionList maps a list', () => {
		expect(toSessionList([{ id: 'a' }, { id: 'b', name: 'B' }]).map((s) => s.title)).toEqual([
			'a',
			'B',
		]);
	});
});

describe('resolveOmpSessionId', () => {
	test('top-level ompSessionId wins', () => {
		expect(
			resolveOmpSessionId({ id: 'a', toolType: 'pi', ompSessionId: '/top.jsonl', aiTabs: [] })
		).toBe('/top.jsonl');
	});
	test('prefers the active aiTab, else the first tab with a key', () => {
		const tabs = [
			{ id: 't1', agentSessionId: '/first.jsonl' },
			{ id: 't2', agentSessionId: '/active.jsonl' },
		];
		expect(resolveOmpSessionId({ id: 'a', toolType: 'pi', activeTabId: 't2', aiTabs: tabs })).toBe(
			'/active.jsonl'
		);
		expect(
			resolveOmpSessionId({
				id: 'a',
				toolType: 'pi',
				activeTabId: 't3',
				aiTabs: [
					{ id: 't3', agentSessionId: null },
					{ id: 't1', agentSessionId: '/first.jsonl' },
				],
			})
		).toBe('/first.jsonl');
	});
	test('undefined for non-omp engines or when no tab carries a key', () => {
		expect(
			resolveOmpSessionId({ id: 'a', toolType: 'claude-code', aiTabs: [{ agentSessionId: '/x' }] })
		).toBeUndefined();
		expect(resolveOmpSessionId({ id: 'a', toolType: 'pi' })).toBeUndefined();
		expect(
			resolveOmpSessionId({ id: 'a', toolType: 'pi', aiTabs: [{ agentSessionId: null }] })
		).toBeUndefined();
	});
});

describe('toCueEntries', () => {
	test('de-dupes subscriptions and uses the most recent run time', () => {
		const graph = [
			{ subscriptions: [{ name: 'nightly' }, { name: 'onPush', lastFiredAt: 5 }] },
			{ subscriptions: [{ name: 'nightly' }] },
		];
		const recent = [
			{ subscriptionName: 'nightly', finishedAt: 100 },
			{ subscriptionName: 'nightly', finishedAt: 50 },
		];
		const entries = toCueEntries(graph, recent);
		expect(entries).toEqual([
			{ name: 'nightly', lastFiredAt: 100 },
			{ name: 'onPush', lastFiredAt: 5 },
		]);
	});

	test('handles empty input', () => {
		expect(toCueEntries([], [])).toEqual([]);
	});
});

describe('mergePlaybooks', () => {
	test('merges + de-dupes by id across files', () => {
		const merged = mergePlaybooks([
			{ playbooks: [{ id: 'p1', name: 'Ship' }, { id: 'p2' }] },
			{
				playbooks: [
					{ id: 'p1', name: 'dup' },
					{ id: 'p3', name: 'Deploy' },
				],
			},
		]);
		expect(merged).toEqual([
			{ id: 'p1', name: 'Ship' },
			{ id: 'p2', name: 'p2' },
			{ id: 'p3', name: 'Deploy' },
		]);
	});
});
