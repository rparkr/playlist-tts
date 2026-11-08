## Done

- [x] Enable two-way sync on Markdown Viewer to PDF Viewer (keep the PDF viewer in sync with the Markdown viewer on page changes). That way, as the current sentence progresses across page boundaries (during listening or from seeking), the PDF in view matches the Markdown being viewed.
- [x] On the estimated remaining time on the playback bar (bottom-right corner), display hours:minutes:seconds rather than just minutes:seconds, so that the time looks like `-6:22:45` instead of `-382:45`.
- [x] Enable voice clone management: rename and/or delete
- [x] Load PDF viewer and postprocessing options prior to OCR, with an "extract text" button to kick off OCR
  - [x] Enable editing page offset (for first page); useful when scanned pages are not the start of the book (e.g., chapter by chapter scan)
  - [x] Enable editing per-page numbers (useful when scanned pages skip physical pages; like when a page is only an illustration, so there would be no text to extract). This could be done, for example, by showing an editable page number on the PDF viewer that will be used for the "Page #." blocks added in postprocessing.
- [x] Refine estimates of playback ETA by tracking total characters processed and the total time for those characters; stored in LocalCache, by voice and TTS engine (where the total time is always calculated based on a speech rate of 1.0). Then, the estimates will improve over time because they are being refined.
- [x] Show voice clone name in the URL query parameter instead of the voice ID; avoid conflicts by appending "-voice-clone" or something like that if the cloned voice name conflicts with a built-in voice name; or show a warning explaining the conflict so the user can rename the voice.
- [x] Add a dedicated show/hide button for the PDF viewer, rather than the "click the top-left logo" behavior. Instead, the top-left logo should land at an overview page showing the user where they can pick up again (e.g., select an item from a playlist to resume listening; or create a new playlist). A playlist is a group of items to be listened to in sequence with autoplay (the next item starts automatically after the current item completes).
- [x] Support digital-native PDFs with text embedded in them and extractable via `pypdf` rather than OCR
- [x] Migrate to a full playlist library: URL fetching and processing to Markdown; plain Markdown upload or copy-paste into a text area; PDF support for digital-native PDFs (use `pypdf` to extract text); ePub documents, and PDF URLs so the user doesn't need to download and then upload PDFs that are already available publicly online. Include a dedicated library management pane with item reordering and renaming and auto-play to the next item when the current one finishes. Each item card in the library will show the current progress through that item along with the estimated total listening time and remaining time. The item cards will also display their source (PDF upload, plain Markdown upload or copy-paste, article URL/domain for URL-fetched items, domain for URL-fetched PDFs).
  - [x] I created a wire-frame mock-up in tldraw to clarify what the UI should look like: [wireframes](./docs/ui-design/)
  - [x] The PDF viewer pane will become an optional pane that can be shown to compare with the OCR version of it (or simply the text-extraction version if a digital-native PDF was used)
