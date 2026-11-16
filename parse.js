// SPDX-License-Identifier: MIT
// Fleetmark: an original single-pass markdown renderer.
//
// Architecture: a cursor-driven block tokenizer (first-character dispatch,
// column-aware container stripping for blockquotes and lists) produces a
// token tree; link reference definitions are collected during that pass.
// Inline rendering then runs a flat scanner (plain-text fast path, code
// spans, links, autolinks) whose delimiter runs are resolved by a
// flanking-rule matching pass for emphasis. Output targets byte identity
// with the reference renderer (marked 18.1.3, GFM defaults).

// ---------------------------------------------------------------- helpers

const ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
const ESC_ENCODE = /[&<>"']/g;
const ESC_PLAIN = /[<>"']|&(?!(?:#\d{1,7}|#[Xx][0-9a-fA-F]{1,6}|\w+);)/g;

function escapeHtml(s, encode) {
  if (!s) return s;
  return encode
    ? s.replace(ESC_ENCODE, (c) => ESCAPES[c])
    : s.replace(ESC_PLAIN, (c) => ESCAPES[c]);
}

const PUNCT_ASCII = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';
function isAsciiPunct(ch) {
  return ch !== undefined && PUNCT_ASCII.indexOf(ch) !== -1;
}
const UNICODE_PUNCT = /[\p{P}\p{S}]/u;
const UNICODE_SPACE = /\s|\p{Zs}/u;
function isPunct(ch) {
  if (ch === undefined || ch === '') return false;
  return UNICODE_PUNCT.test(ch);
}
function isSpace(ch) {
  if (ch === undefined || ch === '') return true;
  return UNICODE_SPACE.test(ch);
}

// Unicode case folding for label matching (beyond simple lowercasing:
// sharp s folds to "ss", final sigma to sigma, ligatures expand).
const FOLD_MAP = {
  'ß': 'ss',
  'ς': 'σ',
  'ﬀ': 'ff',
  'ﬁ': 'fi',
  'ﬂ': 'fl',
  'ﬃ': 'ffi',
  'ﬄ': 'ffl',
  'ﬅ': 'st',
  'ﬆ': 'st',
};
function foldCase(str) {
  let out = '';
  for (const ch of str) {
    const low = ch.toLowerCase();
    out += FOLD_MAP[low] || FOLD_MAP[ch] || low;
  }
  return out;
}

// Normalize a link label the way reference lookups do: collapse internal
// whitespace runs to single spaces, trim, and fold case.
function normalizeLabel(label) {
  return foldCase(label.replace(/\s+/g, ' ').trim());
}

// A link label may not contain unescaped '[' or ']' characters.
function labelHasBrackets(label) {
  for (let k = 0; k < label.length; k++) {
    if (label[k] === '\\') {
      k++;
      continue;
    }
    if (label[k] === '[' || label[k] === ']') return true;
  }
  return false;
}

// ------------------------------------------------------------ inline layer
//
// Inline source is scanned into a flat node list:
//   { k: 'text', s }                    raw text (escaped at render)
//   { k: 'html', s, lc, rc }            finished HTML (code span, link, ...)
//   { k: 'run', ch, n, open, close }    a delimiter run (*, _)
// Emphasis is resolved over the list afterwards; groups become
//   { k: 'wrap', tag, kids: [...] }

const SCHEME_AUTOLINK =
  /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^<>\s]*)>/;
const EMAIL_AUTOLINK =
  /^<([a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+)>/;
const EMAIL_BARE =
  /^[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+/;
const URL_BARE = /^(?:[hH][tT][tT][pP][sS]?:\/\/|[fF][tT][pP]:\/\/|www\.)[^\s<>]+/;

const HTML_BLOCK_TAGS =
  /^(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)$/i;

// Find the index just past the backtick run that closes a run of length n
// starting search at `from`; -1 when there is none.
function findCodeClose(s, from, n) {
  let i = from;
  while (i < s.length) {
    const j = s.indexOf('`', i);
    if (j === -1) return -1;
    let m = 0;
    while (s[j + m] === '`') m++;
    if (m === n) return j + m;
    i = j + m;
  }
  return -1;
}

// Scan a bracketed span starting at s[i] === '['. Returns { end, text }
// where end is the index just past the matching ']' and text is the raw
// inner source, or null. Escapes and code spans are skipped over.
function scanBracket(s, i) {
  let depth = 0;
  let j = i;
  while (j < s.length) {
    const c = s[j];
    if (c === '\\') {
      j += 2;
      continue;
    }
    if (c === '`') {
      let m = 0;
      while (s[j + m] === '`') m++;
      const close = findCodeClose(s, j + m, m);
      j = close === -1 ? j + m : close;
      continue;
    }
    if (c === '<') {
      // Skip a tag, comment or autolink as a unit: brackets inside it
      // (including inside quoted attribute values) do not count.
      const skipped = skipTagLike(s, j);
      if (skipped !== -1) {
        j = skipped;
        continue;
      }
      j++;
      continue;
    }
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) return { end: j + 1, text: s.slice(i + 1, j) };
    }
    j++;
  }
  return null;
}

// If s[j] === '<' begins a tag, comment, declaration or autolink,
// return the index just past its closing '>' (quotes honored), else -1.
function skipTagLike(s, j) {
  if (s.startsWith('<!--', j)) {
    const end = s.indexOf('-->', j + 4);
    return end === -1 ? -1 : end + 3;
  }
  const c1 = s[j + 1];
  if (!(c1 === '/' || c1 === '!' || c1 === '?' || (c1 >= 'a' && c1 <= 'z') || (c1 >= 'A' && c1 <= 'Z'))) {
    return -1;
  }
  let k = j + 1;
  let quote = '';
  while (k < s.length) {
    const c = s[k];
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '>') {
      return k + 1;
    } else if (c === '<') {
      return -1;
    }
    k++;
  }
  return -1;
}

