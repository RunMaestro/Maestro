import { describe, expect, it } from 'vitest';
import { parseWorkspaceFoundation } from '../../../shared/plugins/workspace-foundation';

const ownerPluginId = 'com.maestro.omp';
const rawContributes = {
	workspaces: [
		{
			localId: 'omp-workspace',
			title: 'OMP',
			icon: 'sparkles',
			interactivePanelLocalId: 'omp-panel',
		},
	],
	interactivePanels: [
		{
			localId: 'omp-panel',
			title: 'OMP',
			entry: 'dist/panel.html',
		},
	],
};
const rawPermissions = [{ capability: 'ui:workspace' }, { capability: 'ui:interactivePanel' }];

describe('parseWorkspaceFoundation', () => {
	it('accepts one paired workspace and interactive panel', () => {
		expect(parseWorkspaceFoundation(rawContributes, rawPermissions, ownerPluginId)).toEqual({
			ok: true,
			value: {
				ownerPluginId,
				workspace: {
					localId: 'omp-workspace',
					canonicalId: 'com.maestro.omp/omp-workspace',
					title: 'OMP',
					icon: 'sparkles',
					panelLocalId: 'omp-panel',
				},
				panel: {
					localId: 'omp-panel',
					title: 'OMP',
					entry: 'dist/panel.html',
				},
			},
		});
	});

	it('rejects a non-object contributes value', () => {
		expect(parseWorkspaceFoundation(null, rawPermissions, ownerPluginId)).toEqual({
			ok: false,
			errors: ['contributes must be a plain object'],
		});
	});

	it('rejects an unknown contributes key', () => {
		expect(
			parseWorkspaceFoundation(
				{ ...rawContributes, unexpected: true },
				rawPermissions,
				ownerPluginId
			)
		).toEqual({
			ok: false,
			errors: ['contributes.unexpected is not allowed'],
		});
	});

	it('rejects a non-array contribution list', () => {
		expect(
			parseWorkspaceFoundation({ ...rawContributes, workspaces: {} }, rawPermissions, ownerPluginId)
		).toEqual({
			ok: false,
			errors: ['workspaces must be an array'],
		});
	});

	it('rejects duplicate workspace local IDs', () => {
		expect(
			parseWorkspaceFoundation(
				{
					...rawContributes,
					workspaces: [...rawContributes.workspaces, { ...rawContributes.workspaces[0] }],
				},
				rawPermissions,
				ownerPluginId
			)
		).toEqual({
			ok: false,
			errors: [
				'workspaces must contain exactly one item',
				'workspaces[1].localId duplicates workspaces[0].localId',
			],
		});
	});

	it('rejects duplicate interactive panel local IDs', () => {
		expect(
			parseWorkspaceFoundation(
				{
					...rawContributes,
					interactivePanels: [
						...rawContributes.interactivePanels,
						{ ...rawContributes.interactivePanels[0] },
					],
				},
				rawPermissions,
				ownerPluginId
			)
		).toEqual({
			ok: false,
			errors: [
				'interactivePanels must contain exactly one item',
				'interactivePanels[1].localId duplicates interactivePanels[0].localId',
			],
		});
	});

	it('requires exactly one workspace', () => {
		expect(
			parseWorkspaceFoundation({ ...rawContributes, workspaces: [] }, rawPermissions, ownerPluginId)
		).toEqual({
			ok: false,
			errors: ['workspaces must contain exactly one item'],
		});
	});

	it('requires exactly one interactive panel', () => {
		expect(
			parseWorkspaceFoundation(
				{ ...rawContributes, interactivePanels: [] },
				rawPermissions,
				ownerPluginId
			)
		).toEqual({
			ok: false,
			errors: ['interactivePanels must contain exactly one item'],
		});
	});

	it('rejects an unsafe interactive panel entry', () => {
		expect(
			parseWorkspaceFoundation(
				{
					...rawContributes,
					interactivePanels: [{ ...rawContributes.interactivePanels[0], entry: '../panel.html' }],
				},
				rawPermissions,
				ownerPluginId
			)
		).toEqual({
			ok: false,
			errors: ['interactivePanels[0].entry must be a safe relative path'],
		});
	});

	it('requires the workspace to reference its paired interactive panel', () => {
		expect(
			parseWorkspaceFoundation(
				{
					...rawContributes,
					workspaces: [{ ...rawContributes.workspaces[0], interactivePanelLocalId: 'missing' }],
				},
				rawPermissions,
				ownerPluginId
			)
		).toEqual({
			ok: false,
			errors: ['workspaces[0].interactivePanelLocalId must reference interactivePanels[0].localId'],
		});
	});

	it('requires ui:workspace', () => {
		expect(
			parseWorkspaceFoundation(
				rawContributes,
				[{ capability: 'ui:interactivePanel' }],
				ownerPluginId
			)
		).toEqual({
			ok: false,
			errors: ['workspaces requires ui:workspace'],
		});
	});

	it('requires ui:interactivePanel', () => {
		expect(
			parseWorkspaceFoundation(rawContributes, [{ capability: 'ui:workspace' }], ownerPluginId)
		).toEqual({
			ok: false,
			errors: ['interactivePanels requires ui:interactivePanel'],
		});
	});
});
