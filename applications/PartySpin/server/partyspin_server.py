"""
Party Spin realtime server (WebSocket, JSON messages): it runs the games.

    pip install -r requirements.txt
    python partyspin_server.py                       # ws://0.0.0.0:8765, the hub's database

Who may create rooms is in ../api/authentication_keys.php; the owner of a room is a moderator in it.

Rooms are made and changed by the PHP scripts in ../api (the create menu); this server plays them.
When someone enters a room it is loaded from the database and kept in memory while it is used.
Changes made meanwhile through PHP are picked up within a few seconds; a deleted room sends everyone
in it back to the lobby.

Behind nginx the browser connects with wss://<site>/partyspin/ws (see README.md); nginx handles the
certificate and passes the connection on to this server.

Messages from a browser                         Answers / broadcasts
  hello   {room, roomId?, role, id, name, avatar,  welcome {you, room, cards, events, state, hand}
           ftp, weight, difficulty, ghost,         error {code: 'no-room'} when there is no such room
           roomKey?, authKey?, run?, have?}      (the keys make a spectator a moderator)
  leave   {}  (before closing: you left the room)  left
  profile {name, avatar, ftp, weight, difficulty, ghost}   (a rider changed their profile in the game)
  sync    {run, have}                             events  {run, events, ids}      (only what is missing)
  stats   {power, cadence, hr, speed, eff, mult, points}
  play    {slot, card, target?}   discard {slot}   nope {of}   fixed {of}   answer {of, choice}
  admin   {action, ...}     start pause resume end restart settings quiz launch deal kick
                            kick-all kick-offline
          (settings {powerups} and {break} are the switches of a running game)
  ping    {at}                                    pong {at}
                                                  event {run, event, ids}   state {...} (every second)
                                                  room {room}   hand {hand, nope}   error {message}
                                                  closed (the room was deleted)
Every event carries the id list of the whole log ("1-57"); a client that sees a gap asks with `sync`.

A browser connects when it enters a room and disconnects when it leaves. The riders stay in the
room (and in the database) after they leave, with their score and cards, until they are removed.
"""
import argparse
import asyncio
import json
import logging
import signal

from websockets.asyncio.server import serve
from websockets.exceptions import ConnectionClosed

from cards import public_cards
from game import GameError, check_room_key, now_ms, parse_ranges
from store import Store, check_auth_key, hub_database_path, partyspin_database_path

log = logging.getLogger('partyspin')

TICK = 0.25             # s between game ticks (cards resolve, questions open and close)
STATE_EVERY = 1.0       # s between score broadcasts
SAVE_EVERY = 5.0        # s between saves of changed scores
CHECK_EVERY = 2.0       # s between looks for rooms changed or deleted through PHP
UNLOAD_AFTER = 60.0     # s a room without anyone in it stays in memory


class Client:
    def __init__(self, socket):
        self.socket = socket
        self.room = None
        self.role = None        # 'player' | 'screen'
        self.pid = None
        self.admin = False

    async def send(self, message):
        try:
            await self.socket.send(json.dumps(message, separators=(',', ':')))
        except ConnectionClosed:
            pass