// Parse an inline link destination/title beginning just after '('.
// Returns { href, title, end } or null.
function scanLinkDest(s, i) {
  const n = s.length;
  let j = i;
  const skipWs = () => {
    while (j < n && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++;
  };
  skipWs();
  if (j >= n) return null;
  let href;
  if (s[j] === '<') {
    // Angle destination: ends at the first '>' that is not part of a
    // backslash escape pair; may not contain '<' or a newline.
    let k = j + 1;
    let ok = false;
    while (k < n) {
      const c = s[k];
      if (c === '\\') {
        k += 2;
        continue;
      }
      if (c === '>') {
        ok = true;
        break;
      }
      if (c === '<' || c === '\n') break;
      k++;
    }
    if (!ok) return null;
    href = s.slice(j + 1, k);
    j = k + 1;
  } else {
    let depth = 0;
    const start = j;
    while (j < n) {
      const c = s[j];
      if (c === '\\') {
        j += 2;
        continue;
      }
      if (c === '(') depth++;
      else if (c === ')') {
        if (depth === 0) break;
        depth--;
      } else if (c === ' ' || c === '\t' || c === '\n' || c < ' ') break;
      j++;
    }
    if (depth !== 0) return null;
    href = s.slice(start, j);
  }
  const afterDest = j;
  skipWs();
  let title = null;
  if (j < n && s[j] !== ')') {
    if (j === afterDest) return null; // title glued to the destination
    const q = s[j];
    if (q === '"' || q === "'") {
      let k = j + 1;
      while (k < n && s[k] !== q) {
        if (s[k] === '\\') k++;
        k++;
      }
      if (k >= n) return null;
      title = s.slice(j + 1, k);
      j = k + 1;
    } else if (q === '(') {
      let k = j + 1;
      while (k < n && s[k] !== ')') {
        if (s[k] === '\\' || s[k] === '(') {
          if (s[k] === '(') return null;
          k++;
        }
        k++;
      }
      if (k >= n) return null;
      title = s.slice(j + 1, k);
      j = k + 1;
    } else {
      return null;
    }
    skipWs();
  } else {
    j = afterDest;
    skipWs();
  }
  if (j < n && s[j] === ')') {
    return {
      href: unescapePunct(href),
      title: title === null ? null : unescapePunct(title),
      end: j + 1,
    };
  }
  return null;
}

// Trim a bare autolink candidate the way the GFM extended-autolink rules
// (and the reference) do: trailing punctuation is peeled, unbalanced
// closing parens are peeled, and a semicolon that terminates an
// entity-looking tail is peeled (a bare semicolon is kept).
function backpedal(url) {
  let prev;
  do {
    prev = url;
    const last = url[url.length - 1];
    if (last !== undefined && '?!.,:*_~\''.indexOf(last) !== -1) {
      url = url.slice(0, -1);
    } else if (last === ';') {
      // An entity-looking tail &name; is excluded as a whole.
      const ent = /&[a-zA-Z0-9]+;$/.exec(url);
      if (ent) url = url.slice(0, url.length - ent[0].length);
    } else if (last === ')') {
      let open = 0;
      let close = 0;
      for (let k = 0; k < url.length; k++) {
        if (url[k] === '(') open++;
        else if (url[k] === ')') close++;
      }
      if (close > open) url = url.slice(0, -1);
    }
  } while (url !== prev && url.length > 0);
  return url;
}

// Render inline nodes' plain text (for image alt attributes).
function plainText(nodes) {
  let out = '';
  for (const nd of nodes) {
    if (nd.k === 'text') out += nd.s;
    else if (nd.k === 'run') out += nd.ch.repeat(nd.n);
    else if (nd.k === 'trun') out += '~'.repeat(nd.n);
    else if (nd.k === 'wrap') out += plainText(nd.kids);
    else if (nd.k === 'html') out += nd.plain || '';
  }
  return out;
}

// Scan inline source into nodes. `links` is the document link table,
// `inLink` disables link/autolink recognition inside link text.
// Marked's inline masking, applied before emphasis matching: reference
// links with defined labels, inline links, code spans and HTML tags are
// blanked to bracketed runs of "a" (same length), and escaped
// punctuation becomes "+", so the emphasis scan cannot see delimiters
// inside those constructs.
const MASK_LABEL_SRC =
  '(?:[^\\[\\]\\\\`]*(?:\\[(?:\\[(?:\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\]))){0,999}?[^\\[\\]\\\\`]*?';
const MASK_REF_SRC = '(?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\]){1,999}';
const REFLINK_SEARCH_SRC =
  '!?\\[' + MASK_LABEL_SRC + '\\]\\[' + MASK_REF_SRC + '\\]|' +
  '!?\\[' + MASK_REF_SRC + '\\](?:\\[\\])?(?!\\()';
const ANY_PUNCT_OUTSIDE_CODE =
  /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu;
const BLOCK_SKIP = new RegExp(
  '\\[(?:[^\\[\\]`]|(?<a>`+)[^`]+\\k<a>(?!`))*?\\]\\((?:\\\\[\\s\\S]|[^\\\\\\(\\)]|\\((?:\\\\[\\s\\S]|[^\\\\\\(\\)])*\\))*\\)' +
  '|(?<!`)()(?<b>`+)[^`]+\\k<b>(?!`)' +
  '|<(?! )[^<>]*?>',
  'g',
);

function maskReflink(r, links) {
  const o = r.lastIndexOf('[');
  if (!Object.prototype.hasOwnProperty.call(links, normalizeLabel(r.slice(o + 1, -1)))) {
    return r;
  }
  if (o > 1 && r.charAt(0) !== '!') {
    const inner = r.slice(1, o - 1);
    if (maskLinkInText(inner, links)) {
      const re = new RegExp(REFLINK_SEARCH_SRC, 'g');
      return '[' + inner.replace(re, (r2) => maskReflink(r2, links)) +
        '][' + 'a'.repeat(r.length - o - 2) + ']';
    }
  }
  return '[' + 'a'.repeat(r.length - 2) + ']';
}

function maskLinkInText(text, links) {
  if (!text.includes('[')) return false;
  for (const mm of text.matchAll(BLOCK_SKIP)) {
    if (mm[0].startsWith('[') && text[mm.index - 1] !== '!') return true;
  }
  const re = new RegExp(REFLINK_SEARCH_SRC, 'g');
  for (const mm of text.matchAll(re)) {
    const r = mm[0];
    const o = r.lastIndexOf('[');
    if (Object.prototype.hasOwnProperty.call(links, normalizeLabel(r.slice(o + 1, -1)))) {
      return true;
    }
  }
  return false;
}

function maskInlineText(s, links) {
  let t = s;
  if (links && s.includes('[')) {
    const re = new RegExp(REFLINK_SEARCH_SRC, 'g');
    t = t.replace(re, (r) => maskReflink(r, links));
  }
  t = t.replace(ANY_PUNCT_OUTSIDE_CODE, (n, s1, r) =>
    r ? '+'.repeat(n.length)
      : s1 ? s1 + n.slice(s1.length, -s1.length).replace(/`/g, '+') + s1
      : n);
  t = t.replace(BLOCK_SKIP, (n) => '[' + 'a'.repeat(Math.max(0, n.length - 2)) + ']');
  return t;
}

// For each delimiter, the start index of the last run in the masked
// text whose preceding character is not whitespace: the emphasis scan
// may not use a closer beyond it.
function computeLastIdx(m) {
  const last = { '*': -1, '_': -1, '~': -1 };
  for (let i = 0; i < m.length; i++) {
    const c = m[i];
    if (c !== '*' && c !== '_' && c !== '~') continue;
    let j = i;
    while (m[j] === c) j++;
    const prev = i === 0 ? '\n' : m[i - 1];
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      last[c] = i;
    }
    i = j - 1;
  }
  return last;
}

function clsCh(ch) {
  if (ch === undefined) return 'end';
  if (isSpace(ch)) return 'space';
  if (isPunct(ch)) return 'punct';
  return 'word';
}

// In the GFM asterisk scan, "~" classifies as a word character.
function clsChStar(ch) {
  if (ch === '~') return 'word';
  return clsCh(ch);
}

function isPunctSpace(ch) {
  return ch !== '' && (isSpace(ch) || isPunct(ch));
}

// Marked's emStrong: a balance-counting scan over the masked text. At a
// delimiter run, a left-delimiter gate checks the neighbouring
// characters; the scan then walks later runs of the same delimiter,
// classifying each by its neighbours: some runs count as nested openers
// (balance grows), others as closer candidates; a rule-of-three skip
// (with accumulation) applies to the both-flanking classes and, in
// "R mode", to every class. The first run that brings the balance to
// zero closes the match; an odd used-length yields <em>, else <strong>.
function tryEmStrong(s, masked, lastIdx, pos, prevChar) {
  const delim = s[pos];
  let k = 0;
  while (s[pos + k] === delim) k++;
  const after = s[pos + k];
  if (after === undefined || isSpace(after)) return null;
  const d = isPunct(after) && after !== '~' ? after : '';
  let l = pos;
  while (l > 0 && masked[l - 1] === delim) l--;
  const p = l > 0 ? masked[l - 1] : '';
  const h = p === '*' || p === '_' || isPunctSpace(p);
  let n = prevChar;
  if (l < pos) n = p;
  const u = l < pos ? h : isPunctSpace(n);
  if (delim === '_' && d === '' && /[\p{L}\p{N}]/u.test(n)) return null;
  if (!(d === '' || n === '' || u)) return null;
  const R = p.trim() !== '' && (d !== '' || (delim === '*' && !h));
  const o = prevChar === delim;
  const Q = pos + k;
  const v = lastIdx[delim];
  if (v < Q) return null;
  const ee = v - Q;
  const y = (pos - l) + k;
  const spanRe = delim === '*'
    ? /^[^_*]*?__[^_*]*?\*[^_*]*?(?=__)/
    : /^[^_*]*?\*\*[^_*]*?_[^_*]*?(?=\*\*)/;
  const sm = spanRe.exec(masked.slice(Q));
  let j = Q + (sm ? sm[0].length : 0);
  let m = k;
  let f = 0;
  while (j < masked.length) {
    if (masked[j] !== delim) { j++; continue; }
    let q = j;
    while (masked[q] === delim) q++;
    const b = q - j;
    const ctxLen = (j > Q && masked.charCodeAt(j - 1) >= 0xd800 && masked.charCodeAt(j - 1) <= 0xdbff) ? 2 : 1;
    const sIndex = (j - Q) - ctxLen;
    const cls = delim === '*' ? clsChStar : clsCh;
    const B = cls(masked[j - 1]);
    const A = cls(masked[q]);
    j = q;
    if (sIndex > ee) break;
    let g = 0;
    if (B === 'punct' && (A === 'space' || A === 'end')) g = 1;
    else if (B === 'word' && A !== 'word') g = 2;
    else if ((B === 'punct' || B === 'space') && A === 'word') g = 3;
    else if (B === 'space' && A === 'punct') g = 4;
    else if (B === 'punct' && A === 'punct') g = 5;
    else if (delim === '*' && B === 'word' && A === 'word') g = 6;
    if (g === 0) continue;
    if (g === 3 || g === 4) { m += b; continue; }
    if (g === 5 || g === 6 || R) {
      if (o && (g === 5 || g === 6)) return null;
      if (y % 3 !== 0 && (y + b) % 3 === 0) { f += b; continue; }
    }
    m -= b;
    if (m > 0) continue;
    const bUsed = Math.min(b, b + m + f);
    const rawEnd = (j - b) + bUsed;
    const raw = s.slice(pos, rawEnd);
    if (Math.min(k, bUsed) % 2 === 1) {
      return { tag: 'em', content: raw.slice(1, -1), end: rawEnd };
    }
    return { tag: 'strong', content: raw.slice(2, -2), end: rawEnd };
  }
  return null;
}

function scanInline(s, links, inLink, probe, state) {
  const nodes = [];
  const n = s.length;
  let i = 0;
  let textBuf = '';
  const hasDelim = s.includes('*') || s.includes('_');
  const masked = hasDelim ? maskInlineText(s, links) : s;
  const lastIdx = hasDelim ? computeLastIdx(masked) : null;
  const prevCharForRun = () => {
    if (!textBuf) return '';
    const t = textBuf.replace(/_+$/, '');
    return t ? t[t.length - 1] : '';
  };
  const flushText = () => {
    if (textBuf) {
      nodes.push({ k: 'text', s: textBuf });
      textBuf = '';
    }
  };
  const pushHtml = (html, lc, rc, plain) => {
    flushText();
    nodes.push({ k: 'html', s: html, lc, rc, plain: plain || '' });
  };

  while (i < n) {
    const c = s[i];

    if (c === '\\') {
      const d = s[i + 1];
      if (d === '\n') {
        pushHtml('<br>', '\\', '\n');
        i += 2;
        while (s[i] === ' ' || s[i] === '\t') i++;
        continue;
      }
      if (d !== undefined && isAsciiPunct(d)) {
        flushText();
        nodes.push({ k: 'text', s: d, esc: true });
        i += 2;
        continue;
      }
      textBuf += c;
      i++;
      continue;
    }

    if (c === '`') {
      let m = 0;
      while (s[i + m] === '`') m++;
      const close = findCodeClose(s, i + m, m);
      if (close === -1) {
        textBuf += s.slice(i, i + m);
        i += m;
        continue;
      }
      let content = s.slice(i + m, close - m).replace(/\n/g, ' ');
      if (
        content.length > 1 &&
        content[0] === ' ' &&
        content[content.length - 1] === ' ' &&
        /[^ ]/.test(content)
      ) {
        content = content.slice(1, -1);
      }
      pushHtml(
        '<code>' + escapeHtml(content, true) + '</code>',
        '`',
        '`',
        content,
      );
      i = close;
      continue;
    }

    if (c === '<') {
      const rest = s.slice(i);
      let m;
      if (rest.startsWith('<!--')) {
        const end = rest.indexOf('-->');
        if (end !== -1) {
          pushHtml(rest.slice(0, end + 3), '<', '>');
          i += end + 3;
          continue;
        }
      }
      if (rest.startsWith('<![CDATA[')) {
        const end = rest.indexOf(']]>');
        if (end !== -1) {
          pushHtml(rest.slice(0, end + 3), '<', '>');
          i += end + 3;
          continue;
        }
      }
      if (rest.startsWith('<?')) {
        const end = rest.indexOf('?>');
        if (end !== -1) {
          pushHtml(rest.slice(0, end + 2), '<', '>');
          i += end + 2;
          continue;
        }
      }
      if ((m = /^<![A-Z][^>]*>/.exec(rest))) {
        pushHtml(m[0], '<', '>');
        i += m[0].length;
        continue;
      }
      if ((m = SCHEME_AUTOLINK.exec(rest))) {
        const url = m[1];
        pushHtml(
          '<a href="' + escapeHtml(cleanUrl(url)) + '">' + escapeHtml(url) + '</a>',
          '<',
          '>',
          url,
        );
        i += m[0].length;
        continue;
      }
      if ((m = EMAIL_AUTOLINK.exec(rest))) {
        const mail = m[1];
        pushHtml(
          '<a href="mailto:' + escapeHtml(mail) + '">' + escapeHtml(mail) + '</a>',
          '<',
          '>',
          mail,
        );
        i += m[0].length;
        continue;
      }
      if (
        (m = /^<\/[a-zA-Z][a-zA-Z0-9-]*\s*>/.exec(rest)) ||
        (m = /^<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z_:][a-zA-Z0-9_.:-]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*\/?>/.exec(rest))
      ) {
        // An <a> tag flips the document-level in-link state, which
        // suppresses autolinking until the matching close tag.
        if (state) {
          if (/^<\/a[\s>]/i.test(m[0])) state.inLink = false;
          else if (/^<a[\s/>]/i.test(m[0])) state.inLink = true;
        }
        pushHtml(m[0], '<', '>');
        i += m[0].length;
        continue;
      }
      textBuf += c;
      i++;
      continue;
    }

    if (c === '!' && s[i + 1] === '[') {
      const br = scanBracket(s, i + 1);
      if (br) {
        const made = tryLinkTail(s, br, links, true, probe, state);
        if (made) {
          pushHtml(made.html, '!', '>', made.plain);
          i = made.end;
          continue;
        }
      }
      textBuf += c;
      i++;
      continue;
    }

    if (c === '[') {
      const br = scanBracket(s, i);
      if (br) {
        const made = tryLinkTail(s, br, links, false, probe, state);
        if (made) {
          if (probe) probe.link = true;
          pushHtml(made.html, '[', ')', made.plain);
          i = made.end;
          continue;
        }
      }
      textBuf += c;
      i++;
      continue;
    }

    if (c === '*' || c === '_') {
      const em = tryEmStrong(s, masked, lastIdx, i, prevCharForRun());
      if (em) {
        flushText();
        nodes.push({
          k: 'wrap', tag: em.tag,
          kids: scanInline(em.content, links, inLink, probe, state),
        });
        i = em.end;
        continue;
      }
      textBuf += c;
      i++;
      continue;
    }

    if (c === '~') {
      // Strikethrough delimiters are resolved after scanning, the way
      // emphasis runs are: a maximal tilde run becomes a node.
      let m = 0;
      while (s[i + m] === '~') m++;
      flushText();
      nodes.push({ k: 'trun', n: m, open: false, close: false });
      i += m;
      continue;
    }

    if (c === ' ') {
      const brm = /^ {2,}\n/.exec(s.slice(i));
      if (brm) {
        pushHtml('<br>', ' ', '\n');
        i += brm[0].length;
        while (s[i] === ' ' || s[i] === '\t') i++;
        continue;
      }
      textBuf += c;
      i++;
      continue;
    }

    // Bare autolinks (GFM): tried at word-ish starts.
    if (
      !inLink &&
      !(state && state.inLink) &&
      (c === 'h' || c === 'f' || c === 'w' || /[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]/.test(c))
    ) {
      const rest = s.slice(i);
      let m = URL_BARE.exec(rest);
      if (m) {
        const raw = backpedal(m[0]);
        if (raw.length > 0 && raw !== 'www.') {
          const href = raw.startsWith('www.') ? 'http://' + raw : raw;
          pushHtml(
            '<a href="' + escapeHtml(cleanUrl(href)) + '">' + escapeHtml(raw) + '</a>',
            raw[0],
            raw[raw.length - 1],
            raw,
          );
          i += raw.length;
          continue;
        }
      }
      // mailto:/xmpp: joined to a following email address (GFM).
      const schemeM = /^(mailto|xmpp):/.exec(rest);
      if (schemeM) {
        const em = EMAIL_BARE.exec(rest.slice(schemeM[0].length));
        if (em) {
          const afterCh = rest[schemeM[0].length + em[0].length];
          if (afterCh !== '-' && afterCh !== '_') {
            let whole = schemeM[0] + em[0];
            if (schemeM[1] === 'xmpp' && afterCh === '/') {
              // One optional path segment joins the xmpp link.
              const seg = /^\/[^\s/]+/.exec(rest.slice(whole.length));
              if (seg) whole += seg[0];
            }
            pushHtml(
              '<a href="' + escapeHtml(cleanUrl(whole)) + '">' + escapeHtml(whole) + '</a>',
              whole[0],
              whole[whole.length - 1],
              whole,
            );
            i += whole.length;
            continue;
          }
        }
      }
      if ((m = EMAIL_BARE.exec(rest))) {
        const mail = m[0];
        const afterCh = rest[mail.length];
        // An email candidate immediately continued by '-' or '_' is a
        // longer non-email token: no autolink at all.
        if (afterCh !== '-' && afterCh !== '_') {
          pushHtml(
            '<a href="mailto:' + escapeHtml(mail) + '">' + escapeHtml(mail) + '</a>',
            mail[0],
            mail[mail.length - 1],
            mail,
          );
          i += mail.length;
          continue;
        }
      }
    }

    // Plain text run: consume until the next special character or a
    // plausible autolink start.
    let j = i;
    while (j < n) {
      const d = s[j];
      if (
        d === '\\' || d === '`' || d === '<' || d === '[' || d === '*' ||
        d === '_' || d === '~'
      ) break;
      if (d === '!' && s[j + 1] === '[') break;
      if (d === ' ' && /^ {2,}\n/.test(s.slice(j))) break;
      if (
        !inLink &&
        !(state && state.inLink) &&
        (d === 'h' || d === 'H' || d === 'f' || d === 'F' || d === 'w')
      ) {
        if (URL_BARE.test(s.slice(j))) break;
      }
      if (!inLink && !(state && state.inLink) && d === '@') {
        // An email may start earlier in this run: cut the run at the
        // start of the local part so the autolink check sees it.
        let st = j;
        while (st > i && /[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]/.test(s[st - 1])) st--;
        if (st > i) {
          j = st;
          break;
        }
      }
      j++;
    }
    if (j === i) {
      textBuf += c;
      i++;
    } else {
      // If this run contains an email start, cut the run there so the
      // autolink logic above gets its chance on the next iteration.
      const chunk = s.slice(i, j);
      textBuf += chunk;
      i = j;
    }
  }
  flushText();
  return nodes;
}

