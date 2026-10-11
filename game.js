/* Dancy Fingers, browser edition.
 *
 * A port of the Godot scenes (scripts/gameplay.gd, highway.gd, judge.gd,
 * backdrop.gd, arrow_rain.gd, title.gd, song_select.gd, results.gd,
 * high_scores.gd and settings_screen.gd) to a 360x640 canvas, one third of
 * the app's 1080x1920 layout. Same timing windows, scoring, health, grades,
 * note speed and drawing. Ads do not exist here, so a survival fail goes
 * straight to the results instead of offering a rewarded continue.
 *
 * Exposes window.DancyFingers = { WIDTH, HEIGHT, Judge, create, mount } in
 * the browser and module.exports in Node (web/test/soak.js runs it headless).
 *
 * The game never touches the Web Audio API itself. It talks to an "audio"
 * adapter (see audio.js) with a small interface; the default adapter is
 * silent so the game runs anywhere.
 */
(function (root, factory) {
	if (typeof module === "object" && module.exports) module.exports = factory();
	else root.DancyFingers = factory();
})(typeof self !== "undefined" ? self : this, function () {
	"use strict";

	const WIDTH = 360, HEIGHT = 640;
	const S = 1 / 3;   // app canvas units -> our units

	// ------------------------------------------------------------ colours --
	const LANE_COLORS = ["#ff4fa3", "#4fd8ff", "#7dff4f", "#ffb84f"];
	const LANE_RGB = [[255, 79, 163], [79, 216, 255], [125, 255, 79], [255, 184, 79]];
	const LANE_ROT = [-Math.PI / 2, Math.PI, 0, Math.PI / 2];   // left, down, up, right
	const ARROW = [[0, -1], [1, 0], [0.45, 0], [0.45, 1], [-0.45, 1], [-0.45, 0], [-1, 0]];
	const ACCENT = "#8c61ff", DIM = "rgb(184,179,217)", DIMMER = "rgb(153,148,191)";
	const GOLD = "#ffe066", RED = "#ff4f4f", VIOLET = "#b58cff";
	const BG = "rgb(13,10,26)";
	const DIFF_COLORS = { easy: "#7dff4f", normal: "#ffb84f", hard: "#ff4fa3" };
	const DIFF_NAMES = { easy: "EASY", normal: "NORMAL", hard: "HARD" };
	const DIFFICULTIES = ["easy", "normal", "hard"];
	const FONT = "'Open Sans', 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

	const rgba = (c, a) => "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + a + ")";
	const dark = (c, k) => [Math.round(c[0] * (1 - k)), Math.round(c[1] * (1 - k)), Math.round(c[2] * (1 - k))];
	const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
	const lerp = (a, b, t) => a + (b - a) * t;
	const fmod = (a, b) => ((a % b) + b) % b;

	// ------------------------------------------------------------- judge ---
	// scripts/judge.gd, verbatim
	const Judge = {
		PERFECT: 0.045, GREAT: 0.090, GOOD: 0.150, MISS_LATE: 0.180, HOLD_RELEASE_GRACE: 0.20,
		WEIGHTS: { perfect: 1.0, great: 0.75, good: 0.4, miss: 0.0 },
		HEALTH: { perfect: 1.5, great: 1.0, good: 0.5, miss: -8.0, hold_ok: 1.0, hold_break: -6.0 },
		MAX_SCORE: 1000000, START_HEALTH: 50.0,
		classify(delta) {
			const d = Math.abs(delta);
			if (d <= Judge.PERFECT) return "perfect";
			if (d <= Judge.GREAT) return "great";
			if (d <= Judge.GOOD) return "good";
			return "";
		},
		gradeFor(acc, failed) {
			if (failed) return "F";
			if (acc >= 0.99) return "SSS";
			if (acc >= 0.97) return "SS";
			if (acc >= 0.94) return "S";
			if (acc >= 0.88) return "A";
			if (acc >= 0.80) return "B";
			if (acc >= 0.70) return "C";
			return "D";
		},
		gradeColor(g) {
			switch (g) {
				case "SSS": case "SS": return "#ffe066";
				case "S": return "#ffb84f";
				case "A": return "#7dff4f";
				case "B": return "#4fd8ff";
				case "C": return "#b58cff";
				case "F": return "#ff4f4f";
			}
			return "rgb(204,204,230)";
		},
		scoreFor(weightSum, totalUnits) {
			if (totalUnits <= 0) return 0;
			return Math.round(Judge.MAX_SCORE * weightSum / totalUnits);
		},
	};

	function formatScore(n) {
		const s = String(Math.max(0, Math.floor(n)));
		let out = "";
		for (let i = s.length - 1, c = 0; i >= 0; i--) {
			out = s[i] + out;
			if (++c % 3 === 0 && i > 0) out = "," + out;
		}
		return out;
	}
	function formatTime(sec) {
		const t = Math.round(sec);
		return Math.floor(t / 60) + ":" + String(t % 60).padStart(2, "0");
	}
	const modeName = (survival) => (survival ? "survival" : "normal");
	const modeLabel = (survival) => (survival ? "SURVIVAL" : "NORMAL MODE");

	// ------------------------------------------------------------- rng ------
	function Rng(seed) {
		let s = seed >>> 0 || 1;
		return function () {
			s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
			return s / 4294967296;
		};
	}

	// ----------------------------------------------------------- adapters ---
	const NULL_AUDIO = {
		unlock() {}, setVolumes() {},
		loadTrack() { return Promise.resolve(); },
		play() {}, pause() {}, resume() {}, stop() {}, fadeOut() {},
		position() { return null; }, playing() { return false; },
		preview() {}, stopPreview() {},
		menuMusic() {}, menuMusicTime() { return null; },
		sfx() {},
	};
	function memoryStorage() {
		const m = {};
		return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); } };
	}

	// ----------------------------------------------------------- drawing ----
	function roundRect(ctx, x, y, w, h, r) {
		r = Math.min(r, w / 2, h / 2);
		ctx.beginPath();
		ctx.moveTo(x + r, y);
		ctx.arcTo(x + w, y, x + w, y + h, r);
		ctx.arcTo(x + w, y + h, x, y + h, r);
		ctx.arcTo(x, y + h, x, y, r);
		ctx.arcTo(x, y, x + w, y, r);
		ctx.closePath();
	}
	function panel(ctx, x, y, w, h, r, fill, stroke, lw) {
		roundRect(ctx, x, y, w, h, r);
		if (fill) { ctx.fillStyle = fill; ctx.fill(); }
		if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw || 1; ctx.stroke(); }
	}
	function text(ctx, s, x, y, size, color, align, weight, baseline) {
		ctx.font = (weight || 600) + " " + size + "px " + FONT;
		ctx.fillStyle = color;
		ctx.textAlign = align || "left";
		ctx.textBaseline = baseline || "middle";
		ctx.fillText(s, x, y);
	}
	function textShadow(ctx, s, x, y, size, color, shadow, dy, align, weight) {
		text(ctx, s, x, y + dy, size, shadow, align, weight);
		text(ctx, s, x, y, size, color, align, weight);
	}
	function clipText(ctx, s, maxW, size, weight) {
		ctx.font = (weight || 600) + " " + size + "px " + FONT;
		if (ctx.measureText(s).width <= maxW) return s;
		while (s.length > 1 && ctx.measureText(s + "…").width > maxW) s = s.slice(0, -1);
		return s + "…";
	}
	function arrowPath(ctx, cx, cy, radius, rot) {
		const c = Math.cos(rot), s = Math.sin(rot);
		ctx.beginPath();
		for (let i = 0; i < ARROW.length; i++) {
			const px = ARROW[i][0] * radius, py = ARROW[i][1] * radius;
			const x = cx + px * c - py * s, y = cy + px * s + py * c;
			if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
		}
		ctx.closePath();
	}
	function drawArrow(ctx, cx, cy, radius, rot, fill, stroke, width) {
		arrowPath(ctx, cx, cy, radius, rot);
		if (fill) { ctx.fillStyle = fill; ctx.fill(); }
		if (stroke && width > 0) { ctx.strokeStyle = stroke; ctx.lineWidth = width; ctx.lineJoin = "round"; ctx.stroke(); }
	}

	// ----------------------------------------------------------- backdrop ---
	// scripts/backdrop.gd: neon horizon that pulses on the beat
	function Backdrop() {
		const rnd = Rng(1337);
		const stars = [];
		for (let i = 0; i < 70; i++) stars.push([rnd(), rnd() * 0.5]);
		let t = 0;
		return {
			bpm: 120, intensity: 1.0, timeSource: null,
			update(dt) { t += dt; },
			draw(ctx) {
				const w = WIDTH, h = HEIGHT;
				let beatT = t;
				if (this.timeSource) { const v = this.timeSource(); if (typeof v === "number") beatT = v; }
				const phase = fmod(beatT * this.bpm / 60, 1);
				const pulse = Math.pow(1 - phase, 3) * this.intensity;
				const horizon = h * 0.52;
				ctx.fillStyle = BG;
				ctx.fillRect(0, 0, w, h);
				for (const st of stars) {
					const tw = 0.5 + 0.5 * Math.sin(t * 2 + st[0] * 40);
					ctx.fillStyle = "rgba(255,255,255," + (0.25 + 0.4 * tw).toFixed(3) + ")";
					ctx.beginPath(); ctx.arc(st[0] * w, st[1] * h, (2 + tw * 1.5) * S * 1.5, 0, Math.PI * 2); ctx.fill();
				}
				const g = ctx.createLinearGradient(0, horizon, 0, h);
				g.addColorStop(0, BG);
				g.addColorStop(1, "rgb(" + Math.round(255 * (0.30 + 0.12 * pulse)) + ",26," + Math.round(255 * (0.50 + 0.15 * pulse)) + ")");
				ctx.fillStyle = g;
				ctx.fillRect(0, horizon, w, h - horizon);
				const sx = w * 0.5, sy = horizon - h * 0.02;
				ctx.fillStyle = "rgba(255,89,166,0.18)";
				ctx.beginPath(); ctx.arc(sx, sy, w * 0.16 + pulse * 8 * S, 0, Math.PI * 2); ctx.fill();
				ctx.fillStyle = "rgba(255,115,179,0.30)";
				ctx.beginPath(); ctx.arc(sx, sy, w * 0.12 + pulse * 6 * S, 0, Math.PI * 2); ctx.fill();
				ctx.lineWidth = 1;
				for (let i = 0; i < 14; i++) {
					const f = fmod(i / 14 + t * 0.12, 1);
					const y = horizon + (h - horizon) * f * f;
					ctx.strokeStyle = "rgba(166,115,255," + (0.08 + f * 0.35).toFixed(3) + ")";
					ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
				}
				ctx.strokeStyle = "rgba(166,115,255,0.18)";
				for (let i = -7; i <= 7; i++) {
					const xb = w * 0.5 + i * w * 0.17;
					ctx.beginPath(); ctx.moveTo(sx, horizon); ctx.lineTo(xb, h); ctx.stroke();
				}
				ctx.strokeStyle = "rgba(255,128,204," + (0.35 + 0.3 * pulse).toFixed(3) + ")";
				ctx.lineWidth = 1.5;
				ctx.beginPath(); ctx.moveTo(0, horizon); ctx.lineTo(w, horizon); ctx.stroke();
			},
		};
	}

	// scripts/arrow_rain.gd: lane-coloured arrows drifting up the main menu
	function ArrowRain() {
		const rnd = Rng(2024);
		const arrows = [];
		function spawn(anywhere) {
			const depth = rnd();
			return {
				x: rnd(), y: anywhere ? rnd() : 1.1, lane: Math.floor(rnd() * 4),
				size: lerp(34, 110, depth) * S, speed: lerp(0.04, 0.16, depth),
				alpha: lerp(0.12, 0.42, depth), wobble: lerp(8, 30, rnd()) * S, phase: rnd() * Math.PI * 2,
			};
		}
		for (let i = 0; i < 22; i++) arrows.push(spawn(true));
		let t = 0;
		return {
			beatSource: null,
			update(dt) {
				t += dt;
				for (let i = 0; i < arrows.length; i++) {
					arrows[i].y -= arrows[i].speed * dt;
					if (arrows[i].y < -0.12) arrows[i] = spawn(false);
				}
			},
			draw(ctx) {
				let bt = t;
				if (this.beatSource) { const v = this.beatSource(); if (typeof v === "number") bt = v; }
				const pulse = Math.pow(1 - fmod(bt * 126 / 60, 1), 4);
				for (const a of arrows) {
					const col = LANE_RGB[a.lane];
					const cx = a.x * WIDTH + Math.sin(t * 0.8 + a.phase) * a.wobble;
					const cy = a.y * HEIGHT;
					const r = a.size * (1 + 0.12 * pulse);
					const al = a.alpha * (0.75 + 0.35 * pulse);
					drawArrow(ctx, cx, cy, r, LANE_ROT[a.lane], rgba(col, al), rgba(col, al * 0.9), 1);
				}
			},
		};
	}

	// ----------------------------------------------------------- buttons ----
	function Button(x, y, w, h, label, onPress, opts) {
		opts = opts || {};
		return {
			x, y, w, h, label, onPress, size: opts.size || 15, disabled: !!opts.disabled,
			fill: opts.fill, border: opts.border, color: opts.color, pressed: false, hover: false, id: opts.id || label,
			hit(px, py) { return px >= this.x && px < this.x + this.w && py >= this.y && py < this.y + this.h; },
			draw(ctx) {
				const on = this.pressed;
				const fill = on ? (this.border || ACCENT) : (this.fill || (this.hover ? "rgb(51,38,97)" : "rgb(36,28,71)"));
				panel(ctx, this.x, this.y, this.w, this.h, Math.min(9, this.h / 2), fill, this.border || (this.hover ? "rgb(184,140,255)" : ACCENT), 1.2);
				const col = this.disabled ? "rgb(128,122,153)" : (this.color || "rgb(245,242,255)");
				text(ctx, this.label, this.x + this.w / 2, this.y + this.h / 2 + 1, this.size, col, "center", 700);
			},
		};
	}

	// ============================================================ the game ==
	function create(canvas, opts) {
		opts = opts || {};
		const ctx = canvas.getContext("2d");
		const audio = {};
		for (const k in NULL_AUDIO) {
			const fn = opts.audio && opts.audio[k];
			audio[k] = typeof fn === "function" ? fn.bind(opts.audio) : NULL_AUDIO[k];
		}
		const storage = opts.storage || memoryStorage();
		const loadChart = opts.loadChart || (() => Promise.reject(new Error("no chart loader")));
		const listeners = {};
		const emit = (name, arg) => { (listeners[name] || []).forEach((f) => f(arg)); };

		// ---------------------------------------------------- settings ---
		// scripts/autoload/settings.gd, stored as one JSON blob
		const settings = {
			audio_offset_ms: 0, note_speed: 4, tap_sound: true, fail_enabled: true, difficulty: "normal",
			music_muted: false, sfx_muted: false, best: {},
		};
		function loadSave() {
			try {
				const raw = storage.getItem("dancyfingers.save");
				if (!raw) return;
				const d = JSON.parse(raw);
				if (!d || typeof d !== "object") return;
				settings.audio_offset_ms = clamp(parseInt(d.audio_offset_ms, 10) || 0, -300, 300);
				settings.note_speed = clamp(parseInt(d.note_speed, 10) || 4, 1, 10);
				settings.tap_sound = d.tap_sound !== false;
				settings.fail_enabled = d.fail_enabled !== false;
				settings.music_muted = !!d.music_muted;
				settings.sfx_muted = !!d.sfx_muted;
				settings.difficulty = DIFFICULTIES.includes(d.difficulty) ? d.difficulty : "normal";
				settings.best = d.best && typeof d.best === "object" ? d.best : {};
			} catch (e) { /* no storage, no memory: fine */ }
		}
		function save() {
			try { storage.setItem("dancyfingers.save", JSON.stringify(Object.assign({ version: 2 }, settings))); } catch (e) { /* ignore */ }
			emit("settings", settings);
		}
		function bestFor(trackId, diff, survival) {
			return settings.best[trackId + "|" + diff + "|" + modeName(survival)] || null;
		}
		function recordResult(trackId, diff, r) {
			if (r.failed) return false;
			const key = trackId + "|" + diff + "|" + modeName(r.survival);
			const prev = settings.best[key];
			if (!prev || r.score > prev.score) {
				settings.best[key] = { score: r.score, grade: r.grade, combo: r.max_combo, accuracy: r.accuracy, full_combo: r.full_combo, survival: r.survival };
				save();
				return true;
			}
			return false;
		}
		function topScore() {
			let best = null;
			for (const key in settings.best) {
				const e = settings.best[key];
				if (!best || e.score > best.score) {
					best = Object.assign({}, e);
					const p = key.split("|");
					best.track_id = p[0]; best.difficulty = p[1] || ""; best.survival = p[2] === "survival";
				}
			}
			return best;
		}
		loadSave();
		audio.setVolumes(!settings.music_muted, !settings.sfx_muted);

		// ------------------------------------------------------ shared ---
		const backdrop = Backdrop();
		let tracks = opts.tracks || [];
		const trackById = (id) => tracks.find((t) => t.id === id) || null;
		let current = null;       // current track (a manifest entry)
		let lastResult = null;
		let screen = null;
		const pointers = {};      // pointerId -> { btn } for UI presses
		let sfxOn = true;
		const sfx = (name, db) => { if (sfxOn) audio.sfx(name, db || 0); };

		function goto(next) {
			if (screen && screen.leave) screen.leave();
			screen = next;
			for (const k in pointers) delete pointers[k];
			if (screen.enter) screen.enter();
			emit("screen", screen.name);
		}

		// buttons shared by every screen
		function uiDown(btns, id, x, y) {
			for (const b of btns) {
				if (!b.disabled && b.hit(x, y)) { b.pressed = true; pointers[id] = { btn: b }; return true; }
			}
			return false;
		}
		function uiUp(btns, id, x, y) {
			const p = pointers[id];
			if (!p) return false;
			delete pointers[id];
			p.btn.pressed = false;
			if (p.btn.hit(x, y) && !p.btn.disabled) { p.btn.onPress(); return true; }
			return false;
		}
		function uiMove(btns, x, y) {
			for (const b of btns) b.hover = !b.disabled && b.hit(x, y);
		}
		function header(ctx, title, back) {
			text(ctx, title, WIDTH / 2, 30, 20, "white", "center", 800);
			if (back) back.draw(ctx);
		}
		const backButton = (fn) => Button(12, 14, 44, 32, "‹", fn, { size: 22, id: "back" });

		// ======================================================== MENU ===
		const menu = (function () {
			const rain = ArrowRain();
			rain.beatSource = () => audio.menuMusicTime();
			const btns = [
				Button(30, 402, 300, 42, "PLAY", () => { sfx("menu"); goto(select); }, { size: 20 }),
				Button(30, 452, 300, 38, "HIGH SCORES", () => { sfx("menu"); goto(scores); }),
				Button(30, 498, 300, 38, "SETTINGS", () => { sfx("menu"); goto(settingsScreen); }),
			];
			let t = 0;
			return {
				name: "menu", buttons: btns,
				enter() {
					backdrop.bpm = 126; backdrop.intensity = 1.2;
					backdrop.timeSource = () => audio.menuMusicTime();
					audio.menuMusic(true);
				},
				update(dt) { t += dt; rain.update(dt); },
				draw(ctx) {
					backdrop.draw(ctx);
					rain.draw(ctx);
					const bob = Math.sin(t * Math.PI / 1.2) * 2;
					textShadow(ctx, "DANCY", WIDTH / 2, 92 + bob, 60, "#ff4fa3", "rgba(120,20,70,0.9)", 4, "center", 800);
					textShadow(ctx, "FINGERS", WIDTH / 2, 158 + bob, 60, "#4fd8ff", "rgba(20,80,120,0.9)", 4, "center", 800);
					text(ctx, "a rhythm game for your thumbs", WIDTH / 2, 205 + bob, 13, "rgb(217,209,255)", "center", 600);
					// top score panel (title.gd _refresh)
					panel(ctx, 20, 232, 320, 66, 10, "rgba(24,18,48,0.85)", ACCENT, 1.2);
					text(ctx, "TOP SCORE", WIDTH / 2, 246, 10, DIM, "center", 700);
					const top = topScore();
					if (!top) {
						text(ctx, "—", WIDTH / 2, 266, 24, DIM, "center", 700);
						text(ctx, "No scores yet. Play a song!", WIDTH / 2, 288, 9.5, "rgb(217,209,255)", "center", 600);
					} else {
						const tr = trackById(top.track_id);
						text(ctx, formatScore(top.score), WIDTH / 2, 266, 24, Judge.gradeColor(top.grade), "center", 800);
						const meta = (tr ? tr.title : "(missing song)") + "  ·  " + DIFF_NAMES[top.difficulty] + "  ·  " + top.grade + "  ·  " + top.combo + "x" +
							(top.full_combo ? "  ·  FULL COMBO" : "") + (top.survival ? "  ·  SURVIVAL" : "");
						text(ctx, clipText(ctx, meta, 300, 9.5), WIDTH / 2, 288, 9.5, "rgb(217,209,255)", "center", 600);
					}
					for (const b of btns) b.draw(ctx);
					text(ctx, "v0.1.0  ·  web edition  ·  " + tracks.length + " of 40 songs", WIDTH / 2, 620, 9.5, DIMMER, "center", 600);
				},
				down(id, x, y) { uiDown(btns, id, x, y); },
				up(id, x, y) { uiUp(btns, id, x, y); },
				move(x, y) { uiMove(btns, x, y); },
				key(code, pressed) { if (pressed && (code === "Enter" || code === "Space")) btns[0].onPress(); },
			};
		})();

		// ===================================================== SONG LIST ===
		const select = (function () {
			const CARD_Y = 96, CARD_H = 54, CARD_GAP = 4;
			let selectedId = null;
			const back = backButton(() => { sfx("menu"); goto(menu); });
			const diffBtns = DIFFICULTIES.map((d, i) => Button(30 + i * 102, 54, 96, 30, DIFF_NAMES[d], () => {
				sfx("click"); settings.difficulty = d; save();
			}, { size: 12, id: "diff-" + d }));
			const playBtn = Button(30, 578, 300, 42, "PLAY", () => startSelected(), { size: 18, id: "play" });
			playBtn.disabled = true;
			const btns = [back].concat(diffBtns, [playBtn]);
			function cardRect(i) { return { x: 14, y: CARD_Y + i * (CARD_H + CARD_GAP), w: WIDTH - 28, h: CARD_H }; }
			function choose(id, withSound) {
				const tr = trackById(id);
				if (!tr) return;
				if (withSound) sfx("menu");
				if (selectedId === id && withSound) { startSelected(); return; }
				selectedId = id;
				current = tr;
				playBtn.disabled = false;
				playBtn.label = "PLAY  ·  " + tr.title;
				audio.preview(tr, tr.preview || 0);
			}
			function startSelected() {
				if (!current) return;
				sfx("menu");
				audio.stopPreview();
				goto(play);
			}
			return {
				name: "select", buttons: btns, choose,
				enter() {
					backdrop.bpm = 126; backdrop.intensity = 0.5; backdrop.timeSource = () => audio.menuMusicTime();
					audio.menuMusic(true);
					if (current) { selectedId = current.id; playBtn.disabled = false; playBtn.label = "PLAY  ·  " + current.title; }
				},
				leave() { audio.stopPreview(); },
				update() {},
				draw(ctx) {
					backdrop.draw(ctx);
					header(ctx, "SONG LIST", back);
					const d = settings.difficulty;
					for (const b of diffBtns) {
						const on = b.id === "diff-" + d;
						b.fill = on ? DIFF_COLORS[d] : undefined;
						b.color = on ? "rgb(20,12,32)" : undefined;
						b.border = on ? DIFF_COLORS[d] : undefined;
						b.draw(ctx);
					}
					const col = DIFF_COLORS[d];
					for (let i = 0; i < tracks.length; i++) {
						const tr = tracks[i], r = cardRect(i);
						const sel = tr.id === selectedId;
						panel(ctx, r.x, r.y, r.w, r.h, 8, sel ? "rgba(70,50,130,0.9)" : "rgba(24,18,48,0.85)", sel ? "rgb(184,140,255)" : "rgba(140,97,255,0.5)", 1.2);
						text(ctx, clipText(ctx, tr.title, 190, 14, 700), r.x + 12, r.y + 15, 14, "white", "left", 700);
						text(ctx, DIFF_NAMES[d] + "  Lv " + (tr.levels ? tr.levels[d] : 0), r.x + r.w - 12, r.y + 15, 10.5, col, "right", 700);
						text(ctx, tr.artist + "  ·  " + tr.style + "  ·  " + tr.bpm + " BPM  ·  " + formatTime(tr.duration), r.x + 12, r.y + 31, 9, DIM, "left", 600);
						const b = bestFor(tr.id, d, settings.fail_enabled);
						if (!b) text(ctx, "No score yet", r.x + 12, r.y + 44, 9, DIM, "left", 600);
						else text(ctx, "Best  " + formatScore(b.score) + "  ·  " + b.grade + "  ·  " + b.combo + "x combo" + (b.full_combo ? "  ·  FULL COMBO" : ""), r.x + 12, r.y + 44, 9, GOLD, "left", 600);
					}
					playBtn.draw(ctx);
				},
				down(id, x, y) {
					if (uiDown(btns, id, x, y)) return;
					for (let i = 0; i < tracks.length; i++) {
						const r = cardRect(i);
						if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) { choose(tracks[i].id, true); return; }
					}
				},
				up(id, x, y) { uiUp(btns, id, x, y); },
				move(x, y) { uiMove(btns, x, y); },
				key(code, pressed) {
					if (!pressed) return;
					if (code === "Escape") back.onPress();
					else if (code === "Enter" || code === "Space") { if (!playBtn.disabled) startSelected(); }
					else if (code === "ArrowDown" || code === "ArrowUp") {
						const i = tracks.findIndex((t) => t.id === selectedId);
						const j = i < 0 ? 0 : clamp(i + (code === "ArrowDown" ? 1 : -1), 0, tracks.length - 1);
						if (tracks[j] && (tracks[j].id !== selectedId)) choose(tracks[j].id, false);
					}
				},
			};
		})();

		// ====================================================== GAMEPLAY ===
		// scripts/gameplay.gd + highway.gd
		const LEAD_IN = 2.5, RESUME_DELAY = 1.5, HUD_TOP_DEAD_ZONE = 215 * S;
		const RECEPTOR_Y = 0.80;
		const KEY_LANES = { KeyD: 0, KeyF: 1, KeyJ: 2, KeyK: 3, ArrowLeft: 0, ArrowDown: 1, ArrowUp: 2, ArrowRight: 3 };
		const play = (function () {
			const ST = { LOADING: 0, COUNTDOWN: 1, PLAYING: 2, PAUSED: 3, FINISHED: 4 };
			let g = null;   // per-run state
			const rnd = Rng(42);
			const pauseBtns = [
				Button(70, 262, 220, 40, "RESUME", () => resume()),
				Button(70, 310, 220, 40, "RESTART", () => { sfx("menu"); restart(); }),
				Button(70, 358, 220, 40, "SONG LIST", () => { sfx("menu"); audio.stop(); goto(select); }),
				Button(70, 406, 220, 40, "MAIN MENU", () => { sfx("menu"); audio.stop(); goto(menu); }),
			];
			const pauseBtn = Button(296, 34, 52, 32, "| |", () => { sfx("menu"); togglePause(); }, { size: 12, id: "pause" });

			function fresh() {
				return {
					state: ST.LOADING, loadError: "", track: current, difficulty: settings.difficulty, bpm: current ? current.bpm : 120,
					notes: [], next: 0, totalUnits: 0, endTime: 0, songTime: -LEAD_IN, audioStarted: false, resumeTimer: 0,
					finishedReason: "", finishTimer: 0, countdownText: "", countdownAlpha: 1,
					counts: { perfect: 0, great: 0, good: 0, miss: 0, hold_ok: 0, hold_break: 0 },
					weightSum: 0, combo: 0, maxCombo: 0, health: Judge.START_HEALTH, score: 0, displayedScore: 0,
					lanePressed: [false, false, false, false], touches: {},
					flash: [0, 0, 0, 0], flashColor: [null, null, null, null], particles: [],
					judgeText: "", judgeColor: "white", judgeAge: 99, comboAge: 99, countdownFade: -1, run: 0,
				};
			}
			function loadNotes(raw) {
				g.notes = []; g.totalUnits = 0;
				let lastEnd = 0;
				for (const item of raw) {
					if (!Array.isArray(item) || item.length < 2) continue;
					const n = { time: +item[0], lane: clamp(item[1] | 0, 0, 3), hold: item.length > 2 ? +item[2] : 0,
						hit: false, missed: false, judgement: "", holding: false, holdDone: false, holdOk: false };
					n.resolved = function () { return this.hit && (this.hold <= 0 || this.holdDone); };
					g.notes.push(n);
					g.totalUnits += n.hold > 0 ? 2 : 1;
					lastEnd = Math.max(lastEnd, n.time + n.hold);
				}
				g.notes.sort((a, b) => a.time - b.time);
				g.endTime = lastEnd + 1.6;
			}
			function begin() {
				g = fresh();
				const run = ++play.runCounter;
				g.run = run;
				if (!g.track) { goto(select); return; }
				backdrop.bpm = g.bpm; backdrop.intensity = 0.6;
				backdrop.timeSource = () => gameTime();
				audio.menuMusic(false, true);
				Promise.all([loadChart(g.track), audio.loadTrack(g.track)]).then(([chart]) => {
					if (g.run !== run || screen !== play) return;
					const c = chart && chart.charts && chart.charts[g.difficulty];
					loadNotes(c && Array.isArray(c.notes) ? c.notes : []);
					g.state = ST.COUNTDOWN;
				}, (err) => {
					if (g.run !== run) return;
					g.loadError = "Could not load the song. " + ((err && err.message) || "");
				});
			}
			const gameTime = () => (g ? g.songTime - settings.audio_offset_ms / 1000 : 0);
			const pps = () => (560 + settings.note_speed * 110) * S;

			function advanceClock(dt) {
				if (!g.audioStarted) {
					g.songTime += dt;
					if (g.songTime >= 0) { g.audioStarted = true; audio.play(g.track, g.songTime); }
					return;
				}
				const pos = audio.playing() ? audio.position() : null;
				if (typeof pos === "number") {
					const predicted = g.songTime + dt;
					const drift = pos - predicted;
					g.songTime = Math.abs(drift) > 0.08 ? pos : predicted + drift * 0.15;
				} else g.songTime += dt;
			}
			function scanNotes() {
				const t = gameTime();
				while (g.next < g.notes.length && g.notes[g.next].resolved()) g.next++;
				for (let i = g.next; i < g.notes.length; i++) {
					const n = g.notes[i];
					if (n.time - t > 1.0) break;
					if (!n.hit && t - n.time > Judge.MISS_LATE) { missNote(n); continue; }
					if (n.hold > 0 && n.hit && !n.missed && !n.holdDone && n.holding && t >= n.time + n.hold) holdComplete(n, true);
				}
			}
			function pressLane(lane) {
				if (lane < 0 || lane > 3 || !g) return;
				g.lanePressed[lane] = true;
				if (g.state !== ST.PLAYING && g.state !== ST.COUNTDOWN) return;
				if (settings.tap_sound) sfx("tap", -8);
				const t = gameTime();
				let best = null;
				for (let i = g.next; i < g.notes.length; i++) {
					const n = g.notes[i];
					if (n.time - t > Judge.GOOD) break;
					if (n.hit || n.lane !== lane) continue;
					if (Math.abs(n.time - t) <= Judge.GOOD) { best = n; break; }
				}
				if (!best) return;
				hitNote(best, Judge.classify(t - best.time));
			}
			function releaseLane(lane) {
				if (lane < 0 || lane > 3 || !g) return;
				g.lanePressed[lane] = false;
				if (g.state !== ST.PLAYING && g.state !== ST.COUNTDOWN) return;
				const t = gameTime();
				for (let i = g.next; i < g.notes.length; i++) {
					const n = g.notes[i];
					if (n.time - t > 0) break;
					if (n.lane === lane && n.holding && !n.holdDone) holdComplete(n, t >= n.time + n.hold - Judge.HOLD_RELEASE_GRACE);
				}
			}
			function hitNote(n, j) {
				n.hit = true; n.judgement = j;
				g.counts[j]++; g.weightSum += Judge.WEIGHTS[j];
				g.combo++; g.maxCombo = Math.max(g.maxCombo, g.combo);
				changeHealth(Judge.HEALTH[j]);
				if (n.hold > 0) n.holding = true;
				onHit(n.lane, j);
				showJudgement(j);
				bumpCombo();
				if (g.combo > 0 && g.combo % 50 === 0) sfx("combo", -4);
				g.score = Judge.scoreFor(g.weightSum, g.totalUnits);
				emit("hit", j);
			}
			function missNote(n) {
				n.hit = true; n.missed = true; n.judgement = "miss";
				g.counts.miss++;
				if (n.hold > 0) { n.holdDone = true; n.holdOk = false; g.counts.miss++; }
				g.combo = 0;
				changeHealth(Judge.HEALTH.miss);
				onMiss(n.lane);
				showJudgement("miss");
				bumpCombo();
				sfx("miss", -10);
				g.score = Judge.scoreFor(g.weightSum, g.totalUnits);
				emit("hit", "miss");
			}
			function holdComplete(n, ok) {
				n.holdDone = true; n.holdOk = ok; n.holding = false;
				if (ok) {
					g.counts.hold_ok++; g.weightSum += 1;
					g.combo++; g.maxCombo = Math.max(g.maxCombo, g.combo);
					changeHealth(Judge.HEALTH.hold_ok);
					onHit(n.lane, "great");
					showJudgement("hold");
				} else {
					g.counts.hold_break++; g.combo = 0;
					changeHealth(Judge.HEALTH.hold_break);
					onMiss(n.lane);
					showJudgement("miss");
					sfx("miss", -10);
				}
				bumpCombo();
				g.score = Judge.scoreFor(g.weightSum, g.totalUnits);
				emit("hit", ok ? "hold" : "miss");
			}
			function changeHealth(a) {
				g.health = clamp(g.health + a, 0, 100);
				if (g.health <= 0 && settings.fail_enabled && g.state === ST.PLAYING) finish("failed");
			}
			function accuracy() {
				const c = g.counts;
				const judged = c.perfect + c.great + c.good + c.miss + c.hold_ok + c.hold_break;
				return judged === 0 ? 1 : g.weightSum / judged;
			}
			function buildResult(failed) {
				const acc = g.weightSum / Math.max(g.totalUnits, 1);
				const c = g.counts;
				return {
					track_id: g.track.id, title: g.track.title, artist: g.track.artist, difficulty: g.difficulty,
					score: g.score, accuracy: acc, grade: Judge.gradeFor(acc, failed),
					perfect: c.perfect, great: c.great, good: c.good, miss: c.miss, hold_ok: c.hold_ok, hold_break: c.hold_break,
					max_combo: g.maxCombo, full_combo: c.miss === 0 && c.hold_break === 0 && !failed,
					failed, survival: settings.fail_enabled,
				};
			}
			function finish(reason) {
				if (g.state === ST.FINISHED) return;
				g.state = ST.FINISHED;
				g.finishedReason = reason;
				const failed = reason === "failed";
				g.countdownText = failed ? "FAILED" : "CLEAR!";
				g.countdownAlpha = 1; g.countdownFade = -1;
				g.finishTimer = 1.6;
				if (failed) audio.fadeOut(1.2);
				const r = buildResult(failed);
				r.new_best = recordResult(g.track.id, g.difficulty, r);
				lastResult = r;
				emit("finished", r);
			}
			// highway.gd effects
			function onHit(lane, j) {
				g.flash[lane] = 1;
				const col = LANE_RGB[lane];
				g.flashColor[lane] = j === "perfect" ? [255, 224, 102] : (j === "great" ? col : dark(col, 0.2));
				const count = j === "perfect" ? 16 : (j === "great" ? 10 : 5);
				const cx = (lane + 0.5) * WIDTH / 4, cy = HEIGHT * RECEPTOR_Y;
				for (let i = 0; i < count; i++) {
					const ang = rnd() * Math.PI * 2, speed = lerp(250, 700, rnd()) * S;
					g.particles.push({ x: cx, y: cy, vx: Math.cos(ang) * speed, vy: Math.sin(ang) * speed, life: 1,
						color: rnd() < 0.6 ? g.flashColor[lane] : [255, 255, 255], size: lerp(5, 12, rnd()) * S });
				}
			}
			function onMiss(lane) { g.flash[lane] = 0.6; g.flashColor[lane] = [255, 79, 79]; }
			function showJudgement(kind) {
				const map = { perfect: ["PERFECT", GOLD], great: ["GREAT", "#7dff4f"], good: ["GOOD", "#4fd8ff"], hold: ["HOLD!", VIOLET] };
				const m = map[kind] || ["MISS", RED];
				g.judgeText = m[0]; g.judgeColor = m[1]; g.judgeAge = 0;
			}
			function bumpCombo() { g.comboAge = 0; }

			function togglePause() {
				if (!g) return;
				if (g.state === ST.PLAYING) pause();
				else if (g.state === ST.PAUSED) resume();
			}
			function pause() {
				if (!g || g.state !== ST.PLAYING) return;
				g.state = ST.PAUSED;
				audio.pause();
				g.lanePressed = [false, false, false, false];
				g.touches = {};
				emit("paused", true);
			}
			function resume() {
				if (!g || g.state !== ST.PAUSED) return;
				sfx("menu");
				g.state = ST.COUNTDOWN;
				g.resumeTimer = RESUME_DELAY;
				g.countdownAlpha = 1; g.countdownFade = -1;
				emit("paused", false);
			}
			function restart() { audio.stop(); begin(); }

			function tick(dt) {
				if (!g) return;
				for (let i = 0; i < 4; i++) g.flash[i] = Math.max(0, g.flash[i] - dt * 4);
				const alive = [];
				for (const p of g.particles) {
					p.life -= dt * 2.2;
					if (p.life <= 0) continue;
					p.x += p.vx * dt; p.y += p.vy * dt;
					p.vx *= 0.90; p.vy = p.vy * 0.90 + 900 * S * dt;
					alive.push(p);
				}
				g.particles = alive;
				g.judgeAge += dt; g.comboAge += dt;
				if (g.countdownFade >= 0) { g.countdownFade += dt; g.countdownAlpha = clamp(1 - (g.countdownFade - 0.3) / 0.6, 0, 1); }
				switch (g.state) {
					case ST.COUNTDOWN:
						if (g.resumeTimer > 0) {
							g.resumeTimer -= dt;
							g.countdownText = String(Math.ceil(g.resumeTimer));
							if (g.resumeTimer <= 0) { g.countdownText = ""; if (g.audioStarted) audio.resume(); g.state = ST.PLAYING; }
							return;
						}
						advanceClock(dt);
						{
							const remaining = -g.songTime;
							if (remaining > 0) g.countdownText = remaining > 1.6 ? "READY" : String(Math.ceil(remaining));
							else { g.countdownText = "GO!"; g.state = ST.PLAYING; g.countdownFade = 0; }
						}
						scanNotes();
						break;
					case ST.PLAYING:
						advanceClock(dt);
						scanNotes();
						g.displayedScore = lerp(g.displayedScore, g.score, Math.min(1, dt * 12));
						if (Math.abs(g.displayedScore - g.score) < 1) g.displayedScore = g.score;
						if (gameTime() > g.endTime) finish("end");
						break;
					case ST.FINISHED:
						g.finishTimer -= dt;
						if (g.finishTimer <= 0) { audio.stop(); goto(results); }
						break;
				}
			}

			function laneAt(x, y) {
				if (!g || g.state === ST.PAUSED || g.state === ST.FINISHED || g.state === ST.LOADING) return -1;
				if (y < HUD_TOP_DEAD_ZONE) return -1;
				if (x < 0 || x >= WIDTH) return -1;
				return Math.floor(x / WIDTH * 4);
			}

			function drawHighway(ctx) {
				const w = WIDTH, h = HEIGHT, laneW = w / 4, ry = h * RECEPTOR_Y, radius = laneW * 0.34;
				const speed = pps(), t = gameTime();
				for (let l = 0; l < 4; l++) {
					const a = 0.05 + (g.lanePressed[l] ? 0.12 : 0);
					ctx.fillStyle = rgba(LANE_RGB[l], a);
					ctx.fillRect(l * laneW, 0, laneW, h);
					if (l > 0) { ctx.strokeStyle = "rgba(255,255,255,0.07)"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(l * laneW, 0); ctx.lineTo(l * laneW, h); ctx.stroke(); }
				}
				ctx.fillStyle = "rgba(255,255,255,0.03)";
				ctx.fillRect(0, ry + radius * 1.3, w, h - ry - radius * 1.3);
				// beat lines
				const beatLen = 60 / Math.max(g.bpm, 1);
				const tBottom = t - (h - ry) / speed, tTop = t + ry / speed;
				for (let k = Math.ceil(tBottom / beatLen); k <= Math.floor(tTop / beatLen); k++) {
					if (k < 0) continue;
					const y = ry - (k * beatLen - t) * speed;
					ctx.strokeStyle = "rgba(255,255,255," + (k % 4 === 0 ? 0.12 : 0.05) + ")";
					ctx.lineWidth = 0.75;
					ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
				}
				ctx.strokeStyle = "rgba(255,255,255,0.35)"; ctx.lineWidth = 1.5;
				ctx.beginPath(); ctx.moveTo(0, ry); ctx.lineTo(w, ry); ctx.stroke();
				// receptors
				for (let l = 0; l < 4; l++) {
					const cx = (l + 0.5) * laneW, f = g.flash[l], pressed = g.lanePressed[l], base = LANE_RGB[l];
					if (f > 0) {
						ctx.fillStyle = rgba(g.flashColor[l] || base, 0.25 * f);
						ctx.beginPath(); ctx.arc(cx, ry, radius * (1.5 + 0.6 * f), 0, Math.PI * 2); ctx.fill();
					}
					const r = radius * (1 + 0.12 * f + (pressed ? 0.06 : 0));
					drawArrow(ctx, cx, ry, r, LANE_ROT[l], rgba(base, 0.18 + (pressed ? 0.25 : 0) + 0.5 * f), rgba(base, 0.9), 5 * S);
				}
				// notes
				const notes = g.notes;
				for (let i = Math.max(0, g.next - 24); i < notes.length; i++) {
					const n = notes[i];
					const y = ry - (n.time - t) * speed;
					if (y < -radius * 2 && n.hold <= 0) break;
					const yTail = ry - (n.time + n.hold - t) * speed;
					if (yTail < -radius * 2 && y < -radius * 2) break;
					if (y > h + radius * 2 && yTail > h + radius * 2) continue;
					if (n.resolved() && !n.missed && !(n.hold > 0 && !n.holdOk)) continue;
					if (n.resolved() && (n.missed || !n.holdOk) && yTail > h + radius * 2) continue;
					const col = LANE_RGB[n.lane], cx = (n.lane + 0.5) * laneW;
					const dead = n.missed || (n.holdDone && !n.holdOk);
					if (n.hold > 0) {
						let yHead = y;
						if (n.holding) yHead = Math.min(y, ry);
						const bodyCol = rgba(col, dead ? 0.22 : 0.55), half = radius * 0.42;
						ctx.fillStyle = bodyCol;
						ctx.fillRect(cx - half, yTail, half * 2, Math.max(0, yHead - yTail));
						ctx.beginPath(); ctx.arc(cx, yTail, half, 0, Math.PI * 2); ctx.fill();
						ctx.strokeStyle = rgba(col, dead ? 0.35 : 0.9); ctx.lineWidth = 1;
						ctx.beginPath(); ctx.arc(cx, yTail, half, 0, Math.PI * 2); ctx.stroke();
						if (n.holding) {
							const pulse = 0.5 + 0.5 * Math.sin(t * 18);
							ctx.fillStyle = rgba(col, 0.25);
							ctx.beginPath(); ctx.arc(cx, ry, radius * (1.15 + 0.1 * pulse), 0, Math.PI * 2); ctx.fill();
							drawArrow(ctx, cx, ry, radius * 0.95, LANE_ROT[n.lane], LANE_COLORS[n.lane], "white", 4 * S);
							continue;
						}
					}
					if (n.hit && !n.missed) continue;
					const fill = dead ? rgba(dark(col, 0.55), 0.5) : LANE_COLORS[n.lane];
					drawArrow(ctx, cx, y, radius, LANE_ROT[n.lane], fill, "rgba(13,8,31," + (dead ? 0.5 : 1) + ")", 5 * S);
					if (!dead) drawArrow(ctx, cx, y, radius * 0.55, LANE_ROT[n.lane], "rgba(255,255,255,0.35)", null, 0);
				}
				// fade the top under the HUD
				const fadeH = 350 * S;
				const grad = ctx.createLinearGradient(0, 0, 0, fadeH);
				grad.addColorStop(0, "rgba(13,10,26,0.95)"); grad.addColorStop(1, "rgba(13,10,26,0)");
				ctx.fillStyle = grad; ctx.fillRect(0, 0, w, fadeH);
				for (const p of g.particles) {
					ctx.fillStyle = rgba(p.color, p.life);
					ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(0.1, p.size * p.life), 0, Math.PI * 2); ctx.fill();
				}
			}
			function bar(ctx, x, y, w, h, frac, color) {
				panel(ctx, x, y, w, h, h / 2, "rgba(255,255,255,0.14)", "rgba(255,255,255,0.35)", 0.8);
				if (frac > 0) panel(ctx, x, y, Math.max(h, w * clamp(frac, 0, 1)), h, h / 2, color, null, 0);
			}
			function drawHud(ctx) {
				const hc = g.health > 40 ? "#7dff4f" : (g.health > 20 ? "#ffb84f" : RED);
				bar(ctx, 12, 8, WIDTH - 24, 9, g.health / 100, hc);
				const dur = g.track.duration || g.endTime;
				bar(ctx, 12, 21, WIDTH - 24, 5, clamp(gameTime() / Math.max(dur, 1), 0, 1), ACCENT);
				text(ctx, formatScore(g.displayedScore), 12, 44, 19, "white", "left", 700);
				text(ctx, (accuracy() * 100).toFixed(2) + "%", 12, 61, 11, DIM, "left", 600);
				text(ctx, clipText(ctx, g.track.title + "  ·  " + DIFF_NAMES[g.difficulty], WIDTH - 24, 9), 12, 74, 9, DIMMER, "left", 600);
				pauseBtn.draw(ctx);
				const cy = HEIGHT / 2;
				if (g.combo >= 2) {
					const k = Math.max(0, 1 - g.comboAge / 0.15);
					const sc = 1 + 0.25 * k;
					ctx.save(); ctx.translate(WIDTH / 2, cy - 67); ctx.scale(sc, sc);
					text(ctx, String(g.combo), 0, 0, 50, "rgba(255,255,255,0.9)", "center", 800);
					ctx.restore();
					text(ctx, "COMBO", WIDTH / 2, cy - 32, 12, "rgba(217,209,255,0.8)", "center", 700);
				}
				if (g.judgeAge < 0.75) {
					const a = g.judgeAge < 0.25 ? 1 : 1 - (g.judgeAge - 0.25) / 0.5;
					const sc = 1 + 0.3 * Math.max(0, 1 - g.judgeAge / 0.12);
					ctx.save(); ctx.globalAlpha = a; ctx.translate(WIDTH / 2, cy + 37); ctx.scale(sc, sc);
					textShadow(ctx, g.judgeText, 0, 0, 25, g.judgeColor, "rgba(0,0,0,0.6)", 2, "center", 800);
					ctx.restore();
				}
				if (g.countdownText && g.countdownAlpha > 0) {
					ctx.save(); ctx.globalAlpha = g.countdownAlpha;
					const col = g.countdownText === "FAILED" ? RED : "white";
					textShadow(ctx, g.countdownText, WIDTH / 2, cy, 46, col, "rgba(0,0,0,0.6)", 3, "center", 800);
					ctx.restore();
				}
			}
			function drawPause(ctx) {
				ctx.fillStyle = "rgba(0,0,0,0.6)"; ctx.fillRect(0, 0, WIDTH, HEIGHT);
				panel(ctx, 54, 174, 252, 292, 14, "rgb(24,18,48)", ACCENT, 1.5);
				text(ctx, "PAUSED", WIDTH / 2, 222, 24, "white", "center", 800);
				for (const b of pauseBtns) b.draw(ctx);
			}

			return {
				name: "play", runCounter: 0, buttons: pauseBtns.concat([pauseBtn]),
				get state() { return g ? ["loading", "countdown", "playing", "paused", "finished"][g.state] : "none"; },
				get run() { return g; },
				pressLane, releaseLane, togglePause, pause, resume, tick, gameTime, accuracy,
				enter() { begin(); },
				leave() { g = null; },
				update: tick,
				draw(ctx) {
					backdrop.draw(ctx);
					if (!g) return;
					if (g.state === ST.LOADING) {
						text(ctx, g.loadError ? "OOPS" : "LOADING", WIDTH / 2, HEIGHT / 2 - 10, 24, "white", "center", 800);
						text(ctx, g.loadError || (g.track.title + "  ·  " + DIFF_NAMES[g.difficulty]), WIDTH / 2, HEIGHT / 2 + 18, 11, DIM, "center", 600);
						if (g.loadError) { text(ctx, "Press Escape or tap to go back", WIDTH / 2, HEIGHT / 2 + 40, 10, DIMMER, "center", 600); }
						return;
					}
					drawHighway(ctx);
					drawHud(ctx);
					if (g.state === ST.PAUSED) drawPause(ctx);
				},
				down(id, x, y) {
					if (!g) return;
					if (g.state === ST.LOADING) { if (g.loadError) goto(select); return; }
					if (g.state === ST.PAUSED) { uiDown(pauseBtns, id, x, y); return; }
					if (uiDown([pauseBtn], id, x, y)) return;
					const lane = laneAt(x, y);
					if (lane >= 0) { g.touches[id] = lane; pressLane(lane); }
				},
				up(id, x, y) {
					if (!g) return;
					if (uiUp(pauseBtns.concat([pauseBtn]), id, x, y)) return;
					if (id in g.touches) { const lane = g.touches[id]; delete g.touches[id]; releaseLane(lane); }
				},
				move(x, y) { if (g && g.state === ST.PAUSED) uiMove(pauseBtns, x, y); },
				key(code, pressed) {
					if (!g) return;
					if (code in KEY_LANES) { if (pressed) pressLane(KEY_LANES[code]); else releaseLane(KEY_LANES[code]); }
					else if (pressed && (code === "Escape" || code === "KeyP")) {
						if (g.state === ST.LOADING && g.loadError) goto(select);
						else togglePause();
					}
				},
				blur() { if (g && g.state === ST.PLAYING) pause(); },
			};
		})();

		// ======================================================= RESULTS ===
		const results = (function () {
			const btns = [
				Button(30, 578, 145, 42, "RETRY", () => { sfx("menu"); goto(play); }, { size: 16 }),
				Button(185, 578, 145, 42, "SONG LIST", () => { sfx("menu"); goto(select); }, { size: 16 }),
			];
			let age = 0;
			return {
				name: "results", buttons: btns,
				enter() {
					age = 0;
					if (!lastResult) { goto(select); return; }
					backdrop.bpm = 120; backdrop.intensity = 0.6; backdrop.timeSource = null;
					sfx(lastResult.failed ? "miss" : "fanfare");
				},
				update(dt) { age += dt; },
				draw(ctx) {
					backdrop.draw(ctx);
					const r = lastResult;
					if (!r) return;
					panel(ctx, 16, 16, WIDTH - 32, 548, 14, "rgba(24,18,48,0.88)", ACCENT, 1.5);
					text(ctx, (r.failed ? "FAILED" : "CLEAR") + "  ·  " + modeLabel(r.survival), WIDTH / 2, 42, 13, r.failed ? RED : DIM, "center", 700);
					text(ctx, clipText(ctx, r.title, WIDTH - 60, 18, 800), WIDTH / 2, 66, 18, "white", "center", 800);
					text(ctx, r.artist + "  ·  " + DIFF_NAMES[r.difficulty], WIDTH / 2, 86, 10.5, DIM, "center", 600);
					const gc = Judge.gradeColor(r.grade);
					const punch = 1 + 0.8 * Math.max(0, 1 - age / 0.5);
					ctx.save(); ctx.translate(WIDTH / 2, 152); ctx.scale(punch, punch);
					ctx.shadowColor = gc; ctx.shadowBlur = 16;
					text(ctx, r.grade, 0, 0, 68, gc, "center", 800);
					ctx.restore();
					text(ctx, formatScore(r.score), WIDTH / 2, 226, 30, "white", "center", 800);
					text(ctx, (r.accuracy * 100).toFixed(2) + "% accuracy", WIDTH / 2, 254, 12, DIM, "center", 600);
					let y = 278;
					if (r.new_best) { text(ctx, "NEW BEST!", WIDTH / 2, y, 14, GOLD, "center", 800); y += 20; }
					if (r.full_combo) { text(ctx, "FULL COMBO", WIDTH / 2, y, 14, "#7dff4f", "center", 800); y += 20; }
					y = Math.max(y, 318);
					const rows = [
						["Perfect", r.perfect, GOLD], ["Great", r.great, "#7dff4f"], ["Good", r.good, "#4fd8ff"], ["Miss", r.miss, RED],
						["Holds", r.hold_ok + " / " + (r.hold_ok + r.hold_break), VIOLET], ["Max combo", r.max_combo, "white"],
					];
					for (const row of rows) {
						text(ctx, row[0], WIDTH / 2 - 14, y, 12.5, row[2], "right", 700);
						text(ctx, String(row[1]), WIDTH / 2 + 14, y, 12.5, "white", "left", 700);
						y += 22;
					}
					for (const b of btns) b.draw(ctx);
				},
				down(id, x, y) { uiDown(btns, id, x, y); },
				up(id, x, y) { uiUp(btns, id, x, y); },
				move(x, y) { uiMove(btns, x, y); },
				key(code, pressed) {
					if (!pressed) return;
					if (code === "Enter" || code === "Space" || code === "KeyR") btns[0].onPress();
					else if (code === "Escape") btns[1].onPress();
				},
			};
		})();

		// =================================================== HIGH SCORES ===
		const scores = (function () {
			const back = backButton(() => { sfx("menu"); goto(menu); });
			const ROW_H = 46, TOP = 58;
			let scroll = 0, drag = null, entries = [];
			function refresh() {
				entries = [];
				for (const key in settings.best) {
					const p = key.split("|"), e = settings.best[key], tr = trackById(p[0]);
					entries.push(Object.assign({ track_id: p[0], title: tr ? tr.title : "(missing song)", difficulty: p[1], survival: p[2] === "survival" }, e));
				}
				entries.sort((a, b) => b.score - a.score);
			}
			const maxScroll = () => Math.max(0, TOP + entries.length * ROW_H + 12 - HEIGHT);
			return {
				name: "scores", buttons: [back],
				enter() { backdrop.bpm = 126; backdrop.intensity = 0.5; backdrop.timeSource = () => audio.menuMusicTime(); audio.menuMusic(true); refresh(); scroll = 0; },
				update() {},
				draw(ctx) {
					backdrop.draw(ctx);
					if (entries.length === 0) {
						text(ctx, "No scores yet.", WIDTH / 2, HEIGHT / 2 - 10, 16, "white", "center", 700);
						text(ctx, "Clear a song and it lands here.", WIDTH / 2, HEIGHT / 2 + 14, 11, DIM, "center", 600);
					}
					ctx.save();
					ctx.beginPath(); ctx.rect(0, TOP - 6, WIDTH, HEIGHT - TOP + 6); ctx.clip();
					for (let i = 0; i < entries.length; i++) {
						const e = entries[i], y = TOP + i * ROW_H - scroll;
						if (y + ROW_H < TOP - 6 || y > HEIGHT) continue;
						panel(ctx, 14, y, WIDTH - 28, ROW_H - 6, 8, "rgba(24,18,48,0.85)", "rgba(140,97,255,0.5)", 1.2);
						text(ctx, String(i + 1), 26, y + 20, 14, DIMMER, "left", 800);
						text(ctx, clipText(ctx, e.title, 170, 13, 700), 52, y + 13, 13, "white", "left", 700);
						text(ctx, DIFF_NAMES[e.difficulty] + (e.survival ? "  ·  SURVIVAL" : "") + "  ·  " + e.combo + "x" + (e.full_combo ? "  ·  FC" : "") + "  ·  " + (e.accuracy * 100).toFixed(2) + "%", 52, y + 29, 9, DIM, "left", 600);
						text(ctx, e.grade, WIDTH - 26, y + 13, 14, Judge.gradeColor(e.grade), "right", 800);
						text(ctx, formatScore(e.score), WIDTH - 26, y + 29, 10, GOLD, "right", 700);
					}
					ctx.restore();
					ctx.fillStyle = BG; ctx.fillRect(0, 0, WIDTH, TOP - 6);
					header(ctx, "HIGH SCORES", back);
				},
				down(id, x, y) { if (uiDown([back], id, x, y)) return; drag = { y, scroll }; },
				up(id, x, y) { uiUp([back], id, x, y); drag = null; },
				move(x, y, id) { uiMove([back], x, y); if (drag && id !== undefined) scroll = clamp(drag.scroll - (y - drag.y), 0, maxScroll()); },
				wheel(dy) { scroll = clamp(scroll + dy, 0, maxScroll()); },
				key(code, pressed) { if (pressed && code === "Escape") back.onPress(); },
			};
		})();

		// ====================================================== SETTINGS ===
		const settingsScreen = (function () {
			const back = backButton(() => { sfx("menu"); goto(menu); });
			const rows = [];
			const btns = [back];
			function stepper(y, label, get, set, fmt) {
				const minus = Button(212, y - 15, 34, 30, "−", () => { sfx("click"); set(get() - 1); }, { size: 16, id: label + "-" });
				const plus = Button(300, y - 15, 34, 30, "+", () => { sfx("click"); set(get() + 1); }, { size: 16, id: label + "+" });
				btns.push(minus, plus);
				rows.push({ y, label, draw(ctx) { text(ctx, fmt(get()), 273, y + 1, 13, "white", "center", 700); } });
			}
			const toggles = [];
			function toggle(y, label, get, set, id) {
				const b = Button(212, y - 15, 122, 30, "", () => { sfx("click"); set(!get()); }, { size: 12, id });
				btns.push(b); toggles.push(b);
				rows.push({ y, label, draw(ctx) {
					const on = get();
					b.label = on ? "ON" : "OFF"; b.fill = on ? ACCENT : undefined; b.border = on ? "rgb(184,140,255)" : undefined;
					b.draw(ctx);
				} });
			}
			stepper(112, "Note speed", () => settings.note_speed, (v) => { settings.note_speed = clamp(v, 1, 10); save(); }, (v) => String(v));
			stepper(166, "Audio offset", () => settings.audio_offset_ms / 5, (v) => { settings.audio_offset_ms = clamp(v * 5, -300, 300); save(); }, (v) => (v > 0 ? "+" : "") + (v * 5) + " ms");
			toggle(220, "Survival mode", () => settings.fail_enabled, (v) => { settings.fail_enabled = v; save(); }, "survival");
			toggle(274, "Tap sound", () => settings.tap_sound, (v) => { settings.tap_sound = v; save(); }, "tapsound");
			toggle(328, "Music", () => !settings.music_muted, (v) => { setAudioPrefs(!v, settings.sfx_muted); }, "music");
			toggle(382, "Sound effects", () => !settings.sfx_muted, (v) => { setAudioPrefs(settings.music_muted, !v); }, "sfx");
			const resetBtn = Button(90, 440, 180, 34, "RESET DEFAULTS", () => {
				sfx("click");
				settings.note_speed = 4; settings.audio_offset_ms = 0; settings.fail_enabled = true; settings.tap_sound = true;
				setAudioPrefs(false, false);
			}, { size: 12, id: "reset" });
			btns.push(resetBtn);
			const HELP = {
				"Note speed": "How fast arrows fall. 4 is the app's default.",
				"Audio offset": "Positive if you hear the beat before the arrow lands.",
				"Survival mode": "Health that drains on misses; hit zero and the song fails.",
				"Tap sound": "A click on every lane press.",
				"Music": "Songs, previews and the menu loop.",
				"Sound effects": "Judgement, combo and menu sounds.",
			};
			return {
				name: "settings", buttons: btns,
				enter() { backdrop.bpm = 126; backdrop.intensity = 0.5; backdrop.timeSource = () => audio.menuMusicTime(); audio.menuMusic(true); },
				update() {},
				draw(ctx) {
					backdrop.draw(ctx);
					header(ctx, "SETTINGS", back);
					for (const r of rows) {
						text(ctx, r.label, 26, r.y - 6, 13, "white", "left", 700);
						text(ctx, clipText(ctx, HELP[r.label], 178, 8.5), 26, r.y + 10, 8.5, DIM, "left", 600);
						r.draw(ctx);
					}
					for (const b of btns) if (b !== back && !toggles.includes(b)) b.draw(ctx);
					text(ctx, "Settings and scores live in this browser only.", WIDTH / 2, 600, 9.5, DIMMER, "center", 600);
				},
				down(id, x, y) { uiDown(btns, id, x, y); },
				up(id, x, y) { uiUp(btns, id, x, y); },
				move(x, y) { uiMove(btns, x, y); },
				key(code, pressed) { if (pressed && code === "Escape") back.onPress(); },
			};
		})();

		function setAudioPrefs(musicMuted, sfxMuted) {
			settings.music_muted = !!musicMuted;
			settings.sfx_muted = !!sfxMuted;
			sfxOn = !settings.sfx_muted;
			audio.setVolumes(!settings.music_muted, !settings.sfx_muted);
			save();
		}
		sfxOn = !settings.sfx_muted;

		// ---------------------------------------------------------- api ---
		const game = {
			WIDTH, HEIGHT, Judge, settings,
			on(name, fn) { (listeners[name] = listeners[name] || []).push(fn); return game; },
			setTracks(list) { tracks = list.slice(); },
			get tracks() { return tracks; },
			get screen() { return screen ? screen.name : ""; },
			get current() { return current; },
			get lastResult() { return lastResult; },
			get play() { return play; },
			get select() { return select; },
			goto(name) { goto({ menu, select, play, results, scores, settings: settingsScreen }[name]); },
			update(dt) {
				dt = Math.min(dt, 0.1);
				backdrop.update(dt);
				if (screen) screen.update(dt);
			},
			draw() {
				if (!screen) return;
				ctx.save();
				ctx.textBaseline = "middle";
				screen.draw(ctx);
				ctx.restore();
			},
			pointerDown(id, x, y) { audio.unlock(); if (screen) screen.down(id, x, y); },
			pointerUp(id, x, y) { if (screen) screen.up(id, x, y); },
			pointerMove(x, y, id) { if (screen && screen.move) screen.move(x, y, id); },
			wheel(dy) { if (screen && screen.wheel) screen.wheel(dy); },
			key(code, pressed) { if (pressed) audio.unlock(); if (screen) screen.key(code, pressed); },
			blur() { if (screen && screen.blur) screen.blur(); },
			// the page's toggles under the frame
			setAudio(musicOn, soundOn) { setAudioPrefs(!musicOn, !soundOn); },
			buttons() { return screen ? screen.buttons : []; },
			// find a button on the current screen by its id or label, for tests
			button(id) { return (screen ? screen.buttons : []).find((b) => b.id === id || b.label === id) || null; },
			formatScore,
		};
		goto(menu);
		return game;
	}

	// ============================================================ browser ==
	function mount(canvas, opts) {
		opts = opts || {};
		const base = opts.base || "";
		let storage = null;
		try { storage = window.localStorage; storage.getItem("x"); } catch (e) { storage = null; }
		const charts = {};
		const loadChart = (track) => {
			if (!charts[track.id]) charts[track.id] = fetch(base + "tracks/" + track.id + ".json").then((r) => {
				if (!r.ok) throw new Error("HTTP " + r.status);
				return r.json();
			});
			return charts[track.id];
		};
		const game = create(canvas, { audio: opts.audio, storage: storage || undefined, loadChart, tracks: [] });
		fetch(base + "tracks/manifest.json").then((r) => r.json()).then((m) => { game.setTracks(m.tracks || []); }).catch(() => {});

		const ctx = canvas.getContext("2d");
		let scale = 1;
		function fit() {
			const dpr = window.devicePixelRatio || 1;
			const cssW = canvas.clientWidth || WIDTH;
			scale = cssW / WIDTH;
			const pw = Math.round(WIDTH * scale * dpr), ph = Math.round(HEIGHT * scale * dpr);
			if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
		}
		function toLocal(e) {
			const r = canvas.getBoundingClientRect();
			return [(e.clientX - r.left) / r.width * WIDTH, (e.clientY - r.top) / r.height * HEIGHT];
		}
		canvas.addEventListener("pointerdown", (e) => {
			e.preventDefault();
			canvas.focus({ preventScroll: true });
			try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
			const p = toLocal(e);
			game.pointerDown(e.pointerId, p[0], p[1]);
		});
		canvas.addEventListener("pointermove", (e) => { const p = toLocal(e); game.pointerMove(p[0], p[1], e.buttons ? e.pointerId : undefined); });
		const up = (e) => { const p = toLocal(e); game.pointerUp(e.pointerId, p[0], p[1]); };
		canvas.addEventListener("pointerup", up);
		canvas.addEventListener("pointercancel", up);
		canvas.addEventListener("contextmenu", (e) => e.preventDefault());
		canvas.addEventListener("wheel", (e) => { if (game.screen === "scores") { e.preventDefault(); game.wheel(e.deltaY); } }, { passive: false });
		const GAME_KEYS = ["KeyD", "KeyF", "KeyJ", "KeyK", "ArrowLeft", "ArrowDown", "ArrowUp", "ArrowRight", "Space", "Enter", "Escape", "KeyP", "KeyR"];
		canvas.addEventListener("keydown", (e) => {
			if (e.repeat) { if (GAME_KEYS.includes(e.code)) e.preventDefault(); return; }
			if (GAME_KEYS.includes(e.code)) { e.preventDefault(); game.key(e.code, true); }
		});
		canvas.addEventListener("keyup", (e) => { if (GAME_KEYS.includes(e.code)) { e.preventDefault(); game.key(e.code, false); } });
		window.addEventListener("blur", () => game.blur());
		document.addEventListener("visibilitychange", () => { if (document.hidden) game.blur(); });

		let last = performance.now();
		function frame(now) {
			const dt = (now - last) / 1000;
			last = now;
			fit();
			game.update(dt);
			ctx.setTransform(canvas.width / WIDTH, 0, 0, canvas.height / HEIGHT, 0, 0);
			game.draw();
			requestAnimationFrame(frame);
		}
		requestAnimationFrame(frame);
		return game;
	}

	return { WIDTH, HEIGHT, Judge, create, mount, formatScore };
});
