# Party Spin server

Party Spin has two back ends, and both use the same database: the hub's (the SQLite file named in
`server/config.php`), unless you give Party Spin a file of its own (see *Which database* below):

* **The PHP scripts** in `applications/PartySpin/api/`: everything before a game. Device ids,
  checking a room name and key, and the create menu (log in with an authentication key, create,
  change and delete rooms with their planned events). They run wherever the hub runs (`php -S` at
  home, nginx + php-fpm online).
* **This Python WebSocket server**: the games themselves. When someone enters a room it loads the
  room from the database, keeps it in memory while it is used and saves the game back.

## Run it

```bash
cd applications/PartySpin/server
python -m pip install -r requirements.txt      # once (Python 3.10 or newer)
python partyspin_server.py                      # ws://0.0.0.0:8765
```

Options:

| Option | Default | |
|---|---|---|
| `--host` | `0.0.0.0` | Address to listen on. Use `127.0.0.1` behind nginx. |
| `--port` | `8765` | |
| `--db` | from `config.php` | Another SQLite file, for tests (overrides `config.php`). |

Who may create rooms is not set here: see *Authentication keys* below.

## Authentication keys

Creating rooms (**Create** in the lobby) needs an authentication key. The keys are in
`applications/PartySpin/api/authentication_keys.php`, a list of names and keys you edit by hand:

```php
return [
    'Frode' => 'a-long-random-key',
    'Sigrid' => 'another-long-random-key',
];
```

* Share a key with whoever may make rooms; they type it under **Create**.
* Rooms belong to the **name**: give someone a new key under the same name and they keep their rooms.
  Delete a line to take their access away (their rooms stay, but nobody can edit them).
* Keys must be at least 12 characters. Make one with `php -r "echo bin2hex(random_bytes(12));"`.
* Changes count straight away; nothing needs a restart.
* The file is in `.gitignore`. `authentication_keys.example.php` (committed) shows the format: copy
  it to `authentication_keys.php` on a new server. Keep to one `'Name' => 'key',` per line, because
  this server reads the file too (the owner of a room is a moderator in it when spectating).

Room keys are different: they are set per room in the create menu, and only a hash of them is stored.
Whoever spectates a room with its key is a moderator. Riders are never moderators.

Room names are found without caring about upper case or spaces: "Friday Spin", "friday spin" and
"FridaySpin" are the same room (`name_key`).

Browsers find this server like this:

* on `http://` pages: `ws://<same computer>:8765`
* on `https://` pages: `wss://<same site>/partyspin/ws`
* or an address entered in the lobby (⚙) or given as `?server=` in the address bar

When it can't be reached, or the room doesn't exist, you see the "server disconnected" or "room
not found" picture when you try to enter a room. Making rooms doesn't need it.

On a home network, Windows Firewall has to allow Python on **Private** networks (it asks the first time).

## Which database

By default the Party Spin tables are in the hub's database: one file for everything. To keep them
in a file of their own (to experiment, or to keep the hub's file clean), copy
`config.example.php` in this folder to `config.php` and set `database`:

```php
return [
    'database' => 'partyspin.sqlite',   // null = the hub's database
];
```

* A file name is a file in the hub's `server/databases/` folder (protected from browsers, not in git).
  A full path (`C:/data/test.sqlite`, `/srv/data/partyspin.sqlite`) can be anywhere else.
* The file and its tables are made the first time it is used. Every file keeps its own rooms, so
  you can switch back and forth.
* Logins still come from the hub's database: a logged in user keeps the same device id in both.
* `config.php` is not in git. Restart this server after changing it (the PHP scripts read it every time).

## The database

`database/create-partyspin-tables.sql` has the Party Spin tables, with notes on every column. The PHP
scripts make them when they are missing, and the server runs the file every time it starts.

* `partyspin_device`: device ids (one per hub user, one per guest browser)
* `partyspin_room`: name, room key, settings, and the state of its game
* `partyspin_player`: the riders in a room, with score, cards and ghost mode
* `partyspin_run` and `partyspin_run_player`: every game that was played in a room, with how each
  rider did (written when a game ends and when the room is restarted)
* `partyspin_event_type`: the kinds of event, and what their `server_info` and `device_info` hold
* `partyspin_event`: everything planned for a room (`run` NULL) or that happened in game *n* (`run` *n*);
  a restart keeps the events of the old game, so it can be looked back on later

The two switches moderators use during a game are in the room's `settings`: `powerups` (cards can
be played) and `break` (nobody scores from riding; cards still work and the clock goes on). Pausing
stops the clock and is kept for emergencies; in the room view it has to be held down.

Who writes what: the PHP scripts write rooms (name, key, settings) and planned events; this server
writes the game (status, clock, players, game events and the status of planned events). When the PHP
scripts change a room that is open, they set `edited_at_ms` and the server picks the changes up
within two seconds. A deleted room sends everyone in it back to the lobby.

A browser connects to this server when it enters a room and disconnects when it leaves. Its rider
stays in the room (and in the database) with score and cards, until a moderator removes them or the
room is deleted.

Games are saved right after anything important happens (a card played, a question asked, start,
pause or end), and every 5 seconds while scores change. A room nobody has used for a minute is
saved and taken out of memory. Time a room is not loaded (no one in it, or the server is down)
doesn't count as game time: a game waits for its riders.

## Online, behind nginx (HTTPS → WSS)

Run the server on `127.0.0.1` and let nginx handle the certificate:

```nginx
location /partyspin/ws {
    proxy_pass http://127.0.0.1:8765;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 1h;
}

# The server code is not for browsers (Apache uses .htaccess for this).
location ^~ /applications/PartySpin/server/ { deny all; }
location ~ ^/applications/PartySpin/api/(partyspin_common|authentication_keys.*)\.php$ { deny all; }
```

The server has to be able to write to the database file and its folder, like php-fpm (run both as
the same user, e.g. `www-data`).

To start it with the computer, use a systemd service:

```ini
# /etc/systemd/system/partyspin.service
[Unit]
Description=Party Spin server
After=network.target

[Service]
WorkingDirectory=/var/www/bike-trainer/applications/PartySpin/server
ExecStart=/usr/bin/python3 partyspin_server.py --host 127.0.0.1
Restart=on-failure
User=www-data

[Install]
WantedBy=multi-user.target
```

## Files

* `partyspin_server.py`: connections, messages, the clock (ticks 4×/s, scores 1×/s, saves every 5 s)
* `game.py`: the rules of a room, without networking (cards, Nope, Hakoot, start/pause/end)
* `cards.py`: the power-up cards and their numbers. The browser gets this list from the server.
* `store.py`: loading and saving rooms in the database, reading the authentication keys
* `../api/*.php`: the PHP scripts (see the comment at the top of each)
* `../room.js`: the room in the browser, for riders and spectators (top bar, panels, drawer)
