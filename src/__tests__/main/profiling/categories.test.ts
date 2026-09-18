/**
 * Tests for the trace category preset and buffer config.
 *
 * These assert intent, not a snapshot. Every category in the default set is
 * there because some analysis needs it and costs buffer that another analysis
 * then cannot have, so the interesting failures are "someone dropped the only
 * category that answers X" and "someone re-added the firehose".
 */

import { describe, it, expect } from 'vitest';
import {
	DEFAULT_TRACE_CATEGORIES,
	TRACE_BUFFER_SIZE_KB,
	buildTraceConfig,
} from '../../../main/profiling/categories';

describe('profiling/categories', () => {
	it('records the CPU profiler, the only usable JS attribution in Electron', () => {
		// The devtools FunctionCall / EvaluateScript events an analyzer would
		// normally read are not emitted in an Electron trace. Drop this and every
		// "which function was slow" question becomes unanswerable.
		expect(DEFAULT_TRACE_CATEGORIES).toContain('disabled-by-default-v8.cpu_profiler');
	});

	it('records invalidation tracking, the only source of WHY style/layout ran', () => {
		// Without this a trace can say the renderer recalculated style on every
		// frame but not who asked it to, which is the half that leads to a fix.
		expect(DEFAULT_TRACE_CATEGORIES).toContain(
			'disabled-by-default-devtools.timeline.invalidationTracking'
		);
	});

	it('records the devtools timeline and frame stream', () => {
		expect(DEFAULT_TRACE_CATEGORIES).toContain('disabled-by-default-devtools.timeline');
		expect(DEFAULT_TRACE_CATEGORIES).toContain('disabled-by-default-devtools.timeline.frame');
		expect(DEFAULT_TRACE_CATEGORIES).toContain('disabled-by-default-devtools.timeline.stack');
	});

	it('keeps the compositor but not the GPU process', () => {
		// `cc` carries frame commits and PaintArtifactCompositor::Update, which is
		// how idle repainting is detected at all. `gpu` was 7% of a field capture
		// and produced no finding across two of them; buffer spent there is buffer
		// the renderer does not get.
		expect(DEFAULT_TRACE_CATEGORIES).toContain('cc');
		expect(DEFAULT_TRACE_CATEGORIES).not.toContain('gpu');
	});

	it('never enables the wildcard firehose', () => {
		expect(DEFAULT_TRACE_CATEGORIES).not.toContain('*');
	});

	it('has no duplicate categories', () => {
		expect(new Set(DEFAULT_TRACE_CATEGORIES).size).toBe(DEFAULT_TRACE_CATEGORIES.length);
	});

	it('builds a record-until-full config against the watched buffer size', () => {
		const config = buildTraceConfig();
		// record-until-full is only safe because the buffer is watched: the
		// watchdog ends the recording before this size is reached.
		expect(config.recording_mode).toBe('record-until-full');
		expect(config.trace_buffer_size_in_kb).toBe(TRACE_BUFFER_SIZE_KB);
		expect(config.included_categories).toEqual(DEFAULT_TRACE_CATEGORIES);
	});

	it('honors an explicit category list', () => {
		expect(buildTraceConfig(['toplevel']).included_categories).toEqual(['toplevel']);
	});
});
