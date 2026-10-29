<?php
/*
 * GET ?session_key=<key>[&data=1]  – one session (data=1 adds the .ride recording as base64)
 * GET ?username=<name>             – a user's sessions: all of them for yourself, public ones for others
 *     [&friends=1]                 – (yourself only) also your friends' public sessions
 *     [&from=<ISO>&to=<ISO>]       – only sessions that started in this period
 *     [&limit=<n>]                 – max 500, default 100
 * GET ?feed=1[&limit=<n>]          – the latest public sessions of all public users
 *
 * Allowed from this site, or from elsewhere with an API key (then only public sessions).
 */
require_once __DIR__ . '/api_common.php';

require_method('GET');
require_same_origin_or_api_key();

$viewer = is_same_origin() ? current_user() : null;
$viewer_id = $viewer ? (int) $viewer['user_id'] : 0;
$limit = max(1, min(500, (int) ($_GET['limit'] ?? 100)));

// Every column except the (large) recording.
const SESSION_COLUMNS = 's.session_key, s.user_id, s.application_id, s.is_public, s.started_at, s.duration, s.distance,
    s.avg_power, s.max_power, s.avg_hr, s.avg_speed, s.avg_cadence, s.energy, s.notes, u.username, u.nickname, u.icon, u.icon_image, u.is_public AS user_is_public';

/* ---------- One session ---------- */

if (isset($_GET['session_key'])) {
    $with_data = !empty($_GET['data']);
    $statement = $database->prepare(
        'SELECT ' . SESSION_COLUMNS . ($with_data ? ', s.session_data' : '') . '
         FROM session s JOIN user u ON u.user_id = s.user_id WHERE s.session_key = ?'
    );
    $statement->execute([(string) $_GET['session_key']]);
    $row = $statement->fetch();
    $visible = $row && ((int) $row['user_id'] === $viewer_id || ((int) $row['is_public'] === 1 && (int) $row['user_is_public'] === 1));
    if (!$visible) fail('Session not found.', 404, 'not_found');
    if (!$with_data) $row['session_data'] = null;
    respond(['session' => session_json($row, $with_data)]);
}

/* ---------- Lists ---------- */

$where = [];
$params = [];

if (!empty($_GET['feed'])) {
    $where[] = 's.is_public = 1 AND u.is_public = 1';
} else {
    $target = find_user_by_username((string) ($_GET['username'] ?? ($viewer['username'] ?? '')));
    if (!$target) fail('There is no user with that name.', 404, 'not_found');
    $target_id = (int) $target['user_id'];

    if ($target_id === $viewer_id) {
        if (!empty($_GET['friends'])) {
            $where[] = '(s.user_id = ? OR (s.user_id IN (SELECT friend_id FROM user_friend WHERE user_id = ?) AND s.is_public = 1 AND u.is_public = 1))';
            array_push($params, $viewer_id, $viewer_id);
        } else {
            $where[] = 's.user_id = ?';
            $params[] = $viewer_id;
        }
    } else {
        if ((int) $target['is_public'] !== 1) respond(['sessions' => []]);
        $where[] = 's.user_id = ? AND s.is_public = 1';
        $params[] = $target_id;
    }
}

if ($from = normalize_time($_GET['from'] ?? null)) { $where[] = 's.started_at >= ?'; $params[] = $from; }
if ($to = normalize_time($_GET['to'] ?? null)) { $where[] = 's.started_at <= ?'; $params[] = $to; }

$statement = $database->prepare(
    'SELECT ' . SESSION_COLUMNS . ' FROM session s JOIN user u ON u.user_id = s.user_id
     WHERE ' . implode(' AND ', $where) . " ORDER BY s.started_at DESC LIMIT $limit"
);
$statement->execute($params);
$sessions = array_map(function ($row) { $row['session_data'] = null; return session_json($row); }, $statement->fetchAll());
respond(['sessions' => $sessions]);
