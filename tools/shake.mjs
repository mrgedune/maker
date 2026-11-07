// Keeps, of a set of ES modules, only the top-level statements that their
// importers need, so the public build carries the part of the engine the
// maker uses and nothing else. It reads code the way the engine is written:
// one statement at a time, imports and exports at the top, semicolons after
// statements. Where a file is not written that way it stops with an error
// rather than guess.
//
// Over-keeping is always safe and is the direction every doubt goes: any
// word in a statement counts as a use of a top-level name of that spelling.

import { posix } from 'node:path';

const KEYWORDS_BEFORE_REGEX = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
const PUNCT_BEFORE_REGEX = new Set([...'(,=:[!&|?{};+-*%<>~^']);
const STARTERS = new Set(['import', 'export', 'function', 'class', 'const', 'let', 'var']);

// Tokens: { t: 'word' | 'num' | 'str' | 'tpl' | 're' | 'p', v, s, e, nl }.
// A template literal is 'tpl' pieces (` text ${ ... } text `) with the
// tokens of its ${} parts between them; nl is set on a token that starts a line.
export function tokenize(src) {
  const toks = [];
  let i = 0;
  let nl = true;
  let last = '';
  const n = src.length;
  const templates = [];
  const push = (t, s) => {
    toks.push({ t, v: src.slice(s, i), s, e: i, nl });
    nl = false;
  };
  const regexAllowed = () => last === '' || (last.length === 1 && PUNCT_BEFORE_REGEX.has(last)) || (last.startsWith('word:') && KEYWORDS_BEFORE_REGEX.has(last.slice(5)));
  function readTemplate(s) {
    while (i < n) {
      const c = src[i];
      if (c === '\\') i += 2;
      else if (c === '`') {
        i += 1;
        push('tpl', s);
        last = 'value';
        return;
      } else if (c === '$' && src[i + 1] === '{') {
        i += 2;
        push('tpl', s);
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
    const s = i;
    if (c === '\n') {
      nl = true;
      i += 1;
    } else if (/\s/.test(c)) i += 1;
    else if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') i++;
    } else if (c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end < 0) throw new Error('unterminated comment');
      if (src.slice(i, end).includes('\n')) nl = true;
      i = end + 2;
    } else if (c === '"' || c === "'") {
      i += 1;
      while (i < n && src[i] !== c) {
        if (src[i] === '\\') i++;
        else if (src[i] === '\n') throw new Error(`unterminated string at ${s}`);
        i++;
      }
      i += 1;
      push('str', s);
      last = 'value';
    } else if (c === '`') {
      i += 1;
      readTemplate(s);
    } else if (c === '}' && templates.length && templates[templates.length - 1] === 0) {
      templates.pop();
      i += 1;
      readTemplate(s);
    } else if (c === '/' && regexAllowed()) {
      i += 1;
      let inClass = false;
      while (i < n) {
        const e = src[i];
        if (e === '\\') i += 2;
        else if (e === '\n') throw new Error(`unterminated regex at ${s}`);
        else if (inClass) {
          if (e === ']') inClass = false;
          i++;
        } else if (e === '[') {
          inClass = true;
          i++;
        } else if (e === '/') break;
        else i++;
      }
      i += 1;
      while (i < n && /[a-z]/i.test(src[i])) i++;
      push('re', s);
      last = 'value';
    } else if (/[A-Za-z_$\u0080-￿]/.test(c)) {
      i += 1;
      while (i < n && /[\w$\u0080-￿]/.test(src[i])) i++;
      push('word', s);
      last = `word:${src.slice(s, i)}`;
    } else if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(d ?? ''))) {
      i += 1;
      while (i < n && /[\w.]/.test(src[i])) i++;
      push('num', s);
      last = 'value';
    } else {
      if (c === '{' && templates.length) templates[templates.length - 1]++;
      if (c === '}' && templates.length) templates[templates.length - 1]--;
      i += src.startsWith('...', i) ? 3 : 1;
      push('p', s);
      last = c === ')' || c === ']' ? 'value' : c;
    }
  }
  if (templates.length) throw new Error('unterminated template expression');
  return toks;
}

