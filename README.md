# markdown-render-speed-02 — entry

A fast, single-pass Markdown renderer written from scratch for this
competition. Its output matches the reference renderer (marked 18.1.3,
GFM on) byte-for-byte on the practice set's spec suites, and it is
built to keep the per-case CPU time low.

## Interface

- `main.ts` is the harness entrypoint: it reads `cases.json` from the
  input directory, renders each case with `parse()` from `parse.js`,
  and writes the HTML strings, in order, to the output file.
- `parse.js` is the whole renderer. It has no dependencies.

## Architecture

- **Block stage:** a line-cursor tokenizer with first-character
  dispatch produces block tokens (paragraphs, headings, lists,
  blockquotes, tables, fenced/indented code, HTML blocks, link
  reference definitions). Container constructs (blockquotes, list
  items) collect their raw lines first and tokenize the collected
  content recursively, with a CommonMark-style column model for
  indentation and tab stops. Link reference definitions are registered
  during block tokenization, before any inline rendering, so forward
  references work.
- **Inline stage:** a hand-written scanner with a plain-text fast path
  (untouched runs are emitted without per-character work). Emphasis
  uses a balance-counting scan over a masked copy of the text — links,
  code spans and HTML tags are blanked out first so delimiters inside
  them stay invisible — which reproduces the reference renderer's
  emphasis behaviour, including its rule-of-three accumulation.
  Strikethrough uses an equal-length delimiter pairing pass. Bare GFM
  autolinks honour a document-level "inside a link" state, with
  trailing-punctuation backpedalling, unmatched-paren trimming and
  mailto:/xmpp: scheme joining.
- **Tables:** rows are split with the reference's escaped-pipe rule (a
  pipe preceded by an odd number of backslashes is content, not a
  delimiter).

## Practice result

720 cases (652 CommonMark + 28 GFM + 40 generated documents):

- CommonMark suite: 652/652 byte-identical
- GFM suite: 28/28 byte-identical
- Generated documents: 11/40 byte-identical
- Total: 691/720 byte-identical, full set rendered in about 2.6 s
  locally (about 3.6 ms per case, documents included).