// Try to complete a link or image after its bracketed text was scanned.
// `br` describes the [...] span (for images, the span after '!').
// Returns { html, end, plain } or null.
function tryLinkTail(s, br, links, isImage, probe, state) {
  const text = br.text;
  let j = br.end;
  let href = null;
  let title = null;
  let end = -1;

  if (s[j] === '(') {
    const dest = scanLinkDest(s, j + 1);
    if (dest) {
      href = dest.href;
      title = dest.title;
      end = dest.end;
    }
  }
  let refSpanSeen = false;
  if (end === -1 && s[j] === '[') {
    const lab = scanBracket(s, j);
    if (lab) {
      refSpanSeen = true;
      const labelText = lab.text === '' ? text : lab.text;
      if (!labelHasBrackets(labelText)) {
        const def = links[normalizeLabel(labelText)];
        if (def) {
          href = def.href;
          title = def.title;
          end = lab.end;
        }
      }
    }
  }
  if (end === -1 && !refSpanSeen) {
    // Shortcut reference: only when no [...] tail was present at all.
    if (!labelHasBrackets(text)) {
      const key = normalizeLabel(text);
      const def = key ? links[key] : null;
      if (def) {
        href = def.href;
        title = def.title;
        end = j;
      }
    }
  }
  if (end === -1 || href === null) return null;

  if (isImage) {
    const altNodes = scanInline(text, links, false, probe, state);
    resolveAll(altNodes);
    const alt = plainText(altNodes);
    let html = '<img src="' + escapeHtml(cleanUrl(href)) + '" alt="' + escapeHtml(alt) + '"';
    if (title !== null) html += ' title="' + escapeHtml(title) + '"';
    html += '>';
    return { html, end, plain: alt };
  }
  // Links may not contain links: if the text itself forms a link, this
  // candidate is rejected and the inner link wins instead.
  const textProbe = { link: false };
  scanInline(text, links, true, textProbe, state ? { inLink: state.inLink } : state);
  if (textProbe.link) return null;
  const inner = renderInline(text, links, true, undefined, state);
  let html = '<a href="' + escapeHtml(cleanUrl(href)) + '"';
  if (title !== null) html += ' title="' + escapeHtml(title) + '"';
  html += '>' + inner + '</a>';
  return { html, end, plain: text };
}

