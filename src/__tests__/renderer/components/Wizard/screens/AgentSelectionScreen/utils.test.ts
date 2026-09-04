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
	selectVisibleAgentTiles,
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
import { PICKABLE_AGENT_IDS } from '../../../../../../shared/agentMetadata';
import { SUPPORTED_AGENTS } from '../../../../../../renderer/components/NewInstanceModal/types';
import { getNextAgentTileIndex } from '../../../../../../renderer/components/Wizard/screens/AgentSelectionScreen/utils/agentGrid';
import {
	agentTilesPerRow,
	resolveAgentGridLayout,
} from '../../../../../../renderer/components/Wizard/screens/AgentSelectionScreen/utils/agentGridLayout';
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
		// The strip is alphabetical, so assert on the tile found rather than a
		// fixed index that moves whenever a provider is added.
		expect(AGENT_TILES[findFirstSelectableTileIndex(AGENT_TILES, detected)].id).toBe('claude-code');
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

	it('steps along the single-row strip and clamps at both ends', () => {
		const count = AGENT_TILES.length;

		expect(getNextAgentTileIndex(0, 'ArrowLeft', count)).toBe(0);
		expect(getNextAgentTileIndex(0, 'ArrowRight', count)).toBe(1);
		expect(getNextAgentTileIndex(1, 'ArrowLeft', count)).toBe(0);
		expect(getNextAgentTileIndex(count - 1, 'ArrowRight', count)).toBe(count - 1);
		// The strip is one row, so vertical movement has nowhere to go.
		expect(getNextAgentTileIndex(0, 'ArrowDown', count)).toBe(0);
		expect(getNextAgentTileIndex(1, 'ArrowUp', count)).toBe(1);
	});

	it('steps a whole row on up/down once the tiles wrap', () => {
		// Five tiles laid out 3 + 2. Down from the end of the full row has no tile
		// directly beneath it, and refusing to move there reads as a dead key.
		expect(getNextAgentTileIndex(0, 'ArrowDown', 5, 3)).toBe(3);
		expect(getNextAgentTileIndex(2, 'ArrowDown', 5, 3)).toBe(4);
		expect(getNextAgentTileIndex(4, 'ArrowDown', 5, 3)).toBe(4);
		expect(getNextAgentTileIndex(3, 'ArrowUp', 5, 3)).toBe(0);
		expect(getNextAgentTileIndex(1, 'ArrowUp', 5, 3)).toBe(1);
		// Left/right still walk the flat order across the row break.
		expect(getNextAgentTileIndex(2, 'ArrowRight', 5, 3)).toBe(3);
	});

	it('balances the rows rather than filling one and stranding the rest', () => {
		// Wide enough for four across (the strip's own max width).
		const wide = 1200;

		// Everything fits on one row: one row, centered, no leftovers.
		expect(resolveAgentGridLayout(4, wide)).toMatchObject({ mode: 'wrap', columns: 4 });
		// Five would draw 4 + 1, which looks like a mistake. 3 + 2 does not.
		expect(resolveAgentGridLayout(5, wide)).toMatchObject({ mode: 'wrap', columns: 3 });
		expect(resolveAgentGridLayout(7, wide)).toMatchObject({ mode: 'wrap', columns: 4 });
		// Past two rows the Continue button goes below the fold, so back to the strip.
		expect(resolveAgentGridLayout(9, wide).mode).toBe('strip');
		expect(resolveAgentGridLayout(AGENT_TILES.length, wide).mode).toBe('strip');
	});

	it('measures the row against the real width, and falls back before it is known', () => {
		expect(agentTilesPerRow(0)).toBe(4);
		expect(agentTilesPerRow(300)).toBe(1);
		expect(agentTilesPerRow(500)).toBe(2);
		// Capped at the strip's own width, so a maximized wizard does not spread the
		// tiles wider than the strip it just replaced.
		expect(agentTilesPerRow(4000)).toBe(4);
		// A narrow wizard fits fewer per row, so it drops to the strip sooner.
		expect(resolveAgentGridLayout(7, 700)).toMatchObject({ mode: 'strip' });
		expect(resolveAgentGridLayout(5, 700)).toMatchObject({ mode: 'wrap', columns: 3 });
	});

	it('clamps against the RENDERED tile count, not the provider total', () => {
		// Filtering to the available providers shortens the strip. Clamping on the
		// full registry would walk the focus ring off the end of what is drawn.
		expect(getNextAgentTileIndex(2, 'ArrowRight', 3)).toBe(2);
		expect(getNextAgentTileIndex(1, 'ArrowRight', 3)).toBe(2);
		expect(getNextAgentTileIndex(0, 'ArrowRight', 1)).toBe(0);
		expect(getNextAgentTileIndex(0, 'ArrowRight', 0)).toBe(0);
	});

	it('hides unavailable providers unless asked, and never renders an empty strip', () => {
		const detected = [
			agent({ id: 'claude-code', available: true }),
			agent({ id: 'codex', available: false }),
			agent({ id: 'opencode', available: true }),
		];

		expect(selectVisibleAgentTiles(AGENT_TILES, detected, false).map((tile) => tile.id)).toEqual([
			'claude-code',
			'opencode',
		]);
		expect(selectVisibleAgentTiles(AGENT_TILES, detected, true)).toEqual(AGENT_TILES);

		// Nothing detected: filtering would leave a strip with no tiles, no way to
		// reach Customize, and no way to proceed, so the full list stands in.
		expect(selectVisibleAgentTiles(AGENT_TILES, [], false)).toEqual(AGENT_TILES);
	});

	it('keeps the selected provider visible even when it is not installed', () => {
		// Otherwise the strip hides the very tile that shows what is selected.
		const detected = [
			agent({ id: 'claude-code', available: true }),
			agent({ id: 'codex', available: false }),
		];

		expect(
			selectVisibleAgentTiles(AGENT_TILES, detected, false, 'codex').map((tile) => tile.id)
		).toEqual(['claude-code', 'codex']);
		expect(
			selectVisibleAgentTiles(AGENT_TILES, detected, false, null).map((tile) => tile.id)
		).toEqual(['claude-code']);
	});

	it('offers every pickable provider, in the shared registry order', () => {
		expect(AGENT_TILES.map((tile) => tile.id)).toEqual([...PICKABLE_AGENT_IDS]);
		expect(AGENT_TILES.every((tile) => tile.supported)).toBe(true);
		// Regression: Grok and Qwen3 Coder were selectable in the New Agent modal
		// yet absent from the wizard and un-pickable as a group chat moderator.
		expect(AGENT_TILES.map((tile) => tile.id)).toEqual(
			expect.arrayContaining([...SUPPORTED_AGENTS])
		);
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
