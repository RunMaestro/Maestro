/**
 * Tests for findOwningSessionRecord - the lookup that ties a spawn's process id
 * back to the persisted agent whose Claude token source (API / TUI / Dynamic)
 * the turn must honor. Auto Run, goal iterations and the Cue assistant spawn
 * under `{agentId}-batch-*` / `{agentId}-cue-assist-*` ids, which a bare `-ai-`
 * strip never matched, so those turns ran `claude --print` on a TUI agent.
 */
import { describe, it, expect } from 'vitest';
import { findOwningSessionRecord } from '../../../../../main/ipc/handlers/process/resolve-claude-spawn-context';

const AGENT = 'b9bc0d08-5be2-4fdf-93cd-5618a8d53b35';
const OTHER = 'a1111111-2222-3333-4444-555555555555';

describe('findOwningSessionRecord', () => {
	const sessions = [{ id: OTHER }, { id: AGENT }];

	it('matches the exact base id first (AI tab turns)', () => {
		expect(findOwningSessionRecord(sessions, `${AGENT}-ai-tab1`, AGENT)?.id).toBe(AGENT);
	});

	it('resolves an Auto Run batch id to its agent', () => {
		const pid = `${AGENT}-batch-1760000000000`;
		expect(findOwningSessionRecord(sessions, pid, pid)?.id).toBe(AGENT);
	});

	it('resolves a Cue assistant id to its agent', () => {
		const pid = `${AGENT}-cue-assist-1760000000000`;
		expect(findOwningSessionRecord(sessions, pid, pid)?.id).toBe(AGENT);
	});

	it('prefers the longest matching id', () => {
		const nested = [{ id: 'agent' }, { id: 'agent-batch' }];
		expect(findOwningSessionRecord(nested, 'agent-batch-1', 'agent-batch-1')?.id).toBe(
			'agent-batch'
		);
	});

	it('does not match an id without the separator', () => {
		expect(findOwningSessionRecord(sessions, `${AGENT}xyz`, `${AGENT}xyz`)).toBeUndefined();
	});

	it('returns undefined for spawns no agent owns', () => {
		expect(findOwningSessionRecord(sessions, 'tab-naming-123', 'tab-naming-123')).toBeUndefined();
	});
});