// ------------------------------------------------------- emphasis matching

function nodeFirstChar(nd) {
  if (nd.k === 'text') return nd.s[0];
  if (nd.k === 'run') return nd.ch;
  if (nd.k === 'trun') return '~';
  if (nd.k === 'html') return nd.lc;
  if (nd.k === 'wrap') return nodeFirstChar(nd.kids[0]);
  return '';
}
function nodeLastChar(nd) {
  if (nd.k === 'text') return nd.s[nd.s.length - 1];
  if (nd.k === 'run') return nd.ch;
  if (nd.k === 'trun') return '~';
  if (nd.k === 'html') return nd.rc;
  if (nd.k === 'wrap') return nodeLastChar(nd.kids[nd.kids.length - 1]);
  return '';
}

function resolveEmphasis(nodes) {
  // Compute flanking for every run.
  for (let idx = 0; idx < nodes.length; idx++) {
    const nd = nodes[idx];
    if (nd.k !== 'run') continue;
    const before = idx > 0 ? nodeLastChar(nodes[idx - 1]) : '';
    const after = idx < nodes.length - 1 ? nodeFirstChar(nodes[idx + 1]) : '';
    const beforeWs = isSpace(before);
    const afterWs = isSpace(after);
    const beforeP = isPunct(before);
    const afterP = isPunct(after);
    const leftFlank = !afterWs && (!afterP || beforeWs || beforeP);
    const rightFlank = !beforeWs && (!beforeP || afterWs || afterP);
    if (nd.ch === '*') {
      nd.open = leftFlank;
      nd.close = rightFlank;
    } else {
      nd.open = leftFlank && (!rightFlank || beforeP);
      nd.close = rightFlank && (!leftFlank || afterP);
    }
  }

  // Process closers left to right.
  let ci = 0;
  while (ci < nodes.length) {
    const closer = nodes[ci];
    if (closer.k !== 'run' || !closer.close || closer.n === 0) {
      ci++;
      continue;
    }
    // Find nearest matching opener.
    let oi = ci - 1;
    let matched = false;
    while (oi >= 0) {
      const opener = nodes[oi];
      if (opener.k === 'run' && opener.ch === closer.ch && opener.n > 0 && opener.open) {
        const oddMatch =
          (closer.open || opener.close) &&
          (opener.n + closer.n) % 3 === 0 &&
          !(opener.n % 3 === 0 && closer.n % 3 === 0);
        if (!oddMatch) {
          matched = true;
          break;
        }
      }
      oi--;
    }
    if (!matched) {
      ci++;
      continue;
    }
    const opener = nodes[oi];
    const use = opener.n >= 2 && closer.n >= 2 ? 2 : 1;
    opener.n -= use;
    closer.n -= use;
    const inner = nodes.splice(oi + 1, ci - oi - 1);
    const wrap = { k: 'wrap', tag: use === 2 ? 'strong' : 'em', kids: inner };
    nodes.splice(oi + 1, 0, wrap);
    // Adjust closer index: it shifted left by the removed span, then the
    // wrap was inserted; recompute position of closer.
    ci = oi + 2;
    // Remove exhausted runs.
    if (closer.n === 0) {
      nodes.splice(ci, 1);
    }
    if (opener.n === 0) {
      nodes.splice(oi, 1);
      ci--;
    }
    // If closer still has delimiters, retry it at its new index.
    if (closer.n > 0) {
      ci = nodes.indexOf(closer);
      if (ci === -1) ci = nodes.length;
    }
  }
}

// Strikethrough matching: tilde runs of equal length (1 or 2) pair up
// like emphasis delimiters; a run opens when followed by a non-space
// and closes when preceded by a non-space. Longer runs are inert.
function resolveDel(nodes) {
  for (let idx = 0; idx < nodes.length; idx++) {
    const nd = nodes[idx];
    if (nd.k !== 'trun') continue;
    if (nd.n !== 1 && nd.n !== 2) continue;
    const before = idx > 0 ? nodeLastChar(nodes[idx - 1]) : '';
    const after = idx < nodes.length - 1 ? nodeFirstChar(nodes[idx + 1]) : '';
    nd.open = !isSpace(after);
    nd.close = !isSpace(before);
  }
  let ci = 0;
  while (ci < nodes.length) {
    const closer = nodes[ci];
    if (closer.k !== 'trun' || !closer.close || closer.n === 0) {
      ci++;
      continue;
    }
    let oi = ci - 1;
    let opener = null;
    while (oi >= 0) {
      const cand = nodes[oi];
      if (cand.k === 'trun' && cand.open && cand.n === closer.n) {
        opener = cand;
        break;
      }
      oi--;
    }
    if (!opener) {
      ci++;
      continue;
    }
    const inner = nodes.splice(oi + 1, ci - oi - 1);
    const wrap = { k: 'wrap', tag: 'del', kids: inner };
    nodes.splice(oi + 1, 0, wrap);
    // Remove the (now adjacent) opener and closer runs.
    nodes.splice(oi, 1);
    const closerIdx = nodes.indexOf(closer);
    if (closerIdx !== -1) nodes.splice(closerIdx, 1);
    ci = oi + 1;
  }
}

function resolveAll(nodes) {
  resolveDel(nodes);
  resolveEmphasis(nodes);
  for (const nd of nodes) {
    if (nd.k === 'wrap') resolveAll(nd.kids);
  }
}

function renderNodes(nodes) {
  let out = '';
  for (const nd of nodes) {
    if (nd.k === 'text') {
      out += nd.esc
        ? escapeHtml(nd.s, true)
        : escapeHtml(decodeNumericRefs(nd.s));
    } else if (nd.k === 'html') {
      out += nd.s;
    } else if (nd.k === 'run') {
      out += nd.ch.repeat(nd.n);
    } else if (nd.k === 'trun') {
      out += '~'.repeat(nd.n);
    } else if (nd.k === 'wrap') {
      out += '<' + nd.tag + '>' + renderNodes(nd.kids) + '</' + nd.tag + '>';
    }
  }
  return out;
}

