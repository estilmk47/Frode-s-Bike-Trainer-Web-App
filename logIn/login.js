/**
 * Register and log in. There are no passwords: the server e-mails a login link
 * (logIn/?username=...&key=...). Opening it stores the login in a cookie for a year.
 */
import { initPage, icon, esc, notify, localModeNotice } from '../core/ui.js';
import { BASE_URL } from '../core/storage.js';

const platform = await initPage({ title: 'Log in', iconName: 'user' });
const page = document.getElementById('page');
const params = new URLSearchParams(location.search);

const content = document.createElement('div');
content.style.maxWidth = '520px';
content.style.margin = '0 auto';
page.append(content);

if (params.has('username') && params.has('key')) {
    await handleLoginLink(params.get('username'), params.get('key'));
} else {
    renderForms(params.get('tab') === 'register' ? 'register' : 'login');
}

async function handleLoginLink(username, key) {
    // Remove the key from the address bar (and the browser history) straight away.
    history.replaceState(null, '', location.pathname);
    content.innerHTML = `<div class="card"><p>Logging you in…</p></div>`;
    if (platform.backend.mode !== 'server') {
        content.innerHTML = localModeNotice(platform, 'Logging in');
        return;
    }
    try {
        const user = await platform.login(username, key);
        content.innerHTML = `
            <div class="card" style="text-align:center">
                <h2>Welcome, ${esc(user.nickname || user.username)}!</h2>
                <p>You are logged in on this device for one year. You can add more riders from the profile menu.</p>
                <button class="primary" data-home>${icon('home')} Go to home</button>
            </div>`;
        content.querySelector('[data-home]').focus();
        content.querySelector('[data-home]').addEventListener('click', goHome);
    } catch (error) {
        content.innerHTML = `
            <div class="notice error">${esc(error.message)}</div>
            <button data-retry>Send a new login link</button>`;
        content.querySelector('[data-retry]').addEventListener('click', () => renderForms('login'));
    }
}

function goHome() {
    if (platform.shell) platform.home();
    else location.href = BASE_URL.href;
}

function renderForms(tab) {
    const offline = platform.backend.mode !== 'server';
    const loggedIn = platform.isLoggedIn
        ? `<div class="notice">${icon('user')}<div>You are logged in as <strong>${esc(platform.user.username)}</strong>.
            You can log in another rider below – everyone stays logged in on this device and you switch from the home screen.</div></div>` : '';

    content.innerHTML = `
        ${offline ? localModeNotice(platform, 'Creating an account and logging in') : loggedIn}
        <div style="text-align:center;margin-bottom:1.25rem">
            <div class="segmented" role="tablist">
                <button role="tab" data-tab="login" aria-selected="${tab === 'login'}">Log in</button>
                <button role="tab" data-tab="register" aria-selected="${tab === 'register'}">Register</button>
            </div>
        </div>

        <form class="card grid" data-form="login" ${tab === 'login' ? '' : 'hidden'}>
            <p class="muted" style="margin:0">No password needed. We send a login link to your e-mail.</p>
            <label class="field"><span>E-mail</span>
                <input type="email" name="email" required autocomplete="email" maxlength="254" ${offline ? 'disabled' : ''}></label>
            <button class="primary" type="submit" ${offline ? 'disabled' : ''}>${icon('bolt')} Send login link</button>
            <div data-result></div>
        </form>

        <form class="card grid" data-form="register" ${tab === 'register' ? '' : 'hidden'}>
            <label class="field"><span>Username *</span>
                <input name="username" required minlength="3" maxlength="60" pattern="[A-Za-z0-9_.\\-]{3,60}" autocomplete="username" ${offline ? 'disabled' : ''}>
                <small>Unique, 3–60 letters, numbers, <code>_ . -</code>. Other riders find you by it if your profile is public.</small></label>
            <label class="field"><span>E-mail *</span>
                <input type="email" name="email" required autocomplete="email" maxlength="254" ${offline ? 'disabled' : ''}>
                <small>Only used to send you login links. Stored on the server and never deliberately shared.</small></label>
            <div class="notice">${icon('info')}<div>New profiles are <strong>private</strong> by default. Don't put very personal
                information here – read the <a href="../info/">data policy</a>.</div></div>
            <button class="primary" type="submit" ${offline ? 'disabled' : ''}>${icon('plus')} Create user and send login link</button>
            <div data-result></div>
        </form>`;

    content.querySelector(`[data-form="${tab}"] input:not(:disabled)`)?.focus();
}

content.addEventListener('click', (event) => {
    const tab = event.target.closest('[data-tab]')?.dataset.tab;
    if (tab) renderForms(tab);
});

content.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.target;
    const result = form.querySelector('[data-result]');
    const button = form.querySelector('button[type="submit"]');
    const data = Object.fromEntries(new FormData(form));
    button.disabled = true;
    result.innerHTML = '';
    try {
        const response = form.dataset.form === 'register'
            ? await platform.api.createUser({ username: data.username.trim(), email: data.email.trim() })
            : await platform.api.sendLoginLink(data.email.trim());
        result.innerHTML = `<div class="notice">${icon('check')}<div>${esc(response.message ?? 'Check your e-mail for the login link.')}
            ${response.login_link ? `<br><small>Development mode: <a href="${esc(response.login_link)}">open the login link</a></small>` : ''}</div></div>`;
        notify(platform, 'Login link sent – check your e-mail.');
    } catch (error) {
        result.innerHTML = `<div class="notice error">${esc(error.message)}</div>`;
    } finally {
        button.disabled = false;
    }
});
