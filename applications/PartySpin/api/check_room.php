<?php
/*
 * POST {name, roomKey?} → {room: {id, name}, moderator}
 * Is there a room with this name (upper case and spaces don't matter), and is the room key
 * right? Errors: 404 no-room, 403 wrong-key. Used before joining or spectating.
 */
require_once __DIR__ . '/partyspin_common.php';

require_method('POST');
require_same_origin();

$body = request_body();
$room = ps_find_room((string) ($body['name'] ?? ''));
if (!$room) fail('There is no room with that name.', 404, 'no-room');

$key = (string) ($body['roomKey'] ?? '');
if ($key !== '' && !ps_check_room_key($key, $room['key_hash'])) {
    usleep(300000);
    fail('That is not the key of this room.', 403, 'wrong-key');
}

respond(['room' => ['id' => (int) $room['room_id'], 'name' => $room['name']], 'moderator' => $key !== '']);
