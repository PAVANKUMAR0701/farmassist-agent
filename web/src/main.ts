/**
 * App shell: sign-in and sign-up, header, navigation and a tiny hash router (#/chat, #/today, ...).
 * Wide screens keep the assistant open on the left beside every screen; phones give it its own tab.
 */
import { ApiError, confirmSignUp, displayName, isLocalDevServer, isSignedIn, loadConfig, resendCode, setNewPassword, setSignedOutHandler, signIn, signOut, signUp } from './api.js';
import { clear, h, icon, notice, type IconName } from './dom.js';
import { farmView } from './farm.js';
import { activitiesView, chatView, DESKTOP_QUERY, expensesView, pauseVoice, todayView } from './views.js';

const ROUTES: Record<string, { title: string; icon: IconName; view: () => HTMLElement }> = {
  chat: { title: 'Ask', icon: 'chat', view: todayView },
  today: { title: 'Home', icon: 'home', view: todayView },
  expenses: { title: 'Expenses', icon: 'doc', view: expensesView },
  farm: { title: 'Farm', icon: 'sprout', view: farmView },
  activities: { title: 'Activities', icon: 'list', view: activitiesView },
};

const root = document.getElementById('app')!;
const desktop = window.matchMedia(DESKTOP_QUERY);
/** One assistant per signed-in session, so the conversation survives moving between screens. */
let assistant: HTMLElement | undefined;

const brand = (big = false) =>
  h('div', { class: big ? 'brand brand-big' : 'brand' }, h('span', { class: 'brand-mark' }, icon('logo')), h('span', { class: 'brand-name' }, 'FarmAssist ', h('span', {}, 'Agent')));

const field = (id: string, text: string, control: HTMLElement, hint?: string) =>
  h('div', { class: 'field' }, h('label', { for: id }, text), control, hint ? h('p', { class: 'field-hint', id: `${id}-hint` }, hint) : null);

/** A password box with a Show/Hide button. */
function passwordBox(id: string, autocomplete: string): { input: HTMLInputElement; box: HTMLElement } {
  const input = h('input', { id, type: 'password', autocomplete, required: true, minlength: '8' });
  const reveal = h('button', { type: 'button', class: 'reveal', 'aria-label': 'Show password', 'aria-pressed': 'false' }, 'Show');
  reveal.addEventListener('click', () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    reveal.textContent = show ? 'Hide' : 'Show';
    reveal.setAttribute('aria-pressed', String(show));
    reveal.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  });
  return { input, box: h('div', { class: 'with-action' }, input, reveal) };
}

const errorMessage = (error: unknown, fallback: string) => (error instanceof ApiError ? error.message : fallback);

/** Runs a form step with a busy button and an error line; the button text comes back if the step fails. */
async function busy(button: HTMLButtonElement, busyText: string, status: HTMLElement, fallback: string, step: () => Promise<void>): Promise<void> {
  const idle = button.textContent ?? '';
  button.disabled = true;
  button.textContent = busyText;
  clear(status);
  try {
    await step();
  } catch (error) {
    status.appendChild(notice('error', errorMessage(error, fallback)));
    button.disabled = false;
    button.textContent = idle;
  }
}

