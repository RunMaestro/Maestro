import { describe, expect, it } from 'vitest';
import { parseWorkspaceFoundation } from '../../../shared/plugins/workspace-foundation';

const ownerPluginId = 'com.maestro.omp';

function createRawContributes() {
	return {
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
				workspaceLocalId: 'omp-workspace',
			},
		],
	};
}

function createRawPermissions() {
	return [{ capability: 'ui:workspace' }, { capability: 'ui:interactivePanel' }];
}

const malformedWorkspaceItems = [
	{ label: 'a null workspace item', item: null },
	{ label: 'a non-object workspace item', item: 'not-an-object' },
] as const;
const malformedPanelItems = [
	{ label: 'a null interactive panel item', item: null },
	{ label: 'a non-object interactive panel item', item: 'not-an-object' },
] as const;
const workspaceRequiredFields = ['localId', 'title', 'icon', 'interactivePanelLocalId'] as const;
const panelRequiredFields = ['localId', 'title', 'entry', 'workspaceLocalId'] as const;
const unsafeEntries = [
	{ label: 'a traversal entry', entry: '../panel.html' },
	{ label: 'a nested POSIX traversal entry', entry: 'dist/../../panel.html' },
	{ label: 'a Windows traversal entry', entry: '..\\panel.html' },
	{ label: 'a nested Windows traversal entry', entry: 'dist\\..\\..\\panel.html' },
	{ label: 'an absolute entry', entry: '/panel.html' },
	{ label: 'a Windows drive entry', entry: 'C:\\panel.html' },
	{ label: 'a Windows UNC entry', entry: '\\\\server\\share\\panel.html' },
] as const;
const invalidLocalIds = [
	{ label: 'an empty local ID', value: '' },
	{ label: 'a slash-containing local ID', value: 'omp/panel' },
	{ label: 'a traversal-like local ID', value: '../omp-panel' },
	{ label: 'a leading-numeric local ID', value: '1-omp-panel' },
] as const;
const invalidWorkspaceOrders = [
	{ label: 'a string order', value: '1' },
	{ label: 'a NaN order', value: Number.NaN },
	{ label: 'an infinite order', value: Number.POSITIVE_INFINITY },
	{ label: 'a negative infinite order', value: Number.NEGATIVE_INFINITY },
] as const;
const forbiddenItemKeys = [
	'id',
	'pluginId',
	'ownerPluginId',
	'canonicalId',
	'canonicalContributionId',
] as const;
const invalidOwnerPluginIds = [
	{
		label: 'an empty owner plugin ID',
		value: '',
		error: 'ownerPluginId must be a non-empty string',
	},
	{
		label: 'a null owner plugin ID',
		value: null,
		error: 'ownerPluginId must be a string',
	},
	{
		label: 'a numeric owner plugin ID',
		value: 1,
		error: 'ownerPluginId must be a string',
	},
	{
		label: 'an invalid owner plugin ID',
		value: '../com.maestro.omp',
		error: 'ownerPluginId must be a valid plugin ID',
	},
] as const;
const malformedPermissionLists = [
	{ label: 'a null permission list', value: null },
	{ label: 'a non-array permission list', value: {} },
] as const;
const malformedPermissionItems = [
	{
		label: 'a null permission item',
		item: null,
		error: 'permissions[0] must be a plain object',
	},
	{
		label: 'a non-object permission item',
		item: 'not-an-object',
		error: 'permissions[0] must be a plain object',
	},
	{
		label: 'a permission item with a missing capability',
		item: {},
		error: 'permissions[0].capability must be a string',
	},
	{
		label: 'a permission item with a non-string capability',
		item: { capability: 1 },
		error: 'permissions[0].capability must be a string',
	},
] as const;

