<?php
/*
 * POST {application_id, is_public, started_at, duration, distance, avg_power, max_power, avg_hr,
 *       avg_speed, avg_cadence, energy, notes: {title, description}, data: base64 .ride}
 * Saves a finished session for the logged-in user, awards coins and updates the stats.
 *
 * From this site the user comes from the login cookie. Sites listed in config 'session_origins'
 * may also save sessions; they send {username, user_key} in the body instead.
 */
require_once __DIR__ . '/api_common.php';
require_once __DIR__ . '/update_user_stats.php';

const MAX_RIDE_BYTES = 8 * 1024 * 1024; // the RIDE format is ~120 kB per hour

$origin = request_origin();
$foreign = $origin !== null && !is_same_origin();
if ($foreign) {
    if (!in_array($origin, $config['session_origins'] ?? [], true)) fail('This site may not save sessions here.', 403, 'origin');
    header('Access-Control-Allow-Origin: ' . $origin);
    header('Vary: Origin');
    header('Access-Control-Allow-Methods: POST');
    header('Access-Control-Allow-Headers: Content-Type');
    if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
        http_response_code(204);
        exit;
    }
}

require_method('POST');
$body = request_body();

if ($foreign) {
    $user = user_from_credentials((string) ($body['username'] ?? ''), (string) ($body['user_key'] ?? ''));
    if (!$user) fail('Unknown user or key.', 401, 'login');
} else {
    require_same_origin();
    $user = require_user();
}

/** A number from the body within [min, max], or null when missing. */
function bounded(array $body, string $key, float $min, float $max): ?float
{
    if (!isset($body[$key]) || $body[$key] === '') return null;
    if (!is_numeric($body[$key]) || $body[$key] < $min || $body[$key] > $max) fail("$key is out of range.", 400, 'range');
    return (float) $body[$key];
}

$application_id = (string) ($body['application_id'] ?? '');
if (!preg_match('/^[A-Za-z0-9_\-]{1,60}$/', $application_id)) fail('application_id is missing or invalid.', 400, 'application_id');

$started_at = normalize_time($body['started_at'] ?? null);
if (!$started_at) fail('started_at must be an ISO 8601 time.', 400, 'started_at');

$duration = (int) (bounded($body, 'duration', 0, 7 * 24 * 3600) ?? 0);
$distance = bounded($body, 'distance', 0, 5000000) ?? 0.0;

$notes = is_array($body['notes'] ?? null) ? $body['notes'] : [];
$title = mb_substr(trim((string) ($notes['title'] ?? '')), 0, 120);
$description = mb_substr(trim((string) ($notes['description'] ?? '')), 0, 2000);

$data = null;
if (!empty($body['data'])) {
    $data = base64_decode((string) $body['data'], true);
    if ($data === false || strlen($data) > MAX_RIDE_BYTES || substr($data, 0, 4) !== 'RIDE') fail('data must be a base64 .ride recording.', 400, 'data');
}

$session_key = random_key(16);
$statement = $database->prepare(
    'INSERT INTO session (session_key, user_id, application_id, is_public, started_at, duration, distance,
        avg_power, max_power, avg_hr, avg_speed, avg_cadence, energy, session_data, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
);
$values = [
    $session_key, $user['user_id'], $application_id, !empty($body['is_public']) ? 1 : 0, $started_at, $duration, $distance,
    bounded($body, 'avg_power', 0, 3000), bounded($body, 'max_power', 0, 5000), bounded($body, 'avg_hr', 0, 260),
    bounded($body, 'avg_speed', 0, 200), bounded($body, 'avg_cadence', 0, 300), bounded($body, 'energy', 0, 100000),
];
foreach ($values as $index => $value) $statement->bindValue($index + 1, $value);
$statement->bindValue(14, $data, $data === null ? PDO::PARAM_NULL : PDO::PARAM_LOB);
$statement->bindValue(15, json_encode(['title' => $title, 'description' => $description], JSON_UNESCAPED_UNICODE));
$statement->execute();

$coins = coins_for_session($distance, $duration);
$database->prepare('INSERT OR IGNORE INTO user_stats (user_id) VALUES (?)')->execute([$user['user_id']]);
$database->prepare('UPDATE user_stats SET coins = coins + ? WHERE user_id = ?')->execute([$coins, $user['user_id']]);
$stats = recalculate_user_stats((int) $user['user_id']);

$statement = $database->prepare('SELECT s.*, u.username, u.nickname, u.icon, u.icon_image FROM session s JOIN user u ON u.user_id = s.user_id WHERE s.session_key = ?');
$statement->execute([$session_key]);
respond(['session' => session_json($statement->fetch()), 'coins_earned' => $coins, 'stats' => $stats]);
