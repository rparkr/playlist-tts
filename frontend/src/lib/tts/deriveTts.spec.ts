import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getGlobalSentences, parseMarkdownStructure } from '../markdown/parse';
import {
	chunkForSentence,
	deriveTts,
	extractCodeComments,
	resolveCodeLanguage,
	speakable,
	splitLongSentence,
	tableToRowRecords
} from './deriveTts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

function article(name: string): string {
	return readFileSync(join(repoRoot, 'test-articles', name), 'utf-8');
}

const ARTICLES = [
	'Accelerating vision-language models with LFM2.5-VL-DSpark.md',
	'attention-for-llms.md',
	'gemma-4-technical-report.md',
	'Multimodal open d1 decision models for the edge.md',
	'NVIDIA Kumo Tabular Sets a New Accuracy-Efficiency Frontier for Tabular Prediction.md',
	'Open TTS Leaderboard_ Scalable Evaluation for Multilingual Text-to-Speech and Voice Cloning.md',
	'tokenizers v1_ encode, decode and scaling, measured.md',
	'Transformers now runs llama.cpp quants.md'
];

describe('speakable', () => {
	it('trims URLs to the domain only', () => {
		expect(speakable('See https://huggingface.co/blog/post?x=1 for details.')).toBe(
			'See huggingface.co for details.'
		);
		expect(speakable('On www.example.com/a/b it says hi.')).toBe('On example.com it says hi.');
	});

	it('normalizes curly punctuation and dashes', () => {
		expect(speakable('“Hello” — it’s here…')).toBe('"Hello" , it\'s here...');
	});
});

describe('splitLongSentence', () => {
	it('passes short text through untouched', () => {
		expect(splitLongSentence('Short and sweet.')).toEqual(['Short and sweet.']);
	});

	it('splits long sentences under the cap without losing words', () => {
		const long =
			'The model achieves state of the art results on every benchmark in the suite, ' +
			'including long context reasoning over documents with hundreds of pages; ' +
			'the authors attribute this to a new attention kernel with linear memory scaling.';
		const parts = splitLongSentence(long);
		expect(parts.length).toBeGreaterThan(1);
		for (const p of parts) expect(p.length).toBeLessThanOrEqual(220);
		expect(parts.join(' ').replace(/,\s*/g, ' ').replace(/\s+/g, ' ').trim().length).toBeGreaterThan(
			long.length - 10
		);
	});

	it('hard-splits when no natural break exists', () => {
		const run = 'word '.repeat(100).trim();
		const parts = splitLongSentence(run);
		expect(parts.length).toBeGreaterThan(1);
		for (const p of parts) expect(p.length).toBeLessThanOrEqual(220);
	});
});

describe('extractCodeComments', () => {
	it('keeps Python and JS comments, drops code', () => {
		const raw = '```python\n# Load the model here\nmodel = load("x")\n# Run inference\n```';
		expect(extractCodeComments(raw)).toEqual(['Load the model here', 'Run inference']);
		const js = '```js\n// retry with backoff\nawait fetch(url);\n```';
		expect(extractCodeComments(raw + '\n' + js)).toContain('retry with backoff');
	});

	it('skips fences, shebangs, and comment-free blocks', () => {
		expect(extractCodeComments('```python\nx = 1\ny = 2\n```')).toEqual([]);
		expect(extractCodeComments('#!/usr/bin/env python\nx = 1')).toEqual([]);
	});

	it('captures trailing and block comments', () => {
		const raw = '```js\nconst x = 1; // set the default\n/* multi\nline note */\nfoo();\n```';
		expect(extractCodeComments(raw)).toEqual(['set the default', 'multi', 'line note']);
	});

	it('ignores markers inside strings and non-comment uses', () => {
		const py = '```python\nurl = "http://example.com/x#frag"\nx = 1\n```';
		expect(extractCodeComments(py)).toEqual([]);
		// `#` starts a private field in JS, not a comment.
		const js = '```js\nclass A {\n#count = 0;\n}\n```';
		expect(extractCodeComments(js)).toEqual([]);
	});

	it('skips decorative rules and resolves shebangs', () => {
		expect(extractCodeComments('```js\n// ======\n// real note\n```')).toEqual(['real note']);
		expect(extractCodeComments('#!/bin/bash\n# deploy here\necho hi')).toEqual(['deploy here']);
	});

	it('detects unlabeled code and stays silent on unknown languages', () => {
		expect(extractCodeComments('# Load weights\nmodel = load(path)\nprint(done)')).toEqual([
			'Load weights'
		]);
		expect(extractCodeComments('```foobar\n# not a comment here\n```')).toEqual([]);
		expect(extractCodeComments('Just some prose, no code at all.')).toEqual([]);
	});

	it('resolves languages from info strings, shebangs, and detection', () => {
		expect(resolveCodeLanguage('```py\nx = 1\n```')).toBe('py');
		expect(resolveCodeLanguage('#!/usr/bin/env node\nconsole.log(1)')).toBe('javascript');
		expect(
			resolveCodeLanguage(
				'import os\nfrom pathlib import Path\n\n\ndef load(path):\n    # read it\n    return Path(path).read_text()'
			)
		).toBe('python');
		expect(resolveCodeLanguage('Just some prose, no code at all.')).toBeNull();
	});
});

