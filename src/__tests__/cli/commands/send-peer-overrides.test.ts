/**
 * `maestro-cli send <peer:agent>`: the sender's own choices for one turn (`--model`, `--effort`,
 * `--read-only`, `--no-history`) become the same `TurnOverrides` the mirror composer's chips send.
 */
import { describe, expect, it } from 'vitest';
import { peerTurnOverrides } from '../../../cli/commands/send';

describe('peerTurnOverrides', () => {
	it('maps the send flags onto this turn only', () => {
		expect(
			peerTurnOverrides({ model: 'sonnet', effort: 'high', readOnly: true, history: false })
		).toEqual({ model: 'sonnet', effort: 'high', readOnly: true, saveToHistory: false });
	});

	it('sends nothing when no flag asks for anything', () => {
		expect(peerTurnOverrides({})).toBeUndefined();
		expect(peerTurnOverrides({ history: true, systemPrompt: true })).toBeUndefined();
	});
});
