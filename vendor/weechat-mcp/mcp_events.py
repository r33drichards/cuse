# SPDX-License-Identifier: GPL-3.0-or-later
"""Explicit, owner-scoped MCP Events subscriptions and a durable webhook outbox.

Nothing subscribes on startup, buffer join, discovery or ordinary tool calls.
The callback supplied by the MCP host is the chat/session identity. Secrets stay
in the private runtime database, never in event definitions or method results.
"""

import asyncio
import fcntl
import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import stat
import time
import weakref
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

from jsonschema import ValidationError, validate

from event_webhooks import (
    SecureWebhookSender,
    WebhookError,
    signed_headers,
    validate_secret,
    validate_url,
)

EVENT_NAME = "message.created"
INPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "channel_id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 256,
            "description": "Exact exposed IRC buffer name from weechat_buffers, such as irc.server.#channel.",
        },
        "trigger": {
            "type": "string",
            "enum": ["message", "mention"],
            "description": "Every incoming chat message, or only whole-nick mentions.",
        },
        "nick": {
            "type": "string",
            "minLength": 1,
            "maxLength": 64,
            "pattern": r"^[^\s,\x00-\x1f\x7f]+$",
            "description": "Nick to match when trigger is mention; IRC case folding applies.",
        },
    },
    "required": ["channel_id", "trigger"],
    "additionalProperties": False,
    "oneOf": [
        {
            "properties": {"trigger": {"const": "message"}},
            "not": {"required": ["nick"]},
        },
        {"properties": {"trigger": {"const": "mention"}}, "required": ["nick"]},
    ],
}
PAYLOAD_SCHEMA = {
    "type": "object",
    "properties": {
        key: {"type": "string"} for key in ("channel_id", "message_id", "nick", "text")
    },
    "required": ["channel_id", "message_id", "nick", "text"],
    "additionalProperties": False,
}
DEFINITION = {
    "name": EVENT_NAME,
    "description": "New incoming IRC messages in one explicitly chosen exposed channel. Subscribe only when the user asks this chat to monitor that channel and chooses a trigger. Never subscribe on startup, join, discovery or tool use. Own messages and status lines are excluded. Stop with events/unsubscribe.",
    "delivery": ["webhook"],
    "inputSchema": INPUT_SCHEMA,
    "payloadSchema": PAYLOAD_SCHEMA,
}


class EventError(Exception):
    def __init__(self, code, message, reason=None):
        super().__init__(message)
        self.code, self.message, self.reason = code, message, reason


def canonical(value):
    return json.dumps(value, ensure_ascii=True, separators=(",", ":"), sort_keys=True)


def utc(seconds):
    return (
        datetime.fromtimestamp(seconds, timezone.utc).isoformat().replace("+00:00", "Z")
    )


def irc_fold(value):
    return value.lower().translate(str.maketrans("[]\\^", "{}|~"))


def matches(arguments, line, own_nick):
    nick = line.get("nick", "")
    if not line.get("is_message") or line.get("is_self") or not nick:
        return False
    if own_nick and irc_fold(nick) == irc_fold(own_nick):
        return False
    if arguments["trigger"] == "message":
        return True
    return bool(
        re.search(
            r"(?<![\w{}|~\-])@?"
            + re.escape(irc_fold(arguments["nick"]))
            + r"(?![\w{}|~\-])",
            irc_fold(line["message"]),
        )
    )


