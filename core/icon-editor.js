/**
 * Profile picture picker: the library (assets/profile_icons/) plus "upload your own".
 * Resolves with the updated user, or null when nothing changed.
 * @param {import('./platform.js').Platform} platform
 */
export async function chooseProfilePicture(platform) {
    const user = platform.user;
    const color = avatarColor(user);
    const current = user.icon_image ?? 'assets/profile_icons/default.png';
    const uploaded = !!user.icon_image && !user.icon_image.startsWith('assets/profile_icons/');
    let library = ['default.png'];
    try {
        library = await platform.api.profileIconLibrary();
    } catch (error) {
        console.warn('Could not load the picture library', error);
    }

    const body = document.createElement('div');
    body.className = 'icon-picker';
    const choice = (file) => {
        const path = `assets/profile_icons/${file}`;
        const name = file.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ');
        return `<button class="icon-choice" data-library="${esc(file)}" title="${esc(name)}" aria-pressed="${current === path}">
            ${avatar({ ...user, icon_image: file === 'default.png' ? null : path })}</button>`;
    };
    body.innerHTML = `
        <div class="icon-grid">
            ${uploaded ? `<button class="icon-choice" data-keep title="Your own picture" aria-pressed="true">${avatar(user)}</button>` : ''}
            ${library.map(choice).join('')}
        </div>
        <button data-upload-own>${icon('plus')} Upload your own picture…</button>
        <input type="file" accept="image/*" data-file hidden>
        ${uploaded ? '<p class="muted">Choosing a picture from the library replaces your own upload.</p>' : ''}`;

    let result = null;
    const { closed, close } = modal({ title: 'Choose a profile picture', body, actions: [{ label: 'Cancel' }] });

    body.addEventListener('click', async (event) => {
        const button = event.target.closest('button');
        if (!button) return;
        try {
            if (button.dataset.keep !== undefined) close();
            if (button.dataset.library) {
                result = await platform.api.chooseProfileIcon(button.dataset.library);
                close();
            }
            if (button.matches('[data-upload-own]')) body.querySelector('[data-file]').click();
        } catch (error) {
            toast(error.message);
        }
    });
    body.querySelector('[data-file]').addEventListener('change', async (event) => {
        const file = event.target.files[0];
        event.target.value = '';
        if (!file) return;
        try {
            const blob = await editProfileIcon(file, { color });
            if (!blob) return;
            result = await platform.api.uploadProfileIcon(blob);
            close();
        } catch (error) {
            toast(error.message);
        }
    });

    await closed;
    return result;
}

/**
 * Profile picture editor: pick the square part of an image to use. The circle shows exactly what
 * the avatar will look like; the background colour is shown behind transparent areas.
 * Drag to move, use the slider or the mouse wheel to zoom.
 *
 * Resolves with a square PNG Blob (OUTPUT_SIZE px, transparency kept), or null when cancelled.
 */
import { modal, toast, avatar, avatarColor, icon, esc } from './ui.js';

const OUTPUT_SIZE = 256;   // px – the server accepts 64–1024 and at most 512 kB
const VIEW = 600;          // internal canvas resolution of the editor

