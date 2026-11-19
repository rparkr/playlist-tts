import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchLlmModels, isVisionModel, visionLabel, type LlmModelInfo } from './llm';

describe('isVisionModel', () => {
	it('keeps known vision models and unverified models', () => {
		expect(isVisionModel({ id: 'a', vision: true })).toBe(true);
		expect(isVisionModel({ id: 'b', vision: null })).toBe(true);
		expect(isVisionModel({ id: 'c' })).toBe(true);
	});

	it('drops models the server says lack vision', () => {
		expect(isVisionModel({ id: 'd', vision: false })).toBe(false);
	});
});

describe('visionLabel', () => {
	it('describes reported and unknown capability', () => {
		expect(visionLabel({ id: 'a', vision: true })).toBe('vision');
		expect(visionLabel({ id: 'b', vision: false })).toBe('no vision');
		expect(visionLabel({ id: 'c', vision: null })).toBe('vision unverified');
	});
});

describe('fetchLlmModels', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('posts credentials and returns the model list', async () => {
		const body = {
			base_url: 'http://host/v1',
			models: [
				{ id: 'qwen-vl', vision: true },
				{ id: 'text-only', vision: false }
			] satisfies LlmModelInfo[]
		};
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(JSON.stringify(body), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			})
		);
		vi.stubGlobal('fetch', fetchMock);

		const result = await fetchLlmModels('', '  http://host/v1  ', '  secret  ');

		expect(result).toEqual(body);
		expect(fetchMock).toHaveBeenCalledWith(
			'/api/llm/models',
			expect.objectContaining({
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ base_url: 'http://host/v1', api_key: 'secret' })
			})
		);
	});

	it('surfaces the backend error detail', async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ detail: 'Authentication failed (401).' }), {
				status: 502,
				headers: { 'Content-Type': 'application/json' }
			})
		);
		vi.stubGlobal('fetch', fetchMock);

		await expect(fetchLlmModels('', null, null)).rejects.toThrow(
			'Authentication failed (401).'
		);
	});
});
