/** Minimal element builder. Text is always set as text (never HTML), so server data cannot inject markup. */
type Child = Node | string | null | undefined | false;
type Attrs = Record<string, string | boolean | ((event: Event) => void) | undefined>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (typeof value === 'function') el.addEventListener(name.replace(/^on/, '').toLowerCase(), value);
    else if (value === true) el.setAttribute(name, '');
    else el.setAttribute(name, value);
  }
  append(el, ...children);
  return el;
}

export function append(parent: Node, ...children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
}

export function clear(el: Element): void {
  el.replaceChildren();
}

/** A friendly date like "Wed 14 Oct" from YYYY-MM-DD (shown in the farm's own calendar, no time-zone shift). */
export function shortDate(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  return d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}

export const label = (value: string) => value.charAt(0).toUpperCase() + value.slice(1).replace(/_/g, ' ');

export function notice(kind: 'error' | 'info' | 'empty', text: string, retry?: () => void): HTMLElement {
  return h('div', { class: `notice notice-${kind}`, role: kind === 'error' ? 'alert' : 'status' }, text, retry ? h('button', { class: 'link', onclick: retry }, 'Try again') : null);
}

export const spinner = (text = 'Loading…') => h('div', { class: 'loading', role: 'status' }, text);
