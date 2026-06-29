/**
 * Sparkline - re-export shim.
 *
 * The implementation now lives in the shared widget library at
 * `components/widgets/output/Sparkline`. This shim preserves the historical
 * `UsageDashboard/Sparkline` import path so existing call sites keep resolving
 * while the dependency direction is inverted (Usage Dashboard depends on the
 * library, not the reverse). Prefer importing from `components/widgets` directly
 * in new code.
 */

export { Sparkline, default } from '../widgets/output/Sparkline';
