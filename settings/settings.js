/**
 * Settings: personal information (global on the account + local overrides) and device preferences.
 * Nothing is saved until one of the two buttons at the bottom is pressed.
 */
import { initPage, icon, esc, notify, localModeNotice } from '../core/ui.js';
import { createPersonalForm } from '../core/personal-form.js';
import { DEVICE_FIELDS, applyTheme } from '../core/settings.js';

const platform = await initPage({ title: 'Settings', iconName: 'settings' });
const page = document.getElementById('page');
const settings = platform.settings;

const content = document.createElement('div');
page.append(content);

function canSaveGlobal() {
    return !!platform.user; // the local profile counts as "global" in local mode
}

function render() {
    const user = platform.user;
    const device = settings.device();
    const accountNote = platform.backend.mode === 'local'
        ? localModeNotice(platform, 'Saving to an online account')
        : user ? '' : `<div class="notice">${icon('user')}<div>You are not logged in. Local values still work on this device;
            <a href="#" data-login>log in</a> to save them to your account.</div></div>`;

    content.innerHTML = `
        ${accountNote}
        <section class="section">
            <h2>Personal information</h2>
            <p class="muted">Global values belong to your account and follow you to every device.
                Tick <em>Override</em> to use a different value on this device only – handy for a shared spin bike.
                Applications use the local value when it is set.</p>
            <div id="personal"></div>
        </section>

        <section class="section">
            <h2>This device</h2>
            <div class="grid cols-auto" id="device">
                ${DEVICE_FIELDS.map((field) => `
                    <label class="field"><span>${esc(field.label)}</span>
                        <select data-device="${field.key}">
                            ${field.options.map((o) => `<option value="${esc(o.value)}" ${(device[field.key] ?? field.default) === o.value ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}
                        </select>
                    </label>`).join('')}
            </div>
        </section>

        ${user && !user.local ? `
        <section class="section">
            <h2>Account</h2>
            <div class="list">
                <div class="list-item"><div class="grow"><div class="title">${esc(user.username)}</div>
                    <div class="sub">${esc(user.email ?? '')} · ${user.is_public ? 'Public profile' : 'Private profile'}</div></div>
                    <button class="small" data-profile>${icon('user')} Profile</button>
                    <button class="small danger" data-logout>${icon('logout')} Log out on this device</button>
                </div>
            </div>
        </section>` : ''}

        <section class="section">
            <h2>Stored on this device</h2>
            <p class="muted">Settings, local overrides and (in local mode) your sessions are kept in this browser's storage.
                Login uses one functional cookie. See Info → Data policy.</p>
            <button class="small danger" data-clear-local>Remove all local overrides</button>
        </section>

        <div class="action-bar hidden" id="actions">
            <button class="primary" data-save-global ${canSaveGlobal() ? '' : 'disabled title="Log in to save to your account"'}>
                ${icon('globe')} Save global changes</button>
            <button class="primary" data-save-local>${icon('lock')} Save local changes</button>
            <button data-discard>Discard</button>
        </div>`;

    form = createPersonalForm(platform, { withLocal: true, onChange: updateActions });
    content.querySelector('#personal').append(form.element);
    updateActions();
}

let form;

function deviceChanges() {
    const current = settings.device();
    const changes = {};
    for (const select of content.querySelectorAll('[data-device]')) {
        const field = DEVICE_FIELDS.find((f) => f.key === select.dataset.device);
        if ((current[field.key] ?? field.default) !== select.value) changes[field.key] = select.value;
    }
    return changes;
}

function updateActions() {
    const dirty = form.dirty();
    const deviceDirty = Object.keys(deviceChanges()).length > 0;
    content.querySelector('#actions').classList.toggle('hidden', !dirty.global && !dirty.local && !deviceDirty);
    content.querySelector('[data-save-global]').disabled = !dirty.global || !canSaveGlobal();
    content.querySelector('[data-save-local]').disabled = !dirty.local && !deviceDirty;
}

content.addEventListener('change', (event) => {
    if (event.target.dataset.device === 'theme') applyTheme(document, event.target.value); // preview
    updateActions();
});

content.addEventListener('click', async (event) => {
    const button = event.target.closest('button, a');
    if (!button) return;

    if (button.matches('[data-login]')) { event.preventDefault(); platform.openPage('logIn/'); }
    if (button.matches('[data-profile]')) platform.openPage('profile/');
    if (button.matches('[data-logout]')) {
        await platform.logout();
        notify(platform, 'Logged out on this device.');
        render();
    }
    if (button.matches('[data-clear-local]')) {
        settings.saveLocal({});
        notify(platform, 'Local overrides removed.');
        render();
    }
    if (button.matches('[data-discard]')) {
        applyTheme(document, settings.get('theme'));
        render();
    }
    if (button.matches('[data-save-global]')) {
        button.disabled = true;
        try {
            await settings.saveGlobal(form.changes().global);
            notify(platform, 'Saved to your account.');
            form.commit('global'); // keeps any unsaved local edits on screen
            updateActions();
        } catch (error) {
            notify(platform, `Could not save: ${error.message}`);
            button.disabled = false;
        }
    }
    if (button.matches('[data-save-local]')) {
        settings.saveLocal(form.changes().local, deviceChanges());
        applyTheme(document, settings.get('theme'));
        notify(platform, 'Saved on this device.');
        form.commit('local');
        updateActions();
    }
});

render();
