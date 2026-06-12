import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import { buildMaestroUrl } from '../../../renderer/utils/buildMaestroUrl';

describe('buildMaestroUrl', () => {
	it('appends theme ID as query parameter for built-in themes', () => {
		useSettingsStore.setState({ activeThemeId: 'dracula' });
		const url = buildMaestroUrl('https://runmaestro.ai');
		expect(url).toBe('https://runmaestro.ai/?theme=dracula');
	});

	it('preserves existing path segments', () => {
		useSettingsStore.setState({ activeThemeId: 'nord' });
		const url = buildMaestroUrl('https://runmaestro.ai/discord');
		expect(url).toBe('https://runmaestro.ai/discord?theme=nord');
	});

	it('preserves existing query parameters', () => {
		useSettingsStore.setState({ activeThemeId: 'tokyo-night' });
		const url = buildMaestroUrl('https://docs.runmaestro.ai/?foo=bar');
		expect(url).toBe('https://docs.runmaestro.ai/?foo=bar&theme=tokyo-night');
	});

	it('falls back to dark for custom theme with dark mode', () => {
		useSettingsStore.setState({ activeThemeId: 'custom' });
		// custom theme defaults to dracula which is dark mode
		const url = buildMaestroUrl('https://runmaestro.ai');
		expect(url).toBe('https://runmaestro.ai/?theme=dark');
	});

	it('works with all 16 built-in theme IDs', () => {
		const themeIds = [
			'dracula',
			'monokai',
			'github-light',
			'solarized-light',
			'nord',
			'tokyo-night',
			'one-light',
			'gruvbox-light',
			'catppuccin-mocha',
			'gruvbox-dark',
			'catppuccin-latte',
			'ayu-light',
			'pedurple',
			'maestros-choice',
			'dre-synth',
			'inquest',
		];

		for (const id of themeIds) {
			useSettingsStore.setState({ activeThemeId: id });
			const url = buildMaestroUrl('https://runmaestro.ai');
			expect(url).toContain('theme=' + id);
		}
	});

	it('works with docs subdomain', () => {
		useSettingsStore.setState({ activeThemeId: 'catppuccin-latte' });
		const url = buildMaestroUrl('https://docs.runmaestro.ai/symphony');
		expect(url).toBe('https://docs.runmaestro.ai/symphony?theme=catppuccin-latte');
	});
});
