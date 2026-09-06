/** Backend pocket-tts streaming via MediaSource / Audio element */

export async function fetchTTSWavStream(
	text: string,
	voiceId: string | null,
	voiceBlob: Blob | null
): Promise<{ blob: Blob; url: string }> {
	const apiBase = import.meta.env.PUBLIC_API_URL ?? '';
	const url = `${apiBase}/api/tts/stream`;
	const form = new FormData();
	form.append('text', text);
	if (voiceId && !voiceBlob) {
		// builtin voice name
		form.append('voice_url', voiceId);
	}
	if (voiceBlob) {
		form.append('voice_safetensors', voiceBlob, 'voice.safetensors');
	}

	const resp = await fetch(url, { method: 'POST', body: form });
	if (!resp.ok) {
		const txt = await resp.text();
		throw new Error(`TTS stream failed ${resp.status}: ${txt}`);
	}
	const blob = await resp.blob();
	const objectUrl = URL.createObjectURL(blob);
	return { blob, url: objectUrl };
}

export async function pollTTSJob(jobId: string): Promise<{ status: string; progress: { done: number; total: number }; output?: string; error?: string }> {
	const apiBase = import.meta.env.PUBLIC_API_URL ?? '';
	const resp = await fetch(`${apiBase}/api/tts/jobs/${jobId}`);
	if (!resp.ok) throw new Error(`Job poll failed ${resp.status}`);
	return resp.json();
}

export async function createTTSFileJob(text: string, voiceId: string | null, voiceBlob: Blob | null, fmt: string = 'wav'): Promise<string> {
	const apiBase = import.meta.env.PUBLIC_API_URL ?? '';
	const form = new FormData();
	form.append('text', text);
	if (voiceId && !voiceBlob) form.append('voice_url', voiceId);
	if (voiceBlob) form.append('voice_safetensors', voiceBlob, 'voice.safetensors');
	form.append('fmt', fmt);
	const resp = await fetch(`${apiBase}/api/tts/jobs`, { method: 'POST', body: form });
	if (!resp.ok) throw new Error(`TTS job create failed ${resp.status}: ${await resp.text()}`);
	const data = await resp.json();
	return data.job_id;
}

export function getTTSDownloadUrl(jobId: string): string {
	const apiBase = import.meta.env.PUBLIC_API_URL ?? '';
	return `${apiBase}/api/tts/jobs/${jobId}/download`;
}
