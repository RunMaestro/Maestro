import { describe, it, expect } from 'vitest';
import {
	aggregateContributions,
	collectContributions,
	gateContributions,
	MAX_HOST_VIEW_BLOCKS_BYTES,
	groupingRuleMatches,
	isPluginUiSurface,
	matchesGroupingPattern,
	PROTECTED_UI_SURFACES,
	UI_SURFACES,
	validatePluginUiMount,
} from '../../../shared/plugins/contributions';
import type { PluginManifest } from '../../../shared/plugins/plugin-manifest';

function manifest(
	id: string,
	contributes: Record<string, unknown> | undefined,
	tier: 0 | 1 | 2 = 0
): PluginManifest {
	return {
		id,
		name: id,
		version: '1.0.0',
		tier,
		maestro: { minHostApi: '1.0.0' },
		...(contributes ? { contributes } : {}),
	};
}

describe('collectContributions', () => {
	it('returns empty buckets when there is no contributes block', () => {
		const c = collectContributions(manifest('com.a', undefined));
		expect(c.themes).toEqual([]);
		expect(c.prompts).toEqual([]);
		expect(c.settings).toEqual([]);
		expect(c.commandMacros).toEqual([]);
		expect(c.errors).toEqual([]);
	});

	it('namespaces ids by plugin id', () => {
		const c = collectContributions(
			manifest('com.acme', {
				themes: [{ id: 'midnight', name: 'Midnight', mode: 'dark', colors: { bg: '#000' } }],
			})
		);
		expect(c.themes[0].id).toBe('com.acme/midnight');
		expect(c.themes[0].localId).toBe('midnight');
		expect(c.themes[0].pluginId).toBe('com.acme');
	});
	it('collects namespaced icon packs for tier-0 plugins', () => {
		const c = collectContributions(
			manifest('com.acme', {
				iconPacks: [
					{
						id: 'starter',
						label: 'Starter pack',
						icons: [
							{
								id: 'spark',
								label: 'Spark',
								path: 'M12 2L15 9L22 12L15 15L12 22',
								viewBox: '0 0 24 24',
							},
						],
						colors: [{ id: 'lime', label: 'Lime', value: '#22C55E' }],
					},
				],
			})
		);

		expect(c.iconPacks).toEqual([
			{
				id: 'com.acme/starter',
				localId: 'starter',
				pluginId: 'com.acme',
				label: 'Starter pack',
				icons: [
					{
						id: 'com.acme/starter/spark',
						localId: 'spark',
						label: 'Spark',
						path: 'M12 2L15 9L22 12L15 15L12 22',
						viewBox: '0 0 24 24',
					},
				],
				colors: [
					{
						id: 'com.acme/starter/lime',
						localId: 'lime',
						label: 'Lime',
						value: '#22C55E',
					},
				],
			},
		]);
		expect(c.errors).toEqual([]);
	});

	it('drops unsafe or oversized icon-pack entries while keeping valid siblings', () => {
		const c = collectContributions(
			manifest('com.acme', {
				iconPacks: [
					{
						id: 'starter',
						label: 'Starter pack',
						icons: [
							{ id: 'good', label: 'Good', path: 'M3 12H21' },
							{ id: 'markup', label: 'Markup', path: 'M3 12<foreignObject />' },
							{ id: 'large', label: 'Large', path: `M${'0 '.repeat(4096)}` },
							{ id: 'viewbox', label: 'ViewBox', path: 'M3 12H21', viewBox: '0 0 24 nope' },
						],
						colors: [
							{ id: 'good', label: 'Good', value: '#22C55E' },
							{ id: 'bad', label: 'Bad', value: 'green' },
						],
					},
				],
			})
		);

		expect(c.iconPacks[0].icons.map((icon) => icon.localId)).toEqual(['good']);
		expect(c.iconPacks[0].colors.map((color) => color.localId)).toEqual(['good']);
		expect(c.errors).toHaveLength(4);
	});

	it('validates each contribution type and drops bad ones with an error', () => {
		const c = collectContributions(
			manifest('com.acme', {
				themes: [
					{ id: 'good', name: 'Good', mode: 'dark', colors: { bg: '#000' } },
					{ id: 'nomode', name: 'Bad', colors: { bg: '#000' } },
				],
				prompts: [
					{ id: 'p1', title: 'P1', content: 'hi' },
					{ id: 'p2', title: 'no content' },
				],
				settings: [
					{ id: 's1', key: 'k', type: 'boolean', default: true },
					{ id: 's2', key: 'k2', type: 'number', default: 'x' },
				],
				commandMacros: [
					{ id: 'm1', title: 'M1', prompt: 'do it' },
					{ id: 'm2', title: 'M2' },
				],
			})
		);
		expect(c.themes.map((t) => t.localId)).toEqual(['good']);
		expect(c.prompts.map((p) => p.localId)).toEqual(['p1']);
		expect(c.settings.map((s) => s.localId)).toEqual(['s1']);
		expect(c.commandMacros.map((m) => m.localId)).toEqual(['m1']);
		expect(c.errors.length).toBe(4);
	});

	it('parses interval and dailyTimes cue triggers and rejects bad ones', () => {
		const c = collectContributions(
			manifest('com.acme', {
				cueTriggers: [
					{
						id: 'tick',
						title: 'Tick',
						schedule: { kind: 'interval', everyMinutes: 15 },
						action: 'notify',
						payload: 'tick!',
					},
					{
						id: 'morning',
						title: 'AM',
						schedule: { kind: 'dailyTimes', times: ['09:00', '25:00'] },
						action: 'notify',
						payload: 'gm',
					},
					{
						id: 'nopayload',
						title: 'X',
						schedule: { kind: 'interval', everyMinutes: 5 },
						action: 'notify',
					},
					{
						id: 'baddispatch',
						title: 'Y',
						schedule: { kind: 'interval', everyMinutes: 5 },
						action: 'dispatch',
						payload: 'go',
					},
					{
						id: 'zeromin',
						title: 'Z',
						schedule: { kind: 'interval', everyMinutes: 0 },
						action: 'notify',
						payload: 'p',
					},
				],
			})
		);
		expect(c.cueTriggers.map((t) => t.localId)).toEqual(['tick', 'morning']);
		// invalid HH:MM dropped from the times list, valid one kept
		const morning = c.cueTriggers.find((t) => t.localId === 'morning');
		expect(morning?.schedule).toEqual({ kind: 'dailyTimes', times: ['09:00'] });
		expect(c.errors.length).toBe(3); // nopayload, baddispatch (no agentId), zeromin
	});

	it('accepts a dispatch trigger with an agentId', () => {
		const c = collectContributions(
			manifest('com.acme', {
				cueTriggers: [
					{
						id: 'd',
						title: 'D',
						schedule: { kind: 'interval', everyMinutes: 60 },
						action: 'dispatch',
						payload: 'run',
						agentId: 'agent-1',
					},
				],
			})
		);
		expect(c.cueTriggers[0]).toMatchObject({ action: 'dispatch', agentId: 'agent-1' });
	});

	it('rejects commands/panels for tier 0 (they run code/UI)', () => {
		const c = collectContributions(
			manifest('com.acme', {
				commands: [{ id: 'cmd', title: 'Cmd' }],
				panels: [{ id: 'pan', title: 'Pan', entry: 'panel.html' }],
			})
		);
		expect(c.commands).toEqual([]);
		expect(c.panels).toEqual([]);
		expect(c.errors.some((e) => e.includes('commands require tier'))).toBe(true);
		expect(c.errors.some((e) => e.includes('panels require tier'))).toBe(true);
	});

	it('accepts commands/panels for tier 1 and validates panel entry paths', () => {
		const c = collectContributions(
			manifest(
				'com.acme',
				{
					commands: [{ id: 'cmd', title: 'Run It', description: 'does a thing' }],
					panels: [
						{ id: 'good', title: 'Good', entry: 'ui/panel.html' },
						{ id: 'evil', title: 'Evil', entry: '../../../etc/passwd' },
					],
				},
				1
			)
		);
		expect(c.commands.map((x) => x.id)).toEqual(['com.acme/cmd']);
		expect(c.panels.map((x) => x.localId)).toEqual(['good']);
		expect(c.errors.some((e) => e.includes('relative path inside the plugin'))).toBe(true);
	});

	it('rejects agents for tier 0 and accepts them for tier 1', () => {
		const tier0 = collectContributions(
			manifest('com.acme', {
				agents: [{ id: 'bot', displayName: 'Bot', binaryName: 'mybot' }],
			})
		);
		expect(tier0.agents).toEqual([]);
		expect(tier0.errors.some((e) => e.includes('agents require tier'))).toBe(true);

		const tier1 = collectContributions(
			manifest(
				'com.acme',
				{
					agents: [
						{
							id: 'bot',
							displayName: 'My Bot',
							binaryName: 'mybot',
							baseArgs: ['--json', 5, 'ok'],
							capabilities: { resume: true, stream: 'yes', json: false },
						},
					],
				},
				1
			)
		);
		expect(tier1.agents).toHaveLength(1);
		const agent = tier1.agents[0];
		expect(agent.id).toBe('com.acme/bot');
		expect(agent.localId).toBe('bot');
		expect(agent.displayName).toBe('My Bot');
		expect(agent.binaryName).toBe('mybot');
		// non-string baseArgs dropped
		expect(agent.baseArgs).toEqual(['--json', 'ok']);
		// non-boolean capability values dropped
		expect(agent.capabilities).toEqual({ resume: true, json: false });
	});

	it('rejects an agent with an unsafe binaryName', () => {
		const c = collectContributions(
			manifest(
				'com.acme',
				{
					agents: [
						{ id: 'a', displayName: 'A', binaryName: '../evil' },
						{ id: 'b', displayName: 'B', binaryName: '/usr/bin/x' },
						{ id: 'd', displayName: 'D', binaryName: 'sub/dir' },
						{ id: 'ok', displayName: 'OK', binaryName: 'good-bin' },
					],
				},
				1
			)
		);
		expect(c.agents.map((a) => a.localId)).toEqual(['ok']);
		expect(c.errors.filter((e) => e.includes('binaryName')).length).toBe(3);
	});

	it('rejects an invalid local id', () => {
		const c = collectContributions(
			manifest('com.acme', {
				prompts: [{ id: 'Bad Id', title: 'x', content: 'y' }],
			})
		);
		expect(c.prompts).toEqual([]);
		expect(c.errors[0]).toMatch(/not a valid id/);
	});

	it('keeps only string colors and rejects an empty color map', () => {
		const c = collectContributions(
			manifest('com.acme', {
				themes: [
					{ id: 't1', name: 'T1', mode: 'light', colors: { bg: '#fff', n: 5 } },
					{ id: 't2', name: 'T2', mode: 'light', colors: { n: 5 } },
				],
			})
		);
		expect(c.themes[0].colors).toEqual({ bg: '#fff' });
		expect(c.themes.map((t) => t.localId)).toEqual(['t1']);
	});
});

