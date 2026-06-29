/**
 * ChartTooltip - re-export shim.
 *
 * The implementation now lives in the shared widget library at
 * `components/widgets/output/ChartTooltip`. This shim preserves the historical
 * `UsageDashboard/ChartTooltip` import path so existing chart call sites keep
 * resolving while the dependency direction is inverted (Usage Dashboard depends
 * on the library, not the reverse). Prefer importing from `components/widgets`
 * directly in new code.
 */

export { ChartTooltip, default } from '../widgets/output/ChartTooltip';
