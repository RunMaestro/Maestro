import { describe, it, expect } from 'vitest';
import {
	agentInventoryTags,
	buildNativeCrashFingerprint,
	sentryUserForInstallation,
	summarizeAgentInventory,
	summarizeWorkReasons,
	workContextTags,
} from '../../shared/sentryContext';

describe('sentryUserForInstallation', () => {
	it('uses the install GUID as user.id and nothing else', () => {
		expect(sentryUserForInstallation('70d87ba7-16f0-466d-a8b7-ba2f6702f1c9')).toEqual({
			id: '70d87ba7-16f0-466d-a8b7-ba2f6702f1c9',
		});
	});

	it('returns undefined for a missing or blank id, so Sentry keeps no user rather than an empty one', () => {
		expect(sentryUserForInstallation(undefined)).toBeUndefined();
		expect(sentryUserForInstallation(null)).toBeUndefined();
		expect(sentryUserForInstallation('   ')).toBeUndefined();
	});
});

describe('summarizeWorkReasons / workContextTags', () => {
	it('counts each kind of power-manager reason by prefix', () => {
		const context = summarizeWorkReasons([
			'autorun:agent-1',
			'autorun:agent-2',
			'session:agent-3',
			'cue:run:run-9',
			'groupchat:chat-4',
			'something-else',
		]);
		expect(context).toEqual({ autorunRuns: 2, busyAgents: 1, cueRuns: 1, groupChats: 1 });
		expect(workContextTags(context)).toEqual({
			'autorun.active': 'true',
			'autorun.count': '2',
			'agents.busy': '1',
			'cue.active': 'true',
			'groupchat.active': 'true',
		});
	});

	it('reports idle when nothing is in flight', () => {
		expect(workContextTags(summarizeWorkReasons([]))).toEqual({
			'autorun.active': 'false',
			'autorun.count': '0',
			'agents.busy': '0',
			'cue.active': 'false',
			'groupchat.active': 'false',
		});
	});

	it('never puts the ids after the prefix into a tag', () => {
		const tags = workContextTags(summarizeWorkReasons(['autorun:secret-agent-id']));
		expect(Object.values(tags).join(' ')).not.toContain('secret-agent-id');
	});
});

describe('summarizeAgentInventory / agentInventoryTags', () => {
	it('reports the agent count and the sorted, distinct provider type ids', () => {
		const inventory = summarizeAgentInventory([
			{ toolType: 'codex' },
			{ toolType: 'claude-code' },
			{ toolType: 'claude-code' },
			{ toolType: 'terminal' },
		]);
		expect(inventory).toEqual({ count: 4, providers: ['claude-code', 'codex', 'terminal'] });
		expect(agentInventoryTags(inventory)).toEqual({
			'agents.count': '4',
			'agents.providers': 'claude-code,codex,terminal',
		});
	});

	it('collapses an unknown toolType to "other" instead of echoing stored text', () => {
		const inventory = summarizeAgentInventory([
			{ toolType: '/Users/someone/private/path' },
			{ toolType: 42 },
			{},
		]);
		expect(inventory).toEqual({ count: 3, providers: ['other'] });
	});

	it('reports "none" for an empty agent list', () => {
		expect(agentInventoryTags(summarizeAgentInventory([]))).toEqual({
			'agents.count': '0',
			'agents.providers': 'none',
		});
	});
});

describe('buildNativeCrashFingerprint', () => {
	// The shape @sentry/electron hands beforeSend for a minidump found at startup
	// (sentry-minidump integration): no exception yet, the SDK's native tags, and
	// the crashpad annotations copied onto contexts.electron with a `crashpad.`
	// prefix. Values mirror MAESTRO-174's event as Sentry stored it.
	const heapOomMinidump = () => ({
		level: 'fatal',
		platform: 'native',
		tags: { 'event.environment': 'native', 'event.process': 'browser' },
		contexts: {
			electron: {
				'crashpad.electron.v8-oom.is_heap_oom': '1',
				'crashpad.electron.v8-oom.location': 'Ineffective mark-compacts near heap limit',
				'crashpad.process_type': 'browser',
			},
		},
	});

	it('groups a V8 heap OOM minidump by process', () => {
		expect(buildNativeCrashFingerprint(heapOomMinidump())).toEqual([
			'native-crash',
			'v8-heap-oom',
			'browser',
		]);
	});

	it('gives the same fingerprint whatever the OOM location, so allocation paths do not split it', () => {
		const other = heapOomMinidump();
		other.contexts.electron['crashpad.electron.v8-oom.location'] = 'Reached heap limit';
		expect(buildNativeCrashFingerprint(other)).toEqual(
			buildNativeCrashFingerprint(heapOomMinidump())
		);
	});

	it('lowercases the process, since the SDK reports both "GPU" and "gpu"', () => {
		const event = heapOomMinidump();
		event.tags['event.process'] = 'GPU';
		expect(buildNativeCrashFingerprint(event)).toEqual(['native-crash', 'v8-heap-oom', 'gpu']);
	});

	it('falls back to "unknown" when the process could not be determined', () => {
		const event = heapOomMinidump();
		delete (event.tags as Record<string, string>)['event.process'];
		expect(buildNativeCrashFingerprint(event)).toEqual(['native-crash', 'v8-heap-oom', 'unknown']);
	});

	it('also matches the renderer-OOM event that already carries the parsed V8 stack', () => {
		const event = {
			...heapOomMinidump(),
			tags: { 'event.environment': 'native', 'event.process': 'renderer' },
			exception: { values: [{ type: 'OutOfMemoryError', value: 'Renderer reached heap limit' }] },
		};
		expect(buildNativeCrashFingerprint(event)).toEqual(['native-crash', 'v8-heap-oom', 'renderer']);
	});

	it('keeps default grouping for a native crash that is not a heap OOM', () => {
		// e.g. MAESTRO-SG / MAESTRO-9K: no OOM annotation, the stack is the signal.
		expect(
			buildNativeCrashFingerprint({
				tags: { 'event.environment': 'native', 'event.process': 'unknown' },
				contexts: { electron: {} },
			})
		).toBeUndefined();
	});

	it('ignores JavaScript events entirely', () => {
		const event = heapOomMinidump();
		event.tags['event.environment'] = 'javascript';
		expect(buildNativeCrashFingerprint(event)).toBeUndefined();
		expect(buildNativeCrashFingerprint({})).toBeUndefined();
	});
});
