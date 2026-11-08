/** Identify which runtime a `.safetensors` voice file belongs to.
 *
 * Pocket and Phonon both use safetensors, but their layouts are unrelated:
 * Pocket stores a full transformer KV-cache state (`module/tensor` keys),
 * while Phonon stores a precomputed speaker embedding (`speaker_wavs` or
 * `emb`). Checking the small JSON header before saving gives the user an
 * immediate, actionable error instead of a failed synthesis later.
 */

export type VoiceFileFormat = 'pocket' | 'phonon' | 'unknown';

export interface VoiceFileInfo {
	format: VoiceFileFormat;
	keys: string[];
}

/** Refuse absurd header lengths before allocating a buffer. */
const MAX_HEADER_BYTES = 32 * 1024 * 1024;

function headerKeys(header: Record<string, unknown>): string[] {
	return Object.keys(header).filter((key) => key !== '__metadata__');
}

/** Parse a safetensors header and classify the voice file. */
export async function inspectVoiceFile(blob: Blob): Promise<VoiceFileInfo> {
	if (blob.size < 8) return { format: 'unknown', keys: [] };

	let headerLength: bigint;
	try {
		const prefix = new DataView(await blob.slice(0, 8).arrayBuffer());
		headerLength = prefix.getBigUint64(0, true);
	} catch {
		return { format: 'unknown', keys: [] };
	}
	if (
		headerLength <= 0n ||
		headerLength > BigInt(MAX_HEADER_BYTES) ||
		Number(headerLength) + 8 > blob.size
	) {
		return { format: 'unknown', keys: [] };
	}

	let header: Record<string, unknown>;
	try {
		const raw = await blob.slice(8, 8 + Number(headerLength)).arrayBuffer();
		header = JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>;
	} catch {
		return { format: 'unknown', keys: [] };
	}

	const keys = headerKeys(header);
	const isPhonon =
		'speaker_wavs' in header ||
		'emb' in header ||
		keys.some((key) => key.startsWith('embeddings_v2/'));
	const isPocket = keys.some(
		(key) => key.endsWith('/cache') || key.endsWith('/offset') || key.includes('/self_attn/')
	);

	if (isPhonon && !isPocket) return { format: 'phonon', keys };
	if (isPocket && !isPhonon) return { format: 'pocket', keys };
	return { format: 'unknown', keys };
}
