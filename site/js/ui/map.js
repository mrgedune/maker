// The top-down map of one level, drawn on a 2D canvas: blocks by material
// and height, parts as their footprints, wires as arrows. Build and Wiring
// both use it; they decide what a click does.

import { PART } from '../kit/catalog.js';

const sendsSignal = (part) => Boolean(PART[part.type]?.out) || part.type === 'creature';

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const rgba = (hex, a = 1, k = 1) => {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${Math.round(r * k)},${Math.round(g * k)},${Math.round(b * k)},${a})`;
};

export function createMap(canvas, { getDoc, getLevel, mode = 'build' }) {
  const ctx = canvas.getContext('2d');
  const view = { cx: 12, cy: 12, scale: 24 };
  const state = {
    mode,
    hover: null, // { x, y } world
    selected: null,
    ghost: null, // { type, x, y, turn, size } a part about to be placed
    rect: null, // { x0, y0, x1, y1 } a rectangle being dragged
    wireFrom: null, // part id while making a wire
    selectedWire: null,
    highlight: new Set(),
    signals: null, // part id -> on, while a game runs (wiring test)
  };
  let W = 0;
  let H = 0;
  let dpr = 1;

  function resize() {
    const r = canvas.getBoundingClientRect();
    dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    W = Math.max(1, Math.round(r.width));
    H = Math.max(1, Math.round(r.height));
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    draw();
  }

  function fit() {
    const level = getLevel();
    const [w, h] = level.size;
    view.cx = w / 2;
    view.cy = h / 2;
    view.scale = Math.max(4, Math.min((W - 40) / w, (H - 40) / h));
    draw();
  }

  const sx = (x) => (x - view.cx) * view.scale + W / 2;
  const sy = (y) => (y - view.cy) * view.scale + H / 2;
  function toWorld(clientX, clientY) {
    const r = canvas.getBoundingClientRect();
    return { x: (clientX - r.left - W / 2) / view.scale + view.cx, y: (clientY - r.top - H / 2) / view.scale + view.cy };
  }
  function toScreen(x, y) {
    const r = canvas.getBoundingClientRect();
    return { x: r.left + sx(x), y: r.top + sy(y) };
  }

  function zoomAt(clientX, clientY, factor) {
    const before = toWorld(clientX, clientY);
    view.scale = Math.max(3, Math.min(120, view.scale * factor));
    const after = toWorld(clientX, clientY);
    view.cx += before.x - after.x;
    view.cy += before.y - after.y;
    draw();
  }
  function pan(dxPixels, dyPixels) {
    view.cx -= dxPixels / view.scale;
    view.cy -= dyPixels / view.scale;
    draw();
  }

  // The part under a point: smallest footprint first, so a key on a plate
  // can still be picked.
  function partAt(x, y, filter = () => true) {
    const level = getLevel();
    let best = null;
    let bestArea = Infinity;
    for (const part of level.parts) {
      if (!filter(part)) continue;
      const { hx, hy } = footprint(part);
      const pad = Math.max(0.18, 6 / view.scale);
      if (Math.abs(x - part.x) <= hx + pad && Math.abs(y - part.y) <= hy + pad) {
        const area = hx * hy;
        if (area < bestArea) {
          best = part;
          bestArea = area;
        }
      }
    }
    return best;
  }

  function footprint(part) {
    const def = PART[part.type];
    if (def.shape === 'none') return { hx: 0.3, hy: 0.3 };
    if (part.type === 'creature' || part.type === 'start') return { hx: 0.4, hy: 0.4 };
    const quarter = Math.round(part.turn / 90) % 2 === 1;
    const [a, b] = part.size;
    return { hx: (quarter ? b : a) / 2, hy: (quarter ? a : b) / 2 };
  }

  // Wires near a point (for picking a wire to delete).
  function wireAt(x, y) {
    const level = getLevel();
    const byId = new Map(level.parts.map((p) => [p.id, p]));
    let best = null;
    let bestD = 8 / view.scale;
    for (const w of level.wires) {
      const a = byId.get(w.from);
      const b = byId.get(w.to);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / len2));
      const d = Math.hypot(a.x + dx * t - x, a.y + dy * t - y);
      if (d < bestD) {
        bestD = d;
        best = w;
      }
    }
    return best;
  }

  function draw() {
    const doc = getDoc();
    const level = getLevel();
    if (!doc || !level) return;
    const [w, h] = level.size;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#07080b';
    ctx.fillRect(0, 0, W, H);
    const mats = new Map(doc.materials.map((m) => [m.id, m]));
    const floor = mats.get(level.floor);
    ctx.fillStyle = floor ? rgba(floor.color, 1, 0.28) : '#1a1d23';
    ctx.fillRect(sx(0), sy(0), w * view.scale, h * view.scale);

    // Grid.
    if (view.scale >= 6) {
      ctx.lineWidth = 1;
      for (let x = 0; x <= w; x++) {
        ctx.strokeStyle = x % 4 === 0 ? '#ffffff22' : '#ffffff0d';
        ctx.beginPath();
        ctx.moveTo(Math.round(sx(x)) + 0.5, sy(0));
        ctx.lineTo(Math.round(sx(x)) + 0.5, sy(h));
        ctx.stroke();
      }
      for (let y = 0; y <= h; y++) {
        ctx.strokeStyle = y % 4 === 0 ? '#ffffff22' : '#ffffff0d';
        ctx.beginPath();
        ctx.moveTo(sx(0), Math.round(sy(y)) + 0.5);
        ctx.lineTo(sx(w), Math.round(sy(y)) + 0.5);
        ctx.stroke();
      }
    }
    // Blocks: one rectangle per column, lighter the taller it is.
    const cols = new Map();
    for (const [x, y, m, b, t] of level.blocks) {
      const key = y * w + x;
      if (!cols.has(key)) cols.set(key, { x, y, m, spans: [] });
      cols.get(key).spans.push([b, t]);
    }
    const machinesDim = state.mode === 'wiring';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const c of cols.values()) {
      const mat = mats.get(c.m);
      const top = Math.max(...c.spans.map((s) => s[1]));
      const raised = c.spans.every((s) => s[0] > 0);
      const k = 0.45 + Math.min(1, top / 6) * 0.55;
      ctx.fillStyle = rgba(mat?.color ?? '#888888', machinesDim ? 0.55 : 1, k);
      ctx.fillRect(sx(c.x), sy(c.y), view.scale + 0.5, view.scale + 0.5);
      if (raised) {
        ctx.strokeStyle = '#0008';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(sx(c.x), sy(c.y + 1));
        ctx.lineTo(sx(c.x + 1), sy(c.y));
        ctx.stroke();
      }
      if (view.scale >= 22 && !machinesDim) {
        ctx.fillStyle = '#000a';
        ctx.font = `${Math.round(view.scale * 0.38)}px ui-monospace, monospace`;
        const label = c.spans.length > 1 ? `${c.spans.length}×` : raised ? `${c.spans[0][0]}-${top}` : String(top);
        ctx.fillText(label, sx(c.x + 0.5), sy(c.y + 0.52));
      }
    }
    // Level edge.
    ctx.strokeStyle = '#ffffff55';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(sx(0), sy(0), w * view.scale, h * view.scale);

    // Wires.
    const byId = new Map(level.parts.map((p) => [p.id, p]));
    for (const wire of level.wires) {
      const a = byId.get(wire.from);
      const b = byId.get(wire.to);
      if (!a || !b) continue;
      const on = state.signals?.[a.id];
      const sel = state.selectedWire && state.selectedWire.from === wire.from && state.selectedWire.to === wire.to;
      const alpha = state.mode === 'wiring' ? 1 : 0.35;
      arrow(a.x, a.y, b.x, b.y, sel ? '#7fd4ff' : on ? '#4cc38a' : `rgba(255,209,102,${alpha})`, state.mode === 'wiring' ? 2.2 : 1.2);
    }
    // Parts.
    for (const part of level.parts) drawPart(part, part.id === state.selected, state.highlight.has(part.id));
    if (state.wireFrom && state.hover) {
      const a = byId.get(state.wireFrom);
      if (a) arrow(a.x, a.y, state.hover.x, state.hover.y, '#7fd4ff', 2, [6, 4]);
    }
    if (state.ghost) drawPart({ ...state.ghost, id: '_ghost', color: PART[state.ghost.type].color, props: {} }, false, false, 0.55);
    if (state.rect) {
      const { x0, y0, x1, y1, erase } = state.rect;
      ctx.strokeStyle = erase ? '#ff4d4f' : '#7fd4ff';
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 4]);
      ctx.strokeRect(sx(Math.min(x0, x1)), sy(Math.min(y0, y1)), (Math.abs(x1 - x0) + 1) * view.scale, (Math.abs(y1 - y0) + 1) * view.scale);
      ctx.setLineDash([]);
    } else if (state.hover && state.mode === 'build' && state.cellHover) {
      const cx = Math.floor(state.hover.x);
      const cy = Math.floor(state.hover.y);
      if (cx >= 0 && cy >= 0 && cx < w && cy < h) {
        ctx.strokeStyle = '#7fd4ffaa';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(sx(cx), sy(cy), view.scale, view.scale);
      }
    }
  }

  function arrow(x0, y0, x1, y1, color, width, dash) {
    const ax = sx(x0);
    const ay = sy(y0);
    const bx = sx(x1);
    const by = sy(y1);
    const len = Math.hypot(bx - ax, by - ay);
    if (len < 2) return;
    const ux = (bx - ax) / len;
    const uy = (by - ay) / len;
    const end = Math.max(0, len - Math.max(8, view.scale * 0.32));
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = width;
    ctx.setLineDash(dash ?? []);
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(ax + ux * end, ay + uy * end);
    ctx.stroke();
    ctx.setLineDash([]);
    const tip = { x: ax + ux * end, y: ay + uy * end };
    const s = Math.max(6, Math.min(12, view.scale * 0.3));
    ctx.beginPath();
    ctx.moveTo(tip.x + ux * s * 0.2, tip.y + uy * s * 0.2);
    ctx.lineTo(tip.x - ux * s - uy * s * 0.55, tip.y - uy * s + ux * s * 0.55);
    ctx.lineTo(tip.x - ux * s + uy * s * 0.55, tip.y - uy * s - ux * s * 0.55);
    ctx.closePath();
    ctx.fill();
  }

  function drawPart(part, selected, highlighted, alpha = 1) {
    const def = PART[part.type];
    const machine = def.kind === 'sense' || def.kind === 'logic' || def.kind === 'doer' || def.kind === 'light' || part.type === 'door' || part.type === 'creature';
    const dim = state.mode === 'wiring' && !machine ? 0.35 : 1;
    ctx.globalAlpha = alpha * dim;
    const x = sx(part.x);
    const y = sy(part.y);
    const s = view.scale;
    const color = part.color ?? def.color;
    ctx.save();
    ctx.translate(x, y);
    if (def.shape === 'none') {
      const r = Math.max(9, s * 0.32);
      ctx.fillStyle = '#1b2029';
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.roundRect(-r, -r, r * 2, r * 2, 4);
      ctx.fill();
      ctx.stroke();
      label(def.icon, color, r * 1.05);
    } else if (part.type === 'creature' || part.type === 'start') {
      const r = Math.max(7, s * 0.4);
      ctx.fillStyle = part.type === 'start' ? '#1f5a40' : '#5a1f22';
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.rotate((part.turn * Math.PI) / 180);
      ctx.beginPath();
      ctx.moveTo(r * 1.45, 0);
      ctx.lineTo(r * 0.9, -r * 0.35);
      ctx.lineTo(r * 0.9, r * 0.35);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
      ctx.rotate((-part.turn * Math.PI) / 180);
      label(part.type === 'start' ? '@' : '&', '#fff', r * 1.1);
    } else {
      ctx.rotate((part.turn * Math.PI) / 180);
      const [a, b] = part.size;
      const zone = def.shape === 'zone';
      if (def.shape === 'ball') {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(0, 0, (a * s) / 2, 0, Math.PI * 2);
        ctx.fill();
      } else if (zone) {
        ctx.fillStyle = rgba(color, 0.14);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 4]);
        ctx.fillRect((-a * s) / 2, (-b * s) / 2, a * s, b * s);
        ctx.strokeRect((-a * s) / 2, (-b * s) / 2, a * s, b * s);
        ctx.setLineDash([]);
        if (part.type === 'launcher') {
          ctx.strokeStyle = color;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo((-a * s) / 4, 0);
          ctx.lineTo((a * s) / 4, 0);
          ctx.lineTo((a * s) / 4 - 6, -5);
          ctx.moveTo((a * s) / 4, 0);
          ctx.lineTo((a * s) / 4 - 6, 5);
          ctx.stroke();
        }
      } else {
        ctx.fillStyle = color;
        ctx.strokeStyle = '#000a';
        ctx.lineWidth = 1;
        ctx.fillRect((-a * s) / 2, (-b * s) / 2, a * s, b * s);
        ctx.strokeRect((-a * s) / 2, (-b * s) / 2, a * s, b * s);
        if (part.type === 'door' && part.props?.locked) {
          ctx.fillStyle = '#ffcc33';
          ctx.fillRect(-3, -3, 6, 6);
        }
      }
      ctx.rotate((-part.turn * Math.PI) / 180);
      if (s >= 14 && (zone || Math.max(a, b) * s > 22)) label(def.icon, zone ? color : '#000c', Math.max(9, s * 0.34));
    }
    ctx.restore();
    ctx.globalAlpha = 1;
    if (selected || highlighted) {
      const { hx, hy } = footprint(part);
      const pad = 4;
      ctx.strokeStyle = selected ? '#7fd4ff' : '#ffd166';
      ctx.lineWidth = 2;
      ctx.strokeRect(x - hx * s - pad, y - hy * s - pad, hx * s * 2 + pad * 2, hy * s * 2 + pad * 2);
    }
    if (state.signals && state.signals[part.id] && sendsSignal(part)) {
      ctx.fillStyle = '#4cc38a';
      ctx.beginPath();
      ctx.arc(x + s * 0.35, y - s * 0.35, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function label(text, color, size) {
    ctx.fillStyle = color;
    ctx.font = `600 ${Math.round(Math.max(9, Math.min(18, size)))}px ui-monospace, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 0, 1);
  }

  // Pan with the middle button, the right button or Space + drag; zoom with
  // the wheel.
  let panning = null;
  let space = false;
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.15 : 1 / 1.15);
  }, { passive: false });
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button === 1 || e.button === 2 || (e.button === 0 && space)) {
      panning = { x: e.clientX, y: e.clientY, moved: 0 };
      canvas.setPointerCapture(e.pointerId);
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }, true);
  canvas.addEventListener('pointermove', (e) => {
    if (panning) {
      pan(e.clientX - panning.x, e.clientY - panning.y);
      panning.moved += Math.abs(e.clientX - panning.x) + Math.abs(e.clientY - panning.y);
      panning.x = e.clientX;
      panning.y = e.clientY;
      e.stopImmediatePropagation();
    }
  }, true);
  canvas.addEventListener('pointerup', (e) => {
    if (panning) {
      const moved = panning.moved;
      panning = null;
      e.stopImmediatePropagation();
      // A right click that did not drag still reaches the screen (erase).
      if (e.button === 2 && moved < 4) canvas.dispatchEvent(new CustomEvent('mapcontext', { detail: { clientX: e.clientX, clientY: e.clientY } }));
    }
  }, true);
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !e.target.closest('input, textarea, select, button')) space = true;
  });
  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space') space = false;
  });

  new ResizeObserver(() => resize()).observe(canvas);

  return { state, view, draw, fit, resize, toWorld, toScreen, partAt, wireAt, footprint, zoomAt, pan };
}
