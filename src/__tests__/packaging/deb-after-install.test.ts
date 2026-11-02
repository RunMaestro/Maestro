import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const projectDir = path.resolve(import.meta.dirname, '../../..');
const packageJson = JSON.parse(readFileSync(path.join(projectDir, 'package.json'), 'utf8'));
const templatePath = path.join(
	projectDir,
	packageJson.build.deb.afterInstall ??
		'node_modules/app-builder-lib/templates/linux/after-install.tpl'
);

// Execute the real installer with command doubles. No root privileges or writes
// to the installed application are needed, including on the failing old template.
function runInstaller(failCommand?: 'chown' | 'chmod') {
	const tempDir = mkdtempSync(path.join(os.tmpdir(), 'maestro-deb-postinst-'));
	try {
		const logPath = path.join(tempDir, 'commands.log');
		const environmentPath = path.join(tempDir, 'environment.sh');
		const scriptPath = path.join(tempDir, 'postinst');
		const commands = [
			'chown',
			'chmod',
			'update-alternatives',
			'update-mime-database',
			'update-desktop-database',
			'ln',
			'rm',
			'cp',
			'apparmor_parser',
			'unshare',
		];
		writeFileSync(logPath, '');
		writeFileSync(
			environmentPath,
			commands
				.map(
					(command) => `${command}() {
	printf '%s\\n' "${command} $*" >> "$INSTALLER_TEST_LOG"
	return ${command === failCommand ? 42 : 0}
}`
				)
				.join('\n') + '\napparmor_status() { return 1; }\n'
		);
		writeFileSync(
			scriptPath,
			readFileSync(templatePath, 'utf8')
				.replaceAll('${executable}', 'maestro')
				.replaceAll('${sanitizedProductName}', 'Maestro')
		);
		const result = spawnSync('bash', [scriptPath, 'configure'], {
			encoding: 'utf8',
			env: {
				...process.env,
				BASH_ENV: environmentPath,
				INSTALLER_TEST_LOG: logPath,
			},
		});
		if (result.error) throw result.error;
		return {
			status: result.status,
			stderr: result.stderr,
			commands: readFileSync(logPath, 'utf8').trim().split('\n'),
		};
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
}

describe.skipIf(process.platform !== 'linux')('Debian installer sandbox permissions', () => {
	it('installs a root-owned SUID helper even when the root namespace probe succeeds', () => {
		const result = runInstaller();
		expect(result.status, result.stderr).toBe(0);
		expect(result.commands.filter((command) => command.startsWith('chmod '))).toEqual([
			'chmod 4755 /opt/Maestro/chrome-sandbox',
		]);
		expect(result.commands).toContain('chown root:root /opt/Maestro/chrome-sandbox');
		// chown can clear the SUID bit, so set the mode only after the owner.
		expect(result.commands.indexOf('chown root:root /opt/Maestro/chrome-sandbox')).toBeLessThan(
			result.commands.indexOf('chmod 4755 /opt/Maestro/chrome-sandbox')
		);
		expect(result.commands).toContain(
			'update-alternatives --install /usr/bin/maestro maestro /opt/Maestro/maestro 100'
		);
		expect(result.commands).toContain('update-mime-database /usr/share/mime');
		expect(result.commands).toContain('update-desktop-database /usr/share/applications');
	});

	it.each(['chown', 'chmod'] as const)('fails installation when %s fails', (command) => {
		const result = runInstaller(command);
		expect(result.status, result.stderr).toBe(42);
		expect(result.commands.some((entry) => entry.startsWith('update-mime-database '))).toBe(false);
	});
});
