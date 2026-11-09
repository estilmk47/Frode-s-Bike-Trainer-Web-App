<?php
/*
 * POST {authKey} → {label, rooms}
 * Log in with an authentication key (api/authentication_keys.php): whose it is and their rooms.
 */
require_once __DIR__ . '/partyspin_common.php';

require_method('POST');
require_same_origin();

$owner = ps_require_owner(request_body());
respond(['label' => $owner, 'rooms' => ps_rooms_of($owner)]);
