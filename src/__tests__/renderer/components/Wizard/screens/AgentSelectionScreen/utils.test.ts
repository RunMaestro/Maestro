import { describe, expect, it } from 'vitest';
import type { AgentConfig } from '../../../../../../renderer/types';
import {
	buildConfiguringAgent,
	buildDetectionAnnouncement,
	countSelectableAgentTiles,
	findFirstSelectableTileIndex,
	getConnectionErrors,
	getVisibleAgents,
	hasSshConnectionFailure,
	isAgentAvailable,
} from '../../../../../../renderer/components/Wizard/screens/AgentSelectionScreen/utils/agentAvailability';
import {
	addEnvVar,
	normalizeOptionalWizardString,
	normalizeWizardEnvVars,
	removeEnvVar,
	renameEnvVarKey,
	updateEnvVarValue,
} from '../../../../../../renderer/components/Wizard/screens/AgentSelectionScreen/utils/agentConfigForms';
import {
	AGENT_TILES,
	type AgentTile,
} from '../../../../../../renderer/components/Wizard/screens/AgentSelectionScreen';
import {
	getAgentTileColSpanClass,
	getNextAgentTileIndex,
	LAST_ROW_COL_START_CLASS,
	LAST_ROW_START_INDEX,
} from '../../../../../../renderer/components/Wizard/screens/AgentSelectionScreen/utils/agentGrid';
import {
	getInitialSshRemoteConfig,
	getSshRemoteIdForDetection,
	getSyncedSshRemoteConfig,
	selectSshRemoteConfig,
	toWizardSshRemoteConfig,
} from '../../../../../../renderer/components/Wizard/screens/AgentSelectionScreen/utils/sshConfig';

function agent(overrides: Partial<AgentConfig>): AgentConfig {
	return {
		id: 'claude-code',
		name: 'Claude Code',
		available: true,
		hidden: false,
		...overrides,
	};
}