describe('tableToRowRecords', () => {
	it('verbalizes one record per row with repeated headers', () => {
		const raw = '| Model | Accuracy |\n| --- | --- |\n| Kumo | 91% |\n| Small | 88% |';
		expect(tableToRowRecords(raw)).toEqual([
			'Row 1 of 2: Model: Kumo, Accuracy: 91%',
			'Row 2 of 2: Model: Small, Accuracy: 88%'
		]);
	});

	it('returns empty for header-only or separator-only tables', () => {
		expect(tableToRowRecords('| A | B |\n| --- | --- |')).toEqual([]);
	});
});

describe('deriveTts', () => {
	it('keeps list items whole as single chunks', () => {
		const sections = parseMarkdownStructure('- First item here. It continues.\n- Second item here.');
		const d = deriveTts(sections);
		expect(d.texts).toEqual(['First item here. It continues.', 'Second item here.']);
		expect(d.chunks[0].sentenceIndices).toEqual([0, 1]);
	});

	it('speaks code comments only and maps tables to row records', () => {
		const md = [
			'# Title here.',
			'',
			'```python',
			'# Load weights first',
			'model = load()',
			'```',
			'',
			'| Name | Score |',
			'| --- | --- |',
			'| Ada | 10 |',
			'',
			'Visit https://example.com/docs/page for more.'
		].join('\n');
		const d = deriveTts(sectionsOf(md));
		expect(d.texts).toContain('Load weights first');
		expect(d.texts.some((t) => t.includes('|'))).toBe(false);
		expect(d.texts).toContain('Row 1 of 1: Name: Ada, Score: 10');
		expect(d.texts).toContain('Visit example.com for more.');
		expect(d.texts.some((t) => t.includes('https://'))).toBe(false);
	});

	it('splits long sentences and maps every piece back to its sentence', () => {
		const long =
			'This is a very long observation about model behavior under distribution shift, ' +
			'covering calibration across dozens of evaluation suites with thousands of prompts; ' +
			'the headline finding is that scale keeps helping far past earlier predictions.';
		const sections = parseMarkdownStructure(`Intro line here.\n\n${long}\n\nFinal line here.`);
		const d = deriveTts(sections);
		const total = getGlobalSentences(sections).length;
		expect(total).toBe(3);
		expect(d.sentenceToChunk).toHaveLength(total);
		// The long middle sentence splits into several chunks, all mapped back.
		const middle = d.chunks.filter((c) => c.sentenceIndices.includes(1));
		expect(middle.length).toBeGreaterThan(1);
		for (const g of [0, 1, 2]) {
			const c = chunkForSentence(d, g);
			expect(d.chunks[c].sentenceIndices).toContain(g);
		}
		for (const t of d.texts) expect(t.length).toBeLessThanOrEqual(220);
	});

	it('covers every sentence on all article fixtures with clean chunks', () => {
		for (const name of ARTICLES) {
			const sections = parseMarkdownStructure(article(name));
			const total = getGlobalSentences(sections).length;
			expect(total).toBeGreaterThan(0);
			const d = deriveTts(sections);
			expect(d.texts.length).toBeGreaterThan(0);
			expect(d.sentenceToChunk).toHaveLength(total);
			for (const t of d.texts) {
				expect(t.trim().length).toBeGreaterThan(0);
				expect(t).not.toContain('|');
				expect(t).not.toMatch(/https?:\/\//);
			}
			for (const g of [0, Math.floor(total / 2), total - 1]) {
				const c = chunkForSentence(d, g);
				expect(c).toBeGreaterThanOrEqual(0);
				expect(c).toBeLessThan(d.chunks.length);
			}
		}
	});

	it('derives the full book inside the 3s perf gate', () => {
		const md = readFileSync(join(repoRoot, 'test-pdfs', 'engineering-full-book.md'), 'utf-8');
		const t0 = performance.now();
		const sections = parseMarkdownStructure(md);
		const t1 = performance.now();
		const d = deriveTts(sections);
		const t2 = performance.now();
		expect(getGlobalSentences(sections).length).toBeGreaterThan(3000);
		expect(d.texts.length).toBeGreaterThan(0);
		expect(t2 - t0).toBeLessThan(3000);
		// eslint-disable-next-line no-console
		console.log(
			`derive perf: parse ${(t1 - t0).toFixed(0)}ms + derive ${(t2 - t1).toFixed(0)}ms, ` +
				`${d.texts.length} chunks`
		);
	});
});

function sectionsOf(md: string): ReturnType<typeof parseMarkdownStructure> {
	return parseMarkdownStructure(md);
}
