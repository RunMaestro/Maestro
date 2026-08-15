/**
 * A Cappella provider registry - the one place that decides which trio a
 * session runs on.
 *
 * This is the ONLY module allowed to import a concrete provider. The session
 * service takes the trio at construction, so if resolution lived anywhere else
 * the "never silently substitute a cloud provider for a missing local one" rule
 * would be decided by an import rather than by a policy.
 *
 * The rule in full: when a configured provider is missing, unknown, or
 * unavailable, the fallback is ALWAYS the mock for that role. Never another
 * registered provider, never a different tier, and never quietly: every
 * substitution is returned to the caller and logged, so Voice Setup can say
 * "Whisper is not installed, you are on the mock" instead of shipping the
 * user's microphone to a cloud they did not pick.
 */

import type {
	BrainProvider,
	SttProvider,
	TtsProvider,
	VoiceProviderRole,
	VoiceProviderSubstitution,
	VoiceProviderSubstitutionReason,
	VoiceProviderTier,
	VoiceProviderTrio,
} from '../../../shared/acappella/providers';
import { logger } from '../../utils/logger';
import { MockBrainProvider, MockSttProvider, MockTtsProvider } from './mock';
import type { MockProviderOptions } from './mock';

const LOG_CONTEXT = 'ACappella';

/** Settings key holding everything A Cappella persists. */
export const ACAPPELLA_SETTINGS_KEY = 'acappella';

// Re-exported so existing importers keep their one import site. The shapes
// themselves live in shared/ because they travel to the renderer and, later, to
// the phone.
export type { VoiceProviderRole, VoiceProviderSubstitution, VoiceProviderSubstitutionReason };

/** The provider type each role resolves to. */
interface VoiceProviderByRole {
	stt: SttProvider;
	tts: TtsProvider;
	brain: BrainProvider;
}

/** What the user picked in Voice Setup. Absent means "whatever is default". */
export interface VoiceProviderSettings {
	stt?: string;
	tts?: string;
	brain?: string;
}

export interface VoiceProviderRegistration<R extends VoiceProviderRole = VoiceProviderRole> {
	role: R;
	/** Stable id, the same one that travels in `listen-start` / `speak-start`. */
	id: string;
	label: string;
	tier: VoiceProviderTier;
	/**
	 * False when the provider is registered but cannot run right now (model file
	 * missing, no API key). Checked at resolve time so an install that vanished
	 * downgrades to the mock instead of throwing mid-session.
	 */
	isAvailable?: () => boolean;
	create: () => VoiceProviderByRole[R];
}

export interface VoiceProviderResolution {
	providers: VoiceProviderTrio;
	/** Empty on the happy path. Anything here belongs in front of the user. */
	substitutions: VoiceProviderSubstitution[];
	/** What each role actually resolved to, for the HUD and for `get-state`. */
	resolvedIds: Record<VoiceProviderRole, string>;
}

/** The fallback for each role. Registered below and never removed. */
export const MOCK_PROVIDER_IDS: Record<VoiceProviderRole, string> = {
	stt: 'mock-stt',
	tts: 'mock-tts',
	brain: 'mock-brain',
};

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

const catalog: { [R in VoiceProviderRole]: Map<string, VoiceProviderRegistration<R>> } = {
	stt: new Map(),
	tts: new Map(),
	brain: new Map(),
};

/**
 * Add a provider to the catalog. Phases 05 and 07 call this at startup so real
 * providers become selectable without this file learning about them.
 */
export function registerVoiceProvider<R extends VoiceProviderRole>(
	registration: VoiceProviderRegistration<R>
): void {
	catalog[registration.role].set(registration.id, registration);
}

/** Everything selectable for a role, for Voice Setup to list. */
export function listVoiceProviders(
	role: VoiceProviderRole
): Array<Pick<VoiceProviderRegistration, 'id' | 'label' | 'tier'> & { available: boolean }> {
	return [...catalog[role].values()].map((entry) => ({
		id: entry.id,
		label: entry.label,
		tier: entry.tier,
		available: entry.isAvailable?.() ?? true,
	}));
}

registerVoiceProvider({
	role: 'stt',
	id: MOCK_PROVIDER_IDS.stt,
	label: 'Mock (typed input)',
	tier: 'mock',
	create: () => new MockSttProvider(),
});

