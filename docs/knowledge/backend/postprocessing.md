---
type: system-component
title: Post-Processing Pipeline
description: Composable Markdown post-processing for TTS readiness including reflow, uppercase, item-line separation, and page markers.
resource: backend/app/services/postprocess.py
tags: [backend, postprocessing, tts, markdown]
generated:
  by: muse-spark-1.2-contributor-free
  at: 2026-08-31T07:58:30Z
---

# Post-Processing Pipeline

Composable pure functions `postprocess(markdown, opts: PostprocessOptions) → {markdown, sections, pageMap}`.

## 1. `reflow_columns(text) -> str`

Goal: fix column/page sentence splits noted in `fixes-for-tts-from-line-length.txt`.

- Split on `\n\n` preserving fences/tables (`^#{1,6}\s`, `^[-*+]\s`, `^``` `) verbatim.
- For para `p` without terminal punct `!?.` **or closing quote** `r'[.!?]["\')\]]?\s*$'`: sentence continuing if `next` starts lowercase and not header/list → `merged = p.rstrip() + " " + next.lstrip()` then re-split `r'(?<=[.!?]["\']?)\s+'` and push remainder as new para start.
- Quote-aware: `'Here: "end."' ` matches terminal `."` → **do not merge**.
- Page markers inserted *after* sentence boundary: accumulator holds `Page N.` token until `is_terminal` true, then emit marker paragraph. Updates `pageMap` offsets accordingly.

## 2. `normalize_uppercase(text, mode) -> str`

- `mode off` → noop.
- `title` → consecutive `r'\b[A-Z]{2,}\b'` sequences (≥2 words) → `titlecase`; preserve acronyms ≤5 chars.
- `lower_long` → single words `>5` chars all-upper → `lower`.

## 3. `is_bare_item_line(line) -> bool`

Short (≤60 chars) unterminated lines that are not structural (headings, lists,
tables, quotes) and do not end on a continuation mark or wrap word read as one
item of an unmarked list (bare pypdf table rows, title stacks). Reflow never
merges these into digit/paren-led next lines, and the frontend block splitter
emits one paragraph block per line, so items never collapse into one TTS chunk.
Retired: `ensure_punctuation` (headers-only, made redundant by per-paragraph
TTS derivation) was removed in Phase 1.

## 4. `insert_page_markers(markdown, pageMap) -> str`

Prepend `Page N.` standalone para at page boundaries per `pageMap` offsets when `insert_page_markers: true` (for follow-along readers).

## 5. Tokenizer-Aware Chunking (for TTS)

Not `max_chars 1000` (`src/tts/__init__.py:41`) which overruns `MAX_TOKEN_PER_CHUNK=50` (`pocket-tts/default_parameters.py:9`) and drops words (`fixes-for-tts:14` 61–86 tokens). Use `split_into_best_sentences(tokenizer, text, 50)` (`tts_model.py:1015` path) shared with frontend estimator.

## Options Model

```py
class PostprocessOptions(BaseModel):
    combine_columns: bool = True
    normalize_uppercase: Literal["off","title","lower_long"] = "off"
    insert_page_markers: bool = True
```

Unit-test each with multi-column fixtures and quote-edge cases.