describe('aggregateContributions', () => {
	it('merges across plugins and collects per-plugin errors', () => {
		const agg = aggregateContributions([
			manifest('com.a', {
				themes: [{ id: 'x', name: 'X', mode: 'dark', colors: { bg: '#000' } }],
			}),
			manifest('com.b', {
				prompts: [
					{ id: 'p', title: 'P', content: 'c' },
					{ id: 'bad', title: 'no content' },
				],
			}),
		]);
		expect(agg.themes).toHaveLength(1);
		expect(agg.prompts).toHaveLength(1);
		expect(agg.errorsByPlugin['com.b']).toBeDefined();
		expect(agg.errorsByPlugin['com.a']).toBeUndefined();
	});

	it('does not collide same-localId contributions from different plugins', () => {
		const agg = aggregateContributions([
			manifest('com.a', {
				themes: [{ id: 'midnight', name: 'A', mode: 'dark', colors: { bg: '#000' } }],
			}),
			manifest('com.b', {
				themes: [{ id: 'midnight', name: 'B', mode: 'dark', colors: { bg: '#111' } }],
			}),
		]);
		expect(agg.themes.map((t) => t.id).sort()).toEqual(['com.a/midnight', 'com.b/midnight']);
	});

	it('keeps the first icon pack when a plugin declares the same pack id twice', () => {
		const agg = aggregateContributions([
			manifest('com.acme', {
				iconPacks: [
					{
						id: 'starter',
						label: 'First pack',
						icons: [{ id: 'spark', label: 'Spark', path: 'M3 12H21' }],
					},
					{
						id: 'starter',
						label: 'Second pack',
						icons: [{ id: 'bolt', label: 'Bolt', path: 'M12 2L12 22' }],
					},
				],
			}),
		]);

		expect(agg.iconPacks).toHaveLength(1);
		expect(agg.iconPacks[0].label).toBe('First pack');
		expect(agg.errorsByPlugin['com.acme']).toContain(
			'duplicate iconPacks contribution id "com.acme/starter"'
		);
	});
});