function renderInline(s, links, inLink, probe, state) {
  if (!s) return '';
  const nodes = scanInline(s, links, inLink, probe, state);
  resolveAll(nodes);
  return renderNodes(nodes);
}

// ------------------------------------------------------------- block layer

function isBlankLine(line) {
  return /^[ \t]*$/.test(line);
}

// Column width of the leading whitespace run (tab = next multiple of 4).
function indentCols(line) {
  let col = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === ' ') col++;
    else if (ch === '\t') col = Math.floor(col / 4) * 4 + 4;
    else break;
  }
  return col;
}

// Remove n columns of leading whitespace. Columns are counted from
// baseCol (the column the string starts at), so tab stops stay absolute.
// A tab straddling the cut is replaced by the spaces it still covers;
// with `expand`, later leading tabs are expanded to spaces too (used for
// container content, where inner column math continues).
function stripColsImpl(line, n, expand, baseCol) {
  let col = baseCol;
  const target = baseCol + n;
  let i = 0;
  let out = '';
  while (i < line.length && col < target) {
    const ch = line[i];
    if (ch === ' ') {
      col++;
      i++;
    } else if (ch === '\t') {
      const next = Math.floor(col / 4) * 4 + 4;
      if (next <= target) {
        col = next;
        i++;
      } else {
        out += ' '.repeat(next - target);
        col = next;
        i++;
      }
    } else break;
  }
  if (expand) {
    let c = col;
    while (i < line.length && (line[i] === ' ' || line[i] === '\t')) {
      if (line[i] === ' ') {
        out += ' ';
        c++;
        i++;
      } else {
        const next = Math.floor(c / 4) * 4 + 4;
        out += ' '.repeat(next - c);
        c = next;
        i++;
      }
    }
  }
  return out + line.slice(i);
}

function stripColsRaw(line, n) {
  return stripColsImpl(line, n, false, 0);
}

function stripColsExpand(line, n) {
  return stripColsImpl(line, n, true, 0);
}

// Strip exactly n columns of leading whitespace, but only when the
// line's indent reaches n columns; otherwise the line is untouched.
function stripColsExact(line, n) {
  if (n <= 0) return line;
  if (indentCols(line) < n) return line;
  return stripColsImpl(line, n, true, 0);
}

// Does the inner content collected so far end inside an open
// paragraph? (Determines whether an unmarked line may join as a lazy
// continuation.) Tracks fences and indented code so lazy lines are
// refused after those blocks.
// Reduce a line to its leaf content by unwrapping blockquote markers
// and list item markers, so block classification sees the inner block.
function unwrapLeaf(l) {
  for (let depth = 0; depth < 8; depth++) {
    const q = blockquoteMarker(l);
    if (q !== null) {
      l = q;
      continue;
    }
    const li = listStartInfo(l);
    if (li) {
      l = stripColsImpl(
        l.slice(li.prefixLen),
        li.contentIndentCols - li.markerEndCols,
        true,
        li.markerEndCols
      );
      continue;
    }
    break;
  }
  return l;
}

function innerParaOpen(innerLines, links, noSetextSet, inListItem) {
  let state = 'none';
  let fenceCh = '';
  let fenceLen = 0;
  for (let idx = 0; idx < innerLines.length; idx++) {
    const l = unwrapLeaf(innerLines[idx]);
    if (state === 'fence') {
      if (isFenceClose(l, fenceCh, fenceLen)) state = 'other';
      continue;
    }
    if (isBlankLine(l)) {
      state = 'none';
      continue;
    }
    const fs = fenceStart(l);
    if (fs) {
      state = 'fence';
      fenceCh = fs.ch;
      fenceLen = fs.len;
      continue;
    }
    if (state === 'para') {
      if (indentCols(l) <= 3 && SETEXT_RE.test(l) && !(noSetextSet && noSetextSet.has(idx))) {
        state = 'other';
        continue;
      }
      if (startsInterrupt(l, null, 0, links, inListItem)) {
        state = 'other';
        continue;
      }
      continue;
    }
    if (indentCols(l) >= 4) {
      state = 'code';
      continue;
    }
    if (
      atxHeading(l) ||
      isHrLine(l) ||
      listStartInfo(l) ||
      htmlBlockStart(l, true) !== 0 ||
      blockquoteMarker(l) !== null
    ) {
      state = 'other';
      continue;
    }
    state = 'para';
  }
  return state === 'para';
}

// Percent-encode a link destination the way the reference does.
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return href;
  }
}

// Resolve backslash escapes of ASCII punctuation (destinations, titles).
function unescapePunct(s) {
  return s.replace(/\\([!"#$%&'()*+,\-.\/:;<=>?@\[\\\]^_`{|}~])/g, '$1');
}

// HTML5 remapping for numeric references in the C1 control range.
const C1_REMAP = {
  0x80: 0x20ac, 0x81: 0x81, 0x82: 0x201a, 0x83: 0x192, 0x84: 0x201e,
  0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021, 0x88: 0x2c6, 0x89: 0x2030,
  0x8a: 0x160, 0x8b: 0x2039, 0x8c: 0x152, 0x8d: 0x8d, 0x8e: 0x17d,
  0x8f: 0x8f, 0x90: 0x90, 0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201c,
  0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014, 0x98: 0x2dc,
  0x99: 0x2122, 0x9a: 0x161, 0x9b: 0x203a, 0x9c: 0x153, 0x9d: 0x9d,
  0x9e: 0x17e, 0x9f: 0x178,
};

// Decode numeric character references in text (named references are
// left untouched, like the reference). Invalid code points become
// U+FFFD.
function decodeNumericRefs(s) {
  if (s.indexOf('&#') === -1) return s;
  return s.replace(/&#(\d{1,7});|&#[xX]([0-9a-fA-F]{1,6});/g, (m, dec, hex) => {
    let cp = dec !== undefined ? parseInt(dec, 10) : parseInt(hex, 16);
    if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
      cp = 0xfffd;
    } else if (cp >= 0x80 && cp <= 0x9f) {
      cp = C1_REMAP[cp];
    }
    return String.fromCodePoint(cp);
  });
}

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const ATX_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*)|[ \t]*)$/;
const HR_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const SETEXT_RE = /^ {0,3}(=+|-+)[ \t]*$/;

function fenceStart(line) {
  if (indentCols(line) > 3) return null;
  const m = FENCE_RE.exec(line);
  if (!m) return null;
  if (m[1][0] === '`' && m[2].indexOf('`') !== -1) return null;
  return { ch: m[1][0], len: m[1].length, info: m[2], indent: m[0].length - m[0].trimStart().length - 0 };
}

function isFenceClose(line, ch, len) {
  if (indentCols(line) > 3) return false;
  return new RegExp(
    '^ {0,3}' + (ch === '`' ? '`' : '~') + '{' + len + ',}[ \\t]*$'
  ).test(line);
}

function atxHeading(line) {
  if (indentCols(line) > 3) return null;
  const m = ATX_RE.exec(line);
  if (!m) return null;
  let text = m[2] || '';
  text = text.replace(/[ \t]+$/, '');
  if (/^#+$/.test(text)) text = '';
  else text = text.replace(/[ \t]+#+$/, '');
  return { depth: m[1].length, text };
}

function isHrLine(line) {
  return indentCols(line) <= 3 && HR_RE.test(line);
}

// HTML block start detection. Returns the CM block type (1-7) or 0.
function htmlBlockStart(line, allowType7) {
  const ind = indentCols(line);
  if (ind > 3) return 0;
  const rest = line.slice(line.length - line.trimStart().length);
  if (rest[0] !== '<') return 0;
  let m;
  if ((m = /^<(script|pre|style|textarea)(?=[\s>]|$)/i.exec(rest))) return 1;
  if (rest.startsWith('<!--')) return 2;
  if (rest.startsWith('<?')) return 3;
  if (/^<![A-Z]/.test(rest)) return 4;
  if (rest.startsWith('<![CDATA[')) return 5;
  if ((m = /^<\/?([a-zA-Z][a-zA-Z0-9-]*)(?=[\s/>]|$)/.exec(rest)) && HTML_BLOCK_TAGS.test(m[1])) return 6;
  if (
    allowType7 &&
    (/^<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z_:][a-zA-Z0-9_.:-]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*\/?>[ \t]*$/.test(rest) ||
      /^<\/[a-zA-Z][a-zA-Z0-9-]*\s*>[ \t]*$/.test(rest))
  ) {
    return 7;
  }
  return 0;
}

function parseHtmlBlock(lines, i, type) {
  const collected = [];
  let j = i;
  let text;
  if (type >= 1 && type <= 5) {
    let term;
    if (type === 1) {
      const tag = /^<(script|pre|style|textarea)/i.exec(lines[i].trimStart())[1].toLowerCase();
      term = new RegExp('</' + tag, 'i');
    } else if (type === 2) term = /-->/;
    else if (type === 3) term = /\?>/;
    else if (type === 4) term = />/;
    else term = /\]\]>/;
    let foundTerm = false;
    while (j < lines.length) {
      collected.push(lines[j]);
      const done = term.test(lines[j]);
      j++;
      if (done) {
        foundTerm = true;
        break;
      }
    }
    text = collected.join('\n');
    if (foundTerm) {
      // The terminator line's newline belongs to the block only when
      // more content follows immediately (no blank line), or the block
      // runs to an input that ends with a newline.
      const eofMarker = j === lines.length - 1 && lines[j] === '';
      if (j >= lines.length || eofMarker) {
        if (lines[lines.length - 1] === '' && !text.endsWith('\n')) text += '\n';
      } else if (!isBlankLine(lines[j])) {
        text += '\n';
      }
    }
  } else {
    while (j < lines.length && !isBlankLine(lines[j])) {
      collected.push(lines[j]);
      j++;
    }
    text = collected.join('\n');
    // Ends at a blank line: no trailing newline, except when that
    // "blank line" is just the input's final newline.
    if (j === lines.length - 1 && lines[j] === '') text += '\n';
  }
  return { token: { t: 'html', text }, next: j };
}