/** Sign in, create an account (Cognito sign-up with an email code), and the first-sign-in new password step. */
function signInView(message?: string): HTMLElement {
  const card = h('div', { class: 'signin-card' });
  const show = (...content: Array<Node | null>) => {
    clear(card);
    card.append(brand(true), ...content.filter((c): c is Node => c !== null));
    card.querySelector<HTMLInputElement>('input')?.focus();
  };
  const foot = () =>
    h('p', { class: 'muted small signin-foot' }, isLocalDevServer() ? 'Local test server: any username works, with test data only.' : 'Your records are private to your account.');

  const signInStep = (info?: string, prefillUser = '') => {
    const username = h('input', { id: 'username', type: 'text', name: 'username', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false', required: true, value: prefillUser });
    const password = passwordBox('password', 'current-password');
    const status = h('div', { 'aria-live': 'polite' }, info ? notice('info', info) : null);
    const button = h('button', { type: 'submit', class: 'primary wide' }, 'Sign in');
    const form = h('form', { class: 'signin' }, field('username', 'Username', username), field('password', 'Password', password.box), status, button);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const user = username.value.trim();
      void busy(button, 'Signing in…', status, 'Sign-in failed. Please try again.', async () => {
        const step = await signIn(user, password.input.value);
        if (step.done) return render();
        if ('confirmRequired' in step) return confirmStep(user, password.input.value);
        newPasswordStep(user, step.challengeSession);
      });
    });
    show(
      h('h1', {}, 'Welcome back'),
      h('p', { class: 'tagline' }, 'Sign in to your farm ledger. Every number verified, never guessed.'),
      form,
      h('p', { class: 'switch' }, 'New to FarmAssist? ', h('button', { type: 'button', class: 'link', onclick: () => signUpStep() }, 'Create an account')),
      foot(),
    );
  };

  const signUpStep = () => {
    const name = h('input', { id: 'su-name', type: 'text', autocomplete: 'name', required: true, maxlength: '60' });
    const username = h('input', { id: 'su-username', type: 'text', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false', required: true, minlength: '3', maxlength: '40', pattern: '[A-Za-z0-9._\\-]+', 'aria-describedby': 'su-username-hint' });
    const email = h('input', { id: 'su-email', type: 'email', autocomplete: 'email', required: true, 'aria-describedby': 'su-email-hint' });
    const password = passwordBox('su-password', 'new-password');
    password.input.setAttribute('aria-describedby', 'su-password-hint');
    const status = h('div', { 'aria-live': 'polite' });
    const button = h('button', { type: 'submit', class: 'primary wide' }, 'Create account');
    const form = h(
      'form',
      { class: 'signin' },
      field('su-name', 'Your name', name),
      field('su-username', 'Username', username, 'Letters and numbers, used to sign in.'),
      field('su-email', 'Email', email, 'We send a 6-digit code here to confirm it is you.'),
      field('su-password', 'Password', password.box, 'At least 8 characters, with a small letter and a number.'),
      status,
      button,
    );
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const user = username.value.trim();
      void busy(button, 'Creating account…', status, 'Could not create the account. Please try again.', async () => {
        const sent = await signUp(user, password.input.value, email.value.trim(), name.value.trim());
        confirmStep(user, password.input.value, sent.destination);
      });
    });
    show(
      h('h1', {}, 'Create your account'),
      h('p', { class: 'tagline' }, 'You get your own private farm ledger. Only you can see it.'),
      form,
      h('p', { class: 'switch' }, 'Already have an account? ', h('button', { type: 'button', class: 'link', onclick: () => signInStep() }, 'Sign in')),
      foot(),
    );
  };

  /** Email code (OTP) step. With the password from sign-up we sign straight in afterwards. */
  const confirmStep = (username: string, password?: string, destination?: string) => {
    const code = h('input', { id: 'code', type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', pattern: '[0-9]{6}', maxlength: '6', required: true, class: 'code-input' });
    const status = h('div', { 'aria-live': 'polite' });
    const button = h('button', { type: 'submit', class: 'primary wide' }, 'Confirm and continue');
    const resend = h('button', { type: 'button', class: 'link' }, 'Send a new code');
    resend.addEventListener('click', async () => {
      resend.disabled = true;
      clear(status);
      try {
        const sent = await resendCode(username);
        status.appendChild(notice('info', `A new code was sent${sent.destination ? ` to ${sent.destination}` : ''}.`));
      } catch (error) {
        status.appendChild(notice('error', errorMessage(error, 'Could not send a new code.')));
      } finally {
        setTimeout(() => (resend.disabled = false), 30_000); // Cognito limits resends; avoid hammering it
      }
    });
    const form = h('form', { class: 'signin' }, field('code', 'Verification code', code), status, button);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void busy(button, 'Checking…', status, 'Could not confirm the code. Please try again.', async () => {
        await confirmSignUp(username, code.value.trim());
        if (!password) return signInStep('Email confirmed. Please sign in.', username);
        const step = await signIn(username, password);
        if (step.done) return render();
        signInStep('Email confirmed. Please sign in.', username);
      });
    });
    show(
      h('h1', {}, 'Check your email'),
      h(
        'p',
        { class: 'tagline' },
        isLocalDevServer()
          ? 'Local test server: no email is sent here. Type any 6 digits, e.g. 123456.'
          : `Enter the 6-digit code we sent${destination ? ` to ${destination}` : ''}. It can take a minute to arrive; check spam too.`,
      ),
      form,
      h('p', { class: 'switch' }, 'No code? ', resend, ' · ', h('button', { type: 'button', class: 'link', onclick: () => signInStep(undefined, username) }, 'Back to sign in')),
    );
  };

  /** First sign-in with a temporary password (admin-created users): choose a new one. */
  const newPasswordStep = (username: string, challengeSession: string) => {
    const fresh = passwordBox('new-password', 'new-password');
    const status = h('div', { 'aria-live': 'polite' });
    const button = h('button', { type: 'submit', class: 'primary wide' }, 'Save password');
    const form = h('form', { class: 'signin' }, field('new-password', 'New password', fresh.box, 'At least 8 characters, with a small letter and a number.'), status, button);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void busy(button, 'Saving…', status, 'Could not save the password.', async () => {
        await setNewPassword(username, fresh.input.value, challengeSession);
        render();
      });
    });
    show(h('h1', {}, 'Choose your password'), h('p', { class: 'tagline' }, 'Welcome! Please replace the temporary password with your own.'), form);
  };

  signInStep(message);
  return h('main', { class: 'signin-page' }, card);
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

