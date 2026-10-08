/**
 * Isolated plugin-consent preload (host-owned).
 *
 * This is the dedicated, non-extensible consent surface required by the plugin
 * authorization gate. A separate consent BrowserWindow loads its own minimal
 * page (src/main/consent/consent.html) with THIS preload only -- never the main
 * Maestro SPA and never the main preload (dist/main/preload.js). A malicious
 * plugin must never be able to reach or spoof this window, so the only thing
 * exposed on `window` is a single `pluginConsent` bridge: the decoded offer plus
 * confirm/cancel calls. Nothing else is exposed.
 *
 * The offer is delivered out-of-band through the window's additionalArguments
 * (`--consent-offer=<base64-encoded JSON>`), read here from `process.argv`
 * (available in a sandboxed preload via Electron's process shim). If the arg is
 * missing or unparseable we expose `offer: null` and no-op confirm/cancel.
 *
 * Self-contained on purpose: it imports nothing outside `electron`.
 */

import { contextBridge, ipcRenderer } from 'electron';

/** A single capability the plugin is requesting, as shown to the user. */
interface ConsentOfferItem {
	capability: string;
	risk: 'low' | 'medium' | 'high';
	scope?: string;
	reason?: string;
	description: string;
	/** Phase-4 act verb: rendered in the separate high-risk section, unchecked
	 * by default, approved only via the distinct `approvedHighRisk` channel. */
	actVerb?: boolean;
	/** Act verbs only: wording of the nested unattended consent line. */
	unattended?: string;
}

/** The decoded consent offer handed to the consent window. */
interface ConsentOffer {
	pluginId: string;
	pluginName: string;
	nonce: string;
	offered: ConsentOfferItem[];
	/** Full-trust banner for a code plugin (tier >= 1 with an entry file). */
	codeBanner?: string;
}

/** The single bridge exposed to the consent page via contextBridge. */
interface PluginConsentBridge {
	offer: ConsentOffer | null;
	/**
	 * Confirm the user's choice. Three DISTINCT channels, so a high-risk act
	 * verb can never ride the plain approval click (the minter REJECTS act
	 * verbs arriving in `approved`):
	 *  - `approved`: the plain (non-act-verb) capabilities the user checked;
	 *  - `approvedHighRisk`: the act verbs the user separately checked in the
	 *    high-risk section (unchecked by default);
	 *  - `unattended`: the subset of `approvedHighRisk` whose NESTED
	 *    unattended (no-user-present) checkbox the user also checked.
	 */
	confirm(
		approved: string[],
		approvedHighRisk: string[],
		unattended: string[]
	): Promise<{ ok: boolean }>;
	cancel(): Promise<void>;
}

const CONSENT_OFFER_PREFIX = '--consent-offer=';

/** Parse the base64-encoded ConsentOffer from process.argv, or null on any failure. */
function readOffer(): ConsentOffer | null {
	try {
		const arg = process.argv.find((value) => value.startsWith(CONSENT_OFFER_PREFIX));
		if (!arg) return null;
		const b64 = arg.slice(CONSENT_OFFER_PREFIX.length);
		const json = Buffer.from(b64, 'base64').toString('utf-8');
		return JSON.parse(json) as ConsentOffer;
	} catch {
		return null;
	}
}

const offer = readOffer();

const bridge: PluginConsentBridge = offer
	? {
			offer,
			confirm: (approved: string[], approvedHighRisk: string[], unattended: string[]) =>
				ipcRenderer.invoke('plugins:confirm-consent', {
					pluginId: offer.pluginId,
					nonce: offer.nonce,
					approved,
					approvedHighRisk,
					unattended,
				}),
			cancel: () => ipcRenderer.invoke('plugins:cancel-consent'),
		}
	: {
			// Defensive no-op surface when there is no decodable offer: a malicious
			// or empty load cannot mint anything, and the page degrades gracefully.
			offer: null,
			confirm: async () => ({ ok: false }),
			cancel: async () => {},
		};

contextBridge.exposeInMainWorld('pluginConsent', bridge);
