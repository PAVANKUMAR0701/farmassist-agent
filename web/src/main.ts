/** App shell: sign-in, header, bottom navigation and a tiny hash router (#/chat, #/today, ...). */
import { ApiError, displayName, isLocalDevServer, isSignedIn, loadConfig, setNewPassword, setSignedOutHandler, signIn, signOut } from './api.js';
import { clear, h, notice } from './dom.js';
import { activitiesView, chatView, expensesView, todayView } from './views.js';

const ROUTES: Record<string, { title: string; icon: string; view: () => HTMLElement }> = {
  chat: { title: 'Chat', icon: '💬', view: chatView },
  today: { title: 'Today', icon: '📊', view: todayView },
  expenses: { title: 'Expenses', icon: '₹', view: expensesView },
  activities: { title: 'Activities', icon: '🐄', view: activitiesView },
};

const root = document.getElementById('app')!;

function signInView(message?: string): HTMLElement {
  const username = h('input', { type: 'text', name: 'username', autocomplete: 'username', required: true, 'aria-label': 'Username' });
  const password = h('input', { type: 'password', name: 'password', autocomplete: 'current-password', required: true, 'aria-label': 'Password' });
  const status = h('div', { 'aria-live': 'polite' }, message ? notice('info', message) : null);
  const button = h('button', { type: 'submit', class: 'primary wide' }, 'Sign in');
  const form = h(
    'form',
    { class: 'signin' },
    h('label', {}, 'Username', username),
    h('label', {}, 'Password', password),
    status,
    button,
  );

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    button.disabled = true;
    clear(status);
    try {
      const step = await signIn(username.value.trim(), password.value);
      if (step.done) return render();
      // First sign-in with a temporary password: ask for a new one.
      clear(form);
      const fresh = h('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: '8', 'aria-label': 'New password' });
      const save = h('button', { type: 'submit', class: 'primary wide' }, 'Save password');
      const saveStatus = h('div', { 'aria-live': 'polite' });
      form.append(h('p', {}, 'Welcome! Please choose your own password (at least 8 characters, with a number).'), h('label', {}, 'New password', fresh), saveStatus, save);
      form.onsubmit = async (e) => {
        e.preventDefault();
        save.disabled = true;
        clear(saveStatus);
        try {
          await setNewPassword(username.value.trim(), fresh.value, step.challengeSession);
          render();
        } catch (error) {
          saveStatus.appendChild(notice('error', error instanceof ApiError ? error.message : 'Could not save the password.'));
          save.disabled = false;
        }
      };
    } catch (error) {
      status.appendChild(notice('error', error instanceof ApiError ? error.message : 'Sign-in failed. Please try again.'));
      button.disabled = false;
    }
  });

  return h('main', { class: 'signin-page' }, h('div', { class: 'brand' }, h('span', { class: 'logo', 'aria-hidden': 'true' }, '🌾'), h('h1', {}, 'FarmAssist')), h('p', { class: 'tagline' }, 'Your farm ledger — every number verified, never guessed.'), form);
}

function currentRoute(): string {
  const name = location.hash.replace(/^#\/?/, '');
  return name in ROUTES ? name : 'chat';
}

function shell(): HTMLElement {
  const route = currentRoute();
  const header = h(
    'header',
    { class: 'topbar' },
    h('span', { class: 'brand-small' }, '🌾 FarmAssist'),
    h('span', { class: 'user' }, displayName()),
    h('button', { class: 'link', type: 'button', onclick: () => signOut() }, 'Sign out'),
  );
  const nav = h(
    'nav',
    { class: 'tabs', 'aria-label': 'Sections' },
    ...Object.entries(ROUTES).map(([name, r]) =>
      h('a', { href: `#/${name}`, class: name === route ? 'active' : undefined, 'aria-current': name === route ? 'page' : undefined }, h('span', { class: 'icon', 'aria-hidden': 'true' }, r.icon), h('span', {}, r.title)),
    ),
  );
  const offline = navigator.onLine ? null : notice('error', 'You are offline. Records will load when the connection is back.');
  // The local server looks identical to the real app; make it impossible to mistake one for the other.
  const devBanner = isLocalDevServer()
    ? h('div', { class: 'dev-banner', role: 'note' }, 'Local test server: test data only (not your farm records). The AI assistant is on only if this server was started with AGENT_MODEL_ID.')
    : null;
  return h('div', { class: 'shell' }, header, devBanner, h('main', { class: 'content' }, offline, ROUTES[route]!.view()), nav);
}

function render(message?: string): void {
  clear(root);
  root.appendChild(isSignedIn() ? shell() : signInView(message));
  document.title = isSignedIn() ? `${ROUTES[currentRoute()]!.title} · FarmAssist` : 'FarmAssist';
}

setSignedOutHandler((reason) => render(reason));
window.addEventListener('hashchange', () => render());
window.addEventListener('online', () => render());
window.addEventListener('offline', () => render());

loadConfig()
  .then(() => render())
  .catch(() => {
    clear(root);
    root.appendChild(notice('error', 'FarmAssist could not start. Check your connection and reload the page.', () => location.reload()));
  });
