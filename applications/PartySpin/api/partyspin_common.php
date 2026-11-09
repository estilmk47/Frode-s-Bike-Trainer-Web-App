<?php
/*
 * Helpers for the Party Spin scripts in this folder. They use the hub's helpers (server/api_common.php:
 * logins, answers) and `$ps_db`, the Party Spin database: the hub's own ($database) unless
 * ../server/config.php names another file. The Party Spin tables are made from
 * ../server/database/create-partyspin-tables.sql when they are missing.
 *
 * The browser format of a room and its planned events is the same as the Party Spin server's
 * (server/game.py): keep the two in step.
 */
require_once dirname(__DIR__, 3) . '/server/api_common.php';

const PS_MAX_NAME = 40;
const PS_EVENT_TYPES = ['hakoot', 'poker'];   // the kinds of event that can be planned

/** The Party Spin settings (../server/config.php; without it the defaults from config.example.php). */
function ps_config(): array
{
    $file = dirname(__DIR__) . '/server/config.php';
    $settings = is_file($file) ? require $file : [];
    return (is_array($settings) ? $settings : []) + ['database' => null];
}

/** The database file from the settings: null = the hub's, a name = server/databases/<name>, or a full path. */
function ps_database_path(): ?string
{
    $name = ps_config()['database'];
    if (!is_string($name) || trim($name) === '') return null;
    $name = trim($name);
    $absolute = preg_match('~^([a-zA-Z]:)?[/\\\\]~', $name) === 1;
    return $absolute ? $name : dirname(__DIR__, 3) . '/server/databases/' . basename($name);
}

$ps_path = ps_database_path();
if ($ps_path === null) {
    $ps_db = $database;
} else {
    try {
        $ps_db = new PDO('sqlite:' . $ps_path);
        $ps_db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $ps_db->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
        $ps_db->exec('PRAGMA foreign_keys = ON');
        $ps_db->exec('PRAGMA busy_timeout = 5000');
    } catch (PDOException $exception) {
        error_log('Party Spin database error: ' . $exception->getMessage());
        fail('The Party Spin database is not available.', 500, 'database');
    }
}

// The newest table missing: make what is missing (every statement in the file can run again).
$ps_tables = $ps_db->query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'partyspin_run_player'")->fetchColumn();
if (!$ps_tables) {
    $ps_db->exec(file_get_contents(dirname(__DIR__) . '/server/database/create-partyspin-tables.sql'));
}
// Columns added after the tables were first made (upgrade() in store.py does the same).
$ps_columns = fn(string $table) => array_column($ps_db->query("PRAGMA table_info($table)")->fetchAll(), 'name');
$ps_room_columns = $ps_columns('partyspin_room');
if (!in_array('owner', $ps_room_columns, true)) {
    // Rooms made while authentication keys were kept in the database get their owner's name.
    $ps_db->exec('ALTER TABLE partyspin_room ADD COLUMN owner VARCHAR(80)');
    if (in_array('owner_id', $ps_room_columns, true)) {
        $ps_db->exec('UPDATE partyspin_room SET owner = (SELECT label FROM partyspin_auth_key WHERE auth_key_id = owner_id)');
    }
}
if (!in_array('ghost', $ps_columns('partyspin_player'), true)) {
    $ps_db->exec('ALTER TABLE partyspin_player ADD COLUMN ghost INTEGER NOT NULL DEFAULT 0');
}
// Room names used to be found with single spaces kept; now spaces don't count at all.
$ps_db->exec("UPDATE OR IGNORE partyspin_room SET name_key = REPLACE(name_key, ' ', '') WHERE name_key LIKE '% %'");

function ps_now_ms(): int
{
    return (int) floor(microtime(true) * 1000);
}

/* ---------- Names and keys ---------- */

/** "  Friday   Spin " → "Friday Spin" */
function ps_clean_name($name): string
{
    return trim(preg_replace('/\s+/u', ' ', (string) $name));
}

/** Rooms are found without caring about upper case or spaces: "Friday Spin" = "fridayspin". */
function ps_name_key($name): string
{
    return mb_strtolower(preg_replace('/\s+/u', '', (string) $name), 'UTF-8');
}

function ps_hash_room_key(string $key): string
{
    $salt = bin2hex(random_bytes(8));
    return $salt . '$' . hash_pbkdf2('sha256', $key, $salt, 50000);
}

function ps_check_room_key($key, ?string $stored): bool
{
    if (!is_string($key) || $key === '' || !$stored || strpos($stored, '$') === false) return false;
    [$salt, $digest] = explode('$', $stored, 2);
    return hash_equals($digest, hash_pbkdf2('sha256', $key, $salt, 50000));
}

/**
 * Who may create rooms: name => key from authentication_keys.php (keys shorter than 12 characters
 * are ignored). Fails when the file has not been made yet.
 */