// ------------------------------------------------------------ link defs

// Try to parse link reference definition(s) starting at line i.
// Registers into `links`; returns the number of lines consumed (0 = no).
function tryDef(lines, i, links) {
  const window = lines.slice(i, i + 8).join('\n');
  let pos = 0;
  // Up to three columns of indent on the first line.
  let lead = 0;
  while (window[pos] === ' ' && lead < 4) {
    pos++;
    lead++;
  }
  if (lead > 3 || window[pos] === '\t') {
    if (!(window[pos] === '\t' && lead === 0)) return 0;
  }
  if (window[pos] !== '[') return 0;
  const br = scanBracket(window, pos);
  if (!br || br.text.trim() === '' || br.text.length > 999) return 0;
  if (labelHasBrackets(br.text)) return 0;
  let j = br.end;
  if (window[j] !== ':') return 0;
  j++;
  const skipWs = (allowNl) => {
    let sawNl = false;
    while (j < window.length) {
      const c = window[j];
      if (c === ' ' || c === '\t') j++;
      else if (c === '\n' && allowNl && !sawNl) {
        sawNl = true;
        j++;
      } else break;
    }
  };
  skipWs(true);
  let href;
  if (window[j] === '<') {
    const gt = window.indexOf('>', j + 1);
    if (gt === -1) return 0;
    const inner = window.slice(j + 1, gt);
    if (inner.indexOf('\n') !== -1 || inner.indexOf('<') !== -1) return 0;
    href = inner;
    j = gt + 1;
  } else {
    let depth = 0;
    const start = j;
    while (j < window.length) {
      const c = window[j];
      if (c === '\\') {
        j += 2;
        continue;
      }
      if (c === '(') depth++;
      else if (c === ')') {
        if (depth === 0) break;
        depth--;
      } else if (c === ' ' || c === '\t' || c === '\n') break;
      j++;
    }
    if (j === start || depth !== 0) return 0;
    href = window.slice(start, j);
  }
  // Optional title. On the same line it must be separated from the
  // destination by whitespace and followed only by trailing space;
  // junk after a same-line title invalidates the whole definition.
  // A title on the next line that does not parse cleanly is simply
  // not part of the definition (the definition still counts).
  let title = null;
  const titleStart = (ch) => ch === '"' || ch === "'" || ch === '(';
  const parseTitleAt = (q0) => {
    const q = window[q0];
    if (q === '"' || q === "'") {
      let k = q0 + 1;
      while (k < window.length && window[k] !== q) {
        if (window[k] === '\\') k++;
        k++;
      }
      if (window[k] !== q) return null;
      const t = window.slice(q0 + 1, k);
      if (/\n[ \t]*\n/.test(t)) return null; // blank line inside title
      return { title: t, end: k + 1 };
    }
    if (q === '(') {
      let k = q0 + 1;
      while (k < window.length && window[k] !== ')') {
        if (window[k] === '\\') k++;
        else if (window[k] === '(') return null;
        k++;
      }
      if (window[k] !== ')') return null;
      const t = window.slice(q0 + 1, k);
      if (/\n[ \t]*\n/.test(t)) return null;
      return { title: t, end: k + 1 };
    }
    return null;
  };
  const skipLineWs = (p) => {
    while (window[p] === ' ' || window[p] === '\t') p++;
    return p;
  };
  let p = skipLineWs(j);
  if (p >= window.length || window[p] === '\n') {
    if (window[p] === '\n') {
      // Possible title on the next line.
      const q = skipLineWs(p + 1);
      if (titleStart(window[q])) {
        const t = parseTitleAt(q);
        if (t) {
          const r = skipLineWs(t.end);
          if (r >= window.length || window[r] === '\n') {
            title = t.title;
            j = r;
          } else {
            j = p;
          }
        } else {
          j = p;
        }
      } else {
        j = p;
      }
    } else {
      j = p;
    }
  } else if (titleStart(window[p])) {
    if (p === j) return 0; // title glued to the destination
    const t = parseTitleAt(p);
    if (!t) return 0;
    const r = skipLineWs(t.end);
    if (r < window.length && window[r] !== '\n') return 0;
    title = t.title;
    j = r;
  } else {
    return 0;
  }
  const consumedText = window.slice(0, j);
  const consumedLines = consumedText.split('\n').length;
  const key = normalizeLabel(br.text);
  if (key && !links[key]) {
    links[key] = {
      href: unescapePunct(href),
      title: title === null ? null : unescapePunct(title),
    };
  }
  return consumedLines;
}

// ---------------------------------------------------------------- tables

function splitRow(line) {
  // Marked's splitCells: a pipe preceded by an odd number of
  // backslashes is escaped — it becomes a placeholder (and loses one
  // backslash) instead of splitting. Code spans are NOT respected.
  const s = line.trim();
  const cells = [];
  let cur = '';
  let i = 0;
  if (s[0] === '|') i = 1;
  let endedWithPipe = false;
  for (; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') {
      let n = 0;
      while (s[i + n] === '\\') n++;
      if (s[i + n] === '|') {
        if (n % 2 === 1) {
          cur += '\\'.repeat(n - 1) + 'ǀ';
          i += n;
          endedWithPipe = false;
          continue;
        }
        cur += '\\'.repeat(n);
        i += n - 1;
        endedWithPipe = false;
        continue;
      }
      cur += '\\'.repeat(n);
      i += n - 1;
      endedWithPipe = false;
      continue;
    }
    if (c === '|') {
      cells.push(cur);
      cur = '';
      endedWithPipe = true;
      continue;
    }
    cur += c;
    endedWithPipe = false;
  }
  if (!endedWithPipe) cells.push(cur);
  return cells.map((c) => c.trim().replace(/ǀ/g, '|'));
}

function delimiterAligns(line) {
  const cells = splitRow(line);
  if (cells.length === 0) return null;
  const aligns = [];
  for (const c of cells) {
    if (!/^:?-+:?$/.test(c)) return null;
    const left = c[0] === ':';
    const right = c[c.length - 1] === ':';
    aligns.push(left && right ? 'center' : left ? 'left' : right ? 'right' : null);
  }
  return aligns;
}

function tryTable(lines, i, headerLine) {
  if (i + 1 >= lines.length) return null;
  const aligns = delimiterAligns(lines[i + 1]);
  if (!aligns) return null;
  const header = splitRow(headerLine);
  if (header.length !== aligns.length) return null;
  if (headerLine.indexOf('|') === -1 && lines[i + 1].indexOf('|') === -1) return null;
  const rows = [];
  let j = i + 2;
  while (
    j < lines.length &&
    !isBlankLine(lines[j]) &&
    !fenceStart(lines[j]) &&
    !atxHeading(lines[j]) &&
    !isHrLine(lines[j]) &&
    blockquoteMarker(lines[j]) === null &&
    !listStartInfo(lines[j])
  ) {
    const cells = splitRow(lines[j]);
    while (cells.length < header.length) cells.push('');
    rows.push(cells.slice(0, header.length));
    j++;
  }
  return { token: { t: 'table', header, align: aligns, rows }, next: j };
}

// ------------------------------------------------------------------ lists