const delta = (t) => (t.t !== 'p' ? 0 : '([{'.includes(t.v) ? 1 : ')]}'.includes(t.v) ? -1 : 0);
const unquote = (s) => s.slice(1, -1);
const lineOf = (src, at) => src.slice(0, at).split('\n').length;

// A module's top-level statements, each with what it declares, what it
// exports and what words it uses.
export function parseModule(src, file = 'a module') {
  const toks = tokenize(src);
  const fail = (t, why) => {
    throw new Error(`${file}, line ${lineOf(src, t ? t.s : src.length)}: ${why}`);
  };
  const match = (k) => {
    let d = 0;
    for (let j = k; j < toks.length; j++) {
      d += delta(toks[j]);
      if (d === 0) return j;
    }
    fail(toks[k], 'unmatched bracket');
  };
  const toSemicolon = (k) => {
    let d = 0;
    for (let j = k; j < toks.length; j++) {
      const t = toks[j];
      if (j > k && d === 0 && t.nl && t.t === 'word' && STARTERS.has(t.v) && toks[j + 1]?.v !== '(' && toks[j + 1]?.v !== '.') fail(t, 'a statement with no semicolon before it');
      d += delta(t);
      if (d === 0 && t.t === 'p' && t.v === ';') return j;
      if (d < 0) fail(t, 'unbalanced brackets');
    }
    return toks.length - 1;
  };
  const declEnd = (k) => {
    let j = k;
    if (toks[j].v === 'async') j++;
    if (toks[j].v === 'function') {
      while (j < toks.length && toks[j].v !== '(') j++;
      j = match(j) + 1;
      if (toks[j]?.v !== '{') fail(toks[j], 'a function with no body');
      return match(j);
    }
    let d = 0;
    for (; j < toks.length; j++) {
      if (d === 0 && toks[j].t === 'p' && toks[j].v === '{') return match(j);
      d += delta(toks[j]);
    }
    fail(toks[k], 'a class with no body');
  };
  // Names a declaration (from its keyword on) brings in. Destructuring counts
  // every word in the pattern, which may be too many and is never too few.
  const declared = (a, b) => {
    const k = toks[a].v === 'async' ? a + 1 : a;
    const kw = toks[k].v;
    if (kw === 'function' || kw === 'class') {
      const name = toks[k + 1]?.v === '*' ? toks[k + 2] : toks[k + 1];
      return name?.t === 'word' && name.v !== 'extends' ? [name.v] : [];
    }
    const names = [];
    let j = k + 1;
    while (j <= b) {
      const t = toks[j];
      if (t.t === 'word') names.push(t.v);
      else if (t.v === '{' || t.v === '[') {
        const m = match(j);
        for (let q = j; q < m; q++) if (toks[q].t === 'word') names.push(toks[q].v);
        j = m;
      } else fail(t, 'an unexpected declaration');
      // On to the next declarator, past this one's value.
      let d = 0;
      j += 1;
      while (j <= b && !(d === 0 && (toks[j].v === ',' || toks[j].v === ';'))) {
        d += delta(toks[j]);
        j++;
      }
      if (j > b || toks[j].v === ';') break;
      j += 1;
    }
    return names;
  };
  // { a, b as c, default as d } → [{ name: 'a', as: 'a' }, ...]
  const specList = (a, b) => {
    const out = [];
    for (let j = a; j < b; j++) {
      if (toks[j].v === ',') continue;
      const name = toks[j].t === 'str' ? unquote(toks[j].v) : toks[j].v;
      if (toks[j + 1]?.v === 'as') {
        const as = toks[j + 2].t === 'str' ? unquote(toks[j + 2].v) : toks[j + 2].v;
        out.push({ name, as });
        j += 2;
      } else out.push({ name, as: name });
    }
    return out;
  };
  const uses = (a, b) => {
    const set = new Set();
    for (let j = a; j <= b; j++) if (toks[j].t === 'word' && toks[j - 1]?.v !== '.') set.add(toks[j].v);
    return set;
  };

  const units = [];
  let i = 0;
  while (i < toks.length) {
    const t = toks[i];
    const next = toks[i + 1];
    const u = { kind: 'other', names: [], exports: [] };
    let end;
    if (t.v === ';' ) {
      end = i;
    } else if (t.t === 'word' && t.v === 'import' && next?.v !== '(' && next?.v !== '.') {
      let j = i + 1;
      while (j < toks.length && toks[j].t !== 'str') j++;
      if (j >= toks.length) fail(t, 'an import with no source');
      end = toks[j + 1]?.v === ';' ? j + 1 : j;
      u.kind = 'import';
      u.from = unquote(toks[j].v);
      u.bindings = []; // { imported, local }; imported '*' for a namespace
      let q = i + 1;
      while (q < j && toks[q].v !== 'from') {
        const c = toks[q];
        if (c.v === ',') q++;
        else if (c.v === '*') {
          u.bindings.push({ imported: '*', local: toks[q + 2].v });
          q += 3;
        } else if (c.v === '{') {
          const m = match(q);
          for (const s of specList(q + 1, m)) u.bindings.push({ imported: s.name, local: s.as });
          q = m + 1;
        } else {
          u.bindings.push({ imported: 'default', local: c.v });
          q++;
        }
      }
    } else if (t.t === 'word' && t.v === 'export') {
      if (next.v === '{' || next.v === '*') {
        let j = i + 1;
        if (next.v === '{') {
          j = match(i + 1);
          u.specs = specList(i + 2, j);
        } else if (toks[i + 2]?.v === 'as') {
          u.specs = [{ name: '*', as: toks[i + 3].v }];
          j = i + 3;
        } else u.specs = [{ name: '*', as: '*' }];
        if (toks[j + 1]?.v === 'from') {
          j += 2;
          u.from = unquote(toks[j].v);
        }
        end = toks[j + 1]?.v === ';' ? j + 1 : j;
        u.kind = u.from ? 'reexport' : 'exportList';
        if (!u.from && next.v === '*') fail(t, 'export * with no source');
      } else if (next.v === 'default') {
        const n2 = toks[i + 2];
        const isDecl = n2.v === 'function' || n2.v === 'class' || (n2.v === 'async' && toks[i + 3]?.v === 'function');
        end = isDecl ? declEnd(i + 2) : toSemicolon(i + 2);
        u.kind = 'decl';
        u.names = isDecl ? declared(i + 2, end) : [];
        u.exports = [{ as: 'default', name: u.names[0] ?? null }];
      } else {
        const isDecl = next.v === 'function' || next.v === 'class' || next.v === 'async';
        if (!isDecl && !['const', 'let', 'var'].includes(next.v)) fail(t, 'an export this does not read');
        end = isDecl ? declEnd(i + 1) : toSemicolon(i + 1);
        u.kind = 'decl';
        u.names = declared(i + 1, end);
        u.exports = u.names.map((name) => ({ as: name, name }));
      }
    } else if (t.t === 'word' && (t.v === 'function' || t.v === 'class' || (t.v === 'async' && next?.v === 'function'))) {
      end = declEnd(i);
      u.kind = 'decl';
      u.names = declared(i, end);
    } else if (t.t === 'word' && ['const', 'let', 'var'].includes(t.v)) {
      end = toSemicolon(i);
      u.kind = 'decl';
      u.names = declared(i, end);
    } else {
      end = toSemicolon(i);
    }
    u.start = t.s;
    u.end = toks[end].e;
    u.text = src.slice(u.start, u.end);
    u.uses = uses(i, end);
    u.toks = [i, end];
    units.push(u);
    i = end + 1;
  }
  return { src, toks, units };
}

