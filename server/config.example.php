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

    // Sender of the login e-mails. With Gmail this must be the Gmail address itself (or one of its
    // aliases): Gmail replaces any other sender with the account's address.
    'mail_from' => "Frode's Bike Trainer <your.app@gmail.com>",

    // How e-mail is sent (server/mailer.php). Test it with: php server/test_mail.php you@example.com
    'mail' => [
        // 'smtp' – log in to a mail provider (below). Needs extension=openssl in php.ini.
        // 'php'  – PHP's own mail(), for a server with a working sendmail (then the rest is unused).
        'transport' => 'smtp',

        // Gmail: smtp.gmail.com, port 465 with 'ssl' (or 587 with 'tls' = STARTTLS).
        'host' => 'smtp.gmail.com',
        'port' => 465,
        'encryption' => 'ssl',

        // The Gmail account, and an *App password* for it – not the account's normal password.
        // Google account → Security → turn on 2-Step Verification → App passwords → create one
        // (e.g. "Bike Trainer"). Google shows 16 letters in groups of four; copy them as they are.
        'username' => 'your.app@gmail.com',
        'password' => 'abcd efgh ijkl mnop',

        // Only if connecting fails with a certificate error (PHP on Windows sometimes can't find
        // the trusted certificates): download https://curl.se/ca/cacert.pem and give its full path,
        // e.g. 'C:/php/extras/ssl/cacert.pem'. null = PHP's default (openssl.cafile in php.ini).
        'ca_file' => null,

        // Seconds to wait for the mail server.
        'timeout' => 15,
    ],

    // Minimum seconds between two login e-mails to the same address.
    'login_link_interval' => 60,

    // DEVELOPMENT ONLY: return the login link in the response instead of relying on e-mail.
    // Never enable this on a public server – anyone could log in as anyone.
    'dev_return_login_link' => false,

    // The simulated bike and heart rate monitor (the "Simulator" buttons in Devices, everywhere).
    // true for development and demos; false for a real release: only real Bluetooth devices.
    'simulators' => true,

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