class Server:
    def __init__(self, store):
        self.store = store
        self.rooms = {}         # room id → Room: the rooms in use
        self.clients = {}       # room id → set of Client
        self.empty_since = {}   # room id → loop time it became empty

    # ------------------------------------------------------------ sending

    def members(self, room):
        return self.clients.get(room.id, set())

    async def broadcast(self, room, message, only=None):
        text = json.dumps(message, separators=(',', ':'))
        for client in list(self.members(room)):
            if only and not only(client):
                continue
            try:
                await client.socket.send(text)
            except ConnectionClosed:
                pass

    async def flush(self, room):
        """Send everything the last change produced, and save when it mattered."""
        events, hands, room_changed, important = room.drain()
        for event in events:
            await self.broadcast(room, {'type': 'event', 'run': room.run, 'event': event, 'ids': room.ids()})
        for client in list(self.members(room)):
            if client.pid in hands:
                await client.send({'type': 'hand', **room.hand(client.pid)})
        if room_changed:
            await self.broadcast_room(room)
        if important:
            await self.save(room)

    async def save(self, room):
        if not self.store.save(room):
            await self.drop(room, 'deleted')

    async def drop(self, room, why):
        """Take a room out of memory. A deleted room sends everyone in it back to the lobby."""
        if why == 'deleted':
            await self.broadcast(room, {'type': 'closed'})
            log.info('Room "%s" was deleted', room.name)
        else:
            log.info('Room "%s" unloaded', room.name)
        self.rooms.pop(room.id, None)
        self.clients.pop(room.id, None)
        self.empty_since.pop(room.id, None)

    async def broadcast_room(self, room):
        for client in list(self.members(room)):
            await client.send({'type': 'room', 'room': room.info(admin=client.admin)})

    def open_room(self, name, room_id=None):
        """The room called `name` (or with this id, which survives a rename), loaded when needed."""
        if not (isinstance(room_id, int) and self.store.room_exists(room_id)):
            room_id = self.store.find_room(name)
        if room_id is None:
            return None
        if room_id not in self.rooms:
            room = self.store.load(room_id)
            if not room:
                return None
            self.rooms[room_id] = room
            self.empty_since[room_id] = asyncio.get_running_loop().time()
            log.info('Room "%s" loaded', room.name)
        return self.rooms[room_id]

    def update_online(self, room):
        online = {c.pid for c in self.members(room) if c.pid}
        for player in room.players.values():
            player.online = player.id in online

    # ------------------------------------------------------------ connections

    async def handle(self, socket):
        client = Client(socket)
        try:
            async for text in socket:
                try:
                    message = json.loads(text)
                    if not isinstance(message, dict):
                        raise ValueError
                except ValueError:
                    await client.send({'type': 'error', 'message': 'Unreadable message.'})
                    continue
                try:
                    await self.on_message(client, message)
                except GameError as error:
                    await client.send({'type': 'error', 'message': str(error), 'request': message.get('type'), 'code': error.code})
                except Exception:  # a bug must not take the whole server down
                    log.exception('Error handling %s', message.get('type'))
                    await client.send({'type': 'error', 'message': 'The server could not do that.'})
        except ConnectionClosed:
            pass
        finally:
            if client.room:
                self.leave(client)

    def leave(self, client):
        """The browser left the room (or lost the connection). Its rider stays in the room."""
        room = client.room
        members = self.clients.get(room.id, set())
        members.discard(client)
        if not members:
            self.empty_since[room.id] = asyncio.get_running_loop().time()
        self.update_online(room)

    async def on_message(self, client, message):
        kind = message.get('type')
        now = now_ms()
        if kind == 'ping':
            await client.send({'type': 'pong', 'at': message.get('at')})
            return
        if kind == 'hello':
            await self.hello(client, message, now)
            return
        if kind == 'leave':
            if client.room:
                self.leave(client)
                client.room = None
            await client.send({'type': 'left'})
            return

        room = client.room
        if not room or room.id not in self.rooms:
            raise GameError('Join a room first.')
        if kind == 'sync':
            have = parse_ranges(message.get('have')) if message.get('run') == room.run else set()
            await client.send({'type': 'events', 'run': room.run, 'ids': room.ids(),
                               'events': [e for e in room.events if e['id'] not in have]})
            return
        if kind == 'admin':
            if not client.admin:
                raise GameError('Only the host can do that.')
            await self.admin(client, room, message, now)
            return
        if not client.pid:
            raise GameError('Join as a rider to do that.')
        pid = client.pid
        if kind == 'stats':
            room.stats(pid, message, now)
        elif kind == 'profile':
            room.join(pid, message)
            await self.broadcast(room, {'type': 'state', **room.state(now)})
        elif kind == 'play':
            room.play(pid, message.get('slot'), message.get('target'), now, message.get('card'))
        elif kind == 'discard':
            room.discard(pid, message.get('slot'))
        elif kind == 'nope':
            room.nope(pid, message.get('of'), now)
        elif kind == 'fixed':
            room.fixed(pid, message.get('of'), now)
        elif kind == 'answer':
            room.answer(pid, message.get('of'), message.get('choice'), now)
            await client.send({'type': 'answered', 'of': message.get('of'), 'choice': message.get('choice')})
        else:
            raise GameError(f'Unknown request "{kind}".')
        await self.flush(room)

    # ------------------------------------------------------------ joining a room

    async def hello(self, client, message, now):
        room = self.open_room(message.get('room'), message.get('roomId'))
        if not room:
            await client.send({'type': 'error', 'request': 'hello', 'code': 'no-room',
                               'message': 'There is no room with that name.'})
            return
        if client.room:
            self.leave(client)
        client.room = room
        self.empty_since.pop(room.id, None)
        client.role = 'player' if message.get('role') == 'player' else 'screen'
        # Moderators watch (spectate): a rider is never one, whatever keys they send.
        owner = check_auth_key(message.get('authKey')) if client.role == 'screen' else None
        client.admin = client.role == 'screen' and (bool(owner and owner == room.owner)
                                                    or check_room_key(message.get('roomKey'), room.key_hash))
        client.pid = None
        if client.role == 'player':
            client.pid = str(message.get('id') or '')[:80]
            if not client.pid:
                raise GameError('Missing rider id.')
            room.join(client.pid, message)
        self.clients.setdefault(room.id, set()).add(client)
        self.update_online(room)

        have = parse_ranges(message.get('have')) if message.get('run') == room.run else set()
        room.hands_changed.discard(client.pid)
        await client.send({
            'type': 'welcome',
            'you': {'id': client.pid, 'role': client.role, 'admin': client.admin},
            'room': room.info(admin=client.admin, now=now),
            'cards': public_cards(),
            'events': [e for e in room.events if e['id'] not in have],
            'state': room.state(now),
            'hand': room.hand(client.pid) if client.pid else None,
            'serverTime': now,
        })
        await self.flush(room)

    async def admin(self, client, room, message, now):
        action = message.get('action')
        if action == 'start':
            room.start(now)
        elif action == 'pause':
            room.pause(now)
        elif action == 'resume':
            room.resume(now)
        elif action == 'end':
            room.end(now)
        elif action == 'restart':
            room.restart()
        elif action == 'settings':
            changes = dict(message.get('settings') or {})
            changes.pop('name', None)           # the name is the room's identity: the owner changes it
            room.update_settings(changes)
            self.store.save_settings(room)
        elif action == 'quiz':
            room.set_quiz(message.get('quiz'))
            self.store.save_plan(room)
        elif action == 'launch':
            room.launch(message.get('id'), now)
        elif action == 'deal':
            room.deal(message.get('count', 1), now)
        elif action in ('kick', 'kick-all', 'kick-offline'):
            if action == 'kick':
                gone = {message.get('player')}
            else:
                gone = {p.id for p in room.players.values() if action == 'kick-all' or not p.online}
            for pid in gone:
                room.remove_player(pid)
            for other in list(self.members(room)):
                if other.pid and other.pid in gone:
                    await other.send({'type': 'kicked'})
                    other.pid = None
            room.room_changed = True
        else:
            raise GameError(f'Unknown host action "{action}".')
        await self.flush(room)

    # ------------------------------------------------------------ the clock

    async def run_clock(self):
        last_state = last_save = last_check = 0.0
        loop = asyncio.get_running_loop()
        while True:
            await asyncio.sleep(TICK)
            now = now_ms()
            moment = loop.time()
            send_state = moment - last_state >= STATE_EVERY
            save = moment - last_save >= SAVE_EVERY
            if moment - last_check >= CHECK_EVERY:
                last_check = moment
                await self.check_rooms(moment)
            for room in list(self.rooms.values()):
                try:
                    room.tick(now)
                    await self.flush(room)
                    if send_state and self.members(room):
                        await self.broadcast(room, {'type': 'state', **room.state(now)})
                    if save and room.dirty and room.id in self.rooms:
                        await self.save(room)
                except Exception:
                    log.exception('Tick failed for room %s', room.id)
            if send_state:
                last_state = moment
            if save:
                last_save = moment

    async def check_rooms(self, moment):
        """Rooms changed or deleted through PHP, and rooms nobody has used for a while."""
        try:
            edited = self.store.edited(list(self.rooms))
            for room in list(self.rooms.values()):
                if room.id not in edited:
                    await self.drop(room, 'deleted')
                elif edited[room.id] != room.edited_at:
                    self.store.reload(room)
                    await self.flush(room)
                elif not self.members(room) and moment - self.empty_since.get(room.id, moment) > UNLOAD_AFTER:
                    await self.save(room)
                    if room.id in self.rooms:
                        await self.drop(room, 'unused')
        except Exception:
            log.exception('Checking the rooms failed')

    def save_all(self):
        for room in self.rooms.values():
            self.store.save(room)


async def main():
    parser = argparse.ArgumentParser(description='Party Spin WebSocket server')
    parser.add_argument('--host', default='0.0.0.0', help='address to listen on (127.0.0.1 behind nginx)')
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--db', help='the SQLite database (default: from config.php here, else the hub\'s)')
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
    logging.getLogger('websockets').setLevel(logging.WARNING)  # no line per connection

    path = args.db or partyspin_database_path()
    store = Store(path)
    # The hub's file name is secret: don't put it in the log.
    log.info('Database: %s', "the hub's (server/config.php)" if not args.db and path == hub_database_path() else path)
    server = Server(store)
    stop = asyncio.get_running_loop().create_future()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            asyncio.get_running_loop().add_signal_handler(sig, lambda: stop.done() or stop.set_result(None))
        except NotImplementedError:  # Windows: Ctrl+C raises KeyboardInterrupt instead
            pass

    async with serve(server.handle, args.host, args.port, max_size=256 * 1024):
        log.info('Party Spin server on ws://%s:%d', args.host, args.port)
        clock = asyncio.create_task(server.run_clock())
        try:
            await stop
        finally:
            clock.cancel()
            server.save_all()
            store.close()
            log.info('Saved and stopped')


if __name__ == '__main__':
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
