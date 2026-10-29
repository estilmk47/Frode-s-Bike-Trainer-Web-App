<?php
/*
 * GET – the library of profile pictures everyone can choose from: every image in assets/profile_icons/.
 * Add a picture to that folder and it shows up automatically (default.png is always listed first).
 * Public information, so no login or API key is needed.
 */
require_once __DIR__ . '/api_common.php';

require_method('GET');
header('Access-Control-Allow-Origin: *');

respond(['icons' => profile_icon_library()]);
