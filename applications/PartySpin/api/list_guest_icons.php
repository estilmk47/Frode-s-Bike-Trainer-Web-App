<?php
/*
 * GET → {icons: [file names]}
 * The pictures in assets/guest_player_icons/ that every rider can pick in Party Spin (riders who
 * aren't logged in can only pick these). Add a picture to that folder and it shows up.
 * Public, so no login is needed.
 */
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-cache');

$folder = dirname(__DIR__) . '/assets/guest_player_icons';
$files = [];
foreach (is_dir($folder) ? (scandir($folder) ?: []) : [] as $file) {
    if (preg_match('/^[A-Za-z0-9_.\-]+\.(png|jpe?g|webp|gif)$/i', $file)) $files[] = $file;
}
natcasesort($files);
echo json_encode(['ok' => true, 'icons' => array_values($files)]);
