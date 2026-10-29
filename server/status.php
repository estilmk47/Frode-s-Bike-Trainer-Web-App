<?php
/*
 * Tells the front end that the PHP backend is running (core/api.js → detectBackend()).
 * Without PHP (e.g. python -m http.server) this file is served as plain text and the app uses local mode.
 */
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

$config_file = __DIR__ . '/config.php';
$config = is_file($config_file) ? require $config_file : [];
$modules = $config['modules_source'] ?? 'auto';

echo json_encode([
    'ok' => true,
    'app' => 'fbt',
    'configured' => is_file($config_file) && extension_loaded('pdo_sqlite'),
    'modules' => in_array($modules, ['local', 'cdn', 'auto'], true) ? $modules : 'auto',
]);
