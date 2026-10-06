// Generate docs/cli-reference.md from the live CLI command tree.
//
// Builds the CLI bundle (so the reference reflects the current source) then runs
// `maestro-cli reference` and writes the Markdown to docs/cli-reference.md. The
// reference is introspected from Commander, so it can never drift from the
// registered commands.
//
// Usage: npm run gen:cli-reference

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import prettier from 'prettier';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const cliBundle = join(rootDir, 'dist/cli/maestro-cli.js');
const outFile = join(rootDir, 'docs/cli-reference.md');

console.log('Building CLI bundle...');
execFileSync('node', [join(rootDir, 'scripts/build-cli.mjs')], { stdio: 'inherit' });

console.log('Generating command reference...');
const markdown = execFileSync('node', [cliBundle, 'reference'], {
	encoding: 'utf8',
	maxBuffer: 16 * 1024 * 1024,
});

// Mintlify reads the page title and sidebar icon out of frontmatter; without it
// the nav falls back to the filename and renders "Cli reference" with no icon.
// `maestro-cli reference` stays docs-agnostic, so the frontmatter is added here.
const frontmatter = [
	'---',
	'title: CLI Reference',
	'description: Every maestro-cli command, argument, and option, generated from the live command tree.',
	'icon: book',
	'---',
	'',
	'',
].join('\n');

// The command tree owns options and defaults; these usage notes explain choices
// that do not fit in an option table. Keep them here so regeneration retains them.
const guidance = [
	[
		'## `maestro-cli queue`',
		'`ask` is a background consult: it prints an answer without touching the target agent\'s open conversation. `dispatch` hands over work in a visible tab and returns a tab ID. Ask a self-contained question, or pass `--with-context` to include your transcript. The consult is recorded in the target\'s history.\n\n```bash\nmaestro-cli ask "Substrate PedTome" "How does your authentication gate work?" --from "$MY_AGENT_ID"\n```',
	],
	[
		'## `maestro-cli update-ssh-remote <remote-id>`',
		'`--ssh-option` passes an option to `ssh -o`, overriding Maestro defaults and `~/.ssh/config`. Use it for a tunnel `ProxyCommand`, a `ProxyJump` bastion, or a longer `ConnectTimeout`. `RequestTTY` is reserved because Maestro derives it per command; forcing a TTY can corrupt an agent\'s stream-json output.\n\n```bash\nmaestro-cli create-ssh-remote "Tunnelled box" \\\n  --host tailcat-devbox \\\n  --ssh-option "ProxyCommand=/opt/homebrew/bin/tailcat tcXXXX 22" \\\n  --ssh-option ConnectTimeout=45\n```',
	],
	[
		'## `maestro-cli remove-ssh-remote <remote-id>`',
		'Only supplied fields change. `--env` and `--ssh-option` merge with existing values; use `--clear-env` or `--clear-ssh-options` to start from empty. `--disable-*` keeps a value but stops passing it to SSH; `--enable-*` restores it. Clearing also removes disabled entries. JSON output includes `sshOptions`, disabled entries, and `resolvedSshOptions` (the effective options including defaults).',
	],
	[
		'## `maestro-cli display`',
		'`test-ssh-remote` uses the same connection options as agent spawning and prints the remote hostname, so tunnel and `ProxyCommand` errors can be caught during setup. It also works while the desktop is closed.',
	],
];

let body = markdown.endsWith('\n') ? markdown : markdown + '\n';
for (const [nextHeading, note] of guidance) {
	if (!body.includes(nextHeading)) throw new Error(`Missing CLI reference heading: ${nextHeading}`);
	body = body.replace(nextHeading, `${note}\n\n${nextHeading}`);
}
const formatted = await prettier.format(frontmatter + body, {
	...(await prettier.resolveConfig(outFile)),
	filepath: outFile,
});
writeFileSync(outFile, formatted, 'utf8');
console.log(`Wrote ${outFile}`);
