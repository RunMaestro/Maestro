import { describe, it, expect } from 'vitest';
import {
	findSpawnOwner,
	withHostAgentEnv,
} from '../../../../main/web-server/handlers/remoteSpawnEnv';
import type { StoredSession } from '../../../../main/stores/types';

function agent(id: string, customEnvVars?: Record<string, string>): StoredSession {
	return { id, name: id, toolType: 'codex', cwd: '/w', projectRoot: '/w', customEnvVars };
}

describe('findSpawnOwner', () => {
	it('matches the agent id exactly or as a dash prefix, longest first', () => {
		const sessions = [agent('a'), agent('a-ai'), agent('b')];
		expect(findSpawnOwner('a', sessions)?.id).toBe('a');
		expect(findSpawnOwner('a-batch-123', sessions)?.id).toBe('a');
		expect(findSpawnOwner('a-ai-tab', sessions)?.id).toBe('a-ai');
		expect(findSpawnOwner('ab-ai-tab', sessions)).toBeUndefined();
		expect(findSpawnOwner('wizard-123', sessions)).toBeUndefined();
	});
});

describe('withHostAgentEnv', () => {
	it("fills the agent's saved env when the browser sent none", () => {
		const sessions = [
			agent('one', { CODEX_HOME: '/profiles/a' }),
			agent('two', { CODEX_HOME: '/profiles/b' }),
		];
		expect(withHostAgentEnv({ sessionId: 'one-ai-t1' }, sessions).sessionCustomEnvVars).toEqual({
			CODEX_HOME: '/profiles/a',
		});
		expect(withHostAgentEnv({ sessionId: 'two-ai-t1' }, sessions).sessionCustomEnvVars).toEqual({
			CODEX_HOME: '/profiles/b',
		});
	});

	it('keeps values the client sent over the saved ones', () => {
		const sessions = [agent('one', { CLAUDE_CONFIG_DIR: '/saved', KEEP: '1' })];
		const out = withHostAgentEnv(
			{ sessionId: 'one-ai-t', sessionCustomEnvVars: { CLAUDE_CONFIG_DIR: '/sent' } },
			sessions
		);
		expect(out.sessionCustomEnvVars).toEqual({ CLAUDE_CONFIG_DIR: '/sent', KEEP: '1' });
	});

	it('returns the config untouched without a saved owner or saved env', () => {
		const config = { sessionId: 'wizard-1', sessionCustomEnvVars: { X: '1' } };
		expect(withHostAgentEnv(config, [agent('one', { A: '1' })])).toBe(config);
		const bare = { sessionId: 'one-ai-t' };
		expect(withHostAgentEnv(bare, [agent('one')])).toBe(bare);
		expect(withHostAgentEnv(bare, [agent('one', {})])).toBe(bare);
		const noId = { prompt: 'x' };
		expect(withHostAgentEnv(noId, [agent('one', { A: '1' })])).toBe(noId);
	});

	it('does not mutate the incoming config', () => {
		const config = { sessionId: 'one-ai-t' };
		withHostAgentEnv(config, [agent('one', { A: '1' })]);
		expect(config).toEqual({ sessionId: 'one-ai-t' });
	});
});
