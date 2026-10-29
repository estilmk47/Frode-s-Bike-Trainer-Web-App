<?php
/*
 * Opens the SQLite database. Include this file and use $database (a PDO connection) and $config.
 *
 * The database lives in server/databases/ under the secret file name from server/config.php.
 * When the file does not exist yet it is created from create-database-template.sql.
 * PRAGMA user_version tracks the schema version: add migrations below when the schema changes.
 */

$config_file = __DIR__ . '/config.php';
if (!is_file($config_file)) {
    http_response_code(503);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['ok' => false, 'error' => 'The server is not configured yet (copy server/config.example.php to server/config.php).', 'code' => 'not_configured']);
    exit;
}
$config = require $config_file;

$database_path = __DIR__ . '/databases/' . basename($config['database_file']);

try {
    $database = new PDO('sqlite:' . $database_path);
    $database->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $database->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
    $database->exec('PRAGMA foreign_keys = ON');
    $database->exec('PRAGMA busy_timeout = 5000');

    // A new database gets the full template (always the latest schema); older ones are migrated step by step.
    $latest_version = 2;
    $schema_version = (int) $database->query('PRAGMA user_version')->fetchColumn();
    if ($schema_version < 1) {
        $database->exec(file_get_contents(__DIR__ . '/create-database-template.sql'));
        $database->exec("PRAGMA user_version = $latest_version");
        $schema_version = $latest_version;
    }
    if ($schema_version < 2) {
        // Uploaded profile pictures.
        $database->exec('ALTER TABLE user ADD COLUMN icon_image VARCHAR(120)');
        $database->exec('PRAGMA user_version = 2');
    }
    // Next migration: if ($schema_version < 3) { ...; PRAGMA user_version = 3 } and raise $latest_version.
} catch (PDOException $exception) {
    error_log('Database error: ' . $exception->getMessage());
    http_response_code(500);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['ok' => false, 'error' => 'The database is not available.', 'code' => 'database']);
    exit;
}
