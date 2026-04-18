import hashlib
import math
import random
import secrets
import threading
import time


class AviatorEngine:
    def __init__(self, app, socketio, helpers):
        self.app = app
        self.socketio = socketio
        self.helpers = helpers
        self.lock = threading.RLock()
        self.room_name = "aviator:lobby"
        self.phase = "starting"
        self.countdown = 10
        self.current_multiplier = 1.0
        self.crash_point = 1.0
        self.server_seed = ""
        self.seed_hash = ""
        self.nonce = 1
        self.round_id = 0
        self.status_text = "Preparing runway"
        self.history = []
        self.bets = {}
        self.fake_players = []
        self._thread = None
        self._started = False

    def start(self):
        with self.lock:
            if self._thread and self._thread.is_alive():
                self._started = True
                return
            self._thread = threading.Thread(
                target=self._game_loop,
                name="aviator-engine",
                daemon=True,
            )
            self._thread.start()
            self._started = True

    def _generate_crash_point(self):
        self.server_seed = secrets.token_hex(16)
        digest = hashlib.sha256(f"{self.server_seed}:{self.nonce}".encode("utf-8")).hexdigest()
        normalized = int(digest[:13], 16) / float(0x1FFFFFFFFFFFF)
        normalized = max(0.000001, min(0.999999, normalized))
        crash_point = 1.0 + (-math.log(1 - normalized) * 2.65)
        crash_point = max(1.0, min(20.0, round(crash_point, 2)))
        self.seed_hash = digest
        self.crash_point = crash_point
        self.nonce += 1

    def _build_fake_players(self):
        names = [
            "SkyWolf",
            "FlashRun",
            "Nova77",
            "JetMint",
            "OrbitX",
            "StormAce",
            "PixelRay",
            "DashFox",
        ]
        random.shuffle(names)
        players = []
        for name in names[: random.randint(4, 7)]:
            amount = random.choice([20, 25, 40, 50, 75, 100, 150])
            auto_cashout = round(random.uniform(1.15, min(self.crash_point + 1.5, 8.5)), 2)
            players.append(
                {
                    "username": name,
                    "amount": amount,
                    "auto_cashout": auto_cashout,
                    "cashout_multiplier": None,
                    "payout": 0,
                    "status": "pending",
                    "is_fake": True,
                }
            )
        self.fake_players = players

    def _all_players(self):
        players = []
        for username, bet in self.bets.items():
            players.append(
                {
                    "username": username,
                    "amount": bet["amount"],
                    "auto_cashout": bet.get("auto_cashout"),
                    "cashout_multiplier": bet.get("cashout_multiplier"),
                    "payout": bet.get("payout", 0),
                    "status": bet["status"],
                    "is_fake": False,
                }
            )
        players.extend(self.fake_players)
        players.sort(key=lambda item: (item["status"] != "pending", item["username"].lower()))
        return players[:10]

    def _player_count(self):
        return len(self._all_players())

    def get_public_state(self):
        return {
            "phase": self.phase,
            "countdown": self.countdown,
            "multiplier": round(self.current_multiplier, 2),
            "crash_point": round(self.crash_point, 2) if self.phase == "crashed" else None,
            "round_id": self.round_id,
            "status_text": self.status_text,
            "seed_hash": self.seed_hash,
            "history": list(self.history[:12]),
            "player_count": self._player_count(),
            "players": self._all_players(),
        }

    def get_page_state(self, username):
        state = self.get_public_state()
        balance = self.helpers["get_balance"](username)
        bet = self.bets.get(username)
        state["balance"] = balance
        state["my_bet"] = {
            "amount": bet["amount"],
            "auto_cashout": bet.get("auto_cashout"),
            "cashout_multiplier": bet.get("cashout_multiplier"),
            "payout": bet.get("payout", 0),
            "status": bet["status"],
        } if bet else None
        return state

    def _emit_room(self, event, payload):
        self.socketio.emit(event, payload, room=self.room_name)

    def _emit_user_state(self, username):
        self.socketio.emit(
            "aviator_state",
            self.get_page_state(username),
            room=f"user:{username}",
        )

    def _broadcast_state(self):
        self._emit_room("aviator_state", self.get_public_state())

    def _broadcast_players(self):
        self._emit_room(
            "aviator_players",
            {
                "players": self._all_players(),
                "player_count": self._player_count(),
            },
        )

    def place_bet(self, username, amount, auto_cashout=None):
        with self.lock:
            if self.phase != "starting":
                return False, "Betting is only open during countdown."
            if username in self.bets:
                return False, "You already placed a bet this round."
            if amount <= 0:
                return False, "Bet amount must be greater than zero."
            if len(self._all_players()) >= 10:
                return False, "This Aviator table is full right now."
            ok, message = self.helpers["adjust_balance"](username, -amount, reason="aviator:bet")
            if not ok:
                return False, message
            if auto_cashout is not None:
                auto_cashout = max(1.1, min(20.0, round(float(auto_cashout), 2)))
            self.bets[username] = {
                "amount": amount,
                "auto_cashout": auto_cashout,
                "cashout_multiplier": None,
                "payout": 0,
                "status": "pending",
            }
            self.status_text = "Bet locked in. Ready for takeoff."
            self._broadcast_players()
            self._emit_user_state(username)
            return True, "Aviator bet placed."

    def cash_out(self, username):
        with self.lock:
            bet = self.bets.get(username)
            if self.phase != "running":
                return False, "Cash out is only available while the plane is flying."
            if not bet or bet["status"] != "pending":
                return False, "No active Aviator bet found."
            return self._cash_out_player(username, round(self.current_multiplier, 2), manual=True)

    def _cash_out_player(self, username, multiplier, *, manual=False):
        bet = self.bets.get(username)
        if not bet or bet["status"] != "pending":
            return False, "Bet already settled."
        payout = int(round(bet["amount"] * multiplier))
        bet["status"] = "cashed_out"
        bet["cashout_multiplier"] = multiplier
        bet["payout"] = payout
        self.helpers["adjust_balance"](username, payout, reason="aviator:cashout")
        self.socketio.emit(
            "aviator_result",
            {
                "status": "win",
                "multiplier": multiplier,
                "payout": payout,
                "message": f"Cashed out at {multiplier:.2f}x",
            },
            room=f"user:{username}",
        )
        self._emit_user_state(username)
        self._broadcast_players()
        return True, "Cashed out."

    def _settle_fake_players(self):
        for player in self.fake_players:
            if player["status"] == "pending" and player["auto_cashout"] <= self.current_multiplier:
                player["status"] = "cashed_out"
                player["cashout_multiplier"] = player["auto_cashout"]
                player["payout"] = int(round(player["amount"] * player["auto_cashout"]))

    def _settle_auto_cashouts(self):
        for username, bet in list(self.bets.items()):
            if bet["status"] == "pending" and bet.get("auto_cashout") and bet["auto_cashout"] <= self.current_multiplier:
                self._cash_out_player(username, bet["auto_cashout"], manual=False)

    def _crash_round(self):
        for username, bet in self.bets.items():
            if bet["status"] == "pending":
                bet["status"] = "lost"
                self.socketio.emit(
                    "aviator_result",
                    {
                        "status": "loss",
                        "multiplier": self.crash_point,
                        "payout": 0,
                        "message": f"Crashed at {self.crash_point:.2f}x",
                    },
                    room=f"user:{username}",
                )
                self._emit_user_state(username)
        for player in self.fake_players:
            if player["status"] == "pending":
                player["status"] = "lost"
        self.history.insert(
            0,
            {
                "multiplier": self.crash_point,
                "color": "high" if self.crash_point >= 5 else ("mid" if self.crash_point >= 2 else "low"),
            },
        )
        self.history = self.history[:12]
        self._broadcast_players()

    def _game_loop(self):
        while True:
            try:
                with self.app.app_context():
                    with self.lock:
                        self.round_id += 1
                        self.phase = "starting"
                        self.countdown = 10
                        self.current_multiplier = 1.0
                        self.status_text = "Runway open. Place your bets."
                        self.bets = {}
                        self._generate_crash_point()
                        self._build_fake_players()
                        self._broadcast_state()
                        self._broadcast_players()

                    for remaining in range(10, 0, -1):
                        with self.lock:
                            self.phase = "starting"
                            self.countdown = remaining
                            self.status_text = f"Takeoff in {remaining}s"
                            self._emit_room(
                                "aviator_countdown",
                                {
                                    "countdown": remaining,
                                    "round_id": self.round_id,
                                    "seed_hash": self.seed_hash,
                                },
                            )
                        time.sleep(1)

                    with self.lock:
                        self.phase = "running"
                        self.status_text = "Flight live. Cash out before the crash."
                        started_at = time.time()
                        self._emit_room(
                            "aviator_round_start",
                            {
                                "round_id": self.round_id,
                                "seed_hash": self.seed_hash,
                            },
                        )

                    while True:
                        with self.lock:
                            elapsed = time.time() - started_at
                            self.current_multiplier = round(max(1.0, math.exp(elapsed / 7.5)), 2)
                            self._settle_fake_players()
                            self._settle_auto_cashouts()
                            if self.current_multiplier >= self.crash_point:
                                self.current_multiplier = self.crash_point
                                break
                            self._emit_room(
                                "aviator_multiplier",
                                {
                                    "multiplier": self.current_multiplier,
                                    "round_id": self.round_id,
                                },
                            )
                        time.sleep(0.05)

                    with self.lock:
                        self.phase = "crashed"
                        self.status_text = f"Crashed at {self.crash_point:.2f}x"
                        self._crash_round()
                        self._emit_room(
                            "aviator_crash",
                            {
                                "crash_point": self.crash_point,
                                "round_id": self.round_id,
                                "server_seed": self.server_seed,
                                "seed_hash": self.seed_hash,
                            },
                        )
                        self._broadcast_state()
                time.sleep(2.5)
            except Exception as exc:
                self.app.logger.exception("Aviator loop failed: %s", exc)
                time.sleep(1)