describe('AgentSelectionScreen utils', () => {
	it('filters hidden agents and detects availability', () => {
		const visible = agent({ id: 'claude-code', available: true });
		const hidden = agent({ id: 'terminal', hidden: true });

		expect(getVisibleAgents([visible, hidden])).toEqual([visible]);
		expect(isAgentAvailable([visible], 'claude-code')).toBe(true);
		expect(isAgentAvailable([visible], 'codex')).toBe(false);
	});

	it('counts and finds selectable supported tiles', () => {
		const detected = [
			agent({ id: 'claude-code', available: true }),
			agent({ id: 'codex', available: false }),
			agent({ id: 'opencode', available: true }),
		];

		expect(countSelectableAgentTiles(AGENT_TILES, detected)).toBe(2);
		expect(findFirstSelectableTileIndex(AGENT_TILES, detected)).toBe(0);
		expect(findFirstSelectableTileIndex(AGENT_TILES, [])).toBe(-1);
	});

	it('detects SSH connection failure only when remote detection returned errors for all agents', () => {
		const errored = [
			agent({ id: 'claude-code', available: false, error: 'Connection timed out' } as any),
			agent({ id: 'codex', available: false, error: 'Connection timed out' } as any),
		];
		const mixed = [
			agent({ id: 'claude-code', available: true }),
			agent({ id: 'codex', available: false, error: 'Missing binary' } as any),
		];

		expect(getConnectionErrors(errored)).toEqual(['Connection timed out', 'Connection timed out']);
		expect(hasSshConnectionFailure(errored, true)).toBe(true);
		expect(hasSshConnectionFailure(errored, false)).toBe(false);
		expect(hasSshConnectionFailure(mixed, true)).toBe(false);
	});

	it('builds detection announcements with remote and auto-select context', () => {
		expect(
			buildDetectionAnnouncement({
				availableCount: 1,
				totalCount: 2,
				remote: false,
				autoSelectedClaude: true,
			})
		).toBe(
			'Agent detection complete. 1 of 2 agents available. Claude Code automatically selected.'
		);

		expect(
			buildDetectionAnnouncement({
				availableCount: 2,
				totalCount: 3,
				remote: true,
				autoSelectedClaude: false,
			})
		).toBe('Agent detection complete on remote host. 2 of 3 agents available.');
	});

	it('computes grid movement boundaries and last-row centering classes', () => {
		// Grid is GRID_COLS (4) wide: ArrowDown moves +4, ArrowUp moves -4.
		expect(getNextAgentTileIndex(0, 'ArrowLeft')).toBe(0);
		expect(getNextAgentTileIndex(0, 'ArrowRight')).toBe(1);
		expect(getNextAgentTileIndex(0, 'ArrowDown')).toBe(4);
		expect(getNextAgentTileIndex(4, 'ArrowDown')).toBe(4);
		expect(getNextAgentTileIndex(4, 'ArrowUp')).toBe(0);
		expect(getAgentTileColSpanClass(0)).toBe('col-span-2');
		expect(getAgentTileColSpanClass(LAST_ROW_START_INDEX)).toContain(LAST_ROW_COL_START_CLASS);
	});

	it('normalizes wizard config fields and env var edits', () => {
		expect(normalizeOptionalWizardString('')).toBeUndefined();
		expect(normalizeOptionalWizardString('--debug')).toBe('--debug');
		expect(normalizeWizardEnvVars({})).toBeUndefined();
		expect(normalizeWizardEnvVars({ A: 'B' })).toEqual({ A: 'B' });
		expect(renameEnvVarKey({ OLD: '1' }, 'OLD', 'NEW', '2')).toEqual({ NEW: '2' });
		expect(updateEnvVarValue({ A: '1' }, 'A', '2')).toEqual({ A: '2' });
		expect(removeEnvVar({ A: '1', B: '2' }, 'A')).toEqual({ B: '2' });
		expect(addEnvVar({ NEW_VAR: 'taken' })).toEqual({
			NEW_VAR: 'taken',
			NEW_VAR_1: '',
		});
	});

	it('normalizes SSH config for local and remote selection', () => {
		expect(getInitialSshRemoteConfig(undefined)).toBeUndefined();
		expect(getInitialSshRemoteConfig({ enabled: true, remoteId: 'remote-1' })).toEqual({
			enabled: true,
			remoteId: 'remote-1',
			workingDirOverride: undefined,
		});
		expect(getInitialSshRemoteConfig({ enabled: true, remoteId: '' })).toEqual({
			enabled: true,
			remoteId: null,
			workingDirOverride: undefined,
		});
		expect(getSyncedSshRemoteConfig({ enabled: false, remoteId: null })).toBeUndefined();
		expect(getSyncedSshRemoteConfig(undefined)).toBeNull();
		expect(selectSshRemoteConfig('')).toBeUndefined();
		expect(selectSshRemoteConfig('remote-1')).toEqual({ enabled: true, remoteId: 'remote-1' });
		expect(toWizardSshRemoteConfig(undefined)).toEqual({ enabled: false, remoteId: null });
		expect(
			toWizardSshRemoteConfig({
				enabled: true,
				remoteId: 'remote-1',
				workingDirOverride: '/work',
			})
		).toEqual({ enabled: true, remoteId: 'remote-1', workingDirOverride: '/work' });
		expect(getSshRemoteIdForDetection({ enabled: true, remoteId: 'remote-1' })).toBe('remote-1');
	});

	it('builds a placeholder configuring agent when detection is stale', () => {
		const tile: AgentTile = {
			id: 'codex',
			name: 'Codex',
			supported: true,
			description: 'Agent',
		};
		const detected = agent({ id: 'codex', name: 'Codex', available: true });

		expect(
			buildConfiguringAgent({
				configuringAgentId: 'codex',
				configuringTile: tile,
				detectedAgent: detected,
			})
		).toBe(detected);

		expect(
			buildConfiguringAgent({
				configuringAgentId: 'codex',
				configuringTile: tile,
				detectedAgent: undefined,
			})
		).toMatchObject({
			id: 'codex',
			name: 'Codex',
			available: false,
			hidden: false,
		});
	});
});
