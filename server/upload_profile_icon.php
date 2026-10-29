<?php
/*
 * POST multipart/form-data
 *   icon=<file>      – upload/replace the logged-in user's own profile picture
 *   library=<name>   – use a picture from the library (assets/profile_icons/, see list_profile_icons.php)
 *   remove=1         – go back to the default picture (assets/profile_icons/default.png)
 *
 * A user has one picture at a time: choosing a library picture or the default deletes their upload.
 *
 * Uploads are saved as assets/user_uploaded_profile_icons/<username>.png.
 * They must be a square PNG (transparency is fine – the chosen background colour shows through),
 * 64–1024 px and at most MAX_ICON_BYTES. The profile page crops and resizes images before uploading.
 * Only allowed from this site.
 */
require_once __DIR__ . '/api_common.php';

const MAX_ICON_BYTES = 512 * 1024;
const MIN_ICON_SIZE = 64;
const MAX_ICON_SIZE = 1024;

require_method('POST');
require_same_origin();
$user = require_user();
$path = profile_icon_path($user['username']);

function save_icon_image(array $user, ?string $value): void
{
    global $database;
    $database->prepare('UPDATE user SET icon_image = ? WHERE user_id = ?')->execute([$value, $user['user_id']]);
    $statement = $database->prepare('SELECT * FROM user WHERE user_id = ?');
    $statement->execute([$user['user_id']]);
    respond(['user' => own_user_json($statement->fetch())]);
}

if (!empty($_POST['remove'])) {
    if (is_file($path)) unlink($path);
    save_icon_image($user, null);
}

if (isset($_POST['library'])) {
    $choice = (string) $_POST['library'];
    if (!in_array($choice, profile_icon_library(), true)) fail('That picture is not in the library.', 400, 'library');
    if (is_file($path)) unlink($path);
    save_icon_image($user, $choice === PROFILE_ICON_DEFAULT ? null : PROFILE_ICON_LIBRARY . $choice);
}

$file = $_FILES['icon'] ?? null;
if (!$file || $file['error'] === UPLOAD_ERR_NO_FILE) fail('No picture was sent.', 400, 'no_file');
if ($file['error'] === UPLOAD_ERR_INI_SIZE || $file['error'] === UPLOAD_ERR_FORM_SIZE || $file['size'] > MAX_ICON_BYTES) {
    fail('The picture is too large (max ' . (MAX_ICON_BYTES / 1024) . ' kB).', 413, 'too_large');
}
if ($file['error'] !== UPLOAD_ERR_OK || !is_uploaded_file($file['tmp_name'])) fail('The upload failed. Try again.', 400, 'upload');

// Check the real content, not the file name or the type the browser claims.
$info = @getimagesize($file['tmp_name']);
if (!$info || $info[2] !== IMAGETYPE_PNG || file_get_contents($file['tmp_name'], false, null, 0, 8) !== "\x89PNG\r\n\x1a\n") {
    fail('The picture must be a PNG image.', 400, 'type');
}
[$width, $height] = $info;
if ($width !== $height) fail('The picture must be square.', 400, 'not_square');
if ($width < MIN_ICON_SIZE || $width > MAX_ICON_SIZE) fail('The picture must be between ' . MIN_ICON_SIZE . ' and ' . MAX_ICON_SIZE . ' pixels wide.', 400, 'size');

if (!is_dir(dirname($path))) mkdir(dirname($path), 0755, true);
if (!move_uploaded_file($file['tmp_name'], $path)) fail('The picture could not be saved on the server.', 500, 'save');

save_icon_image($user, profile_icon_url($user['username']));