function ps_auth_keys(): array
{
    $file = __DIR__ . '/authentication_keys.php';
    if (!is_file($file)) {
        fail('Nobody can create rooms yet: copy api/authentication_keys.example.php to api/authentication_keys.php and add a key.', 503, 'no-keys');
    }
    $keys = require $file;
    $valid = [];
    foreach (is_array($keys) ? $keys : [] as $name => $key) {
        if (is_string($key) && strlen($key) >= 12) $valid[(string) $name] = $key;
    }
    return $valid;
}

/** The name the authentication key in the request body belongs to, or a 401. Wrong keys are answered slowly. */
function ps_require_owner(array $body): string
{
    $given = (string) ($body['authKey'] ?? '');
    $owner = null;
    foreach (ps_auth_keys() as $name => $key) {
        if ($given !== '' && hash_equals($key, $given)) $owner = $name;
    }
    if ($owner === null) {
        usleep(500000);
        fail('That authentication key does not exist.', 401, 'wrong-key');
    }
    return $owner;
}

function ps_find_room(string $name): ?array
{
    global $ps_db;
    $statement = $ps_db->prepare('SELECT * FROM partyspin_room WHERE name_key = ?');
    $statement->execute([ps_name_key($name)]);
    return $statement->fetch() ?: null;
}

/* ---------- Numbers ---------- */

function ps_number($value, float $low, float $high, $default)
{
    if (!is_numeric($value)) return $default;
    $number = min($high, max($low, (float) $value));
    return floor($number) == $number ? (int) $number : $number;
}

/* ---------- Settings ---------- */

function ps_settings($input): array
{
    $input = is_array($input) ? $input : [];
    $end = is_array($input['end'] ?? null) ? $input['end'] : [];
    $display = is_array($input['display'] ?? null) ? $input['display'] : [];
    return [
        'mode' => in_array($input['mode'] ?? '', ['ftp', 'power', 'wkg'], true) ? $input['mode'] : 'ftp',
        'end' => [
            'type' => in_array($end['type'] ?? '', ['time', 'points', 'manual'], true) ? $end['type'] : 'time',
            'value' => ps_number($end['value'] ?? null, 1, 10000000, 30),
        ],
        'powerups' => (bool) ($input['powerups'] ?? true),   // cards can be played
        'break' => (bool) ($input['break'] ?? false),         // nobody scores (switched by moderators in a game)
        'display' => [
            'background' => in_array($display['background'] ?? '', ['brick', 'color', 'video'], true) ? $display['background'] : 'brick',
            'color' => mb_substr((string) ($display['color'] ?? '#2b1d33'), 0, 20),
            'video' => mb_substr((string) ($display['video'] ?? ''), 0, 500),
        ],
    ];
}

/* ---------- Planned events ----------
 * Browser format (seconds):
 *   hakoot {id, type, at, question, answers: [2-4], correct, image, read, answer, rewards}
 *   poker  {id, type, at, duration, potMin, potMax}
 * In the database: trigger_at / trigger_window in ms, the secret parts in server_info.
 */

/** A planned event from the browser → the database columns, or null when it is not usable. */
function ps_event_row($event): ?array
{
    if (!is_array($event) || !in_array($event['type'] ?? '', PS_EVENT_TYPES, true)) return null;
    $at = ps_number($event['at'] ?? null, 0, 24 * 3600, 60);
    $id = is_numeric($event['id'] ?? null) ? (int) $event['id'] : null;   // new events have a temporary text id
    if ($event['type'] === 'poker') {
        $duration = ps_number($event['duration'] ?? null, 10, 600, 120);
        $min = ps_number($event['potMin'] ?? null, 0, 1000000, 1000);
        $max = max($min, ps_number($event['potMax'] ?? null, 0, 1000000, 5000));
        return [
            'event_id' => $id, 'type' => 'poker', 'trigger_at' => $at * 1000, 'trigger_window' => $duration * 1000,
            'server_info' => ['pot_min' => $min, 'pot_max' => $max],
            'device_info' => ['duration' => $duration],
        ];
    }
    $answers = [];
    foreach (is_array($event['answers'] ?? null) ? $event['answers'] : [] as $answer) {
        $answer = mb_substr(trim((string) $answer), 0, 120);
        if ($answer !== '' && count($answers) < 4) $answers[] = $answer;
    }
    $question = mb_substr(trim((string) ($event['question'] ?? '')), 0, 300);
    if ($question === '' || count($answers) < 2) return null;
    $read = ps_number($event['read'] ?? null, 0, 60, 5);
    $answer_time = ps_number($event['answer'] ?? null, 3, 120, 10);
    return [
        'event_id' => $id, 'type' => 'hakoot', 'trigger_at' => $at * 1000, 'trigger_window' => ($read + $answer_time) * 1000,
        'server_info' => [
            'correct' => ps_number($event['correct'] ?? null, 0, count($answers) - 1, 0),
            'rewards' => ps_number($event['rewards'] ?? null, 0, 50, 3),
        ],
        'device_info' => [
            'question' => $question, 'answers' => $answers, 'image' => mb_substr((string) ($event['image'] ?? ''), 0, 500),
            'read' => $read, 'answer' => $answer_time,
        ],
    ];
}

