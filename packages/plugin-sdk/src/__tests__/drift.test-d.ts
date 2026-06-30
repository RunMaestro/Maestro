/**
 * Compile-time drift guard for the vendored contribution SHAPES.
 *
 * The runtime guard (drift.test.ts) compares vocabularies and catalogs
 * (capabilities, tiers, topics, methods, surfaces) but cannot see a new or
 * changed FIELD on a contribution interface. These type-level assertions fail
 * `tsc` the moment a vendored shape falls behind its host source — e.g. a new
 * field on `UiItemContribution` or a new contribution array on
 * `PluginContributions` / `AggregatedContributions` that wasn't vendored.
 *
 * Run via vitest typecheck (see vitest.config.ts `typecheck`), which compiles
 * this file with tsconfig.test.json so it may reach into ../../../../src.
 */

import { expectTypeOf } from 'vitest';
import type {
	UiItemContribution,
	PluginContributions,
	AggregatedContributions,
	PluginEventPayloads,
} from '../index';
import type {
	UiItemContribution as SrcUiItemContribution,
	PluginContributions as SrcPluginContributions,
	AggregatedContributions as SrcAggregatedContributions,
} from '../../../../src/shared/plugins/contributions';
import type { PluginEventPayloads as SrcPluginEventPayloads } from '../../../../src/shared/plugins/events';

expectTypeOf<UiItemContribution>().toEqualTypeOf<SrcUiItemContribution>();
expectTypeOf<PluginContributions>().toEqualTypeOf<SrcPluginContributions>();
expectTypeOf<AggregatedContributions>().toEqualTypeOf<SrcAggregatedContributions>();
expectTypeOf<PluginEventPayloads>().toEqualTypeOf<SrcPluginEventPayloads>();
