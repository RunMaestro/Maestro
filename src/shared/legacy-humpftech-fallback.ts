/**
 * legacy-humpftech-fallback.ts
 *
 * Single source of truth for the legacy HumpfTech/Maestro hardcoded fallback
 * values that are kept as defensive defaults across three subsystems
 * (GithubClient, DeliveryPlannerGithubSync, PmResolveGithubProject).
 *
 * Why these still exist:
 *   These fallbacks only activate when the `projectGithubMap` settings store
 *   is empty AND auto-discovery fails for a non-actionable reason (e.g. network
 *   error, not missing auth). They ensure the HumpfTech/Maestro fork continues
 *   to work out-of-the-box before a user runs /PM-init to persist a proper
 *   mapping. Auto-discovery should normally supply values from `projectGithubMap`;
 *   these literals are the last-resort guard, not the active code path.
 *
 * TODO: remove once auto-discovery is universal and every active install has a
 *   populated `projectGithubMap` entry. Track progress in #447.
 */

/** Legacy GitHub owner used as a defensive fallback for the HumpfTech/Maestro fork. */
export const LEGACY_HUMPFTECH_OWNER = 'HumpfTech' as const;

/** Legacy GitHub repository name used as a defensive fallback for the HumpfTech/Maestro fork. */
export const LEGACY_HUMPFTECH_REPO = 'Maestro' as const;

/** Convenience `owner/repo` slug for the legacy HumpfTech/Maestro fallback. */
export const LEGACY_HUMPFTECH_REPOSITORY =
	`${LEGACY_HUMPFTECH_OWNER}/${LEGACY_HUMPFTECH_REPO}` as const;

/** Legacy GitHub Projects v2 project number for the HumpfTech/Maestro fork. */
export const LEGACY_HUMPFTECH_PROJECT_NUMBER = 7 as const;

/** Legacy GitHub Projects v2 project title for the HumpfTech/Maestro fork. */
export const LEGACY_HUMPFTECH_PROJECT_TITLE = 'Humpf Tech Maestro Features' as const;
