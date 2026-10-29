<?php
/*
 * Server configuration – TEMPLATE.
 *
 * Copy this file to server/config.php and change the values. config.php is in .gitignore,
 * so the real database file name (security by obscurity) never ends up in the public repository.
 */

return [
    // File name of the SQLite database inside server/databases/. Pick something long and random,
    // e.g. the output of: php -r "echo bin2hex(random_bytes(12));"
    'database_file' => 'CHANGE-ME-to-something-random.sqlite',

    // Public address of the site (used in login links), with a trailing slash.
    'site_url' => 'https://example.com/',

    // Sender of the login e-mails. The server must be able to send mail with PHP's mail().
    'mail_from' => 'Frodes Bike Trainer <no-reply@example.com>',

    // Minimum seconds between two login e-mails to the same address.
    'login_link_interval' => 60,

    // DEVELOPMENT ONLY: return the login link in the response instead of relying on e-mail.
    // Never enable this on a public server – anyone could log in as anyone.
    'dev_return_login_link' => false,

    // Where the JavaScript modules (cycling-power-ble, three.js) are loaded from:
    //   'local' – modules/node_modules (run "npm install" inside /modules and upload node_modules)
    //   'cdn'   – the pinned online copies on cdn.jsdelivr.net (for servers where npm isn't available).
    //             Note: visitors' browsers then also contact jsdelivr.net.
    //   'auto'  – local when installed, otherwise the CDN
    // The CDN versions are listed in core/modules.js.
    'modules_source' => 'auto',

    // Other web sites (origins) that may save sessions for a logged-in user, e.g. a game hosted elsewhere.
    'session_origins' => [
        // 'https://my-cycling-game.example.org',
    ],

    // API keys for reading public information (get_* scripts) from other servers. key => description.
    'api_keys' => [
        // 'a-long-random-key' => 'Example statistics site',
    ],
];
