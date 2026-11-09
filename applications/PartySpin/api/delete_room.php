<?php
/*
 * POST {authKey, id} → {}
 * Delete one of your rooms with everything in it (players, planned events, games). Riders who are
 * in it are sent back to the lobby by the Party Spin server.
 */
require_once __DIR__ . '/partyspin_common.php';

require_method('POST');
require_same_origin();

$body = request_body();
$owner = ps_require_owner($body);
$statement = $ps_db->prepare('DELETE FROM partyspin_room WHERE room_id = ? AND owner = ?');
$statement->execute([(int) ($body['id'] ?? 0), $owner]);
if ($statement->rowCount() === 0) fail('That is not one of your rooms.', 404, 'not-yours');
respond();
