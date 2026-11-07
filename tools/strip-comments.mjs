// Takes the comments out of JavaScript and CSS without changing the code:
// strings, template literals (with their ${} parts) and regular expression
// literals pass through as written. A comment that spanned lines leaves a
// line break behind, so automatic semicolons fall where they did. Then
// trailing spaces and runs of blank lines go, in the code only: the text of
// strings, templates and regexes is never touched.

const KEYWORDS_BEFORE_REGEX = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
const PUNCT_BEFORE_REGEX = new Set([...'(,=:[!&|?{};+-*%<>~^']);

// Code is tidied a piece at a time; literal text goes in as it is.
function writer() {
  const parts = [];
  let code = '';
  return {
    code: (s) => { code += s; },
    literal: (s) => { parts.push(tidyCode(code), s); code = ''; },
    done: () => { parts.push(tidyCode(code)); return parts.join('').replace(/^\n+/, ''); },
  };
}
const tidyCode = (s) => s.replace(/[ \t]+(?=\n)/g, '').replace(/\n{3,}/g, '\n\n');

// The comments in a piece of shader source (GLSL has no strings, so // and
// /* always start one). A comment may not run into a ${} part.
function stripGlsl(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text.startsWith('//', i)) {
      const end = text.indexOf('\n', i);
      if (end < 0) throw new Error('a shader comment runs into a ${} part');
      i = end;
    } else if (text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) throw new Error('a shader comment runs into a ${} part');
      out += text.slice(i, end).includes('\n') ? '\n' : ' ';
      i = end + 2;
    } else out += text[i++];
  }
  return tidyCode(out);
}

// `glsl: true` also takes the comments out of the shader source that the
// file's template literals hold (every template literal in the file must be
// shader source).
export function stripJs(src, { glsl = false } = {}) {
  const out = writer();
  let i = 0;
  const n = src.length;
  // What came last, for telling a regex from a division: '' (start), a
  // punctuation character, 'word:<identifier>', or 'value'.
  let last = '';
  const templates = []; // open ${ depths, innermost last
  const regexAllowed = () => last === '' || (last.length === 1 && PUNCT_BEFORE_REGEX.has(last)) || (last.startsWith('word:') && KEYWORDS_BEFORE_REGEX.has(last.slice(5)));
  const text = (s) => (glsl ? stripGlsl(s) : s);

  function readTemplate() {
    // At a template's text (just after ` or after the } closing a ${ part).
    const start = i;
    while (i < n) {
      const c = src[i];
      if (c === '\\') i += 2;
      else if (c === '`') {
        out.literal(text(src.slice(start, i)) + '`');
        i += 1;
        last = 'value';
        return;
      } else if (c === '$' && src[i + 1] === '{') {
        out.literal(text(src.slice(start, i)) + '${');
        i += 2;
        templates.push(0);
        last = '{';
        return;
      } else i += 1;
    }
    throw new Error('unterminated template literal');
  }

  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end < 0) throw new Error('unterminated comment');
      out.code(src.slice(i, end + 2).includes('\n') ? '\n' : ' ');
      i = end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c) {
        if (src[j] === '\\') j++;
        else if (src[j] === '\n') throw new Error(`unterminated string at ${i}`);
        j++;
      }
      out.literal(src.slice(i, j + 1));
      i = j + 1;
      last = 'value';
      continue;
    }
    if (c === '`') {
      i += 1;
      out.literal('`');
      readTemplate();
      continue;
    }
    if (c === '{' && templates.length) templates[templates.length - 1]++;
    if (c === '}' && templates.length) {
      if (templates[templates.length - 1] === 0) {
        templates.pop();
        i += 1;
        out.literal('}');
        readTemplate();
        continue;
      }
      templates[templates.length - 1]--;
    }
    if (c === '/' && regexAllowed()) {
      let j = i + 1;
      let inClass = false;
      while (j < n) {
        const e = src[j];
        if (e === '\\') j += 2;
        else if (e === '\n') throw new Error(`unterminated regex at ${i}`);
        else if (inClass) {
          if (e === ']') inClass = false;
          j++;
        } else if (e === '[') {
          inClass = true;
          j++;
        } else if (e === '/') break;
        else j++;
      }
      j++;
      while (j < n && /[a-z]/i.test(src[j])) j++;
      out.literal(src.slice(i, j));
      i = j;
      last = 'value';
      continue;
    }
    if (/[A-Za-z_$\u0080-￿]/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w$\u0080-￿]/.test(src[j])) j++;
      const word = src.slice(i, j);
      out.code(word);
      i = j;
      last = `word:${word}`;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(d ?? ''))) {
      let j = i + 1;
      while (j < n && /[\w.]/.test(src[j])) j++;
      out.code(src.slice(i, j));
      i = j;
      last = 'value';
      continue;
    }
    out.code(c);
    i += 1;
    if (!/\s/.test(c)) last = c === ')' || c === ']' ? 'value' : c;
  }
  if (templates.length) throw new Error('unterminated template expression');
  return out.done();
}

// CSS has no regexes or templates; strings are the only thing a comment
// marker could hide in.
export function stripCss(src) {
  const out = writer();
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end < 0) throw new Error('unterminated comment');
      out.code(src.slice(i, end + 2).includes('\n') ? '\n' : ' ');
      i = end + 2;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
      out.literal(src.slice(i, j + 1));
      i = j + 1;
    } else {
      out.code(c);
      i += 1;
    }
  }
  return out.done();
}

// HTML: comments out, everything else as it is. Inline scripts and styles
// go through the JS and CSS strippers.
export function stripHtml(src) {
  return src
    .replace(/<!--[\s\S]*?-->\n?/g, '')
    .replace(/(<script\b[^>]*>)([\s\S]*?)(<\/script>)/gi, (m, a, body, b) => a + (body.trim() ? stripJs(body) : body) + b)
    .replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (m, a, body, b) => a + stripCss(body) + b);
}
