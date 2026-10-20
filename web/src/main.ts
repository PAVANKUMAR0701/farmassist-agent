/**
 * App shell: sign-in, header, navigation and a tiny hash router (#/chat, #/today, ...).
 * Wide screens keep the assistant open on the left beside every screen; phones give it its own tab.
 */
import { ApiError, displayName, isLocalDevServer, isSignedIn, loadConfig, setNewPassword, setSignedOutHandler, signIn, signOut } from './api.js';
import { clear, h, icon, notice, type IconName } from './dom.js';
import { farmView } from './farm.js';
import { activitiesView, chatView, DESKTOP_QUERY, expensesView, todayView } from './views.js';

const ROUTES: Record<string, { title: string; icon: IconName; view: () => HTMLElement }> = {
  chat: { title: 'Ask', icon: 'chat', view: todayView },
  today: { title: 'Home', icon: 'home', view: todayView },
  expenses: { title: 'Expenses', icon: 'wallet', view: expensesView },
  farm: { title: 'Farm', icon: 'farm', view: farmView },
  activities: { title: 'Activities', icon: 'list', view: activitiesView },
};

const root = document.getElementById('app')!;
const desktop = window.matchMedia(DESKTOP_QUERY);
/** One assistant per signed-in session, so the conversation survives moving between screens. */
let assistant: HTMLElement | undefined;

const brand = (big = false) =>
  h('div', { class: big ? 'brand brand-big' : 'brand' }, h('span', { class: 'brand-mark' }, icon('logo')), h('span', { class: 'brand-name' }, 'FarmAssist ', h('span', {}, 'Agent')));

function signInView(message?: string): HTMLElement {
  const username = h('input', { id: 'username', type: 'text', name: 'username', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false', required: true });
  const password = h('input', { id: 'password', type: 'password', name: 'password', autocomplete: 'current-password', required: true });
  const reveal = h('button', { type: 'button', class: 'reveal', 'aria-label': 'Show password', 'aria-pressed': 'false' }, 'Show');
  reveal.addEventListener('click', () => {
    const show = password.type === 'password';
    password.type = show ? 'text' : 'password';
    reveal.textContent = show ? 'Hide' : 'Show';
    reveal.setAttribute('aria-pressed', String(show));
    reveal.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  });
  const status = h('div', { 'aria-live': 'polite' }, message ? notice('info', message) : null);
  const button = h('button', { type: 'submit', class: 'primary wide' }, 'Sign in');
  const form = h(
    'form',
    { class: 'signin' },
    h('div', { class: 'field' }, h('label', { for: 'username' }, 'Username'), username),
    h('div', { class: 'field' }, h('label', { for: 'password' }, 'Password'), h('div', { class: 'with-action' }, password, reveal)),
    status,
    button,
  );

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    button.disabled = true;
    button.textContent = 'Signing in…';
    clear(status);
    try {
      const step = await signIn(username.value.trim(), password.value);
      if (step.done) return render();
      // First sign-in with a temporary password: ask for a new one.
      clear(form);
      const fresh = h('input', { id: 'new-password', type: 'password', autocomplete: 'new-password', required: true, minlength: '8' });
      const save = h('button', { type: 'submit', class: 'primary wide' }, 'Save password');
      const saveStatus = h('div', { 'aria-live': 'polite' });
      form.append(
        h('p', {}, 'Welcome! Please choose your own password (at least 8 characters, with a number).'),
        h('div', { class: 'field' }, h('label', { for: 'new-password' }, 'New password'), fresh),
        saveStatus,
        save,
      );
      fresh.focus();
      form.onsubmit = async (e) => {
        e.preventDefault();
        save.disabled = true;
        save.textContent = 'Saving…';
        clear(saveStatus);
        try {
          await setNewPassword(username.value.trim(), fresh.value, step.challengeSession);
          render();
        } catch (error) {
          saveStatus.appendChild(notice('error', error instanceof ApiError ? error.message : 'Could not save the password.'));
          save.disabled = false;
          save.textContent = 'Save password';
        }
      };
    } catch (error) {
      status.appendChild(notice('error', error instanceof ApiError ? error.message : 'Sign-in failed. Please try again.'));
      button.disabled = false;
      button.textContent = 'Sign in';
    }
  });

  return h(
    'main',
    { class: 'signin-page' },
    h(
      'div',
      { class: 'signin-card' },
      brand(true),
      h('h1', {}, 'Welcome back'),
      h('p', { class: 'tagline' }, 'Sign in to your farm ledger. Every number verified, never guessed.'),
      form,
      h('p', { class: 'muted small signin-foot' }, isLocalDevServer() ? 'Local test server: any username works, with test data only.' : 'Your records are private to your account.'),
    ),
  );
}

