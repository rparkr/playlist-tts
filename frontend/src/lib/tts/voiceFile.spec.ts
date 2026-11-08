import { describe, expect, it } from 'vitest';
import { inspectVoiceFile } from './voiceFile';

/** Build a minimal safetensors blob with the given JSON header. */
function safetensors(header: Record<string, unknown>): Blob {
	const encoded = new TextEncoder().encode(JSON.stringify(header));
	const prefix = new Uint8Array(8);
	new DataView(prefix.buffer).setBigUint64(0, BigInt(encoded.length), true);
	return new Blob([prefix, encoded]);
}

describe('inspectVoiceFile', () => {
	it('recognizes a Phonon speaker embedding', async () => {
		const info = await inspectVoiceFile(
			safetensors({ speaker_wavs: { dtype: 'F32', shape: [1, 512, 125] } })
		);
		expect(info.format).toBe('phonon');
	});

	it('recognizes a Phonon embedding tensor', async () => {
		const info = await inspectVoiceFile(safetensors({ emb: { dtype: 'F32', shape: [1, 512] } }));
		expect(info.format).toBe('phonon');
	});

	it('recognizes a Pocket KV-cache voice', async () => {
		const info = await inspectVoiceFile(
			safetensors({
				'transformer.layers.0.self_attn/cache': { dtype: 'F32', shape: [2, 1, 126, 16, 64] },
				'transformer.layers.0.self_attn/offset': { dtype: 'I64', shape: [1] }
			})
		);
		expect(info.format).toBe('pocket');
	});

	it('returns unknown for unrelated or malformed files', async () => {
		expect((await inspectVoiceFile(safetensors({ other: {} }))).format).toBe('unknown');
		expect((await inspectVoiceFile(new Blob([new Uint8Array(2)]))).format).toBe('unknown');
	});
});
