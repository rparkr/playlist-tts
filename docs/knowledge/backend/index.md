# Backend

## Concepts
- [API Contracts](api-contracts.md) - REST endpoints, schemas, and error handling for LLM OCR and TTS.
- [LLM Service](llm-service.md) - Stateless vision-LLM page OCR, model discovery, and editable prompts.
- [TTS Service](tts-service.md) - Engine-selected speech synthesis with Phonon streaming, Pocket legacy cloning, file jobs, and an in-browser WASM adapter.

## Boundaries

The backend does not parse PDFs, extract text, or maintain OCR jobs. PDF
extraction and Markdown rendering happen in the browser; the backend only
proxies page images to an OpenAI-compatible vision server.
