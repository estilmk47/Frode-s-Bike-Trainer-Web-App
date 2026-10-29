/**
 * Browse profiles, public sessions or applications.
 * browse/?tab=profiles|sessions|applications
 */
import { initPage, icon, esc, avatar, notify, localModeNotice, formatNumber, appArt, appColors } from '../core/ui.js';
import { sessionRow, bindSessionRows } from '../core/session-ui.js';

const platform = await initPage({ title: 'Browse', iconName: 'browse' });
const page = document.getElementById('page');
const TABS = { applications: 'Applications', profiles: 'Profiles', sessions: 'Sessions' };
const params = new URLSearchParams(location.search);
let tab = TABS[params.get('tab')] ? params.get('tab') : 'applications';

const css = document.createElement('style');
css.textContent = `
    .app-card { display: grid; grid-template-rows: auto 1fr; padding: 0; overflow: hidden; }
    .app-card .art { aspect-ratio: 16 / 9; display: grid; place-items: center; color: #fff; font-size: 2.6rem; font-weight: 800;
        background: linear-gradient(135deg, var(--c1), var(--c2), var(--c3)); position: relative; overflow: hidden; }
    .app-card .art .app-art { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
    .app-card .body { padding: 1rem; display: grid; gap: 0.5rem; align-content: start; }
    .app-card .body h3 { margin: 0; }
    .app-card .actions { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-top: 0.4rem; }
    .tag { font-size: 0.72rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }
    .search { display: flex; gap: 0.5rem; margin-bottom: 1rem; }`;
document.head.append(css);

const content = document.createElement('div');
page.append(content);
bindSessionRows(platform, content);

function render() {
    content.innerHTML = `
        <div style="margin-bottom:1.25rem">
            <div class="segmented" role="tablist">
                ${Object.entries(TABS).map(([id, label]) => `<button role="tab" data-tab="${id}" aria-selected="${tab === id}">${label}</button>`).join('')}
            </div>
        </div>
        <div id="tab"></div>`;
    const host = content.querySelector('#tab');
    ({ applications: renderApplications, profiles: renderProfiles, sessions: renderSessions })[tab](host);
}

/* ---------- Applications ---------- */

const STATUS = { 'in-development': 'In development', concept: 'Concept', available: 'Available' };

function renderApplications(host) {
    host.innerHTML = `<div class="grid cols-auto">${platform.catalog.map((app) => {
        const onHome = platform.isOnHome(app.id);
        return `
            <article class="card app-card">
                <div class="art" style="${appColors(app)}">${appArt(app)}</div>
                <div class="body">
                    <span class="tag">${esc(STATUS[app.status] ?? app.status ?? '')}</span>
                    <h3>${esc(app.title)}</h3>
                    <p class="muted" style="margin:0">${esc(app.description ?? '')}</p>
                    <div class="actions">
                        <button class="small primary" data-open="${esc(app.id)}">${icon('bolt')} Start</button>
                        ${onHome
                            ? `<button class="small" data-remove="${esc(app.id)}">${icon('check')} On Home</button>`
                            : `<button class="small" data-add="${esc(app.id)}">${icon('plus')} Add to Home</button>`}
                    </div>
                </div>
            </article>`;
    }).join('')}</div>`;
}

/* ---------- Profiles ---------- */

function renderProfiles(host) {
    if (platform.backend.mode !== 'server') {
        host.innerHTML = localModeNotice(platform, 'Browsing other riders');
        return;
    }
    host.innerHTML = `
        <form class="search" data-search>
            <input type="search" name="q" placeholder="Search usernames…" aria-label="Search usernames" maxlength="60">
            <button class="primary" type="submit">${icon('browse')} Search</button>
        </form>
        <div class="list" id="results"></div>`;
    host.querySelector('input').focus();
    searchProfiles('');
}

async function searchProfiles(q) {
    const results = content.querySelector('#results');
    if (!results) return;
    results.innerHTML = '<p class="muted">Searching…</p>';
    try {
        const users = await platform.api.searchUsers(q);
        results.innerHTML = users.length ? users.map((u) => `
            <button class="list-item" data-user="${esc(u.username)}">
                ${avatar(u)}
                <span class="grow"><span class="title">${esc(u.nickname || u.username)}</span>
                    <span class="sub">@${esc(u.username)}${u.is_friend ? ' · friend' : ''}</span></span>
                <span class="sub">Level ${formatNumber(u.stats?.level, '', 1)}</span>
            </button>`).join('') : '<p class="empty">No public profiles found.</p>';
    } catch (error) {
        results.innerHTML = `<div class="notice error">${esc(error.message)}</div>`;
    }
}

/* ---------- Sessions ---------- */

async function renderSessions(host) {
    if (platform.backend.mode !== 'server') {
        host.innerHTML = localModeNotice(platform, 'Browsing public sessions');
        return;
    }
    host.innerHTML = '<p class="muted">Loading…</p>';
    try {
        const sessions = await platform.api.sessions({ feed: true, limit: 50 });
        host.innerHTML = sessions.length
            ? `<p class="muted">The latest public sessions from all riders.</p><div class="list">${sessions.map((s) => sessionRow(platform, s, { showUser: true })).join('')}</div>`
            : '<p class="empty">No public sessions yet.</p>';
    } catch (error) {
        host.innerHTML = `<div class="notice error">${esc(error.message)}</div>`;
    }
}

/* ---------- Events ---------- */

content.addEventListener('click', async (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.tab) {
        tab = button.dataset.tab;
        history.replaceState(null, '', `?tab=${tab}`);
        render();
    }
    if (button.dataset.open) platform.openApp(button.dataset.open);
    if (button.dataset.add) {
        await platform.addToHome(button.dataset.add);
        notify(platform, `${platform.app(button.dataset.add).title} was added to Home.`);
        render();
    }
    if (button.dataset.remove) {
        await platform.removeFromHome(button.dataset.remove);
        notify(platform, `${platform.app(button.dataset.remove).title} was removed from Home.`);
        render();
    }
    if (button.dataset.user) platform.openPage(`profile/?user=${encodeURIComponent(button.dataset.user)}`);
});

content.addEventListener('submit', (event) => {
    if (!event.target.matches('[data-search]')) return;
    event.preventDefault();
    searchProfiles(new FormData(event.target).get('q').trim());
});

render();
