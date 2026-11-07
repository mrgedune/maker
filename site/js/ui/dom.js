// Small DOM helpers the screens share.

export const $ = (sel, root = document) => root.querySelector(sel);

// h('button', { class: 'x', onclick }, 'Label', child, ...)
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = Boolean(v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

let toastTimer = 0;
export function toast(text, ms = 2600) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

export function openDialog(...children) {
  const d = document.getElementById('dialog');
  fill(d, ...children);
  if (!d.open) d.showModal();
  return d;
}
export function closeDialog() {
  const d = document.getElementById('dialog');
  if (d.open) d.close();
}

export function downloadBlob(name, blob) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
export const downloadText = (name, text, type = 'text/plain') => downloadBlob(name, new Blob([text], { type }));

export const safeName = (s) => (s || 'world').replace(/[^A-Za-z0-9 _-]+/g, '').trim().replace(/\s+/g, '-').slice(0, 40) || 'world';

// ---------------------------------------------------------------- fields

// A labelled control for one setting from the catalog (or anything shaped
// like it): range, number, check, select, text, color.
export function settingField(spec, value, onInput, { options } = {}) {
  const id = `f-${Math.random().toString(36).slice(2, 8)}`;
  if (spec.type === 'check') {
    const box = h('input', { type: 'checkbox', id, checked: value, onchange: (e) => onInput(e.target.checked) });
    return h('label', { class: 'field check', for: id }, box, h('span', {}, spec.label));
  }
  let control;
  if (spec.type === 'range') {
    const out = h('output', {}, String(value));
    const input = h('input', {
      type: 'range', id, min: spec.min, max: spec.max, step: spec.step ?? 1, value,
      oninput: (e) => { out.textContent = e.target.value; onInput(Number(e.target.value), false); },
      onchange: (e) => onInput(Number(e.target.value), true),
    });
    control = h('div', { class: 'range-row' }, input, out);
  } else if (spec.type === 'number') {
    control = h('input', { type: 'number', id, min: spec.min, max: spec.max, step: spec.step ?? 1, value, onchange: (e) => onInput(Number(e.target.value)) });
  } else if (spec.type === 'select') {
    const opts = options ?? spec.options ?? [];
    control = h('select', { id, onchange: (e) => onInput(e.target.value) },
      opts.map(([v, label]) => h('option', { value: v, selected: v === value }, label)));
    if (!opts.some(([v]) => v === value) && opts.length) control.value = opts[0][0];
  } else if (spec.type === 'color') {
    control = h('input', { type: 'color', id, value, onchange: (e) => onInput(e.target.value) });
  } else {
    control = h('input', { type: 'text', id, value, maxlength: spec.max ?? 80, onchange: (e) => onInput(e.target.value) });
  }
  return h('div', { class: 'field' }, h('label', { for: id }, h('span', { class: 'muted small' }, spec.label)), control, spec.help ? h('div', { class: 'help' }, spec.help) : null);
}

// Like el.replaceChildren(), but skipping null and false and flattening
// arrays, the way h() takes children.
export function fill(el, ...children) {
  el.replaceChildren(...children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false).map((c) => (c instanceof Node ? c : document.createTextNode(String(c)))));
  return el;
}
