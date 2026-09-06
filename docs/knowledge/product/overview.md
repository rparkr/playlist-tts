---
type: reference
title: Product Overview
description: Purpose, target audience, and core value proposition of the OCR-to-audiobook application.
tags: [product, overview, audience]
generated:
  by: muse-spark-1.2-contributor-free
  at: 2026-08-31T07:58:30Z
---

# Product Overview

## Purpose
Turn PDFs (books, course materials) into listenable audiobooks. One-time OCR extracts Markdown; repeatable TTS enables listening, re-listening, and following along with the book.

## Target Audience
New readers and families — listening while following the printed/digital book. Pairing audio with page numbers is critical for co-reading.

## Core Value
- **OCR once, listen many times:** `granite-docling` (258M VLM) on GPU laptop extracts Markdown at ~30 pages/min on RTX 4060.
- **Two TTS engines:** device `SpeechSynthesis` (offline, instant) and server `pocket-tts` (high-quality, voice cloning, 4-6× real-time on CPU).
- **Offline-first reading:** Markdown, progress (sentence granularity), rate, and voice live in the browser; OCR is the only server-dependent step.

## Non-Goals (Current Scope)
- No auth / multi-user / server-persisted library — laptop-on-LAN or stateless Cloud Run (see `operations/deployment.md`).
- No browser-side OCR — `granite-docling` requires GPU; impractical in-browser.
- No in-browser `pocket-tts` WASM for MVP — deferred to Phase 3 (`architecture/decisions.md`).

## Success Criteria
A user uploads a <50-page two-column PDF on mobile, gets editable Markdown with page-aware sync, saves by title, and resumes playback at sentence `N` with correct breadcrumb `65% · Section 6 > Data selection > Ablation studies` after reload.