// Keeps only the listed keys of an object literal a top-level const holds
// (`const NAME = Object.freeze({ key: ..., ... })`). Every key in `need`
// must be there.
export function keepKeys(src, constName, keep, { need = [] } = {}) {
  const { toks, units } = parseModule(src);
  const u = units.find((x) => x.kind === 'decl' && x.names[0] === constName);
  if (!u) throw new Error(`no top-level ${constName}`);
  let open = u.toks[0];
  while (open <= u.toks[1] && toks[open].v !== '{') open++;
  let d = 0;
  let close = open;
  for (; close <= u.toks[1]; close++) {
    d += delta(toks[close]);
    if (d === 0) break;
  }
  const entries = [];
  let from = open + 1;
  d = 0;
  for (let j = open + 1; j <= close; j++) {
    if (j === close || (d === 0 && toks[j].v === ',')) {
      if (j > from) entries.push([from, j - 1]);
      from = j + 1;
    } else d += delta(toks[j]);
  }
  const keyOf = ([a]) => (toks[a].t === 'str' ? unquote(toks[a].v) : toks[a].t === 'word' ? toks[a].v : null);
  const found = new Set(entries.map(keyOf));
  for (const k of need) if (!found.has(k)) throw new Error(`${constName} has no ${k}`);
  const kept = entries.filter((e) => keyOf(e) === null || keep.includes(keyOf(e)));
  const body = kept.map(([a, b]) => `  ${src.slice(toks[a].s, toks[b].e)}`).join(',\n');
  return src.slice(0, toks[open].e) + (body ? `\n${body}\n` : '') + src.slice(toks[close].s);
}