function listStartInfo(line) {
  const ind = indentCols(line);
  if (ind > 3) return null;
  const m = /^ {0,3}([-*+]|\d{1,9}[.)])(?=[ \t]|$)/.exec(line);
  if (!m) return null;
  const marker = m[1];
  const ordered = marker[0] >= '0' && marker[0] <= '9';
  const markerWidth = marker.length;
  let col = ind + markerWidth;
  let k = m[0].length;
  let w = 0;
  while (k < line.length && (line[k] === ' ' || line[k] === '\t')) {
    if (line[k] === ' ') {
      col++;
      w++;
    } else {
      const next = Math.floor(col / 4) * 4 + 4;
      w += next - col;
      col = next;
    }
    k++;
  }
  const restEmpty = line.slice(k).trim() === '';
  const contentIndent =
    restEmpty || w === 0 || w > 4 ? ind + markerWidth + 1 : col;
  return {
    ordered,
    bullet: ordered ? null : marker,
    delim: ordered ? marker[marker.length - 1] : null,
    start: ordered ? parseInt(marker, 10) : null,
    indentCols: ind,
    contentIndentCols: contentIndent,
    prefixLen: m[0].length,
    markerEndCols: ind + markerWidth,
  };
}

function sameListKind(a, b) {
  if (a.ordered !== b.ordered) return false;
  return a.ordered ? a.delim === b.delim : a.bullet === b.bullet;
}

function collectItem(lines, j, info) {
  const ci = info.contentIndentCols;
  const firstContent = stripColsImpl(
    lines[j].slice(info.prefixLen),
    ci - info.markerEndCols,
    true,
    info.markerEndCols,
  );
  const itemLines = [firstContent];
  const lazySetext = new Set();
  const lazyIdx = new Set();
  const dedent = Math.min(ci, 4);
  // Track an open fence in the collected (dedented) content: once the
  // fence has a captured content line, later unindented lines that are
  // not its closing fence are absorbed into the item as fence content.
  let fence = null;
  const noteItemLine = (l) => {
    if (fence) {
      if (isFenceClose(l, fence.ch, fence.len)) fence = null;
      else fence.contentLines++;
      return;
    }
    const fs = fenceStart(l);
    if (fs) fence = { ch: fs.ch, len: fs.len, contentLines: 0 };
  };
  noteItemLine(firstContent);
  let hasContent = itemLines[0].trim() !== '';
  let k = j + 1;
  let pendingBlanks = 0;
  while (k < lines.length) {
    const line = lines[k];
    if (isBlankLine(line)) {
      pendingBlanks++;
      k++;
      continue;
    }
    const ind = indentCols(line);
    if (ind >= ci) {
      // An item whose first line is blank holds no content at all when
      // a blank line intervenes before the first real content line.
      if (!hasContent && pendingBlanks > 0) break;
      if (pendingBlanks > 0) {
        for (let b = 0; b < pendingBlanks; b++) {
          itemLines.push('');
          noteItemLine('');
        }
        pendingBlanks = 0;
      }
      const dedented = stripColsExpand(line, ci);
      itemLines.push(dedented);
      noteItemLine(dedented);
      hasContent = true;
      k++;
      continue;
    }
    if (
      pendingBlanks === 0 &&
      fence &&
      fence.contentLines > 0 &&
      !isFenceClose(line, fence.ch, fence.len)
    ) {
      // Absorbed into the item's open fence.
      itemLines.push(line);
      noteItemLine(line);
      hasContent = true;
      k++;
      continue;
    }
    if (pendingBlanks > 0) break;
    if (listStartInfo(line)) break;
    if (isHrLine(line)) break;
    if (fenceStart(line) || atxHeading(line) || htmlBlockStart(line, false)) break;
    if (indentCols(line) <= 3 && /^ {0,3}>/.test(line)) break;
    if (!innerParaOpen(itemLines, null, lazySetext, true)) break;
    // Lazy paragraph continuation.
    const stripped = stripColsExact(line, dedent);
    itemLines.push(stripped);
    lazyIdx.add(itemLines.length - 1);
    if (SETEXT_RE.test(stripped) && indentCols(stripped) <= 3) {
      lazySetext.add(itemLines.length - 1);
    }
    k++;
  }
  return {
    itemLines,
    next: k,
    contentNext: k - pendingBlanks,
    trailingBlanks: pendingBlanks,
    lazySetext,
    lazyIdx,
  };
}

function parseList(lines, i, links, inListItem) {
  const first = listStartInfo(lines[i]);
  const items = [];
  let loose = false;
  let j = i;
  let prevContentIndent = Infinity;
  while (j < lines.length) {
    if (isHrLine(lines[j])) break;
    const info = listStartInfo(lines[j]);
    if (!info) break;
    if (!sameListKind(info, first)) break;
    if (info.indentCols >= prevContentIndent) break;
    const got = collectItem(lines, j, info);
    const itemMeta = {};
    const kids = lexBlocks(
      got.itemLines.join('\n'),
      links,
      got.lazySetext.size ? got.lazySetext : undefined,
      itemMeta,
      got.lazyIdx.size ? got.lazyIdx : undefined,
      true,
    );
    let task = false;
    let checked = false;
    if (kids.length && kids[0].t === 'para') {
      const m = /^\[( |x|X)\](?:[ \t]|$)/.exec(kids[0].text);
      if (m) {
        task = true;
        checked = m[1] !== ' ';
        kids[0].text = kids[0].text.slice(m[0].length);
        if (kids[0].text === '') kids.shift();
      }
    }
    items.push({ kids, task, checked });
    if (itemMeta.blankBetween) loose = true;
    let sibling = false;
    if (got.trailingBlanks > 0 && got.next < lines.length) {
      const ni = listStartInfo(lines[got.next]);
      if (ni && sameListKind(ni, first)) {
        loose = true;
        sibling = true;
      }
    }
    prevContentIndent = info.contentIndentCols;
    if (got.next <= j) break;
    // When no sibling follows, hand the trailing blank lines back to
    // the enclosing level so it can see the block separation.
    j = sibling || got.trailingBlanks === 0 ? got.next : got.contentNext;
  }
  return {
    token: { t: 'list', ordered: first.ordered, start: first.start, loose, items },
    next: j,
  };
}

// ------------------------------------------------------------- blockquotes

function blockquoteMarker(line) {
  // Returns the content of the line after the marker, or null. The marker
  // is '>' plus one optional column of following whitespace.
  if (indentCols(line) > 3) return null;
  let p = 0;
  while (line[p] === ' ') p++;
  if (line[p] !== '>') return null;
  return stripColsImpl(line.slice(p + 1), 1, true, p + 1);
}

function parseBlockquote(lines, i, links, inListItem) {
  const inner = [];
  const lazyFlags = [];
  const noSetext = new Set();
  let j = i;
  while (j < lines.length) {
    const line = lines[j];
    const content = blockquoteMarker(line);
    if (content !== null) {
      inner.push(content);
      lazyFlags.push(false);
      j++;
      continue;
    }
    if (isBlankLine(line)) break;
    // Lazy continuation: only plain paragraph text lines.
    if (
      innerParaOpen(inner, links, noSetext, inListItem) &&
      !fenceStart(line) &&
      !atxHeading(line) &&
      !isHrLine(line) &&
      !listStartInfo(line) &&
      !htmlBlockStart(line, false) &&
      blockquoteMarker(line) === null
    ) {
      // A lazy setext underline never forms a heading in the reference;
      // after another lazy line it is even indented into the text.
      let text = stripColsExact(line, 4);
      if (SETEXT_RE.test(text) && indentCols(text) <= 3) {
        noSetext.add(inner.length);
        if (lazyFlags[lazyFlags.length - 1]) text = '    ' + text.trim();
      }
      inner.push(text);
      lazyFlags.push(true);
      j++;
      continue;
    }
    break;
  }
  const lazySet = new Set();
  lazyFlags.forEach((f, idx) => {
    if (f) lazySet.add(idx);
  });
  const kids = lexBlocks(
    inner.join('\n'),
    links,
    noSetext.size ? noSetext : undefined,
    undefined,
    lazySet.size ? lazySet : undefined,
    inListItem,
  );
  return { token: { t: 'blockquote', kids }, next: j };
}

// ------------------------------------------------------------ main lex loop

function startsInterrupt(line, lines, j, links, inListItem) {
  if (fenceStart(line)) return true;
  if (atxHeading(line)) return true;
  if (isHrLine(line)) return true;
  if (indentCols(line) <= 3 && /^ {0,3}>/.test(line)) return true;
  if (htmlBlockStart(line, false)) return true;
  const li = listStartInfo(line);
  if (li) {
    // A list interrupts a paragraph only when non-empty and, for ordered
    // lists, starting at 1 — except inside a list item, where the
    // reference lets any start number interrupt.
    const after = stripColsImpl(
      line.slice(li.prefixLen),
      li.contentIndentCols - li.markerEndCols,
      true,
      li.markerEndCols
    );
    if (after.trim() !== '' && (!li.ordered || li.start === 1 || inListItem)) return true;
  }
  // Note: link reference definitions do NOT interrupt a paragraph in
  // the reference; such a line stays paragraph text.
  return false;
}

