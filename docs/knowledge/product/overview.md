---
type: reference
title: Product Overview
description: Purpose, target audience, and core value proposition of the OCR-to-audiobook application.
tags: [product, overview, audience]
generated:
  by: opencode
  at: 2026-11-18T00:00:00Z
---

# Product Overview

## Purpose
Turn PDFs (books, course materials) into listenable audiobooks. PDF text is
extracted once in the browser; repeatable TTS enables listening, re-listening,
and following along with the book.

## Target Audience
New readers and families — listening while following the printed/digital book. Pairing audio with page numbers is critical for co-reading.

## Core Value
- **Extract once, listen many times:** LiteParse WASM parses PDF pages in the
  browser at reading speed, with no GPU and no upload. Scanned or unreadable
  pages can be sent individually to a vision LLM for OCR.
- **Four TTS engines:** device `SpeechSynthesis` (offline, instant, default), server Phonon (fast,
  high quality), in-browser Phonon 31M WASM (optional, offline after one download), and legacy
  Pocket TTS for cloned voices.
- **Offline-first reading:** Markdown, progress (sentence granularity), rate, and voice live in the browser; extraction is local, and only the optional OCR path needs a server.

## Non-Goals (Current Scope)
- No auth / multi-user / server-persisted library — laptop-on-LAN or stateless Cloud Run (see `operations/deployment.md`).
- No server-side PDF parsing, OCR jobs, or PDF uploads. The backend is a
  stateless page-image proxy plus TTS.
- No browser-side audio cloning — Phonon's browser build uses its catalog plus precomputed
  `.safetensors` voices (for example from Gradium Studio), not recordings or Pocket clones.

## Success Criteria
A user opens a <50-page two-column PDF on mobile, gets editable Markdown with page-aware sync, saves by title, and resumes playback at sentence `N` with correct breadcrumb `65% · Section 6 > Data selection > Ablation studies` after reload.
