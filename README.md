# Frode's Bike Trainer Web App

An open source bike trainer web application. It connects to your bike over Bluetooth if your browser supports it, tracks
your progress and makes spinning fun: your bike, a Bluetooth heart-rate monitor and a Zwift Click v2 become the
controllers for spinning games.

The home screen (the *hub*) is inspired by a game console: pick a game from the row of tiles, manage your devices once,
and every game uses them.

## Play online

*Coming soon.*

## Run it on your own computer

```bash
cd modules
npm install          # installs cycling-power-ble and three.js into modules/node_modules
cd ..
python -m http.server 8000
```

Open <http://localhost:8000> in **Chrome, Edge or Opera** (Web Bluetooth only works in Chromium browsers, on
`https://` or `http://localhost`). No trainer at hand? Open **Devices** and click **Simulator**.

### Local mode vs. server mode

`python -m http.server` can't run PHP, so the app detects that and runs in **local mode**: your profile, settings and
sessions are stored in the browser only, and accounts, friends and browsing other riders are disabled.

To test the full backend locally, use PHP's built-in server instead (PHP 7.4+ with the `pdo_sqlite` extension):

```bash
cp server/config.example.php server/config.php   # then edit it, set 'dev_return_login_link' => true
php -S localhost:8000
```

On Windows: `winget install PHP.PHP.8.3`, then enable `extension=pdo_sqlite` (and set `extension_dir = "ext"`) in
`php.ini`.

With `dev_return_login_link` on, the login link is shown on the page instead of e-mailed. **Never enable it on a public
server.**

## Self-host

1. Upload the whole project to a web server with PHP 7.4+ and `pdo_sqlite` (most shared hosting has both).
   Include `modules/node_modules`, or – if you can't install node modules there – set `'modules_source' => 'cdn'`
   in `server/config.php` and the pinned online copies from cdn.jsdelivr.net are used instead (versions in
   [core/modules.js](core/modules.js)). The default `'auto'` uses the local copies when they exist.
2. Copy `server/config.example.php` to `server/config.php` and set:
   - `database_file` – a long random name. The database is created automatically in `server/databases/`.
     The name is not in the repository, so nobody can guess where to download it from.
   - `site_url` – your public address (used in login links).
   - `mail_from` – the sender of login e-mails (the server must be able to send mail with PHP's `mail()`).
3. **Apache:** the included `.htaccess` files block `server/databases/`, `config.php`, the SQL template and notes.
   **nginx:** add the equivalent rules yourself, e.g.

   ```nginx
   location ^~ /server/databases/ { deny all; }
   location ~ ^/server/(config|config\.example|database_link|api_common)\.php$ { deny all; }
   location ~ \.(sql|txt|md)$ { deny all; }
   ```

## Project structure

```
index.html, home-page.js/.css   the hub: tiles, shortcuts, devices dialog, profiles, overlay for pages and apps
core/                           shared code used by the hub, every page and every application
  platform.js                   getPlatform(): devices, user, settings, catalog, navigation, sessions
  api.js                        backend client – ServerBackend (PHP) or LocalBackend (browser only)
  settings.js                   global (account) settings with local (device) overrides
  accounts.js                   the login cookie(s) – several riders can be logged in on one device
  modules.js                    loads cycling-power-ble / three.js from /modules or the CDN (importModule)
  catalog.json                  the list of applications shown on the home screen and in Browse
  ui.js, style.css, ...         icons, dialogs, avatars, formatting, keyboard/controller navigation
activities/ browse/ info/ logIn/ profile/ settings/    the pages
applications/<id>/              the games and applications (each with assets/app_icon.png)
assets/profile_icons/           the picture library users choose from (default.png = the default; add files and they appear)
assets/user_uploaded_profile_icons/  uploaded profile pictures (<username>.png, git-ignored)
server/                         PHP + SQLite API (see server/private-description.txt for the access rules)
modules/                        npm dependencies (cycling-power-ble, three.js)
```

Each folder has a `*-description.txt` with the ideas behind that part.

### Why pages open inside the hub

Web Bluetooth connections are lost when the browser navigates to another page. So the hub never navigates away: pages and
games open in a full-screen frame on top of it, and the frame shares the hub's connected devices. The URL hash
(`#/settings/`, `#/app/<id>`, `#devices`) keeps the browser's back button working. Pages also work on their own (for
example when opened from a login link).

### Controls

Mouse/touch, keyboard (arrows, Enter, Escape, Y for options) or a **Zwift Click v2 / Ride** – on the home screen and on
every page ([core/navigation.js](core/navigation.js)):

| Zwift | Keyboard | Action |
| --- | --- | --- |
| Right shifter + / − | → / ← | next / previous control – keeps going through *every* control on the screen and wraps around |
| Left shifter + / − | ↓ / ↑ | next / previous row (the cursor is remembered per row) |
| A | Enter | press; on a dropdown, number or date field: start editing it (the directions change the value, A or B ends) |
| B | Escape | back: end editing, close a dialog/menu, close the page |
| Y | Y | options (the right-click menu of a tile) |

Holding a direction repeats it. The cyan frame shows where the cursor is; using the mouse hides it until the next
controller or keyboard action.

## Building an application

1. Create `applications/<yourId>/index.html` and `applications/<yourId>/assets/app_icon.png` (square or square-ish –
   it is the art on the home screen and in Browse).
2. Add an entry to `core/catalog.json` (`id`, `title`, `entry`, `colors`, `glyph`, `status`, ...). `colors` and `glyph`
   are shown while the app has no `app_icon.png`.
3. Use the platform from your module:

```js
import { getPlatform } from '../../core/platform.js';

const platform = await getPlatform();       // inside the hub: the devices are already connected

if (!platform.bike?.isConnected) platform.openDevices();
const weight = platform.settings.get('weight', 75);   // null-safe: fall back to your own default

const tracker = await platform.createTracker();        // cycling-power-ble SessionTracker
tracker.start();

function frame() {
    const power = platform.bike?.power ?? 0;           // W – read the device every frame
    platform.controller?.update();                     // Zwift Click v2: your app owns update() while it runs
    if (platform.controller?.justPressed('a')) jump();
    requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// When the ride is over: saved to the account (or the browser in local mode), coins and level update
tracker.stop();
await platform.saveSession(tracker, { applicationId: 'yourId', title: 'Mountain stage' });
platform.home();                                       // back to the home screen
```

Subscribe to events with `listen(target, type, fn)` from `core/ui.js` – it unsubscribes when your page closes (the
platform lives longer than your app). See the [cycling-power-ble README](https://github.com/estilmk47/Cycling-Power-BLE-JavaScript-module)
for everything the bike, heart-rate monitor, controller and session tracker can do (ERG mode, gradients, laps, TCX
export, ...).

## License

[GPL-3.0](LICENSE). Bluetooth support by [cycling-power-ble](https://github.com/estilmk47/Cycling-Power-BLE-JavaScript-module) (MIT).