class EventManager:
    """Single-process dispatcher. SQLite transactions commit intake with outbox.

    Replay is bounded to retained outbox records plus native WeeChat snapshots.
    Never claim exactly-once delivery: a crash after HTTP acceptance can resend.
    Per-subscription delivery is ordered so emitted cursors cannot skip backlog.
    """

    def __init__(self, path, backend, owner_allowed, sender=None, clock=time.time):
        path = Path(path)
        if not path.is_absolute():
            raise ValueError("MCP_EVENTS_DB must be an absolute runtime path")
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        info = path.parent.stat(follow_symlinks=False)
        if (
            not stat.S_ISDIR(info.st_mode)
            or info.st_uid != os.getuid()
            or info.st_mode & 0o077
        ):
            raise ValueError("Events database needs a private owner-only directory")
        self.file = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            info = os.fstat(self.file)
            if (
                not stat.S_ISREG(info.st_mode)
                or info.st_uid != os.getuid()
                or info.st_mode & 0o077
            ):
                raise ValueError("Events database needs owner-only permissions")
            fcntl.flock(self.file, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.db = sqlite3.connect(path)
        except BaseException:
            os.close(self.file)
            raise
        self.db.row_factory = sqlite3.Row
        self.db.executescript("""
          PRAGMA foreign_keys=ON;
          PRAGMA secure_delete=ON;
          CREATE TABLE IF NOT EXISTS subscriptions (
            id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL,
            arguments TEXT NOT NULL, url TEXT NOT NULL, secret TEXT NOT NULL,
            old_secret TEXT, rotate_until REAL NOT NULL DEFAULT 0,
            expires REAL NOT NULL, epoch TEXT NOT NULL, intake INTEGER NOT NULL,
            acknowledged INTEGER NOT NULL DEFAULT 0, truncated INTEGER NOT NULL DEFAULT 0,
            suspended INTEGER NOT NULL DEFAULT 0, pruned_through INTEGER NOT NULL DEFAULT 0, seen_native_line INTEGER NOT NULL DEFAULT 0);
          CREATE TABLE IF NOT EXISTS outbox (
            position INTEGER PRIMARY KEY AUTOINCREMENT,
            subscription TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
            event_key TEXT NOT NULL, payload TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
            due REAL NOT NULL DEFAULT 0, created REAL NOT NULL,
            UNIQUE(subscription, event_key));
          CREATE INDEX IF NOT EXISTS outbox_pending ON outbox(subscription,status,position);
        """)
        self.backend, self.owner_allowed = backend, owner_allowed
        self.sender, self.clock = sender or SecureWebhookSender(), clock
        self.locks = weakref.WeakValueDictionary()
        self.intake_wake = asyncio.Event()
        self.intake_task = None
        self.send_slots = asyncio.Semaphore(8)
        self.wake = asyncio.Event()
        self.dirty = set()
        self.verified = {}
        self.task = None
        self.closed = False
        self.stopping = False

    def _lock(self, ident):
        lock = self.locks.get(ident)
        if lock is None:
            lock = asyncio.Lock()
            self.locks[ident] = lock
        return lock

    def _owner(self, owner):
        if not isinstance(owner, str) or not owner or not self.owner_allowed(owner):
            raise EventError(-32001, "Event owner is not authorized")

    def _identity(self, owner, params):
        self._owner(owner)
        if params.get("name") != EVENT_NAME:
            raise EventError(-32602, "Unknown event name")
        arguments = params.get("arguments")
        try:
            validate(arguments, INPUT_SCHEMA)
        except ValidationError:
            raise EventError(-32602, "Invalid channel or trigger arguments") from None
        delivery = params.get("delivery", {})
        if delivery.get("mode") != "webhook":
            raise EventError(-32602, "Only webhook delivery is supported")
        try:
            url = validate_url(delivery.get("url"))
        except WebhookError as error:
            raise EventError(
                -32015, "Callback endpoint rejected", error.reason
            ) from None
        ident = (
            "sub_"
            + hashlib.sha256(
                canonical([owner, url, EVENT_NAME, arguments]).encode()
            ).hexdigest()
        )
        return ident, arguments, url

    async def _history(self, channel):
        try:
            return await self.backend.request(
                "event_history", uri="weechat://buffer/" + quote(channel, safe="")
            )
        except ValueError:
            raise EventError(-32001, "Channel is not an exposed IRC channel") from None

    async def list_events(self, owner, cursor=None):
        self._owner(owner)
        if cursor is not None:
            raise EventError(-32602, "Invalid event catalog cursor")
        return {"events": [DEFINITION]}

    def _cursor(self, ident, position):
        return ident + ":" + str(position)

    def _parse_cursor(self, ident, cursor):
        if cursor is None:
            return None
        if not isinstance(cursor, str) or not re.fullmatch(
            re.escape(ident) + r":(?:0|[1-9][0-9]{0,18})", cursor
        ):
            raise EventError(-32602, "Invalid subscription cursor")
        return int(cursor.rsplit(":", 1)[1])

    async def _verify(self, owner, ident, url, secret):
        now = self.clock()
        key = (owner, url)
        if self.verified.get(key, 0) > now:
            return
        challenge = secrets.token_urlsafe(32)
        body = canonical({"type": "verification", "challenge": challenge}).encode()
        headers = signed_headers(
            "verify_" + secrets.token_hex(16), body, secret, ident, int(now)
        )
        try:
            status, response = await self.sender.post(url, body, headers)
            value = json.loads(response)
            echoed = value.get("challenge") if isinstance(value, dict) else None
            if (
                not 200 <= status < 300
                or not isinstance(echoed, str)
                or not hmac.compare_digest(echoed, challenge)
            ):
                raise WebhookError("challenge_failed")
        except (ValueError, UnicodeError, TypeError):
            raise EventError(
                -32015, "Callback verification failed", "challenge_failed"
            ) from None
        except WebhookError as error:
            raise EventError(
                -32015, "Callback verification failed", error.reason
            ) from None
        if self.clock() - now > 30:
            raise EventError(-32015, "Callback verification failed", "timeout")
        # Cache is memory-only and bounded by time AND size, keyed to principal.
        self.verified = {
            key: expiry for key, expiry in self.verified.items() if expiry > now
        }
        if len(self.verified) >= 1000:
            self.verified.pop(next(iter(self.verified)))
        self.verified[key] = now + 300

    async def subscribe(self, owner, params):
        ident, arguments, url = self._identity(owner, params)
        secret = params["delivery"].get("secret")
        try:
            validate_secret(secret)
        except WebhookError:
            raise EventError(-32602, "Invalid webhook signing secret") from None
        cursor = self._parse_cursor(ident, params.get("cursor"))
        ttl = params.get("ttlMs", 3600000)
        if ttl is not None and (type(ttl) is not int or ttl <= 0):
            raise EventError(-32602, "ttlMs must be a positive integer or null")
        # Finite lifetime even when the host requests no expiration.
        lifetime = min(ttl / 1000 if ttl is not None else 3600, 86400)
        async with self._lock(ident):
            snapshot = await self._history(arguments["channel_id"])
            old = self.db.execute(
                "SELECT * FROM subscriptions WHERE id=?", (ident,)
            ).fetchone()
            if (
                old is None
                and self.db.execute("SELECT COUNT(*) FROM subscriptions").fetchone()[0]
                >= 100
            ):
                raise EventError(-32000, "Event subscription limit reached")
            if old and old["suspended"]:
                raise EventError(
                    -32000,
                    "Delivery stopped; unsubscribe and explicitly subscribe again",
                )
            if old and cursor is not None and cursor > old["acknowledged"]:
                raise EventError(-32602, "Cursor is ahead of acknowledged delivery")
            await self._verify(owner, ident, url, secret)
            self._owner(owner)
            latest = await self._history(
                arguments["channel_id"]
            )  # Recheck scope after verification.
            expires = self.clock() + lifetime
            # Intake/retention can change the row while callback verification awaits.
            old = self.db.execute(
                "SELECT * FROM subscriptions WHERE id=?", (ident,)
            ).fetchone()
            if old and old["suspended"]:
                raise EventError(
                    -32000,
                    "Delivery stopped; unsubscribe and explicitly subscribe again",
                )
            if old and cursor is not None and cursor > old["acknowledged"]:
                raise EventError(-32602, "Cursor is ahead of acknowledged delivery")
            with self.db:
                if old:
                    self.db.execute(
                        """UPDATE subscriptions SET secret=?,old_secret=?,rotate_until=?,expires=?,suspended=0 WHERE id=?""",
                        (
                            secret,
                            old["secret"]
                            if old["secret"] != secret
                            else old["old_secret"],
                            self.clock() + 300
                            if old["secret"] != secret
                            else old["rotate_until"],
                            expires,
                            ident,
                        ),
                    )
                    if cursor is not None and cursor < old["acknowledged"]:
                        self.db.execute(
                            "UPDATE subscriptions SET acknowledged=?,truncated=MAX(truncated,?) WHERE id=?",
                            (
                                cursor,
                                int(cursor < old["pruned_through"]),
                                ident,
                            ),
                        )
                        self.db.execute(
                            "UPDATE outbox SET status='pending',attempts=0,due=0 WHERE subscription=? AND position>?",
                            (ident, cursor),
                        )
                    self._ingest(ident, latest)
                else:
                    # The callback awaits outside a global lock; enforce quota again
                    # inside the atomic insertion to cover concurrent identities.
                    if (
                        self.db.execute(
                            "SELECT COUNT(*) FROM subscriptions"
                        ).fetchone()[0]
                        >= 100
                    ):
                        raise EventError(-32000, "Event subscription limit reached")
                    high = max(
                        (line["sequence"] for line in snapshot["lines"]), default=0
                    )
                    last_assigned = snapshot.get("last_assigned_id")
                    if isinstance(last_assigned, int):
                        high = max(high, last_assigned + 1)
                    self.db.execute(
                        """INSERT INTO subscriptions(id,owner,name,arguments,url,secret,expires,epoch,intake,truncated,seen_native_line) VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
                        (
                            ident,
                            owner,
                            EVENT_NAME,
                            canonical(arguments),
                            url,
                            secret,
                            expires,
                            snapshot["epoch"],
                            high,
                            int(cursor is not None),
                            int(bool(snapshot["lines"])),
                        ),
                    )
            row = self.db.execute(
                "SELECT * FROM subscriptions WHERE id=?", (ident,)
            ).fetchone()
            self.notify(arguments["channel_id"])
            return {
                "id": ident,
                "refreshBefore": utc(expires),
                "cursor": self._cursor(ident, row["acknowledged"]),
                "truncated": bool(row["truncated"]),
            }

    async def unsubscribe(self, owner, params):
        ident, _, _ = self._identity(owner, params)
        async with self._lock(ident):
            with self.db:
                self.db.execute(
                    "DELETE FROM subscriptions WHERE id=? AND owner=?", (ident, owner)
                )
        self.wake.set()
        return {}

    def _ingest(self, ident, snapshot):
        row = self.db.execute(
            "SELECT * FROM subscriptions WHERE id=?", (ident,)
        ).fetchone()
        if not row:
            return
        same_epoch = row["epoch"] == snapshot["epoch"]
        high = row["intake"]
        if not same_epoch:
            # A new/unknown native buffer lifetime cannot prove which retained
            # lines arrived after this grant. Preserve queued events, flag the
            # interruption, and resume from the current tip rather than replay
            # pre-opt-in history with new event identities.
            high = max((line["sequence"] for line in snapshot["lines"]), default=0)
            last_assigned = snapshot.get("last_assigned_id")
            if isinstance(last_assigned, int):
                high = max(high, last_assigned + 1)
        retained_from = snapshot.get("native_retained_from")
        truncated = (
            not same_epoch
            or snapshot.get("evicted_through", 0) > high
            # Native IDs may be sparse timestamps. Do not infer loss on the
            # first arrival after an empty opt-in; later loss is conservative
            # when the saved position no longer reaches native retention.
            or (
                row["seen_native_line"]
                and high > 0
                and retained_from is not None
                and retained_from > high
            )
        )
        args = json.loads(row["arguments"])
        retained = self.db.execute(
            "SELECT COUNT(*) FROM outbox WHERE subscription=? AND status!='sent'",
            (ident,),
        ).fetchone()[0]
        for line in snapshot["lines"]:
            seq = line["sequence"]
            if seq <= high:
                continue
            if not matches(args, line, snapshot.get("own_nick", "")):
                high = seq
                continue
            if retained >= 10000:
                truncated = True
                self.db.execute(
                    "UPDATE subscriptions SET suspended=1 WHERE id=?", (ident,)
                )
                break
            high = seq
            event_key = hashlib.sha256(
                canonical([args["channel_id"], snapshot["epoch"], seq]).encode()
            ).hexdigest()
            try:
                timestamp = utc(float(line["date"]))
            except (ValueError, TypeError, OverflowError):
                timestamp = utc(self.clock())
            event = {
                "eventId": "evt_" + event_key,
                "name": EVENT_NAME,
                "timestamp": timestamp,
                "data": {
                    "channel_id": args["channel_id"],
                    "message_id": snapshot["epoch"] + ":" + str(seq),
                    "nick": line["nick"],
                    "text": line["message"],
                },
            }
            added = self.db.execute(
                "INSERT OR IGNORE INTO outbox(subscription,event_key,payload,created) VALUES(?,?,?,?)",
                (ident, event_key, canonical(event), self.clock()),
            )
            if added.rowcount:
                retained += 1
                event["cursor"] = self._cursor(ident, added.lastrowid)
                payload = canonical(event)
                if len(payload.encode()) > 262144:
                    # Never truncate signed data silently or advance beyond it.
                    self.db.execute(
                        "UPDATE outbox SET status='failed' WHERE position=?",
                        (added.lastrowid,),
                    )
                    self.db.execute(
                        "UPDATE subscriptions SET suspended=1 WHERE id=?", (ident,)
                    )
                self.db.execute(
                    "UPDATE outbox SET payload=? WHERE position=?",
                    (payload, added.lastrowid),
                )
        self.db.execute(
            "UPDATE subscriptions SET epoch=?,intake=?,truncated=MAX(truncated,?),seen_native_line=? WHERE id=?",
            (
                snapshot["epoch"],
                high,
                int(truncated),
                int(
                    bool(snapshot["lines"]) or (same_epoch and row["seen_native_line"])
                ),
                ident,
            ),
        )

    def notify(self, channel=None):
        # Called synchronously from the IPC reader; never await another IPC request there.
        self.dirty.add(channel)
        self.wake.set()
        self.intake_wake.set()

    async def collect(self, channel=None):
        rows = self.db.execute(
            "SELECT * FROM subscriptions WHERE expires>?", (self.clock(),)
        ).fetchall()
        snapshots = {}
        for row in rows:
            if self.stopping:
                return
            args = json.loads(row["arguments"])
            buffer = args["channel_id"]
            if channel is not None and buffer != channel:
                continue
            if not self.owner_allowed(row["owner"]):
                with self.db:
                    self.db.execute(
                        "DELETE FROM subscriptions WHERE id=?", (row["id"],)
                    )
                continue
            try:
                if buffer not in snapshots:
                    snapshots[buffer] = await self._history(buffer)
            except ConnectionError:
                self.dirty.add(buffer)
                continue
            except EventError:
                with self.db:
                    self.db.execute(
                        "DELETE FROM subscriptions WHERE id=?", (row["id"],)
                    )
                continue
            if self.stopping:
                return
            with self.db:
                self._ingest(row["id"], snapshots[buffer])

    async def deliver_once(self):
        now = self.clock()
        with self.db:
            self.db.execute(
                "UPDATE subscriptions SET old_secret=NULL WHERE rotate_until<=?", (now,)
            )
            self.db.execute(
                """UPDATE subscriptions SET pruned_through=MAX(pruned_through,
                COALESCE((SELECT MAX(position) FROM outbox WHERE subscription=subscriptions.id
                AND status='sent' AND created<?),0))""",
                (now - 86400,),
            )
            self.db.execute(
                "DELETE FROM outbox WHERE status='sent' AND created<?", (now - 86400,)
            )
            self.db.execute("DELETE FROM subscriptions WHERE expires<?", (now - 86400,))
            for item in self.db.execute("SELECT id FROM subscriptions").fetchall():
                cutoff = self.db.execute(
                    "SELECT position FROM outbox WHERE subscription=? AND status='sent' ORDER BY position DESC LIMIT 1 OFFSET 9999",
                    (item["id"],),
                ).fetchone()
                if cutoff:
                    removed = self.db.execute(
                        "SELECT MAX(position) FROM outbox WHERE subscription=? AND status='sent' AND position<?",
                        (item["id"], cutoff[0]),
                    ).fetchone()[0]
                    if removed:
                        self.db.execute(
                            "UPDATE subscriptions SET pruned_through=MAX(pruned_through,?) WHERE id=?",
                            (removed, item["id"]),
                        )
                        self.db.execute(
                            "DELETE FROM outbox WHERE subscription=? AND status='sent' AND position<=?",
                            (item["id"], removed),
                        )
        rows = self.db.execute(
            "SELECT id FROM subscriptions WHERE expires>? AND suspended=0", (now,)
        ).fetchall()
        await asyncio.gather(*(self._deliver(row["id"]) for row in rows))

    async def _deliver(self, ident):
        async with self.send_slots, self._lock(ident):
            sub = self.db.execute(
                "SELECT * FROM subscriptions WHERE id=? AND expires>? AND suspended=0",
                (ident, self.clock()),
            ).fetchone()
            if sub is None:
                return
            if not self.owner_allowed(sub["owner"]):
                with self.db:
                    self.db.execute(
                        "DELETE FROM subscriptions WHERE id=?", (sub["id"],)
                    )
                return
            pending = self.db.execute(
                "SELECT * FROM outbox WHERE subscription=? AND status!='sent' ORDER BY position LIMIT 1",
                (sub["id"],),
            ).fetchone()
            if (
                not pending
                or pending["status"] == "failed"
                or pending["due"] > self.clock()
            ):
                return
            try:
                # Recheck live scope immediately before every network send.
                await self._history(json.loads(sub["arguments"])["channel_id"])
            except (ConnectionError, asyncio.TimeoutError):
                with self.db:
                    self.db.execute(
                        "UPDATE outbox SET due=? WHERE position=?",
                        (self.clock() + 1, pending["position"]),
                    )
                return
            except EventError:
                with self.db:
                    self.db.execute(
                        "DELETE FROM subscriptions WHERE id=?", (sub["id"],)
                    )
                return
            if self.stopping or sub["expires"] <= self.clock():
                return
            keys = [sub["secret"]]
            if sub["old_secret"] and sub["rotate_until"] > self.clock():
                keys.append(sub["old_secret"])
            body = pending["payload"].encode()
            event = json.loads(body)
            headers = signed_headers(
                event["eventId"], body, keys, sub["id"], int(self.clock())
            )
            if pending["attempts"] >= 8:
                with self.db:
                    self.db.execute(
                        "UPDATE outbox SET status='failed' WHERE position=?",
                        (pending["position"],),
                    )
                    self.db.execute(
                        "UPDATE subscriptions SET suspended=1 WHERE id=?", (ident,)
                    )
                return
            attempts = pending["attempts"] + 1
            # Count before I/O, including crashes with uncertain receipt.
            with self.db:
                self.db.execute(
                    "UPDATE outbox SET attempts=? WHERE position=?",
                    (attempts, pending["position"]),
                )
            reason = None
            try:
                status, _ = await self.sender.post(sub["url"], body, headers)
            except WebhookError as error:
                status, reason = 0, error.reason
            with self.db:
                if 200 <= status < 300:
                    self.db.execute(
                        "UPDATE outbox SET status='sent' WHERE position=?",
                        (pending["position"],),
                    )
                    self.db.execute(
                        "UPDATE subscriptions SET acknowledged=? WHERE id=?",
                        (pending["position"], sub["id"]),
                    )
                elif (
                    status in (408, 429)
                    or status >= 500
                    or (
                        status == 0
                        and reason in ("timeout", "dns_error", "connection_failed")
                    )
                ) and attempts < 8:
                    self.db.execute(
                        "UPDATE outbox SET due=? WHERE position=?",
                        (self.clock() + min(300, 2**attempts), pending["position"]),
                    )
                else:
                    self.db.execute(
                        "UPDATE outbox SET status='failed' WHERE position=?",
                        (pending["position"],),
                    )
                    self.db.execute(
                        "UPDATE subscriptions SET suspended=1 WHERE id=?",
                        (sub["id"],),
                    )

    async def ingest_loop(self):
        while not self.stopping:
            await self.intake_wake.wait()
            self.intake_wake.clear()
            dirty, self.dirty = self.dirty, set()
            try:
                if None in dirty:
                    await self.collect()
                else:
                    for channel in dirty:
                        await self.collect(channel)
            except (ConnectionError, asyncio.TimeoutError):
                self.dirty.add(None)
            if self.stopping:
                return
            self.wake.set()
            if self.dirty:
                # Retry temporarily unavailable local channels without dropping grants.
                await asyncio.sleep(1)
                self.intake_wake.set()

    async def run(self):
        while not self.stopping:
            self.wake.clear()
            await self.deliver_once()
            if self.stopping:
                return
            ready = self.db.execute(
                """SELECT 1 FROM subscriptions s JOIN outbox o ON o.subscription=s.id
                WHERE s.expires>? AND s.suspended=0 AND o.status='pending' AND o.due<=?
                AND o.position=(SELECT MIN(position) FROM outbox WHERE subscription=s.id AND status!='sent')
                LIMIT 1""",
                (self.clock(), self.clock()),
            ).fetchone()
            if ready:
                # Drain bursts promptly, yielding to intake and unsubscribe handlers.
                await asyncio.sleep(0)
                continue
            # Python 3.10 wait_for can swallow external cancellation when its
            # inner wait completes concurrently. Await the event directly so
            # shutdown cannot lose cancellation to an intake wakeup.
            timer = asyncio.get_running_loop().call_later(1, self.wake.set)
            try:
                await self.wake.wait()
            finally:
                timer.cancel()

    def start(self):
        if self.task is None:
            self.task = asyncio.create_task(self.run())
            self.intake_task = asyncio.create_task(self.ingest_loop())
            self.notify()

    async def close(self):
        if self.closed:
            return
        # Also bound shutdown if an IPC wait swallowed cancellation on 3.10.
        self.stopping = True
        tasks = [task for task in (self.task, self.intake_task) if task is not None]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        self.db.close()
        os.close(self.file)
        self.closed = True