/** A planned event row from the database → the browser format. */
function ps_event_json(array $row): array
{
    $server = json_decode($row['server_info'] ?? 'null', true) ?: [];
    $device = json_decode($row['device_info'] ?? 'null', true) ?: [];
    $event = ['id' => (int) $row['event_id'], 'type' => $row['type'], 'at' => intdiv((int) $row['trigger_at'], 1000), 'status' => $row['status']];
    if ($row['type'] === 'poker') {
        return $event + ['duration' => $device['duration'] ?? 120, 'potMin' => $server['pot_min'] ?? 1000, 'potMax' => $server['pot_max'] ?? 5000];
    }
    return $event + [
        'question' => $device['question'] ?? '', 'answers' => $device['answers'] ?? [], 'image' => $device['image'] ?? '',
        'read' => $device['read'] ?? 5, 'answer' => $device['answer'] ?? 10,
        'correct' => $server['correct'] ?? 0, 'rewards' => $server['rewards'] ?? 3,
    ];
}

function ps_planned_events(int $room_id): array
{
    global $ps_db;
    $statement = $ps_db->prepare('SELECT * FROM partyspin_event WHERE room_id = ? AND run IS NULL ORDER BY trigger_at, event_id');
    $statement->execute([$room_id]);
    return array_map('ps_event_json', $statement->fetchAll());
}

/**
 * Make the planned events of a room match `$events` (browser format): known ids are updated (their
 * status is kept, so a question that was already asked in a running game is not asked again), new
 * ones are added and missing ones removed.
 */
function ps_save_planned_events(int $room_id, $events): void
{
    global $ps_db;
    $rows = array_values(array_filter(array_map('ps_event_row', is_array($events) ? array_slice($events, 0, 200) : [])));
    $statement = $ps_db->prepare('SELECT event_id FROM partyspin_event WHERE room_id = ? AND run IS NULL');
    $statement->execute([$room_id]);
    $existing = array_map('intval', $statement->fetchAll(PDO::FETCH_COLUMN));

    $update = $ps_db->prepare('UPDATE partyspin_event SET type = ?, trigger_at = ?, trigger_window = ?, server_info = ?, device_info = ?
        WHERE event_id = ? AND room_id = ? AND run IS NULL');
    $insert = $ps_db->prepare("INSERT INTO partyspin_event (room_id, type, trigger_at, trigger_window, status, server_info, device_info)
        VALUES (?, ?, ?, ?, 'planned', ?, ?)");
    $kept = [];
    foreach ($rows as $row) {
        $server = json_encode($row['server_info'], JSON_UNESCAPED_UNICODE);
        $device = json_encode($row['device_info'], JSON_UNESCAPED_UNICODE);
        if ($row['event_id'] !== null && in_array($row['event_id'], $existing, true)) {
            $update->execute([$row['type'], $row['trigger_at'], $row['trigger_window'], $server, $device, $row['event_id'], $room_id]);
            $kept[] = $row['event_id'];
        } else {
            $insert->execute([$room_id, $row['type'], $row['trigger_at'], $row['trigger_window'], $server, $device]);
        }
    }
    $delete = $ps_db->prepare('DELETE FROM partyspin_event WHERE event_id = ? AND room_id = ? AND run IS NULL');
    foreach (array_diff($existing, $kept) as $event_id) $delete->execute([$event_id, $room_id]);
}

/* ---------- Rooms ---------- */

/** A room as its owner sees it in the create menu. */
function ps_room_json(array $room): array
{
    global $ps_db;
    $statement = $ps_db->prepare('SELECT COUNT(*) FROM partyspin_player WHERE room_id = ?');
    $statement->execute([$room['room_id']]);
    return [
        'id' => (int) $room['room_id'],
        'name' => $room['name'],
        'status' => $room['status'],
        'settings' => ps_settings(json_decode($room['settings'] ?? '{}', true)),
        'schedule' => ps_planned_events((int) $room['room_id']),
        'players' => (int) $statement->fetchColumn(),
    ];
}

function ps_rooms_of(string $owner): array
{
    global $ps_db;
    $statement = $ps_db->prepare('SELECT * FROM partyspin_room WHERE owner = ? ORDER BY room_id DESC');
    $statement->execute([$owner]);
    return array_map('ps_room_json', $statement->fetchAll());
}