/** Desktop: the assistant drawer can be hidden to give the dashboard the full width (remembered on this device). */
const DRAWER_KEY = 'farmassist.drawer';
let drawerClosed = (() => {
  try {
    return localStorage.getItem(DRAWER_KEY) === 'closed';
  } catch {
    return false;
  }
})();
function setDrawerClosed(closed: boolean): void {
  drawerClosed = closed;
  try {
    localStorage.setItem(DRAWER_KEY, closed ? 'closed' : 'open');
  } catch {
    /* only a convenience */
  }
  render();
}

/** Avatar, name and a menu with Sign out. */
function accountMenu(user: string): HTMLElement {
  const first = user.split(/[\s@._]/)[0] || user;
  return h(
    'details',
    { class: 'account-menu' },
    h(
      'summary',
      { 'aria-label': `Account: ${user}` },
      h('span', { class: 'avatar', 'aria-hidden': 'true' }, (first.charAt(0) || '?').toUpperCase()),
      h('span', { class: 'account-name' }, first),
      icon('chevronDown'),
    ),
    h('div', { class: 'menu', role: 'menu' }, h('p', { class: 'menu-user' }, user), h('button', { type: 'button', role: 'menuitem', onclick: () => signOut() }, icon('logout'), 'Sign out')),
  );
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
    // A floating glass drawer on a field-and-hills scene, beside the dashboard.
    const drawer = h(
      'aside',
      { class: 'scenic', 'aria-label': 'FarmAssist assistant' },
      h(
        'div',
        { class: 'drawer' },
        h(
          'div',
          { class: 'drawer-head' },
          h('span', { class: 'drawer-logo' }, icon('leaf')),
          h('div', { class: 'drawer-brand' }, h('strong', {}, 'FarmAssist ', h('span', {}, 'Agent')), h('span', {}, 'Your AI farm companion')),
          h('button', { class: 'drawer-toggle', type: 'button', 'aria-label': 'Hide the assistant', title: 'Hide the assistant', onclick: () => setDrawerClosed(true) }, icon('chevronLeft')),
        ),
        assistant,
      ),
    );
    return h(
      'div',
      { class: `app app-wide${drawerClosed ? ' drawer-closed' : ''}` },
      drawerClosed ? null : drawer,
      h(
        'div',
        { class: 'main-col' },
        h('header', { class: 'topbar' }, h('nav', { class: 'topnav', 'aria-label': 'Sections' }, ...navLinks(route, ['today', 'expenses', 'farm', 'activities'])), accountMenu(user)),
        devBanner,
        h('main', { class: 'content' }, offline, ROUTES[route]!.view()),
        drawerClosed ? h('button', { class: 'drawer-open', type: 'button', onclick: () => setDrawerClosed(false) }, icon('mic'), 'Ask FarmAssist') : null,
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
  // Never leave the microphone on behind a screen that does not show the assistant (or after sign-out).
  if (!assistant?.isConnected) pauseVoice();
  document.title = isSignedIn() ? `${ROUTES[currentRoute()]!.title} · FarmAssist Agent` : 'Sign in · FarmAssist Agent';
}

setSignedOutHandler((reason) => render(reason));
window.addEventListener('hashchange', () => render());
// A record was saved in chat: reload the page beside the assistant (the conversation itself is kept).
window.addEventListener('farmassist:changed', () => {
  if (!isSignedIn() || !root.querySelector('.content > .view')) return;
  // The page scrolls inside .content (the window itself never scrolls): keep the farmer's place.
  const y = root.querySelector('.content')?.scrollTop ?? 0;
  render();
  const content = root.querySelector('.content');
  if (content) content.scrollTop = y;
});
window.addEventListener('online', () => render());
window.addEventListener('offline', () => render());
desktop.addEventListener('change', () => isSignedIn() && render());

loadConfig()
  .then(() => render())
  .catch(() => {
    clear(root);
    root.appendChild(notice('error', 'FarmAssist could not start. Check your connection and reload the page.', () => location.reload()));
  });
