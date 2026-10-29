/**
 * Profile: icon, username, stats (read only), privacy, and the global personal information.
 * profile/?user=<username> shows somebody else's public profile.
 */
import { initPage, icon, esc, avatar, avatarColor, notify, AVATAR_COLORS, formatDistance, formatDuration, formatNumber } from '../core/ui.js';
import { chooseProfilePicture } from '../core/icon-editor.js';
import { createPersonalForm } from '../core/personal-form.js';
import { sessionRow, bindSessionRows } from '../core/session-ui.js';

const platform = await initPage({ title: 'Profile', iconName: 'user' });
const page = document.getElementById('page');
const requested = new URLSearchParams(location.search).get('user');

const content = document.createElement('div');
page.append(content);
bindSessionRows(platform, content);

const css = document.createElement('style');
css.textContent = `
    .profile-head { display: flex; align-items: center; gap: 1.5rem; flex-wrap: wrap; margin-bottom: 1.5rem; }
    .profile-head .names { flex: 1; min-width: 200px; }
    .profile-head h2 { font-size: 1.6rem; margin: 0; }
    .level-badge { display: inline-flex; align-items: center; gap: 0.3em; padding: 0.2em 0.8em; border-radius: 999px; background: var(--accent); color: var(--on-accent); font-weight: 700; }
    .color-picker { display: flex; gap: 0.4rem; flex-wrap: wrap; margin-top: 0.6rem; }
    .color-picker button { width: 28px; height: 28px; padding: 0; border-radius: 50%; background: var(--c); border: 3px solid var(--surface); }
    .color-picker button[aria-pressed="true"] { outline: 3px solid var(--accent); }
    .picture-actions { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-top: 0.8rem; }
    .picture-label { font-size: 0.8rem; color: var(--muted); margin-top: 0.8rem; }`;
document.head.append(css);

async function load() {
    const own = !requested || requested === platform.user?.username;
    if (own) {
        if (!platform.user) return renderLoggedOut();
        return renderProfile(platform.user, true);
    }
    try {
        renderProfile(await platform.api.user(requested), false);
    } catch (error) {
        content.innerHTML = `<div class="notice error">${esc(error.message)}</div>`;
    }
}

function renderLoggedOut() {
    content.innerHTML = `
        <div class="empty">
            <p>You are not logged in.</p>
            <button class="primary" data-login>${icon('user')} Log in or register</button>
        </div>`;
}

function statsHtml(stats = {}) {
    const stat = (label, value) => `<div class="stat"><div class="label">${label}</div><div class="value">${esc(value)}</div></div>`;
    return `<div class="stat-grid">
        ${stat('Level', formatNumber(stats.level, '', 1))}
        ${stat('Sessions', formatNumber(stats.session_count))}
        ${stat('Total distance', formatDistance(stats.total_distance ?? 0))}
        ${stat('Total time', formatDuration(stats.total_time ?? 0))}
        ${stat('Longest ride', formatDistance(stats.longest_ride ?? 0))}
        ${stat('Coins', formatNumber(stats.coins ?? 0))}
    </div>`;
}

let personalForm = null;

async function renderProfile(user, own) {
    const hidden = !own && !user.is_public;
    content.innerHTML = `
        <div class="profile-head">
            ${avatar(user, 'large')}
            <div class="names">
                <h2>${esc(user.nickname || user.username)}</h2>
                <div class="muted">@${esc(user.username)} ${user.local ? '· local profile' : ''}</div>
                ${own ? `
                <div class="picture-actions">
                    <button class="small" data-change-picture>${icon('user')} Change picture</button>
                </div>
                <div class="picture-label">Background colour (shows through transparent pictures)</div>
                <div class="color-picker" aria-label="Background colour">
                    ${Object.entries(AVATAR_COLORS).map(([name, color]) =>
                        `<button style="--c:${color}" data-color="${name}" title="${name}" aria-label="${name}" aria-pressed="${avatarColor(user) === color}"></button>`).join('')}
                </div>` : ''}
            </div>
            ${own ? '' : platform.isLoggedIn && !user.own ? `
                <button data-follow="${user.is_friend ? 0 : 1}">${icon(user.is_friend ? 'check' : 'plus')} ${user.is_friend ? 'Friends' : 'Add friend'}</button>` : ''}
        </div>

        ${hidden ? `<div class="notice">${icon('lock')}<div>This profile is private.</div></div>` : `
        <section class="section"><h2>Stats</h2>${statsHtml(user.stats)}</section>`}

        ${own ? `
        <section class="section">
            <h2>Privacy</h2>
            <div class="segmented" role="radiogroup" aria-label="Profile visibility">
                <button role="radio" data-public="0" aria-selected="${!user.is_public}">${icon('lock')} Private</button>
                <button role="radio" data-public="1" aria-selected="${!!user.is_public}">${icon('globe')} Public</button>
            </div>
            <p class="muted">${user.is_public
                ? 'Everyone can find your profile, stats and public sessions.'
                : 'Only you can see your profile and sessions.'}
                ${user.local ? 'In local mode nothing leaves this browser anyway.' : ''}</p>
        </section>

        <section class="section">
            <h2>Personal information</h2>
            <p class="muted">Saved on your account. Greyed out values are overridden on this device (see Settings).</p>
            <div id="personal"></div>
            <div style="margin-top:1rem"><button class="primary" data-save-personal disabled>Save</button></div>
        </section>` : ''}

        ${hidden ? '' : `
        <section class="section">
            <h2>Recent sessions</h2>
            <div class="list" id="sessions"><p class="muted">Loading…</p></div>
            ${own ? `<p><button class="small" data-activities>${icon('activities')} All activities</button></p>` : ''}
        </section>`}`;

    if (own) {
        personalForm = createPersonalForm(platform, {
            withLocal: false,
            onChange: () => { content.querySelector('[data-save-personal]').disabled = !personalForm.dirty().global; },
        });
        content.querySelector('#personal').append(personalForm.element);
    }

    if (!hidden) {
        const list = content.querySelector('#sessions');
        try {
            const sessions = await platform.api.sessions({ username: user.username, limit: 5 });
            list.innerHTML = sessions.length
                ? sessions.map((s) => sessionRow(platform, s)).join('')
                : '<p class="muted">No sessions yet. Go for a ride!</p>';
        } catch (error) {
            list.innerHTML = `<p class="muted">${esc(error.message)}</p>`;
        }
    }
}

content.addEventListener('click', async (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    try {
        if (button.matches('[data-login]')) platform.openPage('logIn/');
        if (button.matches('[data-activities]')) platform.openPage('activities/');
        if (button.matches('[data-change-picture]')) {
            const user = await chooseProfilePicture(platform);
            if (user) {
                platform.setUser(user);
                notify(platform, 'Your profile picture is saved.');
                load();
            }
        }
        if (button.dataset.color) {
            await platform.updateAccount({ icon: button.dataset.color });
            load();
        }
        if (button.dataset.public !== undefined) {
            await platform.updateAccount({ is_public: Number(button.dataset.public) });
            notify(platform, Number(button.dataset.public) ? 'Your profile is now public.' : 'Your profile is now private.');
            load();
        }
        if (button.matches('[data-save-personal]')) {
            button.disabled = true;
            await platform.settings.saveGlobal(personalForm.changes().global);
            notify(platform, 'Saved.');
            load();
        }
        if (button.dataset.follow !== undefined) {
            await platform.api.setFriend(requested, button.dataset.follow === '1');
            load();
        }
    } catch (error) {
        notify(platform, error.message);
    }
});

load();