function lexBlocks(src, links, noSetext, meta, lazyLines, inListItem) {
  const lines = src.split('\n');
  const tokens = [];
  let i = 0;
  let pendingBlankSep = false;
  const markSep = () => {
    if (meta && pendingBlankSep && tokens.length > 0) meta.blankBetween = true;
    pendingBlankSep = false;
  };
  while (i < lines.length) {
    const line = lines[i];
    if (isBlankLine(line)) {
      if (tokens.length > 0) pendingBlankSep = true;
      i++;
      continue;
    }
    markSep();
    const ind = indentCols(line);

    const fence = fenceStart(line);
    if (fence) {
      const content = [];
      let j = i + 1;
      const fenceIndent = line.length - line.trimStart().length;
      while (j < lines.length) {
        const l2 = lines[j];
        if (
          indentCols(l2) <= 3 &&
          new RegExp('^ {0,3}' + (fence.ch === '`' ? '`' : '~') + '{' + fence.len + ',}[ \\t]*$').test(l2)
        ) {
          j++;
          break;
        }
        content.push(stripColsRaw(l2, Math.min(fenceIndent, 3)));
        j++;
      }
      tokens.push({
        t: 'code',
        lang: unescapePunct(fence.info.trim().split(/\s+/)[0] || ''),
        text: content.length
          ? content.join('\n') + (content[content.length - 1] === '' ? '' : '\n')
          : '',
      });
      i = j;
      continue;
    }

    const heading = atxHeading(line);
    if (heading) {
      tokens.push({ t: 'heading', depth: heading.depth, text: heading.text });
      i++;
      continue;
    }

    if (isHrLine(line)) {
      tokens.push({ t: 'hr' });
      i++;
      continue;
    }

    if (blockquoteMarker(line) !== null) {
      const got = parseBlockquote(lines, i, links, inListItem);
      tokens.push(got.token);
      i = got.next;
      continue;
    }

    if (listStartInfo(line)) {
      const got = parseList(lines, i, links, inListItem);
      tokens.push(got.token);
      i = got.next;
      continue;
    }

    const htmlType = htmlBlockStart(line, true);
    if (htmlType) {
      const got = parseHtmlBlock(lines, i, htmlType);
      tokens.push(got.token);
      i = got.next;
      continue;
    }

    if (ind >= 4) {
      const content = [];
      let j = i;
      let lastContent = i;
      while (j < lines.length && (isBlankLine(lines[j]) || indentCols(lines[j]) >= 4)) {
        content.push(lines[j]);
        if (!isBlankLine(lines[j])) lastContent = j;
        j++;
      }
      while (content.length && isBlankLine(content[content.length - 1])) content.pop();
      tokens.push({
        t: 'code',
        lang: '',
        text: content.map((l) => stripColsRaw(l, 4)).join('\n') + '\n',
      });
      i = lastContent + 1;
      continue;
    }

    const defLines = tryDef(lines, i, links);
    if (defLines > 0) {
      i += defLines;
      continue;
    }

    const table = tryTable(lines, i, line);
    if (table) {
      tokens.push(table.token);
      i = table.next;
      continue;
    }

    // Paragraph: collect lines until a blank line, a setext underline
    // (which converts it to a heading), a table delimiter row (which
    // converts its last line to a table header), or an interruption.
    // Line contents are kept raw, like the reference.
    const paraLines = [line];
    let j = i + 1;
    let converted = null;
    while (j < lines.length) {
      const l2 = lines[j];
      if (isBlankLine(l2) && (l2 === '' || j < lines.length - 1)) break;
      if (lazyLines && lazyLines.has(j)) {
        // A lazy continuation line is paragraph text by construction,
        // whatever it looks like.
        paraLines.push(l2);
        j++;
        continue;
      }
      if (
        SETEXT_RE.test(l2) &&
        indentCols(l2) <= 3 &&
        !(noSetext && noSetext.has(j))
      ) {
        const firstLine = paraLines[0];
        const headText = [
          stripColsRaw(firstLine, Math.min(indentCols(firstLine), 3)),
          ...paraLines.slice(1),
        ]
          .join('\n')
          .trimEnd();
        converted = {
          t: 'heading',
          depth: l2.trimStart()[0] === '=' ? 1 : 2,
          text: headText,
        };
        j++;
        break;
      }
      // Table interrupting the paragraph: last line becomes the header.
      const aligns = delimiterAligns(l2);
      if (aligns) {
        const headerLine = paraLines[paraLines.length - 1];
        const header = splitRow(headerLine);
        if (
          header.length === aligns.length &&
          (headerLine.indexOf('|') !== -1 || l2.indexOf('|') !== -1)
        ) {
          paraLines.pop();
          const rows = [];
          let k = j + 1;
          while (
            k < lines.length &&
            !isBlankLine(lines[k]) &&
            !fenceStart(lines[k]) &&
            !atxHeading(lines[k]) &&
            !isHrLine(lines[k]) &&
            blockquoteMarker(lines[k]) === null &&
            !listStartInfo(lines[k])
          ) {
            const cells = splitRow(lines[k]);
            while (cells.length < header.length) cells.push('');
            rows.push(cells.slice(0, header.length));
            k++;
          }
          converted = {
            t: 'table',
            header,
            align: aligns,
            rows,
            prefix: paraLines.length
              ? { t: 'para', text: paraLines.join('\n') }
              : null,
          };
          j = k;
          break;
        }
      }
      if (startsInterrupt(l2, lines, j, links, inListItem)) break;
      paraLines.push(l2);
      j++;
    }
    if (converted) {
      if (converted.t === 'table') {
        if (converted.prefix) tokens.push(converted.prefix);
        tokens.push({
          t: 'table',
          header: converted.header,
          align: converted.align,
          rows: converted.rows,
        });
      } else {
        tokens.push(converted);
      }
      i = j;
      continue;
    }
    tokens.push({ t: 'para', text: paraLines.join('\n') });
    i = j;
  }
  return tokens;
}

// --------------------------------------------------------------- rendering

function renderToken(tok, links, state) {
  switch (tok.t) {
    case 'code': {
      const cls = tok.lang ? ' class="language-' + escapeHtml(tok.lang) + '"' : '';
      return '<pre><code' + cls + '>' + escapeHtml(tok.text, true) + '</code></pre>\n';
    }
    case 'heading':
      return '<h' + tok.depth + '>' + renderInline(tok.text, links, false, undefined, state) + '</h' + tok.depth + '>\n';
    case 'hr':
      return '<hr>\n';
    case 'html':
      return tok.text;
    case 'para':
      return '<p>' + renderInline(tok.text, links, false, undefined, state) + '</p>\n';
    case 'blockquote': {
      let out = '<blockquote>\n';
      for (const kid of tok.kids) out += renderToken(kid, links, state);
      return out + '</blockquote>\n';
    }
    case 'table': {
      let out = '<table>\n<thead>\n<tr>\n';
      tok.header.forEach((cell, idx) => {
        out +=
          '<th' +
          (tok.align[idx] ? ' align="' + tok.align[idx] + '"' : '') +
          '>' +
          renderInline(cell, links, false, undefined, state) +
          '</th>\n';
      });
      out += '</tr>\n</thead>\n';
      if (tok.rows.length) {
        out += '<tbody>';
        for (const row of tok.rows) {
          out += '<tr>\n';
          row.forEach((cell, idx) => {
            out +=
              '<td' +
              (tok.align[idx] ? ' align="' + tok.align[idx] + '"' : '') +
              '>' +
              renderInline(cell, links, false, undefined, state) +
              '</td>\n';
          });
          out += '</tr>\n';
        }
        out += '</tbody>';
      }
      return out + '</table>\n';
    }
    case 'list': {
      const tag = tok.ordered ? 'ol' : 'ul';
      let out =
        '<' +
        tag +
        (tok.ordered && tok.start !== 1 ? ' start="' + tok.start + '"' : '') +
        '>\n';
      for (const item of tok.items) out += renderListItem(item, tok.loose, links, state);
      return out + '</' + tag + '>\n';
    }
    default:
      return '';
  }
}

function renderListItem(item, loose, links, state) {
  const checkbox = item.task
    ? '<input ' + (item.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> '
    : '';
  let body = '';
  item.kids.forEach((tok, idx) => {
    if (tok.t === 'para' && !loose) {
      let inner = renderInline(tok.text, links, false, undefined, state);
      if (item.task && idx === 0) inner = checkbox + inner;
      body += inner;
    } else {
      let r = renderToken(tok, links, state);
      if (item.task && idx === 0 && tok.t === 'para') {
        r = '<p>' + checkbox + r.slice(3);
      }
      body += r;
    }
  });
  if (item.task && item.kids.length === 0) body = checkbox;
  return '<li>' + body + '</li>\n';
}

/** The HTML the reference renderer produces for `markdown`. */
export function parse(markdown) {
  const src = String(markdown).replace(/\r\n|\r/g, '\n');
  const links = {};
  const tokens = lexBlocks(src, links);
  const state = { inLink: false };
  let out = '';
  for (const tok of tokens) out += renderToken(tok, links, state);
  return out;
}