describe('contributed setting key validation', () => {
	const settingsFor = (key: string) =>
		collectContributions(
			manifest('com.acme', {
				settings: [{ id: 'opt', key, type: 'boolean', default: true }],
			})
		);

	it.each([
		['prototype-polluting __proto__', '__proto__'],
		['prototype-polluting a.constructor', 'a.constructor'],
		['the feature gate encoreFeatures', 'encoreFeatures'],
		['a secret-looking apiKey', 'apiKey'],
		['a path-separated a/b', 'a/b'],
		['a traversal ../x', '../x'],
	])('drops a setting whose key is %s and records an error', (_label, key) => {
		const c = settingsFor(key);
		expect(c.settings).toEqual([]);
		expect(c.errors.length).toBe(1);
	});

	it('accepts a setting with a normal key', () => {
		const c = settingsFor('verbose');
		expect(c.settings.map((s) => s.key)).toEqual(['verbose']);
		expect(c.errors).toEqual([]);
	});
});

describe('keybinding contributions', () => {
	it('parses + namespaces a tier-1 keybinding capturing key and command', () => {
		const c = collectContributions(
			manifest(
				'com.acme',
				{
					keybindings: [
						{ id: 'palette', key: 'Ctrl+Shift+P', command: 'open-palette', description: 'Open it' },
					],
				},
				1
			)
		);
		expect(c.keybindings).toEqual([
			{
				id: 'com.acme/palette',
				localId: 'palette',
				pluginId: 'com.acme',
				key: 'Ctrl+Shift+P',
				command: 'open-palette',
				description: 'Open it',
			},
		]);
		expect(c.errors).toEqual([]);
	});

	it('rejects keybindings for tier 0 (they invoke plugin commands)', () => {
		const c = collectContributions(
			manifest('com.acme', {
				keybindings: [{ id: 'palette', key: 'Ctrl+Shift+P', command: 'open-palette' }],
			})
		);
		expect(c.keybindings).toEqual([]);
		expect(c.errors.some((e) => e.includes('keybindings require tier'))).toBe(true);
	});

	it('drops a keybinding missing its key chord or command id', () => {
		const c = collectContributions(
			manifest(
				'com.acme',
				{
					keybindings: [
						{ id: 'nokey', command: 'do-thing' },
						{ id: 'nocmd', key: 'Ctrl+K' },
					],
				},
				1
			)
		);
		expect(c.keybindings).toEqual([]);
		expect(c.errors.length).toBe(2);
	});

	it('aggregates keybindings across plugins via plugins:contributions surface', () => {
		const agg = aggregateContributions([
			manifest('com.a', { keybindings: [{ id: 'k', key: 'Ctrl+1', command: 'one' }] }, 1),
			manifest('com.b', { keybindings: [{ id: 'k', key: 'Ctrl+2', command: 'two' }] }, 1),
		]);
		expect(agg.keybindings.map((k) => k.id).sort()).toEqual(['com.a/k', 'com.b/k']);
		expect(agg.keybindings.map((k) => k.key).sort()).toEqual(['Ctrl+1', 'Ctrl+2']);
	});
});

