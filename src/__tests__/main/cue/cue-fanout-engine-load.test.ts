/**
 * Faithful end-to-end test of the engine's actual load path
 * (`loadCueConfigDetailed`) for fan-out pipelines with differing per-agent
 * prompts. The earlier regression test composed the individual pieces —
 * this one exercises the exact function the CueEngine calls on refresh.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

vi.mock('../../../main/utils/sentry', () => ({
	captureException: vi.fn(),
}));

import { loadCueConfigDetailed } from '../../../main/cue/cue-yaml-loader';

let projectRoot = '';

beforeEach(() => {
	projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-fanout-engine-'));
	fs.mkdirSync(path.join(projectRoot, '.maestro/prompts'), { recursive: true });
});

afterEach(() => {
	if (projectRoot && fs.existsSync(projectRoot)) {
		fs.rmSync(projectRoot, { recursive: true, force: true });
	}
});

function writeFile(relPath: string, content: string) {
	const abs = path.join(projectRoot, relPath);
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, content, 'utf-8');
}

describe('loadCueConfigDetailed — fan-out with per-agent prompt files', () => {
	it('loads the fan-out subscription instead of skipping it as invalid', () => {
		// Exactly the shape the renderer emits post-Commit-7.
		writeFile(
			'.maestro/cue.yaml',
			[
				'subscriptions:',
				'  - name: Pipeline 1',
				'    event: app.startup',
				'    agent_id: sess-codex',
				'    pipeline_name: Pipeline 1',
				"    pipeline_color: '#06b6d4'",
				'    fan_out:',
				'      - Codex 1',
				'      - OpenCode 1',
				'      - Claude 1',
				'    fan_out_prompt_files:',
				'      - .maestro/prompts/codex_1-pipeline_1.md',
				'      - .maestro/prompts/opencode_1-pipeline_1.md',
				'      - .maestro/prompts/claude_1-pipeline_1.md',
				'settings:',
				'  timeout_minutes: 30',
				'  timeout_on_fail: break',
				'  max_concurrent: 1',
				'  queue_size: 10',
				'',
			].join('\n')
		);
		writeFile('.maestro/prompts/codex_1-pipeline_1.md', 'codex work');
		writeFile('.maestro/prompts/opencode_1-pipeline_1.md', 'opencode work');
		writeFile('.maestro/prompts/claude_1-pipeline_1.md', 'claude work');

		const result = loadCueConfigDetailed(projectRoot);
		expect(result.ok).toBe(true);
		if (!result.ok) return; // type narrowing for TS

		// The sub MUST survive the lenient partition — this is the exact
		// place that used to silently drop it (validator error) and cause
		// the pipeline to vanish from the UI after reload.
		expect(result.config.subscriptions).toHaveLength(1);

		const sub = result.config.subscriptions[0];
		expect(sub.fan_out).toEqual(['Codex 1', 'OpenCode 1', 'Claude 1']);
		expect(sub.fan_out_prompts).toEqual(['codex work', 'opencode work', 'claude work']);
		expect(sub.fan_out_prompt_files).toEqual([
			'.maestro/prompts/codex_1-pipeline_1.md',
			'.maestro/prompts/opencode_1-pipeline_1.md',
			'.maestro/prompts/claude_1-pipeline_1.md',
		]);
		// pipeline_name / pipeline_color must round-trip for UI grouping.
		expect(sub.pipeline_name).toBe('Pipeline 1');
		expect(sub.pipeline_color).toBe('#06b6d4');
	});

	it('loads the fan-out subscription with legacy inline fan_out_prompts', () => {
		writeFile(
			'.maestro/cue.yaml',
			[
				'subscriptions:',
				'  - name: Legacy Pipeline',
				'    event: app.startup',
				'    agent_id: sess-a',
				'    fan_out:',
				'      - A',
				'      - B',
				'    fan_out_prompts:',
				'      - "do A"',
				'      - "do B"',
				'settings:',
				'  timeout_minutes: 30',
				'  timeout_on_fail: break',
				'  max_concurrent: 1',
				'  queue_size: 10',
				'',
			].join('\n')
		);

		const result = loadCueConfigDetailed(projectRoot);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.config.subscriptions).toHaveLength(1);
		expect(result.config.subscriptions[0].fan_out_prompts).toEqual(['do A', 'do B']);
	});

	it('does NOT report a warning about skipped subscriptions for a valid fan-out', () => {
		// Regression guard: even if validation passed now, a stray warning
		// in `result.warnings` would surface in logs as if something failed.
		writeFile(
			'.maestro/cue.yaml',
			[
				'subscriptions:',
				'  - name: Clean',
				'    event: app.startup',
				'    fan_out: [A, B]',
				'    fan_out_prompt_files:',
				'      - .maestro/prompts/a.md',
				'      - .maestro/prompts/b.md',
				'settings:',
				'  timeout_minutes: 30',
				'  timeout_on_fail: break',
				'  max_concurrent: 1',
				'  queue_size: 10',
				'',
			].join('\n')
		);
		writeFile('.maestro/prompts/a.md', 'a');
		writeFile('.maestro/prompts/b.md', 'b');

		const result = loadCueConfigDetailed(projectRoot);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.warnings.filter((w) => /Skipped invalid subscription/.test(w))).toEqual([]);
	});
});
