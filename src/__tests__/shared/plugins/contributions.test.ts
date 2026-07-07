import { describe, it, expect } from 'vitest';
import {
	collectContributions,
	aggregateContributions,
	gateContributions,
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
		// escape hatch — it is NOT a substitute grant for the host-rendered surfaces.
		// Holding only it must leave uiItems/panels gated out; otherwise an author who
		// got the inert escape-hatch grant would silently gain menu/panel injection.
		const onlyUnsafe = gateContributions(built, (cap) => cap === 'ui:render-unsafe');
		expect(onlyUnsafe.uiItems).toEqual([]);
		expect(onlyUnsafe.panels).toEqual([]);
	});
});

describe('aggregateContributions — gated aggregation', () => {
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
