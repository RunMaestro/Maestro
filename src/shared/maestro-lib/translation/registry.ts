import { generateUUID } from '../../uuid';
import { canonicalJson } from '../../canonicalJson';
import { translationHash } from './identity';
import { translationVersionLimitation } from './support';
import { activeContextRecords } from './context-window';
import type {
	TranslationAdapter,
	TranslationIdentity,
	TranslationPlan,
	TranslationScope,
	PortableConversation,
	TranslationLimitation,
	TranslationDirection,
	TranslationArtifact,
} from './types';

export class TranslationRegistry {
	private readonly adapters = new Map<string, TranslationAdapter>();
	private readonly directions: TranslationDirection[] = [];
	register(adapter: TranslationAdapter): void {
		if (this.adapters.has(adapter.provider))
			throw new Error(`Translation adapter already registered: ${adapter.provider}`);
		this.adapters.set(adapter.provider, adapter);
	}
	get(provider: string): TranslationAdapter | undefined {
		return this.adapters.get(provider);
	}
	declareDirection(direction: TranslationDirection): void {
		if (
			direction.verification === 'verified' &&
			(!direction.evidence?.nativeResume ||
				!direction.evidence.roundTrip ||
				!direction.evidence.resources ||
				!direction.evidence.payloadClasses.length)
		)
			throw new Error(
				'Native translation certification requires resume, round-trip and resource evidence'
			);
		this.directions.push(direction);
	}
	direction(
		source: TranslationIdentity,
		destination: TranslationIdentity
	): TranslationDirection | undefined {
		for (const direction of this.directions) {
			if (direction.source !== source.provider || direction.destination !== destination.provider)
				continue;
			const limitations = [
				translationVersionLimitation(source.provider, source.version, {
					minVersion: direction.sourceMinVersion,
					testedVersions: direction.sourceTestedVersions,
				}),
				translationVersionLimitation(destination.provider, destination.version, {
					minVersion: direction.destinationMinVersion,
					testedVersions: direction.destinationTestedVersions,
				}),
			];
			if (limitations.some((limitation) => limitation?.severity === 'block')) continue;
			return limitations.some(Boolean) ? { ...direction, verification: 'unverified' } : direction;
		}
		return undefined;
	}
}

