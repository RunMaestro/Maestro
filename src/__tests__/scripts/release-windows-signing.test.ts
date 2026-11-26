/**
 * @file release-windows-signing.test.ts
 * @description Guards the Windows code-signing wiring in release.yml: OIDC login
 * with no stored secret, signing only for tag builds, a hard signature check,
 * and the windows-signature.json marker the rollback list depends on.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { WINDOWS_SIGNATURE_ASSET } from '../../shared/updateRollback';

const root = path.resolve(__dirname, '../../..');
const workflowText = readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8');

interface Step {
	name?: string;
	if?: string;
	uses?: string;
	run?: string;
	env?: Record<string, string>;
	with?: Record<string, string>;
}
interface BuildJob {
	environment?: string;
	permissions?: Record<string, string>;
	steps: Step[];
}
const build = (yaml.load(workflowText) as { jobs: { build: BuildJob } }).jobs.build;
const steps = build.steps;
const index = (name: string) => steps.findIndex((s) => s.name === name);
const step = (name: string) => steps[index(name)];

describe('release workflow: Windows code signing', () => {
	it('gives only tag builds of the Windows leg the signing environment', () => {
		expect(build.environment).toContain("matrix.platform == 'win'");
		expect(build.environment).toContain("startsWith(github.ref, 'refs/tags/')");
		expect(build.environment).toContain("'windows-signing'");
	});

	it('can mint an OIDC token, so no Azure client secret exists', () => {
		expect(build.permissions?.['id-token']).toBe('write');
		expect(workflowText).not.toContain('AZURE_CLIENT_SECRET');
	});

	it('logs in to Azure from environment variables before packaging Windows', () => {
		const login = step('Azure login for Windows signing');
		expect(login.uses).toMatch(/^azure\/login@/);
		expect(login.with?.['client-id']).toBe('${{ vars.AZURE_CLIENT_ID }}');
		expect(login.if).toContain("startsWith(github.ref, 'refs/tags/')");
		expect(index('Azure login for Windows signing')).toBeLessThan(index('Package for Windows'));
	});

	it('passes the signing config on the command line, only for tag builds', () => {
		const pkg = step('Package for Windows');
		expect(pkg.env?.SIGN_WINDOWS).toBe("${{ startsWith(github.ref, 'refs/tags/') }}");
		expect(pkg.run).toContain('azureSignOptions.codeSigningAccountName=runmaestro-signing');
		expect(pkg.run).toContain('azureSignOptions.publisherName=Pedram Amini');
	});

	it('fails a tag build whose executables are not signed, then writes the rollback marker', () => {
		const verify = step('Verify Windows signatures');
		expect(index('Verify Windows signatures')).toBeGreaterThan(index('Package for Windows'));
		expect(index('Verify Windows signatures')).toBeLessThan(index('Upload Windows artifacts'));
		expect(verify.run).toContain('Get-AuthenticodeSignature');
		expect(verify.run).toContain('CN=Pedram Amini');
		expect(verify.run).toContain(`release/${WINDOWS_SIGNATURE_ASSET}`);
	});

	it('ships the marker as a release asset', () => {
		expect(step('Upload Windows artifacts').with?.path).toContain(
			`release/${WINDOWS_SIGNATURE_ASSET}`
		);
	});
});