function currentRoute(): string {
  const name = location.hash.replace(/^#\/?/, '');
  return name in ROUTES ? name : 'chat';
}

function navLinks(route: string, names: string[]): HTMLElement[] {
  return names.map((name) => {
    const r = ROUTES[name]!;
    const active = name === route;
    return h('a', { href: `#/${name}`, class: active ? 'active' : undefined, 'aria-current': active ? 'page' : undefined }, icon(r.icon), h('span', {}, r.title));
  });
}

function shell(): HTMLElement {
  assistant ??= chatView();
  const wide = desktop.matches;
  // On a wide screen the assistant is always beside the page, so "Ask" shows Home next to it.
  const route = wide && currentRoute() === 'chat' ? 'today' : currentRoute();
  const user = displayName();
  const account = h(
    'div',
    { class: 'account' },
    h('span', { class: 'avatar', title: user, 'aria-hidden': 'true' }, (user.charAt(0) || '?').toUpperCase()),
    h('button', { class: 'ghost-btn', type: 'button', onclick: () => signOut(), 'aria-label': 'Sign out' }, icon('logout'), h('span', { class: 'label' }, 'Sign out')),
  );
  const offline = navigator.onLine ? null : notice('error', 'You are offline. Records will load when the connection is back.');
  // The local server looks identical to the real app; make it impossible to mistake one for the other.
  const devBanner = isLocalDevServer()
    ? h('div', { class: 'dev-banner', role: 'note' }, 'Local test server: test data only (not your farm records). The AI assistant is on only if this server was started with AGENT_MODEL_ID.')
    : null;

  if (wide) {
    return h(
      'div',
      { class: 'app app-wide' },
      h('aside', { class: 'side' }, h('div', { class: 'side-brand' }, brand()), assistant),
      h(
        'div',
        { class: 'main-col' },
        h('header', { class: 'topbar' }, h('nav', { class: 'topnav', 'aria-label': 'Sections' }, ...navLinks(route, ['today', 'expenses', 'farm', 'activities'])), account),
        devBanner,
        h('main', { class: 'content' }, offline, ROUTES[route]!.view()),
      ),
    );
  }
  const onChat = route === 'chat';
  return h(
    'div',
    { class: `app app-narrow${onChat ? ' on-chat' : ''}` },
    h('header', { class: 'topbar' }, brand(), account),
    devBanner,
    h('main', { class: 'content' }, offline, onChat ? assistant : ROUTES[route]!.view()),
    h('nav', { class: 'tabs', 'aria-label': 'Sections' }, ...navLinks(route, ['chat', 'today', 'expenses', 'farm', 'activities'])),
  );
}

function render(message?: string): void {
  // Moving the assistant between layouts detaches it, which resets its scroll; keep the farmer's place.
  const log = assistant?.querySelector('.chat-log');
  const scrolled = log ? log.scrollTop : 0;
  clear(root);
  if (!isSignedIn()) assistant = undefined; // a new sign-in starts a fresh assistant
  root.appendChild(isSignedIn() ? shell() : signInView(message));
  if (log?.isConnected) log.scrollTop = scrolled;
  document.title = isSignedIn() ? `${ROUTES[currentRoute()]!.title} · FarmAssist Agent` : 'Sign in · FarmAssist Agent';
}

setSignedOutHandler((reason) => render(reason));
window.addEventListener('hashchange', () => render());
window.addEventListener('online', () => render());
window.addEventListener('offline', () => render());
desktop.addEventListener('change', () => isSignedIn() && render());

loadConfig()
  .then(() => render())
  .catch(() => {
    clear(root);
    root.appendChild(notice('error', 'FarmAssist could not start. Check your connection and reload the page.', () => location.reload()));
  });
