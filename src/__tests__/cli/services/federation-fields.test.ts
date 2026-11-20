/**
 * Tests for readAgentFederation, the `federation` block of `maestro-cli show agent`: every
 * setting's scope from the Federation tables, and what waits on it as the desktop reports it.
 * With no desktop to ask, every scope is still there and `stateKnown` is false.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendCommand = vi.fn();
vi.mock('../../../cli/services/maestro-client', () => ({
	withMaestroClient: vi.fn(async (fn: (client: { sendCommand: typeof sendCommand }) => unknown) =>
		fn({ sendCommand })
	),
}));

import { readAgentFederation } from '../../../cli/services/federation-fields';
import { describeFederationFields } from '../../../shared/maestro-lib/agents/lift-settings-sync';

describe('readAgentFederation', () => {
	beforeEach(() => {
		sendCommand.mockReset();
	});

	it("asks the desktop for the agent's field states and reports them with their labels", async () => {
		sendCommand.mockResolvedValue({
			success: true,
			fields: describeFederationFields({
				pendingIds: ['customModel'],
				conflictIds: ['nudgeMessage'],
			}),
		});
		const report = await readAgentFederation('box', 'host-1');
		expect(sendCommand).toHaveBeenCalledWith(
			{ type: 'federation_command', action: 'settings-fields', agent: 'box:host-1' },
			'federation_command_result'
		);
		expect(report).toMatchObject({ host: 'box:host-1', stateKnown: true });
		expect(report.fields.model).toMatchObject({
			scope: 'shared',
			label: 'From host',
			pending: true,
		});
		expect(report.fields.nudgeMessage).toMatchObject({ conflict: true });
		expect(report.fields.gatewayUrl).toMatchObject({ scope: 'machine', label: 'This machine' });
		expect(report.fields.tierTargets).toMatchObject({
			scope: 'not-synced',
			label: 'Not synced yet',
		});
	});

	it('still reports every scope when the desktop cannot be asked', async () => {
		sendCommand.mockRejectedValue(new Error('Maestro is not running'));
		const report = await readAgentFederation('box', 'host-1');
		expect(report).toMatchObject({
			stateKnown: false,
			stateError: 'Maestro is not running',
		});
		expect(report.fields.model).toMatchObject({ scope: 'shared', pending: false, conflict: false });
	});
});
