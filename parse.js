// SPDX-License-Identifier: MIT
// A fast single-pass Markdown renderer (CommonMark + GFM) written from
// scratch for the markdown-render-speed-02 competition. The block level
// works on the remaining source with anchored patterns and a cursor; the
// inline level is a hand-written token loop with a masked-source balance
// scan for emphasis, so plain paragraphs take a fast text path.

const TAG = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
const COMMENT = String.raw`<!--(?:-?>|[\s\S]*?(?:-->|$))`;
const ATTR = String.raw` +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>` + '`]+)?';
const HR_SRC = String.raw` {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)`;
const HEADING_SRC = String.raw` {0,3}#{1,6}(?:\s|$)`;
const FENCES_SRC = String.raw` {0,3}(?:\`{3,}(?=[^\`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)`;
const HTML_SRC = String.raw` {0,3}(?:</?(?:tag)(?: +|\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)`;

function compose(src, pairs) {
  let out = src;
  for (const [key, val] of pairs) out = out.split(key).join(val);
  return out;
}

// Replace only the first occurrence of each placeholder, so fragments
// inserted earlier are never re-scanned for later placeholder names.
function composeFirst(src, pairs) {
  let out = src;
  for (const [key, val] of pairs) {
    const at = out.indexOf(key);
    if (at !== -1) out = out.slice(0, at) + val + out.slice(at + key.length);
  }
  return out;
}

// GFM table grammar (header line, delimiter line, body lines that do not
// start another block).
const TABLE_SRC = compose(
  String.raw`^ *([^\n ].*)\n {0,3}((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?)(?:\n((?:(?! *\n|hr|heading|blockquote|code|fences|list|html).*(?:\n|$))*)\n*|$)`,
  [
    ['hr', HR_SRC],
    ['heading', HEADING_SRC],
    ['blockquote', String.raw` {0,3}>`],
    ['code', String.raw`(?: {4}| {0,3}\t)[^\n]`],
    ['fences', FENCES_SRC],
    ['list', String.raw` {0,3}(?:[*+-]|1[.)])[ \t]`],
    ['html', HTML_SRC],
    ['tag', TAG],
  ],
);
const TABLE_RE = new RegExp(TABLE_SRC);

// Paragraph grammar: lines keep coming until a line starts one of the
// interrupting constructs (or a blank line).
const PARAGRAPH_RE = new RegExp(composeFirst(
  String.raw`^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)`,
  [
    ['hr', HR_SRC],
    ['|lheading', ''],
    ['heading', HEADING_SRC],
    ['table', TABLE_SRC.slice(1)],
    ['blockquote', String.raw` {0,3}>`],
    ['fences', FENCES_SRC],
    ['list', String.raw` {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]`],
    ['html', HTML_SRC],
    ['tag', TAG],
  ],
));

// Setext heading grammar.
const LHEADING_RE = new RegExp(compose(
  String.raw`^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)`,
  [
    ['bull', String.raw` {0,3}(?:[*+-]|\d{1,9}[.)])`],
    ['blockCode', String.raw`(?: {4}| {0,3}\t)`],
    ['fences', String.raw` {0,3}(?:\`{3,}|~{3,})`],
    ['blockquote', String.raw` {0,3}>`],
    ['heading', HEADING_SRC],
    ['hr', String.raw` {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)`],
    ['html', String.raw` {0,3}<[^\n>]+>\n`],
    ['table', String.raw` {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n`],
  ],
));

// The paragraph pattern allowed to continue a blockquote line lazily.
const QUOTE_PARA_SRC = composeFirst(
  String.raw`^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)`,
  [
    ['hr', HR_SRC],
    ['|lheading', ''],
    ['|table', ''],
    ['heading', HEADING_SRC],
    ['blockquote', String.raw` {0,3}>`],
    ['fences', FENCES_SRC],
    ['list', String.raw` {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)`],
    ['html', HTML_SRC],
    ['tag', TAG],
  ],
);
const BLOCKQUOTE_RE = new RegExp(
  String.raw`^( {0,3}> ?(?:(?![ \t]*(?:\n|$))` +
    QUOTE_PARA_SRC.slice(1) +
    String.raw`|[^\n]*)(?:\n|$))+`,
);

const BLOCK = {
  newline: /^(?:[ \t]*(?:\n|$))+/,
  code: /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/,
  fences: /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/,
  heading: /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/,
  hr: /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/,
  blockquoteStart: /^ {0,3}>/,
  list: new RegExp(String.raw`^( {0,3}(?:[*+-]|\d{1,9}[.)]))([ \t][^\n]*?)?(?:\n|$)`),
  html: new RegExp(
    String.raw`^ {0,3}(?:<(script|pre|style|textarea)[\s>][\s\S]*?(?:</\1>[^\n]*\n*|$)|` +
      COMMENT +
      String.raw`[^\n]*(\n+|$)|<\?[\s\S]*?(?:\?>[^\n]*\n*|$)|<![A-Z][\s\S]*?(?:>[^\n]*\n*|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>[^\n]*\n*|$)|</?(?:` +
      TAG +
      String.raw`)(?:[ \t]+|\n|/?>|$)[\s\S]*?(?:(?:\n[ \t]*)+\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:` +
      ATTR +
      String.raw`)*? */?>(?=[ \t]*(?:\n|$))[\s\S]*?(?:(?:\n[ \t]*)+\n|$)|</[a-z][a-z0-9-]*\s*>(?=[ \t]*(?:\n|$))[\s\S]*?(?:(?:\n[ \t]*)+\n|$))`,
    'i',
  ),
  def: new RegExp(
    String.raw`^ {0,3}\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)((?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))))? *(?:\n+|$)`,
  ),
  table: TABLE_RE,
  lheading: LHEADING_RE,
  paragraph: PARAGRAPH_RE,
  text: /^[^\n]+/,
};

const OTHER = {
  codeRemoveIndent: /^(?: {0,3}\t| {1,4})/gm,
  blankLine: /^[ \t]*$/,
  doubleBlankLine: /\n[ \t]*\n[ \t]*$/,
  anyLine: /\n.*\n/,
  nonSpace: /[^ ]/,
  listTask: /^\[[ xX]\][ \t]+\S/,
  listTaskStrip: /^\[[ xX]\][ \t]+/,
  listTaskBox: /\[[ xX]\]/,
};

