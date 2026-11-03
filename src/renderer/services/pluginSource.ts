/** Shared native source chooser for both plugin installation surfaces and updates. */
export function selectPluginSource(title: string, fromFolder = false): Promise<string | null> {
	if (fromFolder) return window.maestro.dialog.selectFolder();
	return window.maestro.dialog.selectFile({
		title,
		filters: [{ name: 'Plugin archives or plugin.json', extensions: ['tgz', 'tar.gz', 'json'] }],
	});
}