registerVoiceProvider({
	role: 'tts',
	id: MOCK_PROVIDER_IDS.tts,
	label: 'Mock (silent)',
	tier: 'mock',
	create: () => new MockTtsProvider(),
});

registerVoiceProvider({
	role: 'brain',
	id: MOCK_PROVIDER_IDS.brain,
	label: 'Mock (keyword routing)',
	tier: 'mock',
	create: () => new MockBrainProvider(),
});

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export interface ResolveVoiceProvidersOptions {
	/** Provider ids from settings. Omitted roles take the mock. */
	settings?: VoiceProviderSettings;
	/** Timing overrides for the mock tier, so tests can run without timers. */
	mock?: MockProviderOptions;
}

/**
 * Build the trio a session will run on, plus the list of substitutions the user
 * needs to be told about.
 */
export function resolveVoiceProviders(
	options: ResolveVoiceProvidersOptions = {}
): VoiceProviderResolution {
	const settings = options.settings ?? {};
	const substitutions: VoiceProviderSubstitution[] = [];

	const stt = resolveRole(
		'stt',
		settings.stt,
		substitutions,
		() => new MockSttProvider(options.mock?.stt)
	);
	const tts = resolveRole(
		'tts',
		settings.tts,
		substitutions,
		() => new MockTtsProvider(options.mock?.tts)
	);
	const brain = resolveRole('brain', settings.brain, substitutions, () => new MockBrainProvider());

	return {
		providers: { stt: stt.provider, tts: tts.provider, brain: brain.provider },
		substitutions,
		resolvedIds: { stt: stt.id, tts: tts.id, brain: brain.id },
	};
}

/** Read the persisted provider selection. Anything malformed reads as unset. */
export function readVoiceProviderSettings(store: {
	get: (key: string, defaultValue: unknown) => unknown;
}): VoiceProviderSettings {
	const stored = store.get(ACAPPELLA_SETTINGS_KEY, {}) as { providers?: unknown } | undefined;
	const providers = (stored?.providers ?? {}) as Record<string, unknown>;

	return {
		stt: asProviderId(providers.stt),
		tts: asProviderId(providers.tts),
		brain: asProviderId(providers.brain),
	};
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function resolveRole<R extends VoiceProviderRole>(
	role: R,
	requestedId: string | undefined,
	substitutions: VoiceProviderSubstitution[],
	createMock: () => VoiceProviderByRole[R]
): { id: string; provider: VoiceProviderByRole[R] } {
	const mockId = MOCK_PROVIDER_IDS[role];

	// No selection is the documented default, not a substitution: A Cappella
	// ships on the mock tier until the user picks something in Voice Setup.
	if (!requestedId || requestedId === mockId) {
		return { id: mockId, provider: createMock() };
	}

	const entries = catalog[role];
	const registration = entries.get(requestedId);

	if (!registration) {
		return {
			id: mockId,
			provider: substituteMock(role, requestedId, 'unknown-provider', substitutions, createMock),
		};
	}

	if (registration.isAvailable && !registration.isAvailable()) {
		return {
			id: mockId,
			provider: substituteMock(role, requestedId, 'unavailable', substitutions, createMock),
		};
	}

	return { id: registration.id, provider: registration.create() };
}

/**
 * The fallback path. It takes `createMock` rather than looking the replacement
 * up by tier on purpose: there is no search here that could ever land on a
 * cloud provider.
 */
function substituteMock<R extends VoiceProviderRole>(
	role: R,
	requestedId: string,
	reason: VoiceProviderSubstitutionReason,
	substitutions: VoiceProviderSubstitution[],
	createMock: () => VoiceProviderByRole[R]
): VoiceProviderByRole[R] {
	const resolvedId = MOCK_PROVIDER_IDS[role];
	const message =
		reason === 'unknown-provider'
			? `Voice provider '${requestedId}' is not registered; using '${resolvedId}'`
			: `Voice provider '${requestedId}' is not available; using '${resolvedId}'`;

	logger.warn(message, LOG_CONTEXT);
	substitutions.push({ role, requestedId, resolvedId, reason, message });

	return createMock();
}

function asProviderId(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
