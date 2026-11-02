import { describe, it, expect } from 'vitest';
import {
	agentInventoryTags,
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
			// session: reasons are per process: two busy tabs of one agent are two.
			'session:agent-3-ai-tab-1',
			'session:agent-3-ai-tab-2',
			'cue:run:run-9',
			'groupchat:chat-4',
			'something-else',
		]);
		expect(context).toEqual({ autorunRuns: 2, agentProcesses: 2, cueRuns: 1, groupChats: 1 });
		expect(workContextTags(context)).toEqual({
			'autorun.count': '2',
			'agents.processes': '2',
			'cue.active': 'true',
			'groupchat.active': 'true',
		});
	});

	it('reports idle when nothing is in flight', () => {
		expect(workContextTags(summarizeWorkReasons([]))).toEqual({
			'autorun.count': '0',
			'agents.processes': '0',
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
