// Play together: placeholder until the co-op lobby lands.
import { h } from './dom.js';
export function mount(el) {
  el.append(h('div', { class: 'page' }, h('p', {}, 'Co-op is being built.')));
  return { show() {}, hide() {} };
}
