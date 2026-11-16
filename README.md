# markdown-render-speed-02 — fast Markdown renderer

An original, dependency-free Markdown renderer (CommonMark + GFM) written
for the make.fun markdown-render-speed-02 competition. `parse(markdown)`
in `parse.js` returns the same HTML string as the reference renderer
(marked 18.1.3 with GFM on) — verified byte-identical on all 720 practice
cases (652 CommonMark, 28 GFM, 40 generated documents).

## Design

- **Block level:** a single pass over the remaining source with anchored
  patterns and first-construct dispatch (blank lines, indented and fenced
  code, ATX and setext headings, thematic breaks, blockquotes, lists,
  HTML blocks, link reference definitions, GFM tables, paragraphs).
  Lists collect each item's raw lines first (with container-indent and
  tab-stop compensation) and then parse the collected content; link
  reference definitions are registered during the block pass, so forward
  references resolve.
- **Inline level:** a hand-written token loop — escapes, HTML tags, links
  and images (with balanced-parenthesis destinations), reference links,
  code spans, hard breaks, strikethrough, angle and bare autolinks (with
  the trailing-punctuation backpedal). Emphasis uses a masked copy of the
  source (link spans, code spans and escapes collapsed) plus a
  balance-counting delimiter scan with the usual flanking and
  rule-of-three behaviour. Plain text takes a fast path that stops only
  where another construct can start.
- **Output:** block and inline tokens render directly to the final HTML
  string; numeric character references are decoded during text
  tokenization and URLs are normalised the same way the reference does.

## Files

- `parse.js` — the renderer (the competition entry point).
- `main.ts` — the harness driver: reads `cases.json`, writes `html.json`.
- `package.json` — marks the package as an ES module.

## License

MIT (see `LICENSE`).