describe('aggregateContributions per-bucket id uniqueness', () => {
	it('keeps a tool and a command that share a localId (cross-type is not a collision)', () => {
		const agg = aggregateContributions([
			manifest(
				'com.p',
				{
					commands: [{ id: 'run', title: 'Run' }],
					tools: [{ id: 'run', name: 'Run', description: 'run it' }],
				},
				1
			),
		]);
		expect(agg.commands.map((c) => c.id)).toContain('com.p/run');
		expect(agg.tools.map((t) => t.id)).toContain('com.p/run');
		expect(agg.errorsByPlugin['com.p']).toBeUndefined();
	});

	it('still drops a true within-type duplicate id', () => {
		const agg = aggregateContributions([
			manifest(
				'com.p',
				{
					commands: [
						{ id: 'run', title: 'A' },
						{ id: 'run', title: 'B' },
					],
				},
				1
			),
		]);
		expect(agg.commands.filter((c) => c.id === 'com.p/run')).toHaveLength(1);
		expect(agg.errorsByPlugin['com.p']?.some((e) => e.includes('duplicate'))).toBe(true);
	});
});

describe('uiItems contribution (ui:contribute surface items)', () => {
	const withItem = (over: Record<string, unknown> = {}) =>
		manifest(
			'com.ui',
			{ uiItems: [{ id: 'go', surface: 'status-bar', label: 'Go', command: 'run', ...over }] },
			1
		);

	it('parses a valid uiItem at tier 1', () => {
		const c = collectContributions(withItem());
		expect(c.errors).toEqual([]);
		expect(c.uiItems).toHaveLength(1);
		expect(c.uiItems[0]).toMatchObject({
			id: 'com.ui/go',
			surface: 'status-bar',
			label: 'Go',
			command: 'run',
		});
	});

	it('requires tier >= 1', () => {
		const c = collectContributions(
			manifest(
				'com.ui',
				{ uiItems: [{ id: 'go', surface: 'menu', label: 'Go', command: 'run' }] },
				0
			)
		);
		expect(c.uiItems).toEqual([]);
		expect(c.errors.join(' ')).toContain('tier >= 1');
	});

	it('rejects an invalid surface', () => {
		const c = collectContributions(withItem({ surface: 'nowhere' }));
		expect(c.uiItems).toEqual([]);
		expect(c.errors.join(' ')).toContain('surface');
	});

	it('rejects a non-plugin-local command', () => {
		const c = collectContributions(withItem({ command: 'other-plugin/cmd' }));
		expect(c.uiItems).toEqual([]);
		expect(c.errors.join(' ')).toContain('command');
	});
});

