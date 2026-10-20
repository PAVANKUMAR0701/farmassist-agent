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

export const spinner = (text = 'Loading…') => h('div', { class: 'loading', role: 'status' }, h('span', { class: 'spin', 'aria-hidden': 'true' }), text);

// Line icons (24×24, stroke = currentColor). Constant strings only, never data.
const ICONS = {
  logo: '<path d="M12 21V10"/><path d="M12 14c-4 0-6-2.5-6-6 3.5 0 6 2 6 6Z"/><path d="M12 11c0-3.5 2.5-6 6-6 0 3.5-2 6-6 6Z"/><path d="M5 21h14"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="2"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4Z"/><circle cx="12" cy="13" r="3.5"/>',
  send: '<path d="M4 12 20 4l-6 16-3-7Z"/>',
  home: '<path d="M4 11 12 4l8 7"/><path d="M6 10v10h12V10"/>',
  chat: '<path d="M4 5h16v11H9l-5 4Z"/>',
  wallet: '<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M16 12h2"/><path d="M3 9h18"/>',
  farm: '<path d="M3 21V10l9-6 9 6v11"/><path d="M9 21v-6h6v6"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2 5.3"/><path d="M20 4v7h-7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4Z"/><path d="M10 21h4"/>',
  milk: '<path d="M9 3h6v3l2 4v11H7V10l2-4Z"/><path d="M7 13h10"/>',
  sprout: '<path d="M12 20v-8"/><path d="M12 12c-4 0-6-2-6-6 4 0 6 2 6 6Z"/><path d="M12 14c0-3 2-5 6-5 0 3-2 5-6 5Z"/>',
  cow: '<path d="M6 8c-2 0-3-1-3-3 2 0 3 1 3 3Z"/><path d="M18 8c2 0 3-1 3-3-2 0-3 1-3 3Z"/><path d="M6 8h12v6a6 6 0 0 1-12 0Z"/><circle cx="10" cy="15" r=".6"/><circle cx="14" cy="15" r=".6"/>',
  volume: '<path d="M4 9v6h4l5 4V5L8 9Z"/><path d="M16 9a4 4 0 0 1 0 6"/><path d="M18.5 6.5a7.5 7.5 0 0 1 0 11"/>',
  mute: '<path d="M4 9v6h4l5 4V5L8 9Z"/><path d="m17 10 4 4M21 10l-4 4"/>',
  logout: '<path d="M10 4H5v16h5"/><path d="M14 8l4 4-4 4"/><path d="M18 12H9"/>',
} as const;
export type IconName = keyof typeof ICONS;

export function icon(name: IconName): HTMLElement {
  const span = h('span', { class: 'ico', 'aria-hidden': 'true' });
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
  return span;
}

/** A small status pill. `tone` carries meaning, so the text must say it too (never colour alone). */
export const badge = (text: string, tone: 'ok' | 'warn' | 'danger' | 'neutral' = 'neutral') => h('span', { class: `badge badge-${tone}` }, text);

/** Screen title with an optional one-line description and actions on the right. */
export function pageHeader(title: string, subtitle?: string, ...actions: Child[]): HTMLElement {
  return h('div', { class: 'page-head' }, h('div', {}, h('h2', {}, title), subtitle ? h('p', { class: 'muted small' }, subtitle) : null), h('div', { class: 'page-actions' }, ...actions));
}