// ---------------------------------------------------------------- helpers

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_ENCODE_RE = /[&<>"']/g;
const ESC_PLAIN_RE = /[<>\"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const ESC_ENCODE_TEST = /[&<>"']/;
const ESC_PLAIN_TEST = /[<>\"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;

function escapeHtml(text, encode) {
  if (encode) {
    return ESC_ENCODE_TEST.test(text) ? text.replace(ESC_ENCODE_RE, (c) => ESC_MAP[c]) : text;
  }
  return ESC_PLAIN_TEST.test(text) ? text.replace(ESC_PLAIN_RE, (c) => ESC_MAP[c]) : text;
}

const NUMERIC_REF_TEST = /&#(?:\d{1,7}|[Xx][A-Fa-f0-9]{1,6});/;
const NUMERIC_REF_RE = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

function decodeNumericRefs(text) {
  if (!NUMERIC_REF_TEST.test(text)) return text;
  return text.replace(NUMERIC_REF_RE, (m, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const cp = dec !== undefined ? parseInt(dec, 10) : parseInt(hex, 16);
    if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '\uFFFD';
    if (cp === 38) return '&amp;';
    return String.fromCodePoint(cp);
  });
}

function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

function normalizeRef(label) {
  return label.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

function trimRightChar(str, ch) {
  let n = str.length;
  while (n > 0 && str[n - 1] === ch) n--;
  return str.slice(0, n);
}

function stripTrailingNewlines(str) {
  return trimRightChar(str, '\n');
}

// Expand tabs to spaces, tracking the column (tab stops of 4).
function expandTabs(str, startCol) {
  let col = startCol;
  let out = '';
  for (const ch of str) {
    if (ch === '\t') {
      const n = 4 - (col % 4);
      out += ' '.repeat(n);
      col += n;
    } else {
      out += ch;
      col++;
    }
  }
  return out;
}

// Drop trailing blank lines, keeping the text if at most one empty line
// trails the last content line.
function trimBlankSuffix(text) {
  const lines = text.split('\n');
  let last = lines.length - 1;
  while (last >= 0 && OTHER.blankLine.test(lines[last])) last--;
  return lines.length - last <= 2 ? text : lines.slice(0, last + 1).join('\n');
}

// Count balanced delimiters: -1 when neither appears, the index of an
// unmatched closing delimiter, or -2 when some opener never closes.
function parenBalance(str, pair) {
  if (str.indexOf(pair[0]) === -1 && str.indexOf(pair[1]) === -1) return -1;
  let depth = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\') i++;
    else if (str[i] === pair[0]) depth++;
    else if (str[i] === pair[1] && --depth < 0) return i;
  }
  return depth > 0 ? -2 : -1;
}

// Split a table row into cells. A pipe preceded by an odd number of
// backslashes is literal; other pipes separate cells.
function splitRow(line, count) {
  const marked = line.replace(/\|/g, (m, offset, full) => {
    let backslashes = 0;
    let p = offset;
    while (--p >= 0 && full[p] === '\\') backslashes++;
    return backslashes % 2 === 1 ? '|' : ' |';
  });
  const cells = marked.split(' |');
  if (cells.length > 0 && !cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells[cells.length - 1].trim()) cells.pop();
  if (count !== undefined) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (let i = 0; i < cells.length; i++) cells[i] = cells[i].trim().replace(/\\\|/g, '|');
  return cells;
}

// Fenced code inside a container: when the opening fence line itself was
// indented, strip that much indent from every content line.
function compensateFenceIndent(raw, content) {
  const m = /^(\s+)(?:```)/.exec(raw);
  if (m === null) return content;
  const indent = m[1];
  return content
    .split('\n')
    .map((line) => {
      const lead = /^\s+/.exec(line);
      if (lead === null) return line;
      return line.slice(Math.min(lead[0].length, indent.length));
    })
    .join('\n');
}

// ------------------------------------------------------------- block level

function parseBlocks(src, top, ctx, out, mergeParas) {
  const tokens = out || [];
  let rest = src;
  while (rest.length > 0) {
    const before = rest.length;
    let m;
    if ((m = BLOCK.newline.exec(rest))) {
      const raw = m[0];
      rest = rest.slice(raw.length);
      const prev = tokens[tokens.length - 1];
      if (raw.length === 1 && prev !== undefined) prev.raw += '\n';
      else tokens.push({ type: 'space', raw });
      continue;
    }
    if ((m = BLOCK.code.exec(rest))) {
      const raw = trimBlankSuffix(m[0]);
      const text = raw.replace(OTHER.codeRemoveIndent, '');
      rest = rest.slice(raw.length);
      const prev = tokens[tokens.length - 1];
      if (prev && (prev.type === 'paragraph' || prev.type === 'text')) {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + raw;
        prev.text += '\n' + text;
      } else {
        tokens.push({ type: 'code', raw, text, lang: '' });
      }
      continue;
    }
    if ((m = BLOCK.fences.exec(rest))) {
      const raw = m[0];
      rest = rest.slice(raw.length);
      const info = m[2];
      tokens.push({
        type: 'code',
        raw,
        text: compensateFenceIndent(raw, m[3] || ''),
        lang: info ? info.trim().replace(/\\([\p{P}\p{S}])/gu, '$1') : info,
      });
      continue;
    }
    if ((m = BLOCK.heading.exec(rest))) {
      let text = m[2].trim();
      if (/#$/.test(text)) {
        const stripped = trimRightChar(text, '#');
        if (!stripped || /[ \t]$/.test(stripped)) text = stripped.trim();
      }
      tokens.push({ type: 'heading', raw: stripTrailingNewlines(m[0]), depth: m[1].length, text });
      rest = rest.slice(stripTrailingNewlines(m[0]).length);
      continue;
    }
    if ((m = BLOCK.hr.exec(rest))) {
      tokens.push({ type: 'hr', raw: stripTrailingNewlines(m[0]) });
      rest = rest.slice(stripTrailingNewlines(m[0]).length);
      continue;
    }
    let tok;
    if ((tok = blockquoteToken(rest, ctx))) {
      tokens.push(tok);
      rest = rest.slice(tok.raw.length);
      continue;
    }
    if ((tok = listToken(rest, ctx))) {
      tokens.push(tok);
      rest = rest.slice(tok.raw.length);
      continue;
    }
    if ((m = BLOCK.html.exec(rest))) {
      const raw = trimBlankSuffix(m[0]);
      tokens.push({ type: 'html', raw, text: raw });
      rest = rest.slice(raw.length);
      continue;
    }
    if ((m = BLOCK.def.exec(rest))) {
      if (!m[2].startsWith('<') && parenBalance(m[2], '()') !== -1) {
        // unbalanced destination: not a definition after all
      } else {
        const raw = stripTrailingNewlines(m[0]);
        rest = rest.slice(raw.length);
        const href = m[2]
          ? m[2].replace(/^<(.*)>$/, '$1').replace(/\\([\p{P}\p{S}])/gu, '$1')
          : '';
        const title = m[3]
          ? m[3].substring(1, m[3].length - 1).replace(/\\([\p{P}\p{S}])/gu, '$1')
          : undefined;
        const prev = tokens[tokens.length - 1];
        if (prev && (prev.type === 'paragraph' || prev.type === 'text')) {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + raw;
          prev.text += '\n' + raw;
        } else {
          const tag = normalizeRef(m[1]);
          if (!ctx.links.has(tag)) ctx.links.set(tag, { href, title });
          tokens.push({ type: 'def', raw });
        }
        continue;
      }
    }
    if ((tok = tableToken(rest, ctx))) {
      tokens.push(tok);
      rest = rest.slice(tok.raw.length);
      continue;
    }
    if ((m = BLOCK.lheading.exec(rest))) {
      tokens.push({
        type: 'heading',
        raw: stripTrailingNewlines(m[0]),
        depth: m[2].charAt(0) === '=' ? 1 : 2,
        text: m[1].trim(),
      });
      rest = rest.slice(stripTrailingNewlines(m[0]).length);
      continue;
    }
    if (top && (m = BLOCK.paragraph.exec(rest))) {
      const prev = tokens[tokens.length - 1];
      if (mergeParas && prev && prev.type === 'paragraph') {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + m[0];
        prev.text += '\n' + m[1];
      } else {
        tokens.push({ type: 'paragraph', raw: m[0], text: m[1] });
      }
      rest = rest.slice(m[0].length);
      continue;
    }
    if ((m = BLOCK.text.exec(rest))) {
      const prev = tokens[tokens.length - 1];
      if (prev && prev.type === 'text') {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + m[0];
        prev.text += '\n' + m[0];
      } else {
        tokens.push({ type: 'text', raw: m[0], text: m[0] });
      }
      rest = rest.slice(m[0].length);
      continue;
    }
    break; // unreachable safety net
    // eslint-disable-next-line no-unreachable
    if (rest.length === before) break;
  }
  return tokens;
}

const BQ_MARKER_WS = /^( {0,3}>)([ \t]+)/gm;
const BQ_SETEXT = /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g;
const BQ_MARKER_STRIP = /^ {0,3}>[ \t]?/gm;

function blockquoteToken(src, ctx) {
  const m = BLOCKQUOTE_RE.exec(src);
  if (!m) return null;
  let lines = stripTrailingNewlines(m[0]).split('\n');
  let raw = '';
  let text = '';
  const children = [];
  while (lines.length > 0) {
    let seenMarker = false;
    const chunk = [];
    let p = 0;
    for (p = 0; p < lines.length; p++) {
      if (BLOCK.blockquoteStart.test(lines[p])) {
        chunk.push(lines[p]);
        seenMarker = true;
      } else if (!seenMarker) {
        chunk.push(lines[p]);
      } else break;
    }
    lines = lines.slice(p);
    const chunkRaw = chunk.join('\n');
    const cleaned = chunkRaw
      .replace(BQ_MARKER_WS, (mm, marker, ws) => marker + expandTabs(ws, marker.length))
      .replace(BQ_SETEXT, '\n    $1')
      .replace(BQ_MARKER_STRIP, '');
    raw = raw ? raw + '\n' + chunkRaw : chunkRaw;
    text = text ? text + '\n' + cleaned : cleaned;
    parseBlocks(cleaned, true, ctx, children, true);
    if (lines.length === 0) break;
    const last = children[children.length - 1];
    if (!last) break;
    if (last.type === 'code' || last.type === 'heading' || last.type === 'hr' || last.type === 'html' || last.type === 'table') break;
    if (last.type === 'blockquote') {
      const combined = last.raw + '\n' + lines.join('\n').replace(BQ_MARKER_STRIP, '');
      const merged = blockquoteToken(combined, ctx);
      if (!merged) break;
      children[children.length - 1] = merged;
      const restText = combined.substring(merged.raw.length).replace(/^\n/, '');
      const restCount = restText ? restText.split('\n').length : 0;
      const consumed = restCount ? lines.slice(0, -restCount) : lines;
      if (consumed.length > 0) {
        raw += '\n' + consumed.join('\n');
        text += '\n' + consumed.join('\n');
      }
      lines = lines.slice(consumed.length);
      if (lines.length > 0 && BLOCK.blockquoteStart.test(lines[0])) continue;
      break;
    }
    if (last.type === 'list') {
      const combined = last.raw + '\n' + lines.join('\n');
      const merged = listToken(combined, ctx);
      if (merged && merged.raw.length > last.raw.length) {
        const extra = combined.slice(last.raw.length + 1, merged.raw.length);
        const extraLines = extra ? extra.split('\n').length : 0;
        if (extraLines > 0) {
          raw += '\n' + lines.slice(0, extraLines).join('\n');
          text += '\n' + lines.slice(0, extraLines).join('\n');
          children[children.length - 1] = merged;
        }
        lines = lines.slice(extraLines);
        continue;
      }
      break;
    }
  }
  return { type: 'blockquote', raw, text, tokens: children };
}

function listToken(src, ctx) {
  const first = BLOCK.list.exec(src);
  if (!first) return null;
  const bullet = first[1].trim();
  const ordered = bullet.length > 1;
  const list = {
    type: 'list',
    ordered,
    start: ordered ? parseInt(bullet.slice(0, -1), 10) : '',
    loose: false,
    items: [],
    raw: '',
  };
  const bulletPat = ordered ? '\\d{1,9}\\' + bullet.slice(-1) : '\\' + bullet;
  const itemPattern = new RegExp(/^( {0,3}BULLET)((?:[\t ][^\n]*)?(?:\n|$))/.source.replace('BULLET', bulletPat));
  let rest = src;
  let prevItemEndedBlankish = false;
  while (rest.length > 0) {
    if (BLOCK.hr.test(rest)) break;
    const m = itemPattern.exec(rest);
    if (!m) break;
    const itemStart = src.length - rest.length;
    rest = rest.slice(m[0].length);
    const firstLine = m[2].split('\n', 1)[0];
    const bulletLen = m[1].length;
    const content = firstLine.replace(/^[ \t]+/, (v) => expandTabs(v, bulletLen));
    let nextLine = rest.split('\n', 1)[0];
    let isBlankContent = !content.trim();
    let itemText = '';
    let itemDone = false;
    let indent = 0;
    if (isBlankContent) {
      indent = bulletLen + 1;
    } else {
      let r = content.search(OTHER.nonSpace);
      if (r > 4) r = 1;
      itemText = content.slice(r);
      indent = r + bulletLen;
    }
    if (isBlankContent && OTHER.blankLine.test(nextLine)) {
      rest = rest.slice(nextLine.length + 1);
      itemDone = true;
    }
    if (!itemDone) {
      const cap = Math.min(indent - 1, 3);
      const nextBulletRe = new RegExp('^ {0,' + cap + '}(?:[*+-]|\\d{1,9}[.)])((?:[ \\t][^\\n]*)?(?:\\n|$))');
      const hrRe = new RegExp('^ {0,' + cap + '}((?:-[ \\t]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)');
      const fencesRe = new RegExp('^ {0,' + cap + '}(?:```|~~~)');
      const headingRe = new RegExp('^ {0,' + cap + '}#{1,6}(?:\\s|$)');
      const htmlRe = new RegExp('^ {0,' + cap + '}(?:</?(?:' + TAG + ')(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)', 'i');
      const quoteRe = new RegExp('^ {0,' + cap + '}>');
      let currentContent = content;
      while (rest.length > 0) {
        const nl = rest.indexOf('\n');
        const line = nl === -1 ? rest : rest.slice(0, nl);
        if (
          fencesRe.test(line) ||
          headingRe.test(line) ||
          htmlRe.test(line) ||
          quoteRe.test(line) ||
          nextBulletRe.test(line) ||
          hrRe.test(line)
        ) {
          break;
        }
        const expanded = line.replace(/^[ \t]+/, (v) => expandTabs(v, 0));
        if (expanded.search(OTHER.nonSpace) >= indent || !line.trim()) {
          itemText += '\n' + expanded.slice(indent);
        } else {
          if (
            isBlankContent ||
            currentContent.replace(/\t/g, '    ').search(OTHER.nonSpace) >= 4 ||
            fencesRe.test(currentContent) ||
            headingRe.test(currentContent) ||
            htmlRe.test(currentContent) ||
            hrRe.test(currentContent)
          ) {
            break;
          }
          let add = line;
          if (/^ {0,3}(?:=+|-+) *$/.test(line) && BLOCK.lheading.test(itemText + '\n' + line)) {
            add = '    ' + expanded.replace(/^ {0,3}/, '');
          }
          itemText += '\n' + add;
        }
        isBlankContent = !line.trim();
        rest = nl === -1 ? '' : rest.slice(nl + 1);
        currentContent = expanded.slice(indent);
      }
    }
    const itemRaw = src.slice(itemStart, src.length - rest.length);
    if (!list.loose) {
      if (prevItemEndedBlankish) list.loose = true;
      else if (OTHER.doubleBlankLine.test(itemRaw)) prevItemEndedBlankish = true;
    }
    list.items.push({
      text: itemText,
      raw: itemRaw,
      task: OTHER.listTask.test(itemText),
      tokens: null,
      checkbox: null,
      checkboxInPara: false,
    });
  }
  if (list.items.length === 0) return null;
  const lastItem = list.items[list.items.length - 1];
  lastItem.raw = lastItem.raw.trimEnd();
  lastItem.text = lastItem.text.trimEnd();
  list.raw = src.slice(0, src.length - rest.length).trimEnd();
  for (const item of list.items) {
    item.tokens = parseBlocks(item.text, false, ctx);
    if (!list.loose) {
      const spacers = item.tokens.filter((t) => t.type === 'space');
      if (spacers.length > 0 && spacers.some((t) => OTHER.anyLine.test(t.raw))) list.loose = true;
    }
  }
  if (list.loose) {
    for (const item of list.items) {
      for (const t of item.tokens) if (t.type === 'text') t.type = 'paragraph';
    }
  }
  for (const item of list.items) {
    if (!item.task) continue;
    const firstTok = item.tokens[0];
    if (firstTok && (firstTok.type === 'text' || firstTok.type === 'paragraph')) {
      item.text = item.text.replace(OTHER.listTaskStrip, '');
      firstTok.raw = firstTok.raw.replace(OTHER.listTaskStrip, '');
      firstTok.text = firstTok.text.replace(OTHER.listTaskStrip, '');
      const box = OTHER.listTaskBox.exec(item.raw);
      if (box) {
        item.checkbox = { checked: box[0] !== '[ ]' };
        item.checkboxInPara = list.loose;
      }
    } else {
      item.task = false;
    }
  }
  return list;
}

function tableToken(src, ctx) {
  const m = BLOCK.table.exec(src);
  if (!m) return null;
  if (!/[:|]/.test(m[2])) return null;
  const headerCells = splitRow(m[1]);
  const alignParts = m[2].replace(/^\||\| *$/g, '').split('|');
  if (headerCells.length !== alignParts.length) return null;
  const align = alignParts.map((part) => {
    if (/^ *-+: *$/.test(part)) return 'right';
    if (/^ *:-+: *$/.test(part)) return 'center';
    if (/^ *:-+ *$/.test(part)) return 'left';
    return null;
  });
  const rowsText = m[3] && m[3].trim() ? m[3].replace(/\n[ \t]*$/, '').split('\n') : [];
  const table = {
    type: 'table',
    raw: stripTrailingNewlines(m[0]),
    header: headerCells.map((cell, i) => ({ text: cell, align: align[i], header: true })),
    rows: rowsText.map((line) =>
      splitRow(line, headerCells.length).map((cell, i) => ({ text: cell, align: align[i], header: false })),
    ),
  };
  return table;
}

// ------------------------------------------------------------ inline level

const LABEL_SRC = String.raw`(?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|\`+(?!\`)[^\`]*?\`+(?!\`)|\`\`+(?=\])|[^\[\]\\\u0060])*?`;
const REF_SRC = String.raw`(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+`;
const LINK_RE = new RegExp(
  String.raw`^!?\[(` +
    LABEL_SRC +
    String.raw`)\]\([ \t\n]*(<(?:\\.|[^\n<>\x5c])+>|[^ \t\n\x00-\x1f]+|(?=\)))` + String.raw`(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)))?[ \t\n]*\)`,
);
const REFLINK_RE = new RegExp(String.raw`^!?\[(` + LABEL_SRC + String.raw`)\]\[(` + REF_SRC + String.raw`)\]`);
const NOLINK_RE = new RegExp(String.raw`^!?\[(` + REF_SRC + String.raw`)\](?:\[\])?`);
const SEARCH_LABEL_SRC = String.raw`(?:[^\[\]\\\u0060]*(?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|\`+(?!\`)[^\`]*?\`+(?!\`)|\`\`+(?=\]))){0,999}?[^\[\]\\\u0060]*?`;
const SEARCH_REF_SRC = String.raw`(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}`;
const REFLINK_SEARCH_RE = new RegExp(
  String.raw`!?\[(` + SEARCH_LABEL_SRC + String.raw`)\]\[(` + SEARCH_REF_SRC + String.raw`)\]|!?\[(` + SEARCH_REF_SRC + String.raw`)\](?:\[\])?(?!\()`,
  'g',
);
const BLOCK_SKIP_RE = new RegExp(
  String.raw`\[(?:[^\[\]\`]|(?<a>\`+)[^\`]+\k<a>(?!\`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)|(?<!\`)((?<b>\`+)[^\`]+\k<b>(?!\`))|<(?! )[^<>]*?>`,
  'g',
);
const ANY_PUNCT_OUTSIDE_CODE_RE = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu;
const ANY_PUNCT_RE = /\\([\p{P}\p{S}])/gu;

const INLINE = {
  escape: /^\\([!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~])/,
  code: /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/,
  br: /^( {2,}|\\)\n(?!\s*$)[ \t]*/,
  tag: new RegExp(
    String.raw`^(?:` +
      String.raw`<!--(?:-?>|[\s\S]*?-->)` +
      String.raw`|</[a-zA-Z][a-zA-Z0-9-]*\s*>|<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>` + '`]+)?)*?\\s*/?>|<\\?[\\s\\S]*?\\?>|<![a-zA-Z]+\\s[\\s\\S]*?>|<!\\[CDATA\\[[\\s\\S]*?\\]\\]>)',
  ),
  autolink: new RegExp(
    String.raw`^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*|[a-zA-Z0-9.!#$%&'*+/=?^_\`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>`,
  ),
  url: new RegExp(
    String.raw`^(?:mailto:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])|xmpp:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])(?:\/[A-Za-z0-9@.]+)?)` +
      String.raw`|^((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*` +
      String.raw`|^[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])`,
  ),
  backpedal: /(?:[^?!.,:;*_'\"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+/,
  emLDelim: /^(?:\*+(?:((?!\*)(?!~)[\p{P}\p{S}])|([^\s*]))?)|^_+(?:((?!_)(?!~)[\p{P}\p{S}])|([^\s_]))?/u,
  emRDelimAst: new RegExp(
    String.raw`^[^_*]*?__[^_*]*?\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?=[\s]|$)|(?:[^\s\p{P}\p{S}]|~)(\*+)(?!\*)(?=(?!~)[\s\p{P}\p{S}]|$)|(?!\*)(?!~)[\s\p{P}\p{S}](\*+)(?=(?:[^\s\p{P}\p{S}]|~))|[\s](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?:[^\s\p{P}\p{S}]|~)(\*+)(?=(?:[^\s\p{P}\p{S}]|~))`,
    'gu',
  ),
  emRDelimUnd: new RegExp(
    String.raw`^[^_*]*?\*\*[^_*]*?_[^_*]*?(?=\*\*)|[^_]+(?=[^_])|(?!_)[\p{P}\p{S}](_+)(?=[\s]|$)|[^\s\p{P}\p{S}](_+)(?!_)(?=[\s\p{P}\p{S}]|$)|(?!_)[\s\p{P}\p{S}](_+)(?=[^\s\p{P}\p{S}])|[\s](_+)(?!_)(?=[\p{P}\p{S}])|(?!_)[\p{P}\p{S}](_+)(?!_)(?=[\p{P}\p{S}])`,
    'gu',
  ),
  delLDelim: /^~~?(?:((?!~)[\p{P}\p{S}])|[^\s~])/u,
  delRDelim: new RegExp(
    String.raw`^[^~]+(?=[^~])|(?!~)[\p{P}\p{S}](~~?)(?=[\s]|$)|[^\s\p{P}\p{S}](~~?)(?!~)(?=[\s\p{P}\p{S}]|$)|(?!~)[\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])|[\s](~~?)(?!~)(?=[\p{P}\p{S}])|(?!~)[\p{P}\p{S}](~~?)(?!~)(?=[\p{P}\p{S}])|[^\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])`,
    'gu',
  ),
  punctuation: /^((?![*_])[\s\p{P}\p{S}])/u,
  startATag: /^<a /i,
  endATag: /^<\/a>/i,
  startPreTag: /^<(pre|code|kbd|script)(\s|>)/i,
  endPreTag: /^<\/(pre|code|kbd|script)(\s|>)/i,
};

function punctTest(ch) {
  if (!ch) return false;
  return INLINE.punctuation.test(ch);
}

// Positions of the last plausible closing delimiter runs in a masked
// string, per delimiter character.
function closerInfo(masked) {
  const info = { '*': -1, _: -1, '~': -1 };
  const n = masked.length;
  for (let s = 0; s < n; s++) {
    const r = masked[s];
    if (r !== '*' && r !== '_' && r !== '~') continue;
    let i = s + 1;
    while (i < n && masked[i] === r) i++;
    const before = s === 0 ? '\n' : masked[s - 1];
    if (before !== ' ' && before !== '\t' && before !== '\n' && before !== '\r' && before !== '\f') {
      info[r] = s;
    }
    s = i - 1;
  }
  return info;
}

function linkInText(text, ctx) {
  if (!text.includes('[')) return false;
  for (const match of text.matchAll(BLOCK_SKIP_RE)) {
    if (LINK_RE.test(match[0]) && text.charAt(match.index - 1) !== '!') return true;
  }
  for (const match of text.matchAll(REFLINK_SEARCH_RE)) {
    const s = match[0];
    const r = s.lastIndexOf('[');
    if (s.charAt(0) === '!' || !ctx.links.has(normalizeRef(s.slice(r + 1, -1)))) continue;
    if (r > 1 && linkInText(s.slice(1, r - 1), ctx)) continue;
    return true;
  }
  return false;
}

// Build the masked copy of an inline string used by the emphasis scan:
// resolvable link spans collapse to a placeholder word, code spans keep
// their fences but lose inner backticks, escapes become filler.
function buildMask(src, ctx) {
  let t = src;
  if (t.includes('[')) {
    const collapse = (r) => {
      const o = r.lastIndexOf('[');
      if (!ctx.links.has(normalizeRef(r.slice(o + 1, -1)))) return r;
      if (o > 1 && r.charAt(0) !== '!') {
        const inner = r.slice(1, o - 1);
        if (linkInText(inner, ctx)) {
          return '[' + inner.replace(REFLINK_SEARCH_RE, collapse) + '][' + 'a'.repeat(r.length - o - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(r.length - 2) + ']';
    };
    t = t.replace(REFLINK_SEARCH_RE, collapse);
  }
  t = t.replace(ANY_PUNCT_OUTSIDE_CODE_RE, (n, g1, g2) =>
    g2 ? '+'.repeat(n.length) : g1 ? g1 + n.slice(g1.length, -g1.length).replace(/`/g, '+') + g1 : n,
  );
  t = t.replace(BLOCK_SKIP_RE, (n) => '[' + 'a'.repeat(Math.max(0, n.length - 2)) + ']');
  return t;
}

function makeLinkToken(raw, label, href, title, isImage, ctx) {
  const text = label.replace(/\\([\[\]])/g, '$1');
  const savedInLink = ctx.inLink;
  const savedEmitted = ctx.linkEmitted;
  const savedRawBlock = ctx.inRawBlock;
  ctx.inLink = true;
  ctx.linkEmitted = false;
  const tokens = tokenizeInline(text, ctx);
  const emitted = ctx.linkEmitted;
  ctx.linkEmitted = savedEmitted;
  ctx.inLink = savedInLink;
  if (!isImage) {
    if (emitted) {
      ctx.inRawBlock = savedRawBlock;
      return null;
    }
    ctx.linkEmitted = true;
  }
  return { type: isImage ? 'image' : 'link', raw, href, title, text, tokens };
}

// True when the label text contains an HTML tag or angle autolink that
// would extend past the end of the label.
function labelHasHtml(label, fullSrc, offset) {
  if (!label.includes('<')) return false;
  for (let s = 0; s < label.length; s++) {
    if (label[s] === '\\') {
      s++;
      continue;
    }
    if (label[s] === '`') {
      const cm = INLINE.code.exec(label.slice(s));
      if (cm) {
        s += cm[0].length - 1;
        continue;
      }
    }
    if (label[s] !== '<') continue;
    const rest = fullSrc.slice(offset + s);
    const tm = INLINE.tag.exec(rest) || INLINE.autolink.exec(rest);
    if (tm) {
      if (tm[0].length > label.length - s) return true;
      s += tm[0].length - 1;
    }
  }
  return false;
}

function linkToken(src, ctx) {
  if (ctx.linkParenPossible === false) return null;
  const m = LINK_RE.exec(src);
  if (!m) return null;
  const isImage = m[0].charAt(0) === '!';
  const label = m[1];
  if (labelHasHtml(label, src, isImage ? 2 : 1)) return null;
  let raw = m[0];
  let href = m[2];
  let titlePart = m[3];
  const hrefTrim = href.trim();
  if (hrefTrim.startsWith('<')) {
    if (!hrefTrim.endsWith('>')) return null;
    const stripped = trimRightChar(hrefTrim.slice(0, -1), '\\');
    if ((hrefTrim.length - stripped.length) % 2 === 0) return null;
  } else {
    const balance = parenBalance(href, '()');
    if (balance === -2) return null;
    if (balance > -1) {
      const total = (isImage ? 5 : 4) + label.length + balance;
      href = href.substring(0, balance);
      raw = m[0].substring(0, total).trim();
      titlePart = undefined;
    }
  }
  const rawStripped = trimRightChar(raw.slice(0, -1), '\\');
  if ((raw.length - rawStripped.length) % 2 === 0) return null;
  let hrefOut = href.trim();
  if (hrefOut.startsWith('<')) hrefOut = hrefOut.slice(1, -1);
  hrefOut = hrefOut.replace(ANY_PUNCT_RE, '$1');
  const title = titlePart ? titlePart.slice(1, -1).replace(ANY_PUNCT_RE, '$1') : '';
  return makeLinkToken(raw, label, hrefOut, title || null, isImage, ctx);
}

function reflinkToken(src, ctx) {
  const m = REFLINK_RE.exec(src) || NOLINK_RE.exec(src);
  if (!m) return null;
  const isImage = m[0].charAt(0) === '!';
  if (labelHasHtml(m[1], src, isImage ? 2 : 1)) return null;
  const def = ctx.links.get(normalizeRef(m[2] || m[1]));
  if (!def) {
    const ch = m[0].charAt(0);
    return { type: 'text', raw: ch, text: ch, fromReflink: true };
  }
  return makeLinkToken(m[0], m[1], def.href, def.title ?? null, isImage, ctx);
}

function emStrongToken(src, masked, prevChar, closers, ctx) {
  const m = INLINE.emLDelim.exec(src);
  if (!m || (!m[1] && !m[2] && !m[3] && !m[4])) return null;
  const ch = m[0][0];
  const sameRun = prevChar === ch;
  const pos = masked.length - src.length;
  let runStart = pos;
  while (runStart > 0 && masked[runStart - 1] === ch) runStart--;
  const beforeRun = [...masked.slice(Math.max(0, runStart - 2), runStart)].at(-1) ?? '';
  const beforeIsPunct = beforeRun === '*' || beforeRun === '_' || punctTest(beforeRun);
  const effPrev = runStart < pos ? beforeRun : prevChar;
  const effPrevPunct = runStart < pos ? beforeIsPunct : punctTest(effPrev);
  if (m[4] && /[\p{L}\p{N}]/u.test(effPrev)) return null;
  const punctAfter = m[1] || m[3] || '';
  if (!(!punctAfter || !effPrev || effPrevPunct)) return null;
  const openLen = [...m[0]].length - 1;
  let balance = openLen;
  let midTotal = 0;
  const ruleBase = pos - runStart + openLen;
  const canMid = !!beforeRun.trim() && (!!punctAfter || (ch === '*' && !beforeIsPunct));
  const lastCloser = closers[ch];
  const afterOpen = pos + openLen;
  if (lastCloser < afterOpen) return null;
  const rest = masked.slice(afterOpen);
  const limit = lastCloser - afterOpen;
  const delimRe = ch === '*' ? INLINE.emRDelimAst : INLINE.emRDelimUnd;
  delimRe.lastIndex = 0;
  let m2;
  while ((m2 = delimRe.exec(rest)) !== null && m2.index <= limit) {
    const g = m2[1] || m2[2] || m2[3] || m2[4] || m2[5] || m2[6];
    if (!g) continue;
    const b = [...g].length;
    if (m2[3] || m2[4]) {
      balance += b;
      continue;
    }
    if (m2[5] || m2[6] || canMid) {
      if (sameRun && (m2[5] || m2[6])) break;
      if (ruleBase % 3 && !((ruleBase + b) % 3)) {
        midTotal += b;
        continue;
      }
    }
    balance -= b;
    if (balance > 0) continue;
    const use = Math.min(b, b + balance + midTotal);
    const firstLen = [...m2[0]][0].length;
    const raw = src.slice(0, openLen + m2.index + firstLen + use);
    if (Math.min(openLen, use) % 2 === 1) {
      const text = raw.slice(1, -1);
      return { type: 'em', raw, text, tokens: tokenizeInline(text, ctx) };
    }
    const text = raw.slice(2, -2);
    return { type: 'strong', raw, text, tokens: tokenizeInline(text, ctx) };
  }
  return null;
}

function delToken(src, masked, prevChar, closers, ctx) {
  const m = INLINE.delLDelim.exec(src);
  if (!m) return null;
  if (!(!m[1] || !prevChar || punctTest(prevChar))) return null;
  const openLen = [...m[0]].length - 1;
  let balance = openLen;
  const pos = masked.length - src.length;
  const lastCloser = closers['~'];
  const afterOpen = pos + openLen;
  if (lastCloser < afterOpen) return null;
  const rest = masked.slice(afterOpen);
  const limit = lastCloser - afterOpen;
  const delimRe = INLINE.delRDelim;
  delimRe.lastIndex = 0;
  let m2;
  while ((m2 = delimRe.exec(rest)) !== null && m2.index <= limit) {
    const g = m2[1] || m2[2] || m2[3] || m2[4] || m2[5] || m2[6];
    if (!g) continue;
    const b = [...g].length;
    if (b !== openLen) continue;
    if (m2[3] || m2[4]) {
      balance += b;
      continue;
    }
    balance -= b;
    if (balance > 0) continue;
    const use = Math.min(b, b + balance);
    const firstLen = [...m2[0]][0].length;
    const raw = src.slice(0, openLen + m2.index + firstLen + use);
    const text = raw.slice(openLen, -openLen);
    return { type: 'del', raw, text, tokens: tokenizeInline(text, ctx) };
  }
  return null;
}

const TEXT_STOP_CHARS = new Set(['\\', '<', '!', '[', '`', '*', '~', '_']);
const EMAIL_AHEAD_RE = /^[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+/;
const PROTOCOL_AHEAD_RE = /^(?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\//;
const MAILTO_AHEAD_RE = /^(?:mailto|xmpp):/;
const HARD_BREAK_AHEAD_RE = /^ {2,}\n/;
const ALNUM_RE = /[A-Za-z0-9]/;

// Consume a run of plain text, stopping where another inline construct
// (or a GFM autolink) can start.
function scanText(src) {
  const first = src[0];
  let i = 1;
  if (first === '`' || first === '~') {
    while (i < src.length && src[i] === first) i++;
  }
  const n = src.length;
  for (let p = i; p < n; p++) {
    const c = src[p];
    if (TEXT_STOP_CHARS.has(c)) return src.slice(0, p);
    if (c === ' ') {
      if (HARD_BREAK_AHEAD_RE.test(src.slice(p))) return src.slice(0, p);
      continue;
    }
    if (c !== ' ' && HARD_BREAK_AHEAD_RE.test(src.slice(p + 1))) return src.slice(0, p + 1);
    if ((c === 'h' || c === 'H' || c === 'f' || c === 'F') && PROTOCOL_AHEAD_RE.test(src.slice(p))) {
      return src.slice(0, p);
    }
    if (c === 'w' && src.startsWith('www.', p)) {
      const prev = src[p - 1];
      if (prev === undefined || /[\s*_~(]/.test(prev)) return src.slice(0, p);
      continue;
    }
    if (ALNUM_RE.test(c) || c === '.' || c === '+' || c === '-') {
      // possible bare email: stop before it when the previous character
      // is not alphanumeric (that character stays in the text run)
      if (p > 0 && !ALNUM_RE.test(src[p - 1]) && EMAIL_AHEAD_RE.test(src.slice(p))) {
        return src.slice(0, p);
      }
      if (p > 0 && !ALNUM_RE.test(src[p - 1]) && MAILTO_AHEAD_RE.test(src.slice(p))) {
        return src.slice(0, p);
      }
    }
  }
  return src;
}

function tokenizeInline(src, ctx) {
  const savedFlag = ctx.linkParenPossible;
  ctx.linkParenPossible = savedFlag && src.includes(')');
  try {
    return tokenizeInlineInner(src, ctx);
  } finally {
    ctx.linkParenPossible = savedFlag;
  }
}

function tokenizeInlineInner(src, ctx) {
  const needsMask = src.includes('*') || src.includes('_') || src.includes('~');
  const masked = needsMask ? buildMask(src, ctx) : src;
  const closers = needsMask ? closerInfo(masked) : { '*': -1, _: -1, '~': -1 };
  const tokens = [];
  let rest = src;
  let prevChar = '';
  let prevWasText = false;
  while (rest.length > 0) {
    let tok = null;
    let m;
    const pc = prevWasText ? prevChar : '';
    prevWasText = false;
    if ((m = INLINE.escape.exec(rest))) {
      tok = { type: 'escape', raw: m[0], text: m[1] };
    } else if ((m = INLINE.tag.exec(rest))) {
      const tag = m[0];
      if (!ctx.inLink && INLINE.startATag.test(tag)) ctx.inLink = true;
      else if (ctx.inLink && INLINE.endATag.test(tag)) ctx.inLink = false;
      if (!ctx.inRawBlock && INLINE.startPreTag.test(tag)) ctx.inRawBlock = true;
      else if (ctx.inRawBlock && INLINE.endPreTag.test(tag)) ctx.inRawBlock = false;
      tok = { type: 'html', raw: tag, text: tag };
    } else if ((tok = linkToken(rest, ctx))) {
      // link or image
    } else if ((tok = reflinkToken(rest, ctx))) {
      // reference link, or a literal bracket character
    } else if ((tok = emStrongToken(rest, masked, pc, closers, ctx))) {
      // emphasis or strong
    } else if ((m = INLINE.code.exec(rest))) {
      let text = m[2].replace(/\n/g, ' ');
      const hasNonSpace = /\S/.test(text);
      if (hasNonSpace && text.startsWith(' ') && text.endsWith(' ')) {
        text = text.substring(1, text.length - 1);
      }
      tok = { type: 'codespan', raw: m[0], text };
    } else if ((m = INLINE.br.exec(rest))) {
      tok = { type: 'br', raw: m[0] };
    } else if ((tok = delToken(rest, masked, pc, closers, ctx))) {
      // strikethrough
    } else if ((m = INLINE.autolink.exec(rest))) {
      const text = m[1];
      tok = {
        type: 'link',
        raw: m[0],
        text,
        href: m[2] === '@' ? 'mailto:' + text : text,
        title: null,
        autolink: true,
        tokens: [{ type: 'text', raw: text, text }],
      };
    } else if (!ctx.inLink && (m = INLINE.url.exec(rest))) {
      if (m[2] === '@') {
        tok = {
          type: 'link',
          raw: m[0],
          text: m[0],
          href: 'mailto:' + m[0],
          title: null,
          autolink: true,
          tokens: [{ type: 'text', raw: m[0], text: m[0] }],
        };
      } else {
        let raw = m[0];
        let prev = '';
        while (prev !== raw) {
          prev = raw;
          const bp = INLINE.backpedal.exec(raw);
          raw = bp ? bp[0] : '';
        }
        if (raw) {
          tok = {
            type: 'link',
            raw,
            text: raw,
            href: m[1] === 'www.' ? 'http://' + raw : raw,
            title: null,
            autolink: true,
            tokens: [{ type: 'text', raw, text: raw }],
          };
        }
      }
    }
    if (!tok) {
      const raw = scanText(rest);
      if (!raw) break;
      const inRaw = ctx.inRawBlock;
      tok = {
        type: 'text',
        raw,
        text: inRaw ? raw : decodeNumericRefs(raw),
        escaped: inRaw,
        fromScanner: true,
      };
    }
    rest = rest.slice(tok.raw.length);
    if (tok.type === 'text') {
      if (tok.fromScanner) {
        if (!tok.raw.endsWith('_')) prevChar = tok.raw.slice(-1);
        prevWasText = true;
      }
      const prevTok = tokens[tokens.length - 1];
      if (prevTok && prevTok.type === 'text' && !tok.fromReflink) {
        prevTok.raw += tok.raw;
        prevTok.text += tok.text;
        continue;
      }
      if (prevTok && prevTok.type === 'text' && tok.fromReflink) {
        prevTok.raw += tok.raw;
        prevTok.text += tok.text;
        continue;
      }
    }
    tokens.push(tok);
  }
  return tokens;
}

// --------------------------------------------------------------- rendering

function checkboxHtml(checked) {
  return '<input ' + (checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
}

function renderTextOnly(tokens) {
  let out = '';
  for (const tok of tokens) {
    switch (tok.type) {
      case 'text':
      case 'escape':
      case 'html':
      case 'codespan':
        out += tok.text;
        break;
      case 'strong':
      case 'em':
      case 'del':
      case 'link':
      case 'image':
        out += renderTextOnly(tok.tokens);
        break;
      case 'br':
        break;
      default:
        break;
    }
  }
  return out;
}

function renderInlineTokens(tokens, ctx) {
  let out = '';
  for (const tok of tokens) out += renderInlineToken(tok, ctx);
  return out;
}

function renderInlineToken(tok, ctx) {
  switch (tok.type) {
    case 'escape':
      return escapeHtml(tok.text, false);
    case 'text':
      return tok.escaped ? tok.text : escapeHtml(tok.text, false);
    case 'html':
      return tok.text;
    case 'codespan':
      return '<code>' + escapeHtml(tok.text, true) + '</code>';
    case 'br':
      return '<br>';
    case 'strong':
      return '<strong>' + renderInlineTokens(tok.tokens, ctx) + '</strong>';
    case 'em':
      return '<em>' + renderInlineTokens(tok.tokens, ctx) + '</em>';
    case 'del':
      return '<del>' + renderInlineTokens(tok.tokens, ctx) + '</del>';
    case 'link': {
      const inner = tok.autolink ? escapeHtml(tok.text, true) : renderInlineTokens(tok.tokens, ctx);
      const cleaned = cleanUrl(tok.href);
      if (cleaned === null) return inner;
      let out = '<a href="' + escapeHtml(cleaned, tok.autolink) + '"';
      if (tok.title) out += ' title="' + escapeHtml(tok.title, false) + '"';
      return out + '>' + inner + '</a>';
    }
    case 'image': {
      const alt = renderTextOnly(tok.tokens);
      const cleaned = cleanUrl(tok.href);
      if (cleaned === null) return escapeHtml(alt, false);
      let out = '<img src="' + escapeHtml(cleaned, false) + '" alt="' + escapeHtml(alt, false) + '"';
      if (tok.title) out += ' title="' + escapeHtml(tok.title, false) + '"';
      return out + '>';
    }
    default:
      return '';
  }
}

function inlineHtml(text, ctx) {
  return renderInlineTokens(tokenizeInline(text, ctx), ctx);
}

function renderBlocks(tokens, ctx) {
  let out = '';
  for (const tok of tokens) out += renderBlock(tok, ctx);
  return out;
}

function renderBlock(tok, ctx) {
  switch (tok.type) {
    case 'space':
    case 'def':
      return '';
    case 'hr':
      return '<hr>\n';
    case 'heading':
      return '<h' + tok.depth + '>' + inlineHtml(tok.text, ctx) + '</h' + tok.depth + '>\n';
    case 'code': {
      const body = tok.text ? escapeHtml(tok.text.replace(/\n$/, '') + '\n', true) : '';
      const langWord = tok.lang ? /^\S*/.exec(tok.lang)[0] : '';
      if (langWord) {
        return '<pre><code class="language-' + escapeHtml(langWord, false) + '">' + body + '</code></pre>\n';
      }
      return '<pre><code>' + body + '</code></pre>\n';
    }
    case 'html':
      return tok.text;
    case 'paragraph':
      return '<p>' + inlineHtml(tok.text, ctx) + '</p>\n';
    case 'text':
      return inlineHtml(tok.text, ctx);
    case 'blockquote':
      return '<blockquote>\n' + renderBlocks(tok.tokens, ctx) + '</blockquote>\n';
    case 'list': {
      const tag = tok.ordered ? 'ol' : 'ul';
      const start = tok.ordered && tok.start !== 1 ? ' start="' + tok.start + '"' : '';
      let out = '<' + tag + start + '>\n';
      for (const item of tok.items) out += renderListItem(item, ctx);
      return out + '</' + tag + '>\n';
    }
    case 'table': {
      let out = '<table>\n<thead>\n<tr>\n';
      for (const cell of tok.header) out += renderCell(cell, ctx);
      out += '</tr>\n</thead>\n';
      if (tok.rows.length > 0) {
        out += '<tbody>';
        for (const row of tok.rows) {
          out += '<tr>\n';
          for (const cell of row) out += renderCell(cell, ctx);
          out += '</tr>\n';
        }
        out += '</tbody>';
      }
      return out + '</table>\n';
    }
    default:
      return '';
  }
}

function renderCell(cell, ctx) {
  const tag = cell.header ? 'th' : 'td';
  const align = cell.align ? ' align="' + cell.align + '"' : '';
  return '<' + tag + align + '>' + inlineHtml(cell.text, ctx) + '</' + tag + '>\n';
}

function renderListItem(item, ctx) {
  let inner = '';
  if (item.checkbox && !item.checkboxInPara) inner += checkboxHtml(item.checkbox.checked);
  let prefixUsed = false;
  for (const tok of item.tokens) {
    if (item.checkbox && item.checkboxInPara && !prefixUsed && (tok.type === 'paragraph' || tok.type === 'text')) {
      prefixUsed = true;
      if (tok.type === 'paragraph') {
        inner += '<p>' + checkboxHtml(item.checkbox.checked) + inlineHtml(tok.text, ctx) + '</p>\n';
      } else {
        inner += checkboxHtml(item.checkbox.checked) + inlineHtml(tok.text, ctx);
      }
      continue;
    }
    inner += renderBlock(tok, ctx);
  }
  if (item.checkbox && item.checkboxInPara && !prefixUsed) {
    inner = '<p>' + checkboxHtml(item.checkbox.checked) + '</p>\n' + inner;
  }
  return '<li>' + inner + '</li>\n';
}

// ------------------------------------------------------------------- entry

export function parse(markdown) {
  const ctx = {
    links: new Map(),
    inLink: false,
    inRawBlock: false,
    linkEmitted: false,
    linkParenPossible: true,
  };
  const src = String(markdown).replace(/\r\n|\r/g, '\n');
  const tokens = parseBlocks(src, true, ctx);
  ctx.inLink = false;
  ctx.inRawBlock = false;
  ctx.linkEmitted = false;
  ctx.linkParenPossible = true;
  return renderBlocks(tokens, ctx);
}