// What modules import from the modules being shaken: { path: [names] } with
// '*' for everything. `read(path)` gives a module's source; paths are posix,
// relative to the site. Returns { path: newSource } for every module kept.
export function shake(read, roots) {
  const parsed = new Map();
  const get = (path) => {
    if (!parsed.has(path)) parsed.set(path, parseModule(read(path), path));
    return parsed.get(path);
  };
  const needs = new Map();
  let changed = true;
  const need = (path, name) => {
    if (!path) return; // a package by name: not ours to shake
    if (!needs.has(path)) {
      needs.set(path, new Set());
      changed = true;
    }
    if (name && !needs.get(path).has(name)) {
      needs.get(path).add(name);
      changed = true;
    }
  };
  for (const [path, names] of Object.entries(roots)) {
    need(path, null);
    for (const name of names) need(path, name);
  }
  const resolve = (from, spec) => (spec.startsWith('.') ? posix.normalize(posix.join(posix.dirname(from), spec)) : null);
  const plans = new Map();

  while (changed) {
    changed = false;
    for (const path of [...needs.keys()]) {
      const { units } = get(path);
      const wanted = needs.get(path);
      const all = wanted.has('*');
      const keep = new Set(); // units kept
      const keepSpecs = new Map(); // export unit → specs kept
      const usedBindings = new Set(); // `${unitIndex}:${local}`
      const declaredBy = new Map();
      units.forEach((u, k) => {
        for (const name of u.names) {
          if (!declaredBy.has(name)) declaredBy.set(name, []);
          declaredBy.get(name).push(k);
        }
      });
      const keepSpec = (k, spec) => {
        if (!keepSpecs.has(k)) keepSpecs.set(k, []);
        if (!keepSpecs.get(k).includes(spec)) keepSpecs.get(k).push(spec);
      };
      const locals = []; // local names whose declarations are needed
      const exported = (as) => {
        let found = false;
        units.forEach((u, k) => {
          if (u.kind === 'decl' && u.exports.some((x) => x.as === as)) {
            keep.add(k);
            found = true;
          } else if (u.kind === 'exportList') {
            for (const s of u.specs) if (s.as === as) {
              keepSpec(k, s);
              locals.push(s.name);
              found = true;
            }
          } else if (u.kind === 'reexport') {
            for (const s of u.specs) if (s.as === as && s.name !== '*') {
              keepSpec(k, s);
              need(resolve(path, u.from), s.name);
              found = true;
            } else if (s.as === as && s.name === '*') {
              keepSpec(k, s);
              need(resolve(path, u.from), '*');
              found = true;
            }
          }
        });
        if (!found && as !== 'default') {
          units.forEach((u, k) => {
            if (u.kind === 'reexport' && u.specs[0].as === '*') {
              keepSpec(k, u.specs[0]);
              need(resolve(path, u.from), as);
              found = true;
            }
          });
        }
        if (!found) throw new Error(`${path} does not export ${as}`);
      };
      if (all) {
        units.forEach((u, k) => {
          if (u.kind === 'decl' && u.exports.length) keep.add(k);
          if (u.kind === 'exportList') for (const s of u.specs) {
            keepSpec(k, s);
            locals.push(s.name);
          }
          if (u.kind === 'reexport') for (const s of u.specs) {
            keepSpec(k, s);
            need(resolve(path, u.from), s.name === '*' ? '*' : s.name);
          }
        });
      } else for (const as of wanted) exported(as);
      units.forEach((u, k) => {
        if (u.kind === 'other') keep.add(k);
        if (u.kind === 'import' && !u.bindings.length) {
          keep.add(k);
          need(resolve(path, u.from), null);
        }
      });
      // Everything the kept statements use, and what that uses, and so on.
      const done = new Set();
      const queue = [...keep];
      const useName = (name) => {
        for (const k of declaredBy.get(name) ?? []) if (!keep.has(k)) {
          keep.add(k);
          queue.push(k);
        }
        units.forEach((u, k) => {
          if (u.kind !== 'import') return;
          for (const b of u.bindings) if (b.local === name && !usedBindings.has(`${k}:${name}`)) {
            usedBindings.add(`${k}:${name}`);
            need(resolve(path, u.from), b.imported);
          }
        });
      };
      for (const name of locals) useName(name);
      while (queue.length) {
        const k = queue.shift();
        if (done.has(k)) continue;
        done.add(k);
        for (const name of units[k].uses) useName(name);
      }
      plans.set(path, { keep, keepSpecs, usedBindings });
    }
  }

  const out = {};
  for (const [path, { keep, keepSpecs, usedBindings }] of plans) {
    const { units } = get(path);
    const parts = [];
    units.forEach((u, k) => {
      if (u.kind === 'import') {
        if (!u.bindings.length) return parts.push(u.text);
        const used = u.bindings.filter((b) => usedBindings.has(`${k}:${b.local}`));
        if (!used.length) return;
        const def = used.find((b) => b.imported === 'default');
        const ns = used.find((b) => b.imported === '*');
        const named = used.filter((b) => b.imported !== 'default' && b.imported !== '*');
        const what = [def && def.local, ns && `* as ${ns.local}`, named.length && `{ ${named.map((b) => (b.imported === b.local ? b.local : `${b.imported} as ${b.local}`)).join(', ')} }`].filter(Boolean);
        return parts.push(`import ${what.join(', ')} from '${u.from}';`);
      }
      if (u.kind === 'exportList' || u.kind === 'reexport') {
        const specs = keepSpecs.get(k);
        if (!specs) return;
        const from = u.from ? ` from '${u.from}'` : '';
        if (specs[0].name === '*') return parts.push(specs[0].as === '*' ? `export *${from};` : `export * as ${specs[0].as}${from};`);
        return parts.push(`export { ${specs.map((s) => (s.name === s.as ? s.name : `${s.name} as ${s.as}`)).join(', ')} }${from};`);
      }
      if (keep.has(k)) parts.push(u.text);
    });
    out[path] = `${parts.join('\n\n')}\n`;
  }
  return out;
}