describe('hostViews contribution (host-rendered BlockView data)', () => {
	const hostView = (overrides: Record<string, unknown> = {}) =>
		manifest(
			'com.host-view',
			{
				hostViews: [
					{
						id: 'status',
						surface: 'movement',
						title: 'Status',
						blocks: [{ kind: 'text', content: 'Rendered by the host.' }],
						...overrides,
					},
				],
			},
			0
		);

	it.each([
		['movement', [{ kind: 'text', content: 'Movement data' }]],
		['cadenza', [{ kind: 'heading', text: 'Cadenza data' }]],
	])('parses and namespaces a valid %s host view', (surface, blocks) => {
		const c = collectContributions(hostView({ surface, blocks }));

		expect(c.errors).toEqual([]);
		expect(c.hostViews).toEqual([
			{
				id: 'com.host-view/status',
				localId: 'status',
				pluginId: 'com.host-view',
				surface,
				title: 'Status',
				blocks,
			},
		]);
	});

	it('drops a host view with an invalid surface', () => {
		const c = collectContributions(hostView({ surface: 'sidebar' }));

		expect(c.hostViews).toEqual([]);
		expect(c.errors.join(' ')).toContain('surface');
	});

	it('rejects non-BlockView data, including a decision cadenza payload', () => {
		const c = collectContributions(
			hostView({ blocks: { op: 'open', viewType: 'decision', options: [{ label: 'Allow' }] } })
		);

		expect(c.hostViews).toEqual([]);
		expect(c.errors.join(' ')).toContain('blocks');
	});

	it('drops blocks whose serialized UTF-8 payload exceeds the pure size cap', () => {
		const c = collectContributions(
			hostView({ blocks: [{ kind: 'text', content: 'x'.repeat(MAX_HOST_VIEW_BLOCKS_BYTES) }] })
		);

		expect(c.hostViews).toEqual([]);
		expect(c.errors.join(' ')).toContain('size limit');
	});

	it('keeps the first host view on a same-id collision during aggregation', () => {
		const agg = aggregateContributions([
			manifest(
				'com.host-view',
				{
					hostViews: [
						{ id: 'status', surface: 'movement', title: 'First' },
						{ id: 'status', surface: 'cadenza', title: 'Second' },
					],
				},
				1
			),
		]);

		expect(agg.hostViews).toMatchObject([{ id: 'com.host-view/status', title: 'First' }]);
		expect(agg.errorsByPlugin['com.host-view']?.join(' ')).toContain('duplicate hostViews');
	});

	it('keeps static host views when no ui:hostView grant exists', () => {
		const collected = collectContributions(hostView());

		expect(gateContributions(collected, () => false).hostViews).toHaveLength(1);
		expect(
			gateContributions(collected, (cap) => cap === 'ui:render-unsafe').hostViews
		).toHaveLength(1);
	});
});

