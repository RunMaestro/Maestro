import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, URL } from 'node:url';
import console from 'node:console';
const result = await build({
	entryPoints: [fileURLToPath(new URL('./ui.mjs', import.meta.url))],
	bundle: true,
	platform: 'browser',
	format: 'iife',
	write: false,
	minify: true,
	legalComments: 'inline',
	target: 'chrome120',
});
const html = await readFile(new URL('./ui.html', import.meta.url), 'utf8');
await writeFile(
	new URL('./prototype.html', import.meta.url),
	html.replace('/* PROTOTYPE_BUNDLE */', () =>
		result.outputFiles[0].text.replaceAll('</script', '<\\/script')
	)
);
console.log('Built self-contained prototype.html; no server, listener or network access.');
