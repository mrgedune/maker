// Ship: placeholder until the checklist and export land.
import { h } from './dom.js';
export function mount(el) {
  el.append(h('div', { class: 'page' }, h('p', {}, 'Ship is being built.')));
  return { show() {}, hide() {} };
}
