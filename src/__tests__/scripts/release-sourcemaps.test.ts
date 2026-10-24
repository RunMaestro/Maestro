/**
 * The release workflow builds hidden renderer source maps, uploads them to
 * Sentry, and deletes them before packaging. These tests pin the ordering and
 * gating that keep the two promises: maps never ship inside the app, and a
 * fork (no SENTRY_AUTH_TOKEN) or a Sentry outage never fails a release.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

const root = path.resolve(__dirname, '../../..');

interface WorkflowStep {
	name?: string;
	run?: string;
	if?: string;
	env?: Record<string, string>;
	'continue-on-error'?: boolean;
}

function buildSteps(): WorkflowStep[] {
	const workflow = yaml.load(
		readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8')
	) as { jobs: { build: { steps: WorkflowStep[] } } };
	return workflow.jobs.build.steps;
}

function indexOfStep(steps: WorkflowStep[], name: string): number {
	const index = steps.findIndex((step) => step.name === name);
	expect(index, `step "${name}"`).toBeGreaterThanOrEqual(0);
	return index;
}

describe('release workflow: renderer source maps', () => {
	const steps = buildSteps();

	it('builds the renderer with hidden source maps', () => {
		const build = steps[indexOfStep(steps, 'Build application')];
		expect(build.env?.MAESTRO_RENDERER_SOURCEMAPS).toBe('1');
	});

	it('uploads only when the token is present and never fails the release', () => {
		const upload = steps[indexOfStep(steps, 'Upload renderer source maps to Sentry')];
		expect(upload['continue-on-error']).toBe(true);
		expect(upload.env?.SENTRY_AUTH_TOKEN).toBe('${{ secrets.SENTRY_AUTH_TOKEN }}');
		expect(upload.run).toMatch(/if \[ -z "\$\{SENTRY_AUTH_TOKEN:-\}" \]; then[\s\S]*exit 0/);
		// The release must match app.getVersion() and the frame paths app://app/assets/*.
		expect(upload.run).toContain('--release "$VERSION"');
		expect(upload.run).toContain("--url-prefix 'app://app/'");
		expect(upload.env?.VERSION).toBe('${{ steps.version.outputs.VERSION }}');
	});

	it('injects and uploads after the build, then deletes every map before any packaging step', () => {
		const build = indexOfStep(steps, 'Build application');
		const upload = indexOfStep(steps, 'Upload renderer source maps to Sentry');
		const remove = indexOfStep(steps, 'Remove renderer source maps before packaging');
		const firstPackage = steps.findIndex((step) => step.name?.startsWith('Package for'));

		expect(firstPackage).toBeGreaterThan(0);
		expect(build).toBeLessThan(upload);
		expect(upload).toBeLessThan(remove);
		expect(remove).toBeLessThan(firstPackage);

		const removeStep = steps[remove];
		expect(removeStep.if).toBeUndefined();
		expect(removeStep.run).toContain("find dist/renderer -type f -name '*.map' -delete");
	});

	it('excludes renderer maps from the packaged files as a second guard', () => {
		const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
		expect(pkg.build.files).toContain('!dist/renderer/**/*.map');
	});
});
