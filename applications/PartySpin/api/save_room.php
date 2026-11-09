<?php
/*
 * POST {authKey, room: {id?, name, roomKey, settings, schedule}} → {room}
 * Create a room (no id) or change one of your own. A new room needs a room key; when changing,
 * an empty roomKey keeps the old one. `schedule` is the list of planned events (Hakoot, poker).
 * If the room is open on the Party Spin server, the server picks up the changes by itself.
 */
require_once __DIR__ . '/partyspin_common.php';

require_method('POST');
require_same_origin();

$body = request_body();
$owner = ps_require_owner($body);
$input = is_array($body['room'] ?? null) ? $body['room'] : [];

$room = null;
if (!empty($input['id'])) {
    $statement = $ps_db->prepare('SELECT * FROM partyspin_room WHERE room_id = ? AND owner = ?');
    $statement->execute([(int) $input['id'], $owner]);
    $room = $statement->fetch() ?: null;
    if (!$room) fail('That is not one of your rooms.', 404, 'not-yours');
}

$name = ps_clean_name($input['name'] ?? '');
if ($name === '' || mb_strlen($name) > PS_MAX_NAME) fail('Give the room a name of at most ' . PS_MAX_NAME . ' characters.', 400, 'name');
$other = ps_find_room($name);
if ($other && (!$room || (int) $other['room_id'] !== (int) $room['room_id'])) fail('There is already a room with that name.', 409, 'name-taken');

$key = (string) ($input['roomKey'] ?? '');
if (!$room && $key === '') fail('A room needs a room key.', 400, 'room-key');
$settings = json_encode(ps_settings($input['settings'] ?? []), JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);

try {
    $ps_db->beginTransaction();
    if ($room) {
        $room_id = (int) $room['room_id'];
        $ps_db->prepare('UPDATE partyspin_room SET name = ?, name_key = ?, settings = ?, edited_at_ms = ? WHERE room_id = ?')
            ->execute([$name, ps_name_key($name), $settings, ps_now_ms(), $room_id]);
        if ($key !== '') {
            $ps_db->prepare('UPDATE partyspin_room SET key_hash = ? WHERE room_id = ?')->execute([ps_hash_room_key($key), $room_id]);
        }
    } else {
        $ps_db->prepare('INSERT INTO partyspin_room (name, name_key, key_hash, owner, settings, edited_at_ms) VALUES (?, ?, ?, ?, ?, ?)')
            ->execute([$name, ps_name_key($name), ps_hash_room_key($key), $owner, $settings, ps_now_ms()]);
        $room_id = (int) $ps_db->lastInsertId();
    }
    ps_save_planned_events($room_id, $input['schedule'] ?? []);
    $ps_db->commit();
} catch (PDOException $exception) {
    if ($ps_db->inTransaction()) $ps_db->rollBack();
    if ($exception->getCode() === '23000') fail('There is already a room with that name.', 409, 'name-taken');
    throw $exception;
}

$statement = $ps_db->prepare('SELECT * FROM partyspin_room WHERE room_id = ?');
$statement->execute([$room_id]);
respond(['room' => ps_room_json($statement->fetch())]);