- [x] Full audio file generation. An asynchronous process on the backend server (doesn't block the UI or the server if already running TTS); perhaps a separate process or worker to manage it. Basically, the user selects "download full audio TTS" and the frontend kicks off a process on the backend to generate a full audio file. We can show progress if it is feasible, otherwise, just notify the front-end via a toast that the download is ready. The user can then download the file from the library item card in the library manager pane. The audio should probably be compressed automatically before being made ready for download, from WAV to mp3 or webm audio or some other compressed format to reduce the file size while preserving quality (we can probably do that with the `pyav` library). **One note here:** the browser already saves generated audio during normal playback: after the server is shut down, a user can still play back previous sentences since the TTS outputs are cached by the browser. In that case, we could consider surfacing an option to download the already-listened-to audio, perhaps listing the sentence range (or section range) for which TTS audio is already available.
- [x] Sort voice list alphabetically (placing cloned voices at the top)
- [x] Voice selection should be based on the TTS engine selected
- [x] Breadcrumbs: for some reason, the top-level one isn't updating (shows "Electrical grid > Radio towers" instead of "Communications > Radio towers"); perhaps because all levels in the `engineering*.pdf` seem to be at `h2` level (that may require post-processing after OCR to correct, or it may come from a setting in Docling)
- [x] Enable uploading a PDF along with its Markdown file (pages synced by enumerating the "Page N" lines, verifying the count matches the count of PDF pages, then synchronizing the view between Markdown and PDF pages based on those "Page N" lines)
- [x] Process the Markdown text to prevent sentences that are too long for the TTS model. The `pocket-tts` model is designed to handle sequences of 50 tokens at a time; it typically works fine with up to 100 tokens. Beyond that, the output quality degrades to become unintelligible sounds rather than speech and generation time stalls precipitously (e.g., >20 seconds for a 300-token sequence vs. 2-4s for typical 50-chunk sequences). If we have access to the `pocket-tts` tokenizer, we should use that directly and break up chunks that exceed the limit. Otherwise, we can use character or whitespace-delimited word counts as rough heuristics. We should do the chunking in an intelligent way to obtain the best output quality and listening experience, looking for natural breaks in the text sequence, for example: punctuation like commas, semicolons, colons, quote characters, parentheses, etc. For references, here's an example error from `pocket-tts` when the sequence exceeds its supported length: `WARNING:pocket_tts.models.tts_model:Chunk has 70 tokens (max 50), generation may skip words: '“I told him he could have our snacks if he promise...'`
    The 50-token limit suffices for most sentences. If a sentence exceeds around 70 tokens, it is likely in error. Here are some examples I've seen:

    **Punctuation marks that aren't yet handled by our sentence splitting logic:**

    **Angled double quote characters** (e.g.,`“` and `”`, or `U+201C` and `U+201D`). Here's an example sentence that had >70 tokens:

    > Will exclaimed, “Bix, what on earth did you say?”
    > “We made a deal,” she replied, winking. “I told him he could have our snacks if he promised to leave alone the herd of defenseless prosauropods coming through tomorrow…” A deception which Bix modestly characterized as mere tact.

    Notice in that example that there are multiple sentences, but the boundary check groups them together because they end with the angled quote character rather than a standard quote character. Also note that the ellipsis followed by a double quote character seems to be the end of a sentence (the following words, "A deception" starts with a capital "A", indicating a new sentence), but it was grouped with the one that follows. This was possibly an OCR artifact missing the period at the end of that sentence, but we should still have a more robust way to handle punctuation like the angled quotes. Perhaps we can normalize all punctuation to their standard ASCII equivalents (plain straight quotes in this case).

    **Angled single quote characters.** (i.e., `’`). These should be normalized to standard straight quote characters: `'`.

    **Bullet points.** `•` should be `-`. Bullet points typically come through via PDF text extraction. They should be normalized to standard Markdown lists for proper rendering and TTS generation.

    **Newline-separated lists that are treated as though they are one sentence, like this:**

    > SONGS OF THE SEA TURTLES
    > HOW TO MAKE GOLD
    > PALEOZOIC POEMS
    > LESSONS FROM THE BEE DANCE
    > THE CARE AND TEACHING OF HUMANS
    > PERPETUAL MOTION MECHANICS
    > A COMPENDIUM OF HELPFUL FUNGI
    > MASTERPIECES OF TERMITE ENGINEERING

    Notice that those are clearly individual items that should be read as if there were individual sentence blocks (each line = one sentence). However, because they have terminal punctuation, they are all collapsed together, like this: `SONGS OF THE SEA TURTLES HOW TO MAKE GOLD PALEOZOIC POEMS LESSONS FROM THE BEE DANCE THE CARE AND TEACHING OF HUMANS PERPETUAL MOTION MECHANICS A COMPENDIUM OF HELPFUL FUNGI MASTERPIECES OF TERMITE ENGINEERING`. That combined "sentence" is too long for the model (and also doesn't make sense) so the output is poor.

    I think we could solve for this by adding intelligent logic for determining when to collapse newlines and when to treat them as separate sentences. That will be nuanced, since we also have paragraphs like the following example, which _should_ be collapsed, since the newlines were exactly replicating page formatting/structure rather than content:

    > One morning, Norah cheerfully said to me,
    > "Arthur, it’s time you had some company on your
    > rambles. Take Melanie and Kalyptra with you."
    > Melanie is her five-year-old granddaughter, and
    > ‘Kal’ the Dryosaurus who always accompanies her.

- [x] **Retain lists in the processed Markdown.** Currently, the web UI strips ordered and unordered lists, which impairs readability by squashing together list items into single sentences. We should preserve numbering for ordered lists and paragraph separation for unordered lists, so that each list item reads as its own sentence.
- [x] **Fix Markdown rendering.** The Markdown viewer currently does not render Markdown very well. For example: it does not handle lists, code blocks, links (which should render as clickable links, with TTS reading just the link name rather than its `href`), or images, and it does not place article titles as an h1 element at the top of the Markdown viewer (which it should -- it's helpful to hear the article name when listening, especially when one article concludes and the next one begins). We should have a robust Markdown viewer that should render really well (e.g., like how Markdown pages render on other sides like GitHub)
- [x] **Drop the "Upload PDF" button in the top-right.** It is redundant compared to opening the library and uploading a PDF from there.
- [x] **Display in the library all items that are not assigned to a playlist.** Right now, there is a menu button on the top-right of the page that opens a modal showing all individual items that have been added, whether or not those items are in a playlist. When I got to the main overview, I cannot see any of the items that were added outside of a playlist. Similarly, when I view the library, I cannot see the items added outside of a playlist -- the only way to access those items right now is the menu button on the top-right.
- [x] **Remove the redundant menu button on the top right.** There is a three-bar button on the top right that opens a modal with all items added to the library. That seems to overlap in purpose with the overview/library view (from clicking the logo in the top-left). We should consolidate into one view; I prefer the overview page rather than the modal.
- [x] **Add a "this is clickable" signal to the logo** in the top-left of the page so the cursor changes its icon when hovering over the logo. Otherwise, it might not be clear to users that you can click that to see the overview page.
- [x] **Add an easy-to-see button to access the library overview,** besides clicking the logo. Something that clearly describes returning to the library view.
- [x] **Improve TTS on Markdown documents.** We need to improve the processing of text to make it sound better when passed to the TTS model. Here are some examples:
  - [x] URLs: we should trim to the domain only
  - [x] Code blocks: pass only comments to the TTS engine (e.g., for Python, that would mean passing every line starting with the `#` character)
  - [x] Tables: We might need to do something like convert the table to a list of JSON records, so the headers are repeated with the values for each row.
  - [x] Long sentences: we should split on punctuation (`,`, `;`, `—`, `()`, etc.) or other natural breaks to split up really long sentences so the model can process them quickly and with good sound quality.

    My suggestion for how to implement this: for each database entry that has the Markdown text (extracted from a web article, a PDF, or raw upload, etc.), we keep a separate TTS version of that text that has been processed to make it sound best for TTS. We could use that layer for doing things like splitting up lines or paragraphs to be sent to the TTS engine (rather than inserting periods to force that behavior), trimming code blocks to comments only, converting Markdown tables to JSON records to repeat the header followed by its value for each row while also ensuring that the TTS engine doesn't need to figure out how to read a pipe symbol `|`, passing list items as individual "sentences" to the TTS engine (again, instead of adding punctuation or newlines, which reduces readability in the viewer). The way I'm envisioning this is that the TTS layer will be a list, where each item in the list is one "sentence" chunk to send to the TTS engine. Those list items will then map back to the Markdown document, so any edits to the Markdown will be reflected in the TTS list.

- [x] **On PDF upload, provide the option to force OCR even if the document has a text layer.** This can improve the text extraction quality when a document has tables, images with captions, headers, or math formulas.
  - [x] We should also enable re-processing a PDF file any time, via any of the engines (text extraction, OCR with `granite-docling`, or OCR with a VLM).
- [x] **PDF files need to have a "Page 1." marker.** Currently, I cannot navigate back to page 1 using the left arrow on the PDF viewer: it stops at page 2, and won't cycle back further. Due to the bidirectional sync, I can still get it to show Page 1 by clicking text from the first page in the Markdown viewer, but it would be better to be able to simply click the left arrow on the PDF viewer to move back to page 1.
- [x] **Remove the `-` from the time-left indicators on the library and playlist views.** It's confusing that the text on each card renders as: `huggingface.co · 0% · -16:13 left · -16:13 total` because the `-` interfere with the `·` separators.
- [x] **Text post-processing: combining hyphenated words from OCR or text extraction from PDFs.** When loading a PDF, words that split across lines are often hyphenated, like this: `cele- bration`. We would want that to become: `celebration`. Natural hyphenations, like `a win-win scenario` should be preserved. My guess is that a word ending in a hyphen followed by a space is the way to detect that a word was broken across lines.
- [x] **Enable adding a title to an entry that was added via direct text entry (pasting).** This applies only to the "listen now" feature rather than a playlist, since every item in a playlist can be renamed.
- [x] **Enable ePub document format..** Let's add support for the ePub format.
- [x] **Consolidate upload feature and link-add.** We should have 3 options: (1) upload (any document type: PDF, Markdown, .txt, ePub, etc.), (2) URL (either a link to a page, or else to a document hosted on the web, like a PDF), and (3) paste (plain-text paste, which will be rendered as Markdown in the viewer). We can auto-detect the file type based on the file uploaded or the URL given.
- [x] **Remove the client-side Kokoro TTS engine.** It performs poorly: <1x real-time-factor on WASM, on a powerful consumer laptop (14-core CPU). Performance is even lower on a mobile device. Also, don't implement pocket-tts via onnxruntime, either -- it runs ~1x real-time-factor on a laptop CPU on WASM, but barely. It's possible that using multiple web worker threads would improve that, but it's probably not worth it for now -- realistically, when running on a laptop, the server will be available so we would just use that for speech data. Mobile devices run the pocket-tts model at <1x real-time factor on onnxruntime, so it wouldn't be helpful there, either. Also, mobile devices tend to have excellent built-in TTS engines for accessibility (e.g., Google's TTS on Pixel phones), so they can use the built-in TTS engine and don't need a separate one.
- [x] **Remove the "Ensure Punctuation" option in Markdown post-processing.** Since paragraphs are sent to the TTS engine individually, we don't need to separately add punctuation to force sentence boundaries at paragraph breaks: they won't blend into each other as-is. Also, list items are already handled as well, so those also don't blend into each other.
- [x] **Fix `INFO:     127.0.0.1:59892 - "GET /v1/models HTTP/1.1" 404 Not Found`** those logs appear regularly while the app is running, we should address them.
- [x] **Replace the left-pane library/PDF viewer with tabs.** Focus the UI entirely on the Markdown viewer. Remove the outline around it and the background color, so it is no longer a pane, but rather blends in with the page's background. Keep the buttom playback bar fixed, as well as the top bar. The entire middle section will be the Markdown viewer. The viewer should not scroll horizontally (except for code blocks, where the scroll bar should be within the code block only). Use tabs to open up the alternative views: PDF, library, playlist -- similar to the "up next" feature in music-playback or audiobook apps.
- [x] **When an item is added to the library, it does not immediately appear in the list.** We should make sure it is added right away, without the user opening the overview and selecting "library" to refresh that view.
- [x] **When any dialog window is open, like the overflow menu for the Markdown viewer or the settings menu, clicking/tapping in a different area of the page should dismiss it.** Currently, if I tap the overflow menu on the Markdown viewer, I need to tap the same overflow icon again to hide it.
- [x] **When calculating ETA for a voice/engine combination, smooth the updates.** When a new voice/engine is selected, data must be gathered for that combination to accurately calculate ETA. During the data-gathering period, before the average is stabilized, the variation in each new sentence leads to large swings in the ETA. Perhaps we should introduce some smoothing (e.g., moving average or weighted moving average) until the calculation converges. Otherwise, the ETA updates back and forth, which feels unusual and unexpected to a user (we are used to seeing ETA decrease relatively monotonically).
- [x] **Split at sentence ends, even when the sentence ends with parentheses or quotation marks.** Currently, sentences that end with `."` or `?"` (because they are part of a quotation) or `.)` (part of a parenthetical statement) are not treated as individual TTS spans, so they can result in spans much longer than 50 tokens because the sentences are not split at those boundaries. When terminal punctuation occurs just prior to a quotation mark or parenthesis, we should split the sentence to avoid really long spans when a paragraph has much dialog.
- [x] Fix scroll on library pane (the container extends way down the page: it should stop at the bottom bar and if it needs to, it should scroll within its pane, not down the entire page). Also, the scroll position is incorrect: when opening the pane, the scroll follows the markdown viewer's position, placing the view in the pane to empty space below the playlist items.
- [x] Quick question: how are we estimating playback time per engine-voice combination? Are we using character count or word/sentence count? Character count seems to be really stable and a solid approach to estimating playback time, so we should use characters rather than words or sentences if we have not already done so.

### TTS upgrade

- [x] **Add a new TTS option: in-browser Phonon 31m (a model adapted from pocket-tts).** There are 8-bit quantized versions of the model that run faster than real-time in a browser on WASM (e.g., using 3 threads). For more info, see the [Phonon TTS GitHub repository](https://github.com/gradium-ai/xn-ptts). In the docs of that repository, you'll find information about how to use the WASM and Python bindings that we will implement in our application.
  - [x] **Consider replacing the server-side TTS with Phonon 31m.** Implemented as a selectable server engine; Pocket stays until the migration is verified. In addition to in-browser WASM, we can deploy Phonon (via its Python bindings) on the server. Phonon runs at 16x real-time on 6 CPU threads, and 8x real-time on a single CPU thread -- much faster than `pocket-tts`, meaning that speech could be generated much faster. Furthermore, Phonon (the `ptts` Python library) doesn't require PyTorch, which significantly reduces our application's size and dependency footprint -- it's just a tiny <10MB Rust binary, and the model itself is only 31M parameters. The voice quality is also much better than the voices in `pocket-tts`. The only downside: no voice cloning support. I think that high-quality voices and fast generation is better than voice cloning, so my recommendation is that we eventually phase out `pocket-tts` in favor of WASM and server-side Phonon (WASM to enable running in real-time and offline on a client, and server-side to enable pre-fetching all the audio faster when pre-generating audio for continuous offline playback).
    - [x] **Accept Phonon voice files.** Server and browser Phonon engines accept precomputed `.safetensors` voice files (for example from Gradium Studio) and store them in IndexedDB alongside Pocket clones.
    - [x] **Check Pocket-to-Phonon clone compatibility.** Pocket `export-voice` files store a full KV-cache state and are not loadable by `ptts.add_voice`; Phonon needs a `speaker_wavs` embedding. The 31M English checkpoint also reports no audio voice-cloning support.
    - [x] **Group voice pickers by language → dialect → speaker gender → alphabetical.** Device, Pocket, and Phonon lists all use the same grouping, with localized labels such as English · US English · Female.

## To-do

### Deployment, packaging

- [ ] **Rename the package to "playlist-tts".** This app now supports full playlist functionality, far beyond OCR to TTS, so the new name is a better fit for what it does.
- [ ] **Make this application a Progressive Web App** so it can run offline
- [ ] **Web app hosting.** We want to host this via GitHub pages, with the web-fetch backend running on Google Cloud Functions. For now, the `granite-docling` OCR, LLM-based OCR, and pocket-tts engine will be supported for local runs only (i.e., running on a laptop). The following are some considerations prior to v1.0.0. Use at least two subagents for each of these items individually, to get independent evaluations that can then be reconciled:
  - [ ] Clean up documentation. Do a thorough review and update stale comments and docs.
  - [ ] Check for unused code paths and clean up. Are there outdated tests, unused functions, or legacy functionality that we can remove?
  - [ ] Review the architecture and ensure it is clean and optimal.
  - [ ] Check for maintainability: does the API make sense? Do we adequately follow DRY principles? Is the code modular and extensible?
  - [ ] Are there any unnecessary parts, given the purpose as a web app without a CLI? For example, do we need duplicate TTS span-parsing in Python and in TypeScript? Or can we remove the Python parsing altogether?
- [ ] Help me package this using Capacitor and run it as an Android app (I'd like to use it on my mobile device).

### UI enhancements

- [ ] **Resize viewers horizontally.** Add a line/handle in between the library/PDF and Markdown Viewer panes for horizontal dragging to adjust the width of each pane (might be superseded by the suggestion directly below: switch to a tabbed layout instead of side-by-side view.)
- [ ] **Consider a "Now playing" and "Up next" tabbed division rather than side-by-side panes.** That format might be more intuitive to users and friendlier on mobile devices with narrow screens. In that approach, there would be only one pane at a time, but it would show either the content of the current article, or else the playlist with the active item highlighted (and a live progress bar updating).
- [ ] **Support additional Markdown styling features.** e.g., Definition Lists, Footnotes, Alerts (`[!NOTE]` or `[!TIP]`, etc.), LaTeX (heavily used in academic papers), YAML frontmatter, syntax highlighting for code blocks
- [ ] When I tap "Enter URL," a separate text area opens up that I then need to tap on. It would be better if the button itself converted into a text area with the cursor inside of it when I tap "enter URL."
- [ ] When uploading a new PDF file, clear the current Markdown pane. Otherwise, it is somewhat confusing because the PDF renders in the viewer with the toolbar above it showing "Extract text," but the Markdown pane has unrelated text already there from whatever was active before the user selected the "Upload PDF" button. Also, fix the PDF controls when uploading a PDF: they go to the bottom of the web page, rather than right below the previewed PDF page -- when a long article was already loaded in the Markdown pane prior to clicking "Upload PDF," this meant that the controls to navigate pages of the PDF preview were buried all the way down the page and not visible to the user without scrolling all the way down.
- [ ] We should provide an "info" button on item cards that shows the date it was added, when it was last accessed, and a link to the source URL (for items created via a URL), and potentially could consider adding the options there to pre-generate audio, delete pre-generated audio, delete an associated PDF document, and re-extract text from an associated PDF document.
- [ ] Verify that the Markdown viewer longer scrolls to keep the active sentence visible (on mobile and desktop layouts). There may have been a regression in that feature, so we want to verify it.
- [ ] The playlist pane has rounded corners underneath the bar with library/PDF/playlist buttons: it would be more cohesive if it were directly connected, without looking like a separate container below.
- [ ] PDF upload -> attach Markdown. Should support pasted markdown as well as uploaded.
- [ ] Speech rate should remember the last-used setting by engine and voice. Switching the engine/voice should go back to the last setting for that combination, being overwritten the next time the setting is changed.
- [ ] The Markdown editor view box needs to extend all the way to the playback bar: right now it is in an adjustable-size text area that defaults to a shorter length. Also, we should style it to match the rest of the app, the default text area style is quite plain and doesn't match the theme of the rest of the app.
- [ ] When the device's TTS is used, add a feature that prevents the phone screen from locking (while allowing it to dim all the way); otherwise, TTS playback stops as soon as the screen locks. This is a workaround due to limitations of the web app when run in a mobile browser (e.g., Chrome).
- [ ] Provide a "reset" function to restore Markdown to the state it was when it was first parsed (undoing any edits or changes made to it).
- [ ] Markdown rendering needs to support LaTeX (heavily used by arXiv papers). We should probably have the synthesized speech skip LaTeX blocks because they wouldn't sound correct with all the characters (unless the TTS engine knew how to read the Greek letters or math notation as English instead of reading each character in something like `\frac{}{}`).
- [ ] We should show a progress bar when pre-generating text, along with ETA based on the fraction of characters processed (by the way, pre-generation is the same feature as downloading the full audio -- we could consider consolidating them or at least giving them the same name whether accessed from the markdown viewer overflow menu or from the playlist pane).
- [ ] We should enable pre-generating audio for all items in a playlist with a single button, and progress and ETA show for each article (on the article's card) as well as overall (on the playlist name header)
- [ ] To reduce rendering time on long documents (e.g., ePub or PDF books, or perhaps anything longer than a certain character count), we should introduce a within-document pagination feature that splits based on section headers or chapters, and automatically advances to the next section after reaching the final sentence in the current section. The skip-section buttons on the playback bar would enable the user to move between sections, just as they do today. Editing the Markdown would stay within the current section.

### PDF text extraction

- [ ] **Replace PDF text extraction (`granite-docling` and `pypdf`) with [`LiteParse`](https://github.com/run-llama/liteparse/tree/main):** `LiteParse` is a robust Rust library from LlamaIndex that is fantastic at extracting structured Markdown from PDF documents. It is much faster than `granite-docling` and much more accurate than both `granite-docling` and `pypdf`. It also has TypeScript and WASM bindings, so we could run it directly in the browser rather than on the server. I recommend cloning the source to a temp directory and reviewing its documentation to learn how to integrate it into our application. Here's the [source code](https://github.com/run-llama/liteparse/tree/main).
- [ ] **PDF text extraction: hybrid per-page routing:** route each page independently between direct text extraction and OCR instead of one whole-document decision, so mixed vector/scan documents use text where dense and OCR where not. `LiteParse` has a built-in `is_complex()` method to detect when a page needs OCR; we can rely on that to determine when to apply OCR.
- [ ] **We need a "back" button on the PDF viewer/playlist viewer pane that moves back to view one-level up:** for the PDF viewer, that would be the Playlist, for the Playlist, that would be the Library, for the Library, that would be the Overview. Otherwise, it is very difficult to get back to the Playlist view if the PDF viewer is active (I have to go back to the library overview and then select the playlist from there to get to it).
- [ ] **Stream the LLM's OCR content to disk (or browser memory/cache)** to enable resume in the event the OCR server crashes. For the LLM-based OCR, that would mean capturing the LLM's output and appending to the output file each time another page is completed, rather than holding everything in memory and writing to a file all at once after all pages are complete.
- [ ] **More OCR options for LLM generation.** The OCR options should include a way to specify the base URL and API key for an OpenAI-compatible server that can be used for OCR; we should then use those credentials to query the server, list available LLMs (with vision support) for the user to choose, and also provide options for the user to change the system and user prompts that are sent to the LLM for each page of the PDF.

### Markdown parsing

- [ ] **Look into table processing by engine.** I listened to the demo article `test-articles/tokenizers-v1.md` and noticed that tables are processed by the device-native TTS engine (Speech Synthesis Web API) differently than they are processed by the pocket-tts engine. With pocket-tts, I hear a row-by-row listing in this format: "Row 1 of 7. Column header 1: value at row 1, column 1; Column header 2: value at row 1, column 2. Row 2 of 7. ...". In the Speech Synthesis API, the same table sounds like this: "Column header 1. Column header 2. Value at row 1, column 1. Value at row 1, column 2." Notice that the Speech Synthesis API version doesn't give me row counts or per-row header repetition. Why is that?
- [ ] **In the Markdown editor settings, we should hide the PDF-only options** (e.g., page numbering) unless the file was generated from a PDF or uploaded along with a PDF.
- [ ] **In the Markdown editor, we need to provide options to adjust how the article text is extracted from the webpage.** That means the backend will need to pass the full HTML to the front end's IndexDB, enabling adjustments afterwards. The options should be: a toggle for article-focused vs. full-page (defaults to article-focused, full-page sends all the HTML to Markdownify without passing through readability-lxml first). When article-focused is set, we should show options for the min and max text lengths that affect recall and precision for readability-lxml. Here's an example where tweaking these settings would help: <https://kyutai.org/blog/2026-10-20-pocket-tts-small/>. The article extraction methods currently trim the entire article, leaving only a sponsorship message at the end.
- [ ] **Avoid splitting text spans on a period following a person's initial**, like: "President Russell M. Nelson of The Church of Jesus Christ of Latter-day Saints." The `M.` shouldn't be treated as the end of a sentence. Here's my idea on this: use a pattern that checks if there is a single uppercase letter followed by `.`, to avoid splitting initials as separate sentences.

### Format support

- [ ] Enable PDF direct links (like arXiv papers: <https://arxiv.org/pdf/2509.06926v3>). Right now, the app tells me I need to download the PDF and then upload it. I should just be able to give the URL directly.
- [ ] **Support YouTube videos by extracting audio transcriptions.** Here's a quick example:

    ```python
    # uv add youtube-transcript-api

    def youtube_video_transcript(url: str = URL) -> str:
        """
        Extract the audio transcript from a YouTube video.
        """
        import re

        from youtube_transcript_api import YouTubeTranscriptApi

        # Extract the video ID from the URL
        video_id = re.search(pattern=r"v=([A-Za-z0-9]+)", string=url)
        if not video_id:
            return ""

        video_id = video_id.group(1)
        print(f"For URL: {url}, extracted video id: {video_id}")

        ytt_api = YouTubeTranscriptApi()
        transcript = ytt_api.fetch(video_id)
        text = " ".join([i.text for i in transcript])
        return text
    ```

    For the URL: `https://www.youtube.com/watch?v=UkZxPIZ1ngY&t=618`, that returns (truncated for brevity):

    ```
    For URL: https://www.youtube.com/watch?v=UkZxPIZ1ngY&t=618s&pp=ugUEEgJlbg%3D%3D, extracted video id: UkZxPIZ1ngY
    The most common question we get is
    "how do I fix my shifting?" Maybe it's not reaching all the gears,
    or maybe it's making all sorts of noises. Whatever the issue, and regardless of the make or model, this video on mechanical
    rear derailleur adjustment will help you dial in your shifting
    for optimal performance. Calvin Jones here, Park Tool Company. We hope this video will give you a
    whole new outlook on your bike shifting. And before we begin, here's a quick overview
    of the components and procedures. The rear derailleur is the mechanism
    ...
    ```