export async function editProfileIcon(file, { color = '#888' } = {}) {
    const image = await loadImage(file);
    const fit = VIEW / Math.min(image.width, image.height); // zoom 1 = the image just covers the square
    const state = { zoom: 1, x: 0, y: 0 };
    center();

    const body = document.createElement('div');
    body.className = 'icon-editor';
    body.innerHTML = `
        <canvas width="${VIEW}" height="${VIEW}" aria-label="Drag to choose the part of the picture"></canvas>
        <label class="field"><span>Zoom</span><input type="range" min="1" max="5" step="0.01" value="1" data-zoom></label>
        <p class="muted">Drag the picture to move it. Everything inside the circle is shown as your profile picture.</p>`;
    const canvas = body.querySelector('canvas');
    const context = canvas.getContext('2d');
    const zoomInput = body.querySelector('[data-zoom]');

    function scale() { return fit * state.zoom; }

    function center() {
        state.x = (VIEW - image.width * fit * state.zoom) / 2;
        state.y = (VIEW - image.height * fit * state.zoom) / 2;
    }

    // Keep the square covered by the image.
    function clamp() {
        const w = image.width * scale();
        const h = image.height * scale();
        state.x = Math.min(0, Math.max(VIEW - w, state.x));
        state.y = Math.min(0, Math.max(VIEW - h, state.y));
    }

    function draw() {
        context.clearRect(0, 0, VIEW, VIEW);
        context.fillStyle = color;
        context.fillRect(0, 0, VIEW, VIEW);
        context.drawImage(image, state.x, state.y, image.width * scale(), image.height * scale());
        // Dim everything outside the circle and outline it.
        context.save();
        context.beginPath();
        context.rect(0, 0, VIEW, VIEW);
        context.arc(VIEW / 2, VIEW / 2, VIEW / 2 - 2, 0, Math.PI * 2);
        context.fillStyle = 'rgba(0, 0, 0, 0.55)';
        context.fill('evenodd');
        context.beginPath();
        context.arc(VIEW / 2, VIEW / 2, VIEW / 2 - 4, 0, Math.PI * 2);
        context.lineWidth = 6;
        context.strokeStyle = '#ffffff';
        context.stroke();
        context.restore();
    }

    function setZoom(zoom) {
        const previous = scale();
        state.zoom = Math.min(5, Math.max(1, zoom));
        // Zoom around the middle of the square.
        const ratio = scale() / previous;
        state.x = VIEW / 2 - (VIEW / 2 - state.x) * ratio;
        state.y = VIEW / 2 - (VIEW / 2 - state.y) * ratio;
        zoomInput.value = state.zoom;
        clamp();
        draw();
    }

    zoomInput.addEventListener('input', () => setZoom(Number(zoomInput.value)));
    canvas.addEventListener('wheel', (event) => {
        event.preventDefault();
        setZoom(state.zoom * (event.deltaY < 0 ? 1.08 : 1 / 1.08));
    }, { passive: false });

    let drag = null;
    canvas.addEventListener('pointerdown', (event) => {
        canvas.setPointerCapture(event.pointerId);
        drag = { x: event.clientX, y: event.clientY };
    });
    canvas.addEventListener('pointermove', (event) => {
        if (!drag) return;
        const factor = VIEW / canvas.getBoundingClientRect().width;
        state.x += (event.clientX - drag.x) * factor;
        state.y += (event.clientY - drag.y) * factor;
        drag = { x: event.clientX, y: event.clientY };
        clamp();
        draw();
    });
    canvas.addEventListener('pointerup', () => { drag = null; });

    draw();

    let result = null;
    const { closed } = modal({
        title: 'Profile picture',
        body,
        actions: [
            { label: 'Cancel' },
            { label: 'Use this picture', primary: true, onClick: async () => { result = await exportSquare(image, state, fit); } },
        ],
    });
    await closed;
    return result;
}

/** The part inside the square, OUTPUT_SIZE × OUTPUT_SIZE, without the editor's background colour. */
function exportSquare(image, state, fit) {
    const output = document.createElement('canvas');
    output.width = OUTPUT_SIZE;
    output.height = OUTPUT_SIZE;
    const context = output.getContext('2d');
    const factor = OUTPUT_SIZE / VIEW;
    const s = fit * state.zoom * factor;
    context.imageSmoothingQuality = 'high';
    context.drawImage(image, state.x * factor, state.y * factor, image.width * s, image.height * s);
    return new Promise((resolve) => output.toBlob(resolve, 'image/png'));
}

function loadImage(file) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const image = new Image();
        image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
        image.onerror = () => { URL.revokeObjectURL(url); reject(new Error(`"${file.name}" is not an image this browser can open.`)); };
        image.src = url;
    });
}

const css = `
.icon-editor { display: grid; gap: 1rem; }
.icon-editor canvas { width: min(100%, 360px); aspect-ratio: 1; justify-self: center; border-radius: var(--radius); cursor: grab; touch-action: none; }
.icon-editor canvas:active { cursor: grabbing; }
.icon-editor p { margin: 0; }
.icon-picker { display: grid; gap: 1rem; }
.icon-picker p { margin: 0; }
.icon-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(84px, 1fr)); gap: 0.75rem; }
.icon-choice { padding: 0.4rem; border-radius: var(--radius-lg); background: transparent; box-shadow: none; border: 2px solid transparent; }
.icon-choice .avatar { --size: 68px; }
.icon-choice[aria-pressed="true"] { border-color: var(--accent); background: var(--surface-2); }`;
if (!document.getElementById('icon-editor-css')) {
    const style = document.createElement('style');
    style.id = 'icon-editor-css';
    style.textContent = css;
    document.head.append(style);
}