export function planTranslation(options: {
	agentId: string;
	tabId?: string;
	source: TranslationIdentity;
	destination: TranslationIdentity;
	scope: TranslationScope;
	conversations: PortableConversation[];
	registry: TranslationRegistry;
	busy?: boolean;
	limitations?: TranslationLimitation[];
	newRecords?: Record<string, number>;
	resources?: TranslationArtifact[];
}): TranslationPlan {
	const { source, destination, registry } = options;
	const conversations =
		options.tabId === undefined
			? options.conversations
			: options.conversations.filter((c) => c.tabId === options.tabId);
	if (options.tabId !== undefined && (!options.tabId || conversations.length !== 1))
		throw new Error('Single-tab translation requires exactly one matching conversation');
	const noop =
		source.provider === destination.provider && source.accountRoot === destination.accountRoot;
	const direction = registry.direction(source, destination);
	const payloadClasses = new Set<string>();
	for (const conversation of conversations) {
		for (const artifact of conversation.artifacts) payloadClasses.add(artifact.kind);
		for (const record of conversation.records) {
			if (record.role) payloadClasses.add('conversation');
			if (record.boundary) payloadClasses.add(record.boundary);
			if (record.branchId || (record.native as { isSidechain?: boolean } | undefined)?.isSidechain)
				payloadClasses.add('branch');
			for (const block of record.blocks) if (block.kind !== 'text') payloadClasses.add(block.kind);
		}
	}
	for (const resource of options.resources ?? []) payloadClasses.add(resource.kind);
	const limitations: TranslationLimitation[] = noop
		? []
		: [
				...(options.limitations ?? []).filter(
					(limitation) =>
						options.tabId === undefined ||
						limitation.tabId === undefined ||
						limitation.tabId === options.tabId
				),
				...conversations.flatMap((c) => c.limitations),
			];
	if (!noop) {
		if (destination.provider === 'codex')
			for (const conversation of conversations) {
				if (
					conversation.records.some(
						(record) =>
							record.role === 'assistant' &&
							record.blocks.some((block) => block.kind === 'attachment')
					)
				)
					limitations.push({
						code: 'assistant-attachment-projection',
						severity: 'warning',
						tabId: conversation.tabId,
						message:
							'Assistant image output is preserved in the archive but is not projected into Codex assistant Responses messages.',
					});
			}
		for (const identity of [source, destination]) {
			const adapter = registry.get(identity.provider);
			if (!adapter)
				limitations.push({
					code: 'unsupported-provider',
					severity: 'block',
					message: `No translation adapter for ${identity.provider}. Native resume support is separate.`,
				});
			else {
				const limitation = translationVersionLimitation(
					identity.provider,
					identity.version,
					adapter
				);
				if (limitation) limitations.push(limitation);
			}
		}
		if (direction) {
			for (const [identity, support] of [
				[
					source,
					{
						minVersion: direction.sourceMinVersion,
						testedVersions: direction.sourceTestedVersions,
					},
				],
				[
					destination,
					{
						minVersion: direction.destinationMinVersion,
						testedVersions: direction.destinationTestedVersions,
					},
				],
			] as const) {
				const limitation = translationVersionLimitation(
					identity.provider,
					identity.version,
					support
				);
				if (limitation) limitations.push(limitation);
			}
		}
		if (!direction)
			limitations.push({
				code: 'unsupported-direction',
				severity: 'block',
				message: 'This direction/version pair has no declared translation contract.',
			});
		if (direction?.verification === 'verified') {
			const uncovered = [...payloadClasses].filter(
				(kind) => !direction.evidence?.payloadClasses.includes(kind)
			);
			if (uncovered.length)
				limitations.push({
					code: 'uncertified-payload',
					severity: 'warning',
					message: `Native acceptance evidence does not cover selected payload classes: ${uncovered.join(', ')}.`,
				});
		}
		if (direction?.verification !== 'verified')
			limitations.push({
				code: 'unverified-native-resume',
				severity: 'warning',
				message: `${source.provider} -> ${destination.provider} native resume and repeated round-trip continuity have not been verified.`,
			});
	}
	const unique = [...new Map(limitations.map((l) => [canonicalJson(l), l])).values()];
	const artifacts = [...conversations.flatMap((c) => c.artifacts), ...(options.resources ?? [])];
	return {
		schemaVersion: 1,
		id: generateUUID(),
		agentId: options.agentId,
		...(options.tabId !== undefined && { tabId: options.tabId }),
		source,
		destination,
		scope: options.scope,
		status: noop
			? 'noop'
			: unique.some((l) => l.severity === 'block')
				? 'blocked'
				: options.busy
					? 'deferred'
					: 'ready',
		verification:
			direction?.verification === 'verified' && unique.length === 0 ? 'verified' : 'unverified',
		limitations: unique,
		tabs: conversations.map((c) => {
			const activeRecords = activeContextRecords(c.records).length;
			return {
				tabId: c.tabId,
				sourceSessionId: c.nativeSessionId,
				records: c.records.length,
				activeRecords,
				archivedRecords: c.records.length - activeRecords,
				newRecords: options.newRecords?.[c.tabId] ?? c.records.length,
			};
		}),
		counts: {
			messages: conversations.reduce(
				(n, c) =>
					n +
					c.records.filter(
						(record) =>
							(record.role === 'user' || record.role === 'assistant') &&
							record.blocks.some((block) => block.kind === 'text' || block.kind === 'attachment')
					).length,
				0
			),
			records: conversations.reduce((n, c) => n + c.records.length, 0),
			artifacts: artifacts.length,
			bytes: artifacts.reduce((n, a) => n + Buffer.from(a.bytesBase64, 'base64').length, 0),
		},
		fingerprint: translationHash(
			canonicalJson({
				source,
				destination,
				tabId: options.tabId,
				scope: options.scope,
				conversations,
				resources: options.resources ?? [],
				limitations: unique,
			})
		),
	};
}

/** The same planner and acceptance gates, scoped to one native conversation. */
export function planTabTranslation(
	options: Parameters<typeof planTranslation>[0] & { tabId: string }
): TranslationPlan {
	return planTranslation(options);
}