describe('parseWorkspaceFoundation', () => {
	it('accepts one paired workspace and interactive panel without mutating raw input', () => {
		const rawContributes = createRawContributes();
		const rawPermissions = createRawPermissions();
		const expectedContributes = structuredClone(rawContributes);
		const expectedPermissions = structuredClone(rawPermissions);

		expect(parseWorkspaceFoundation(rawContributes, rawPermissions, ownerPluginId)).toEqual({
			ok: true,
			value: {
				ownerPluginId,
				workspace: {
					localId: 'omp-workspace',
					canonicalContributionId: 'com.maestro.omp/omp-workspace',
					title: 'OMP',
					icon: 'sparkles',
					panelLocalId: 'omp-panel',
					order: 0,
				},
				panel: {
					localId: 'omp-panel',
					canonicalContributionId: 'com.maestro.omp/omp-panel',
					title: 'OMP',
					entry: 'dist/panel.html',
				},
			},
		});
		expect(rawContributes).toEqual(expectedContributes);
		expect(rawPermissions).toEqual(expectedPermissions);
	});

	it('freezes canonical workspace foundation records', () => {
		const result = parseWorkspaceFoundation(
			createRawContributes(),
			createRawPermissions(),
			ownerPluginId
		);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error(result.errors.join(', '));

		expect(Object.isFrozen(result)).toBe(true);
		expect(Object.isFrozen(result.value)).toBe(true);
		expect(Object.isFrozen(result.value.workspace)).toBe(true);
		expect(Object.isFrozen(result.value.panel)).toBe(true);
		expect(Reflect.set(result.value.workspace, 'title', 'changed')).toBe(false);
		expect(Reflect.set(result.value.panel, 'entry', 'changed.html')).toBe(false);
		expect(result.value.workspace.title).toBe('OMP');
		expect(result.value.panel.entry).toBe('dist/panel.html');
	});

	it('rejects a non-object contributes value', () => {
		expect(parseWorkspaceFoundation(null, createRawPermissions(), ownerPluginId)).toEqual({
			ok: false,
			errors: ['contributes must be a plain object'],
		});
	});

	it('rejects an array contributes value', () => {
		expect(parseWorkspaceFoundation([], createRawPermissions(), ownerPluginId)).toEqual({
			ok: false,
			errors: ['contributes must be a plain object'],
		});
	});

	for (const { label, value, error } of invalidOwnerPluginIds) {
		it(`rejects ${label}`, () => {
			const parse = () =>
				parseWorkspaceFoundation(
					createRawContributes(),
					createRawPermissions(),
					value as unknown as string
				);

			expect(parse).not.toThrow();
			expect(parse()).toEqual({
				ok: false,
				errors: [error],
			});
		});
	}

	it('rejects an unknown contributes key', () => {
		const rawContributes = createRawContributes();
		expect(
			parseWorkspaceFoundation(
				{ ...rawContributes, unexpected: true },
				createRawPermissions(),
				ownerPluginId
			)
		).toEqual({
			ok: false,
			errors: ['contributes.unexpected is not allowed'],
		});
	});

	for (const key of forbiddenItemKeys) {
		it(`rejects workspace item key ${key}`, () => {
			const rawContributes = createRawContributes();
			expect(
				parseWorkspaceFoundation(
					{
						...rawContributes,
						workspaces: [{ ...rawContributes.workspaces[0], [key]: 'forged' }],
					},
					createRawPermissions(),
					ownerPluginId
				)
			).toEqual({
				ok: false,
				errors: [`workspaces[0].${key} is not allowed`],
			});
		});

		it(`rejects interactive panel item key ${key}`, () => {
			const rawContributes = createRawContributes();
			expect(
				parseWorkspaceFoundation(
					{
						...rawContributes,
						interactivePanels: [{ ...rawContributes.interactivePanels[0], [key]: 'forged' }],
					},
					createRawPermissions(),
					ownerPluginId
				)
			).toEqual({
				ok: false,
				errors: [`interactivePanels[0].${key} is not allowed`],
			});
		});
	}

	it('rejects an arbitrary unknown workspace item key', () => {
		const rawContributes = createRawContributes();
		expect(
			parseWorkspaceFoundation(
				{
					...rawContributes,
					workspaces: [{ ...rawContributes.workspaces[0], unexpected: true }],
				},
				createRawPermissions(),
				ownerPluginId
			)
		).toEqual({
			ok: false,
			errors: ['workspaces[0].unexpected is not allowed'],
		});
	});

	it('rejects an arbitrary unknown interactive panel item key', () => {
		const rawContributes = createRawContributes();
		expect(
			parseWorkspaceFoundation(
				{
					...rawContributes,
					interactivePanels: [{ ...rawContributes.interactivePanels[0], unexpected: true }],
				},
				createRawPermissions(),
				ownerPluginId
			)
		).toEqual({
			ok: false,
			errors: ['interactivePanels[0].unexpected is not allowed'],
		});
	});

	it('rejects a non-array contribution list', () => {
		const rawContributes = createRawContributes();
		expect(
			parseWorkspaceFoundation(
				{ ...rawContributes, workspaces: {} },
				createRawPermissions(),
				ownerPluginId
			)
		).toEqual({
			ok: false,
			errors: ['workspaces must be an array'],
		});
	});

	it('rejects a non-array interactive panel list', () => {
		const rawContributes = createRawContributes();
		expect(
			parseWorkspaceFoundation(
				{ ...rawContributes, interactivePanels: {} },
				createRawPermissions(),
				ownerPluginId
			)
		).toEqual({
			ok: false,
			errors: ['interactivePanels must be an array'],
		});
	});

	for (const { label, value } of malformedPermissionLists) {
		it(`returns a structured error for ${label} without throwing`, () => {
			const parse = () => parseWorkspaceFoundation(createRawContributes(), value, ownerPluginId);

			expect(parse).not.toThrow();
			expect(parse()).toEqual({
				ok: false,
				errors: ['permissions must be an array'],
			});
		});
	}

	for (const { label, item, error } of malformedPermissionItems) {
		it(`returns a structured error for ${label} without throwing`, () => {
			const parse = () => parseWorkspaceFoundation(createRawContributes(), [item], ownerPluginId);

			expect(parse).not.toThrow();
			expect(parse()).toEqual({
				ok: false,
				errors: [error],
			});
		});
	}

	for (const { label, item } of malformedWorkspaceItems) {
		it(`returns a structured error for ${label} without throwing`, () => {
			const rawContributes = createRawContributes();
			const parse = () =>
				parseWorkspaceFoundation(
					{ ...rawContributes, workspaces: [item] },
					createRawPermissions(),
					ownerPluginId
				);

			expect(parse).not.toThrow();
			expect(parse()).toEqual({
				ok: false,
				errors: ['workspaces[0] must be a plain object'],
			});
		});
	}

	for (const field of workspaceRequiredFields) {
		it(`returns a structured error when workspace ${field} is missing`, () => {
			const rawContributes = createRawContributes();
			const workspace = { ...rawContributes.workspaces[0] } as Record<string, unknown>;
			delete workspace[field];
			const parse = () =>
				parseWorkspaceFoundation(
					{ ...rawContributes, workspaces: [workspace] },
					createRawPermissions(),
					ownerPluginId
				);

			expect(parse).not.toThrow();
			expect(parse()).toEqual({
				ok: false,
				errors: [`workspaces[0].${field} must be a string`],
			});
		});

		it(`returns a structured error when workspace ${field} is not a string`, () => {
			const rawContributes = createRawContributes();
			const workspace = {
				...rawContributes.workspaces[0],
				[field]: 1,
			};
			const parse = () =>
				parseWorkspaceFoundation(
					{ ...rawContributes, workspaces: [workspace] },
					createRawPermissions(),
					ownerPluginId
				);

			expect(parse).not.toThrow();
			expect(parse()).toEqual({
				ok: false,
				errors: [`workspaces[0].${field} must be a string`],
			});
		});
	}

	it('rejects an unknown workspace icon', () => {
		const rawContributes = createRawContributes();
		expect(
			parseWorkspaceFoundation(
				{
					...rawContributes,
					workspaces: [{ ...rawContributes.workspaces[0], icon: 'unknown' }],
				},
				createRawPermissions(),
				ownerPluginId
			)
		).toEqual({
			ok: false,
			errors: ['workspaces[0].icon must be one of sparkles, bot, workflow'],
		});
	});

	for (const { label, value } of invalidLocalIds) {
		it(`rejects a workspace with ${label}`, () => {
			const rawContributes = createRawContributes();
			expect(
				parseWorkspaceFoundation(
					{
						...rawContributes,
						workspaces: [{ ...rawContributes.workspaces[0], localId: value }],
					},
					createRawPermissions(),
					ownerPluginId
				)
			).toEqual({
				ok: false,
				errors: ['workspaces[0].localId must be a valid local ID'],
			});
		});
	}

	it('accepts and carries a finite workspace order', () => {
		const rawContributes = createRawContributes();
		expect(
			parseWorkspaceFoundation(
				{
					...rawContributes,
					workspaces: [{ ...rawContributes.workspaces[0], order: -2.5 }],
				},
				createRawPermissions(),
				ownerPluginId
			)
		).toMatchObject({
			ok: true,
			value: { workspace: { order: -2.5 } },
		});
	});

	for (const { label, value } of invalidWorkspaceOrders) {
		it(`rejects ${label}`, () => {
			const rawContributes = createRawContributes();
			expect(
				parseWorkspaceFoundation(
					{
						...rawContributes,
						workspaces: [{ ...rawContributes.workspaces[0], order: value }],
					},
					createRawPermissions(),
					ownerPluginId
				)
			).toEqual({
				ok: false,
				errors: ['workspaces[0].order must be a finite number'],
			});
		});
	}

	for (const { label, item } of malformedPanelItems) {
		it(`returns a structured error for ${label} without throwing`, () => {
			const rawContributes = createRawContributes();
			const parse = () =>
				parseWorkspaceFoundation(
					{ ...rawContributes, interactivePanels: [item] },
					createRawPermissions(),
					ownerPluginId
				);

			expect(parse).not.toThrow();
			expect(parse()).toEqual({
				ok: false,
				errors: ['interactivePanels[0] must be a plain object'],
			});
		});
	}

	for (const field of panelRequiredFields) {
		it(`returns a structured error when interactive panel ${field} is missing`, () => {
			const rawContributes = createRawContributes();
			const panel = { ...rawContributes.interactivePanels[0] } as Record<string, unknown>;
			delete panel[field];
			const parse = () =>
				parseWorkspaceFoundation(
					{ ...rawContributes, interactivePanels: [panel] },
					createRawPermissions(),
					ownerPluginId
				);

			expect(parse).not.toThrow();
			expect(parse()).toEqual({
				ok: false,
				errors: [`interactivePanels[0].${field} must be a string`],
			});
		});

		it(`returns a structured error when interactive panel ${field} is not a string`, () => {
			const rawContributes = createRawContributes();
			const panel = {
				...rawContributes.interactivePanels[0],
				[field]: 1,
			};
			const parse = () =>
				parseWorkspaceFoundation(
					{ ...rawContributes, interactivePanels: [panel] },
					createRawPermissions(),
					ownerPluginId
				);

			expect(parse).not.toThrow();
			expect(parse()).toEqual({
				ok: false,
				errors: [`interactivePanels[0].${field} must be a string`],
			});
		});
	}

	for (const { label, value } of invalidLocalIds) {
		it(`rejects an interactive panel with ${label}`, () => {
			const rawContributes = createRawContributes();
			expect(
				parseWorkspaceFoundation(
					{
						...rawContributes,
						interactivePanels: [{ ...rawContributes.interactivePanels[0], localId: value }],
					},
					createRawPermissions(),
					ownerPluginId
				)
			).toEqual({
				ok: false,
				errors: ['interactivePanels[0].localId must be a valid local ID'],
			});
		});
	}

	it('rejects duplicate workspace local IDs', () => {
		const rawContributes = createRawContributes();
		expect(
			parseWorkspaceFoundation(
				{
					...rawContributes,
					workspaces: [...rawContributes.workspaces, { ...rawContributes.workspaces[0] }],
				},
				createRawPermissions(),
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
		const rawContributes = createRawContributes();
		expect(
			parseWorkspaceFoundation(
				{
					...rawContributes,
					interactivePanels: [
						...rawContributes.interactivePanels,
						{ ...rawContributes.interactivePanels[0] },
					],
				},
				createRawPermissions(),
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
		const rawContributes = createRawContributes();
		expect(
			parseWorkspaceFoundation(
				{ ...rawContributes, workspaces: [] },
				createRawPermissions(),
				ownerPluginId
			)
		).toEqual({
			ok: false,
			errors: ['workspaces must contain exactly one item'],
		});
	});

	it('requires exactly one interactive panel', () => {
		const rawContributes = createRawContributes();
		expect(
			parseWorkspaceFoundation(
				{ ...rawContributes, interactivePanels: [] },
				createRawPermissions(),
				ownerPluginId
			)
		).toEqual({
			ok: false,
			errors: ['interactivePanels must contain exactly one item'],
		});
	});

	for (const { label, entry } of unsafeEntries) {
		it(`rejects ${label}`, () => {
			const rawContributes = createRawContributes();
			expect(
				parseWorkspaceFoundation(
					{
						...rawContributes,
						interactivePanels: [{ ...rawContributes.interactivePanels[0], entry }],
					},
					createRawPermissions(),
					ownerPluginId
				)
			).toEqual({
				ok: false,
				errors: ['interactivePanels[0].entry must be a safe relative path'],
			});
		});
	}

	it('requires the workspace to reference its paired interactive panel', () => {
		const rawContributes = createRawContributes();
		expect(
			parseWorkspaceFoundation(
				{
					...rawContributes,
					workspaces: [{ ...rawContributes.workspaces[0], interactivePanelLocalId: 'missing' }],
				},
				createRawPermissions(),
				ownerPluginId
			)
		).toEqual({
			ok: false,
			errors: ['workspaces[0].interactivePanelLocalId must reference interactivePanels[0].localId'],
		});
	});

	it('requires the interactive panel to reference its paired workspace', () => {
		const rawContributes = createRawContributes();
		expect(
			parseWorkspaceFoundation(
				{
					...rawContributes,
					interactivePanels: [
						{ ...rawContributes.interactivePanels[0], workspaceLocalId: 'missing' },
					],
				},
				createRawPermissions(),
				ownerPluginId
			)
		).toEqual({
			ok: false,
			errors: ['interactivePanels[0].workspaceLocalId must reference workspaces[0].localId'],
		});
	});

	it('requires ui:workspace', () => {
		expect(
			parseWorkspaceFoundation(
				createRawContributes(),
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
			parseWorkspaceFoundation(
				createRawContributes(),
				[{ capability: 'ui:workspace' }],
				ownerPluginId
			)
		).toEqual({
			ok: false,
			errors: ['interactivePanels requires ui:interactivePanel'],
		});
	});
});