describe('PluginUiSurface registry and trusted-chrome guard', () => {
	function uiItemManifest(surface: string): PluginManifest {
		const contribution = {
			id: 'go',
			surface,
			label: 'Go',
			command: 'run',
			tooltip: 'Run Go',
		};
		return manifest('com.ui', { uiItems: [contribution] }, 1);
	}

	it.each([
		'tabBar',
		'sessionRowBadge',
		'groupHeaderBadge',
		'settingsSection',
		'rightPanelTab',
		'contextMenuItem',
		'emptyState',
	])('accepts the %s ui:contribute surface', (surface) => {
		const collected = collectContributions(uiItemManifest(surface));

		expect(collected.errors).toEqual([]);
		expect(collected.uiItems).toMatchObject([{ surface, tooltip: 'Run Go' }]);
		expect(isPluginUiSurface(surface)).toBe(true);
	});

	it('keeps every contributable surface in the positive allowlist', () => {
		expect(UI_SURFACES).toEqual(
			expect.arrayContaining([
				'status-bar',
				'menu',
				'sidebar',
				'activity-bar',
				'toolbar',
				'tabBar',
				'sessionRowBadge',
				'groupHeaderBadge',
				'settingsSection',
				'rightPanelTab',
				'contextMenuItem',
				'emptyState',
			])
		);
		for (const protectedSurface of PROTECTED_UI_SURFACES) {
			expect(UI_SURFACES).not.toContain(protectedSurface);
			expect(isPluginUiSurface(protectedSurface)).toBe(false);
		}
	});

	it.each(PROTECTED_UI_SURFACES)(
		'drops declarative and ui:render-unsafe attempts at protected %s',
		(protectedSurface) => {
			const collected = collectContributions(uiItemManifest(protectedSurface));
			const aggregated = aggregateContributions(
				[uiItemManifest(protectedSurface)],
				(pluginId, capability) => pluginId === 'com.ui' && capability === 'ui:contribute'
			);
			const unsafe = validatePluginUiMount({
				pluginId: 'com.ui',
				tier: 'ui:render-unsafe',
				target: protectedSurface,
			});

			expect(collected.uiItems).toEqual([]);
			expect(collected.errors.join(' ')).toContain('protected chrome');
			expect(aggregated.uiItems).toEqual([]);
			expect(aggregated.errorsByPlugin['com.ui']?.join(' ')).toContain('protected chrome');
			expect(unsafe.allowed).toBe(false);
			expect(unsafe.error).toContain('protected chrome');
		}
	);

	it('does not infer target policy from a namespaced contribution id', () => {
		const collected = collectContributions(
			manifest(
				'evil',
				{
					uiItems: [
						{
							id: 'permission-consent',
							surface: 'permission-consent',
							label: 'Spoof consent',
							command: 'run',
						},
					],
				},
				1
			)
		);

		expect(collected.uiItems).toEqual([]);
		expect(collected.errors.join(' ')).toContain('permission-consent');
		expect(isPluginUiSurface('evil/permission-consent')).toBe(false);
	});
});

