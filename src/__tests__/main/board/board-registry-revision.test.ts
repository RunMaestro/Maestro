import { describe, expect, it } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { BoardRegistryRevision } from '../../../main/board/board-registry-revision';
import { canonicalJson } from '../../../shared/canonicalJson';

/** Same complete inputs as the desktop fence, including non-public launch fields. */
function registry() {
	return {
		catalog: {
			agents: [{ id: 'worker', groupId: 'group' }],
			groups: [{ id: 'group' }],
			profiles: [{ namespace: 'legacy', profile: { id: 'role', model: 'model' } }],
			repositories: [
				{ id: 'repo', validated: true, workingDirectory: path.join(os.tmpdir(), 'fixture') },
			],
			defaultStartMode: 'approval',
		},
		agents: [
			{
				id: 'worker',
				groupId: 'group',
				toolType: 'codex',
				cwd: '/fixture',
				customModel: 'model',
				customEffort: 'medium',
				customArgs: '--arg',
				customEnvVars: { SYNTHETIC: 'value' },
				appendSystemPrompt: 'instructions',
				sessionSshRemoteConfig: { enabled: true, remoteId: 'remote' },
				aiTabs: [{ id: 'tab', logs: [{ text: 'transcript', timestamp: 1 }] }],
				futureLaunchInput: { values: [false, null, 0, 'value'] },
			},
		],
		groups: [{ id: 'group', name: 'Group', parentId: 'parent' }],
		workers: [
			{
				agentId: 'worker',
				enabled: true,
				paused: false,
				revision: 3,
				payload: {
					allowedRepositoryIds: ['repo'],
					roleRefs: [{ namespace: 'legacy', profileId: 'role' }],
					executionOptions: { model: 'model', customArgs: '--worker' },
					unknown: { value: 1 },
				},
			},
		],
		agentConfigs: {
			codex: { path: path.join(os.tmpdir(), 'fixture', 'provider'), env: { SYNTHETIC: 'config' } },
		},
		sshRemotes: [
			{
				id: 'remote',
				host: 'fixture.invalid',
				port: 22,
				options: { IdentityFile: path.join(os.tmpdir(), 'fixture', 'key') },
			},
		],
	};
}

describe('complete Board registry revision', () => {
	it('matches the original canonical fence for changes and deletions at every input leaf', () => {
		const original = registry();
		const paths: string[][] = [];
		function visit(value: unknown, path: string[]) {
			if (value && typeof value === 'object') {
				for (const key of Object.keys(value))
					visit((value as Record<string, unknown>)[key], [...path, key]);
			} else paths.push(path);
		}
		visit(original, []);
		expect(paths.length).toBeGreaterThan(45);
		const tracker = new BoardRegistryRevision();
		let fingerprint = '';
		let revision = 0;
		function compare(value: Record<string, unknown>) {
			const next = canonicalJson(value);
			if (next !== fingerprint) {
				fingerprint = next;
				revision++;
			}
			expect(tracker.observe(value)).toBe(revision);
		}
		compare(original);
		for (const path of paths) {
			for (const remove of [false, true]) {
				const changed = structuredClone(original);
				let parent: Record<string, unknown> = changed;
				for (const key of path.slice(0, -1)) parent = parent[key] as Record<string, unknown>;
				const key = path.at(-1)!;
				// Array holes are invalid JSON; those are exercised in the refusal cases.
				if (remove && Array.isArray(parent)) continue;
				if (remove) delete parent[key];
				else parent[key] = { changed: 'all fields count' };
				compare(changed);
				compare(original);
			}
		}
	});

	it('detects in-place changes even when the store returns the same object again', () => {
		const input = registry();
		const tracker = new BoardRegistryRevision();
		expect(tracker.observe(input)).toBe(1);
		input.agents[0].customEnvVars.SYNTHETIC = 'edited';
		expect(tracker.observe(input)).toBe(2);
		input.agents[0].aiTabs[0].logs[0].text = 'edited transcript';
		expect(tracker.observe(input)).toBe(3);
		input.workers[0].payload.unknown.value++;
		expect(tracker.observe(input)).toBe(4);
		expect(tracker.observe(structuredClone(input))).toBe(4);
	});

	it('preserves canonical semantics for order, omitted values and numeric representations', () => {
		const tracker = new BoardRegistryRevision();
		expect(tracker.observe({ a: [{ '2': 2, '10': 10, z: 0, optional: undefined }], b: null })).toBe(
			1
		);
		expect(tracker.observe({ b: null, a: [{ z: -0, '10': 10, '2': 2 }] })).toBe(1);
		expect(tracker.observe({ b: null, a: [{ z: 0, '10': 10, '2': 2 }], omitted: undefined })).toBe(
			1
		);
		expect(tracker.observe({ a: [], b: null })).toBe(2);
		expect(tracker.observe({ a: {}, b: null })).toBe(3);
		expect(tracker.observe({ replaced: {}, b: null })).toBe(4);
		expect(tracker.observe({ replaced: {}, b: null, future: ['\ud800', 'é', '"\\'] })).toBe(5);
		expect(tracker.observe({ replaced: {}, b: null, future: ['é', '\ud800', '"\\'] })).toBe(6);
		expect(tracker.observe({ replaced: {}, b: null })).toBe(7);
	});

	it.each([
		NaN,
		Infinity,
		1n,
		new Date(0),
		new Map(),
		() => 0,
		Symbol('invalid'),
		[undefined],
		new Array(1),
	])('refuses non-JSON input without advancing or poisoning the previous fence (%#)', (invalid) => {
		const tracker = new BoardRegistryRevision();
		expect(tracker.observe({ agents: [{ field: null }], other: 1 })).toBe(1);
		expect(() => tracker.observe({ agents: [{ field: invalid }], other: 2 })).toThrow(TypeError);
		expect(tracker.observe({ agents: [{ field: null }], other: 1 })).toBe(1);
		expect(tracker.observe({ agents: [{ field: null }], other: 2 })).toBe(2);
	});

	it('refuses cyclic values after a valid observation', () => {
		const tracker = new BoardRegistryRevision();
		const cycle: Record<string, unknown> = {};
		cycle.self = cycle;
		expect(tracker.observe({ agents: [{}] })).toBe(1);
		expect(() => tracker.observe({ agents: [cycle] })).toThrow(TypeError);
		expect(tracker.observe({ agents: [{}] })).toBe(1);
	});
});
