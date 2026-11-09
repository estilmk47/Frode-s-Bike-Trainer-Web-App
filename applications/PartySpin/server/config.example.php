<?php
/*
 * Party Spin settings. Copy this file to config.php (in this folder) and change it there; config.php
 * is not in git. Without config.php the defaults below are used.
 *
 * Both back ends read it: the PHP scripts in ../api and the Python server (store.py). Keep to the
 * simple form below (one 'name' => value per line), because Python reads this file as text.
 * After a change, restart the Python server.
 */
return [
    // Where Party Spin keeps its rooms, riders and games:
    //   null                     the hub's database (server/config.php → database_file): one database
    //                            for everything (default)
    //   'partyspin.sqlite'       a database of its own, in the hub's server/databases/ folder (protected
    //                            from browsers and not in git). It is made the first time it is used.
    //   'C:/data/test.sqlite'    a full path: anywhere else (keep it out of the web folders)
    // Switching back and forth is fine: every file keeps its own rooms.
    'database' => null,
];