describe('gateContributions (per-capability customization gate)', () => {
	const built = collectContributions(
		manifest(
			'com.g',
			{
				uiItems: [{ id: 'go', surface: 'status-bar', label: 'Go', command: 'run' }],
				panels: [{ id: 'p', title: 'P', entry: 'panel.html' }],
				commands: [{ id: 'run', title: 'Run' }],
			},
			1
		)
	);

	it('drops uiItems without ui:contribute and panels without ui:panel', () => {
		const none = gateContributions(built, () => false);
		expect(none.uiItems).toEqual([]);
		expect(none.panels).toEqual([]);
		expect(none.commands).toHaveLength(1); // ungated category passes through
	});

	it('keeps uiItems with ui:contribute and panels with ui:panel', () => {
		const all = gateContributions(built, (cap) => cap === 'ui:contribute' || cap === 'ui:panel');
		expect(all.uiItems).toHaveLength(1);
		expect(all.panels).toHaveLength(1);
	});

	it('gates each capability independently', () => {
		const onlyItems = gateContributions(built, (cap) => cap === 'ui:contribute');
		expect(onlyItems.uiItems).toHaveLength(1);
		expect(onlyItems.panels).toEqual([]);
	});

	it('ui:render-unsafe does NOT unlock host-rendered uiItems or panels (D-PanelsEscape)', () => {
		// SECURITY INVARIANT: ui:render-unsafe is the high-risk "render arbitrary UI"
		// escape hatch - it is NOT a substitute grant for the host-rendered surfaces.
		// Holding only it must leave uiItems/panels gated out; otherwise an author who
		// got the inert escape-hatch grant would silently gain menu/panel injection.
		const onlyUnsafe = gateContributions(built, (cap) => cap === 'ui:render-unsafe');
		expect(onlyUnsafe.uiItems).toEqual([]);
		expect(onlyUnsafe.panels).toEqual([]);
	});
});

describe('aggregateContributions - gated aggregation', () => {
	it('gates capability-scoped contributions per plugin when given the predicate', () => {
		const m = manifest(
			'com.g2',
			{
				uiItems: [{ id: 'go', surface: 'menu', label: 'Go', command: 'run' }],
				commands: [{ id: 'run', title: 'Run' }],
			},
			1
		);
		expect(aggregateContributions([m]).uiItems).toHaveLength(1); // ungated (back-compat)
		const gated = aggregateContributions([m], () => false);
		expect(gated.uiItems).toEqual([]); // gated out without ui:contribute
		expect(gated.commands).toHaveLength(1); // ungated category survives
	});
});

describe('groupings contribution', () => {
	it('collects tier-0 rules, namespaces its id, and rejects unsafe patterns', () => {
		const c = collectContributions(
			manifest('com.acme', {
				groupings: [
					{
						id: 'by-type',
						label: 'Group by agent type',
						rules: [{ match: { toolType: 'claude' }, group: 'Claude' }],
					},
					{
						id: 'bad-pattern',
						label: 'Bad',
						rules: [{ match: { namePattern: 'x'.repeat(257) }, group: 'Nope' }],
					},
				],
			})
		);
		expect(c.groupings).toEqual([
			expect.objectContaining({ id: 'com.acme/by-type', localId: 'by-type', pluginId: 'com.acme' }),
		]);
		expect(c.errors.join(' ')).toContain('pattern');
	});

	it('evaluates each matcher with literal-safe wildcards', () => {
		const session = {
			id: 'session-1',
			toolType: 'claude-code',
			cwd: 'C:/work/api',
			name: 'API [draft]',
		};
		expect(
			groupingRuleMatches(session, { match: { toolType: 'claude-code' }, group: 'Tool' })
		).toBe(true);
		expect(groupingRuleMatches(session, { match: { cwdGlob: 'C:/work/*' }, group: 'Cwd' })).toBe(
			true
		);
		expect(groupingRuleMatches(session, { match: { namePattern: 'API [*]' }, group: 'Name' })).toBe(
			true
		);
		expect(matchesGroupingPattern('abc', 'a.c')).toBe(false);
	});
});

describe('combined contribution surfaces', () => {
	it('collects hostViews, iconPacks, and groupings together', () => {
		const c = collectContributions(
			manifest('com.acme', {
				iconPacks: [
					{
						id: 'pack',
						label: 'Pack',
						icons: [{ id: 'folder', label: 'Folder', path: 'M1 1h2v2H1z' }],
						colors: [],
					},
				],
				hostViews: [{ id: 'status', surface: 'movement', title: 'Status', blocks: [] }],
				groupings: [
					{
						id: 'by-tool',
						label: 'By tool',
						rules: [{ match: { toolType: 'claude' }, group: 'Claude' }],
					},
				],
			})
		);
		expect(c.iconPacks).toHaveLength(1);
		expect(c.hostViews).toHaveLength(1);
		expect(c.groupings).toHaveLength(1);
	});
});
