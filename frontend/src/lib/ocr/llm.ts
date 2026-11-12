/** Client helpers for the LLM OCR settings API.
 *
 * All requests go through our backend, which proxies the OpenAI-compatible
 * server. That keeps API keys out of browser CORS preflights and lets the
 * backend resolve environment defaults when the UI leaves fields blank.
 */

import type { LlmOcrPayload } from '$lib/settings';

export interface LlmModelInfo {
	id: string;
	name?: string | null;
	/** True/False when the server reports vision support; null when unknown. */
	vision?: boolean | null;
}

export interface LlmModelsResponse {
	/** Base URL the backend actually queried (useful when the UI used defaults). */
	base_url: string;
	models: LlmModelInfo[];
}

export interface LlmOcrDefaults {
	base_url: string;
	model: string;
	system_message: string;
	user_message: string;
	concurrency: number;
	enable_thinking: boolean;
}

export interface LlmTestResponse {
	ok: boolean;
	model: string;
	latency_ms: number;
}

/** Parse a FastAPI error response into a readable message. */
async function parseError(resp: Response): Promise<string> {
	const text = await resp.text();
	try {
		const data = JSON.parse(text);
		if (typeof data?.detail === 'string') return data.detail;
		if (Array.isArray(data?.detail)) {
			return data.detail.map((d: any) => d.msg ?? JSON.stringify(d)).join('; ');
		}
	} catch {
		// fall through to the raw body
	}
	return text || `HTTP ${resp.status}`;
}

/** Show models that are not known to lack vision; unknown models stay visible. */
export function isVisionModel(model: LlmModelInfo): boolean {
	return model.vision !== false;
}

/** Human-readable badge text for a model's reported vision capability. */
export function visionLabel(model: LlmModelInfo): string {
	if (model.vision === true) return 'vision';
	if (model.vision === false) return 'no vision';
	return 'vision unverified';
}

/** Fetch server-side defaults for the settings modal. */
export async function fetchLlmDefaults(apiBase: string): Promise<LlmOcrDefaults> {
	const resp = await fetch(`${apiBase}/api/ocr/llm/options`);
	if (!resp.ok) throw new Error(await parseError(resp));
	return resp.json();
}

/** Query the configured OpenAI-compatible server for its model list. */
export async function fetchLlmModels(
	apiBase: string,
	baseUrl: string | null,
	apiKey: string | null
): Promise<LlmModelsResponse> {
	const body: Record<string, string> = {};
	if (baseUrl?.trim()) body.base_url = baseUrl.trim();
	if (apiKey?.trim()) body.api_key = apiKey.trim();
	const resp = await fetch(`${apiBase}/api/ocr/llm/models`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body)
	});
	if (!resp.ok) throw new Error(await parseError(resp));
	return resp.json();
}

/** Probe the configured model with a tiny image to verify vision support. */
export async function testLlmConnection(
	apiBase: string,
	payload: LlmOcrPayload
): Promise<LlmTestResponse> {
	const resp = await fetch(`${apiBase}/api/ocr/llm/test`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(payload)
	});
	if (!resp.ok) throw new Error(await parseError(resp));
	return resp.json();
}
