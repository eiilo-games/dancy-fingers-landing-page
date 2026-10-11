// Headless soak test for the browser port: runs the real game on a stub
// canvas with a silent audio adapter and steps it deterministically, the
// way tests/test_runner.gd does for the Godot scene. It walks every screen,
// plays a perfect run and a silent run through each of the shipped charts,
// pauses and resumes, and checks scoring, grades, health and persistence.
// `node web/test/soak.js [easy|normal|hard|all]`
"use strict";
const fs = require("fs");
const path = require("path");
const DF = require("../game.js");

const here = path.join(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(here, "tracks", "manifest.json"), "utf8"));
const arg = process.argv[2] || "all";
const DIFFS = arg === "all" ? ["easy", "normal", "hard"] : [arg];

// ------------------------------------------------------------- stubs -----
const calls = { fillText: 0, fill: 0, stroke: 0, fillRect: 0 };
function stubCanvas(w, h) {
	const ctx = new Proxy({}, {
		get: (_, k) => {
			if (k === "measureText") return (s) => ({ width: String(s).length * 7 });
			if (k === "createLinearGradient") return () => ({ addColorStop() {} });
			if (typeof k !== "string") return undefined;
			return function () { if (k in calls) calls[k]++; };
		},
		set: () => true,
	});
	return { width: w, height: h, getContext: () => ctx };
}
const store = {};
const storage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } };
const audioLog = {};
const audio = new Proxy({}, {
	get: (_, k) => function () {
		audioLog[k] = (audioLog[k] || 0) + 1;
		if (k === "loadTrack") return Promise.resolve();
		if (k === "position" || k === "menuMusicTime") return null;
		if (k === "playing") return false;
	},
});
const loadChart = (track) => Promise.resolve(JSON.parse(fs.readFileSync(path.join(here, "tracks", track.id + ".json"), "utf8")));

// ------------------------------------------------------------- harness ---
let failures = 0;
function check(cond, msg) {
	if (cond) return;
	failures++;
	console.log("FAIL: " + msg);
}
const DT = 1 / 120;
let frames = 0;
function step(game, seconds) {
	const n = Math.round(seconds / DT);
	for (let i = 0; i < n; i++) {
		game.update(DT);
		if (frames++ % 7 === 0) game.draw();
	}
}
const yieldNow = () => new Promise((r) => setImmediate(r));
async function untilState(game, state, timeoutSec) {
	let waited = 0;
	while (game.play.state !== state && waited < timeoutSec) {
		await yieldNow();
		step(game, DT);
		waited += DT;
	}
	check(game.play.state === state, "expected play state " + state + ", got " + game.play.state);
}
function press(game, id) {
	const b = game.button(id);
	check(b, "button " + id + " exists on " + game.screen);
	if (!b) return;
	check(!b.disabled, "button " + id + " enabled");
	const x = b.x + b.w / 2, y = b.y + b.h / 2;
	game.pointerDown(1, x, y);
	game.pointerMove(x, y, 1);
	game.pointerUp(1, x, y);
}

// Drives a run to completion. `perfect` taps every note dead on; otherwise
// it never touches the lanes.
async function playRun(game, perfect) {
	await untilState(game, "countdown", 5);
	const g = game.play.run;
	const notes = g.notes;
	check(notes.length > 0, "chart has notes");
	const releaseAt = [Infinity, Infinity, Infinity, Infinity];
	let i = 0;
	let guard = 0;
	while (game.screen === "play" && guard++ < 200000) {
		const t = game.play.gameTime();
		if (perfect && (game.play.state === "playing" || game.play.state === "countdown")) {
			while (i < notes.length && notes[i].time <= t + 0.001) {
				const n = notes[i++];
				game.play.pressLane(n.lane);
				releaseAt[n.lane] = n.hold > 0 ? n.time + n.hold + 0.05 : t + 0.05;
			}
			for (let l = 0; l < 4; l++) if (t >= releaseAt[l]) { game.play.releaseLane(l); releaseAt[l] = Infinity; }
		}
		step(game, DT);
	}
	check(game.screen === "results", "run ended on the results screen (got " + game.screen + ")");
	return game.lastResult;
}

async function main() {
	const canvas = stubCanvas(DF.WIDTH, DF.HEIGHT);
	const game = DF.create(canvas, { audio, storage, loadChart, tracks: manifest.tracks });
	check(game.screen === "menu", "starts on the menu");
	step(game, 1);
	check(audioLog.menuMusic > 0, "menu asks for the menu music");

	// settings screen: every control responds
	press(game, "SETTINGS");
	check(game.screen === "settings", "SETTINGS opens the settings screen");
	step(game, 0.2);
	const speed0 = game.settings.note_speed;
	press(game, "Note speed+");
	check(game.settings.note_speed === speed0 + 1, "note speed + steps up");
	press(game, "Note speed-");
	check(game.settings.note_speed === speed0, "note speed - steps back");
	press(game, "Audio offset+");
	check(game.settings.audio_offset_ms === 5, "audio offset steps by 5 ms");
	press(game, "Audio offset-");
	press(game, "survival");
	check(game.settings.fail_enabled === false, "survival toggle switches off");
	press(game, "survival");
	check(game.settings.fail_enabled === true, "survival toggle switches back on");
	press(game, "music");
	check(game.settings.music_muted === true, "music toggle mutes");
	check(store["dancyfingers.save"] && JSON.parse(store["dancyfingers.save"]).music_muted === true, "settings persist to storage");
	game.setAudio(true, true);
	check(game.settings.music_muted === false, "setAudio() from the page unmutes");
	press(game, "reset");
	press(game, "back");
	check(game.screen === "menu", "back returns to the menu");

	// high scores, empty
	press(game, "HIGH SCORES");
	check(game.screen === "scores", "HIGH SCORES opens the list");
	step(game, 0.2);
	game.wheel(100);
	press(game, "back");

	// song list
	press(game, "PLAY");
	check(game.screen === "select", "PLAY opens the song list");
	check(game.button("play").disabled, "PLAY on the list is disabled until a song is chosen");
	step(game, 0.2);
	game.key("ArrowDown", true); game.key("ArrowDown", false);
	check(game.current && game.current.id === manifest.tracks[0].id, "arrow keys pick a song");
	check(audioLog.preview > 0, "choosing a song starts its preview");

	const summary = [];
	for (const diff of DIFFS) {
		for (const track of manifest.tracks) {
			// pick the difficulty and the song through the real buttons
			if (game.screen !== "select") { game.goto("select"); step(game, 0.1); }
			press(game, "diff-" + diff);
			check(game.settings.difficulty === diff, "difficulty button sets " + diff);
			game.select.choose(track.id, false);
			game.settings.fail_enabled = true;
			press(game, "play");
			check(game.screen === "play", "PLAY starts the song");

			// perfect run, with a pause in the middle
			await untilState(game, "countdown", 5);
			const notes = game.play.run.notes;
			const units = notes.reduce((s, n) => s + (n.hold > 0 ? 2 : 1), 0);
			const holds = notes.filter((n) => n.hold > 0).length;
			// pause during the countdown is ignored; pause while playing works
			step(game, 3.0);
			check(game.play.state === "playing", "song is playing after the lead-in");
			game.key("Escape", true); game.key("Escape", false);
			check(game.play.state === "paused", "Escape pauses");
			step(game, 0.5);
			press(game, "RESUME");
			check(game.play.state === "countdown", "RESUME starts the resume countdown");
			step(game, 1.6);
			check(game.play.state === "playing", "resume countdown returns to playing");
			// the notes that passed while we sat in the countdown are misses;
			// restart for a clean perfect run
			press(game, "pause");
			check(game.play.state === "paused", "pause button pauses");
			press(game, "RESTART");
			const r = await playRun(game, true);
			check(r && !r.failed, "perfect run clears " + track.id + " " + diff);
			check(r && r.score === DF.Judge.MAX_SCORE, "perfect run scores 1,000,000 on " + track.id + " " + diff + " (got " + (r && r.score) + ")");
			check(r && r.grade === "SSS" && r.full_combo, "perfect run is an SSS full combo on " + track.id + " " + diff);
			check(r && r.perfect === notes.length && r.miss === 0 && r.hold_break === 0, "every note judged perfect on " + track.id + " " + diff + " (" + (r && r.perfect) + "/" + notes.length + ", miss " + (r && r.miss) + ")");
			check(r && r.hold_ok === holds, "every hold kept on " + track.id + " " + diff + " (" + (r && r.hold_ok) + "/" + holds + ")");
			check(r && r.max_combo === units, "max combo equals the unit count on " + track.id + " " + diff);
			check(r && r.new_best, "first clear is a new best");
			summary.push(track.id + " " + diff + ": " + notes.length + " notes, " + holds + " holds, perfect " + (r ? r.score : "-"));
			step(game, 0.3);

			// silent run in survival: must fail before the end
			press(game, "RETRY");
			check(game.screen === "play", "RETRY restarts the song");
			const f = await playRun(game, false);
			check(f && f.failed && f.grade === "F", "silent survival run fails " + track.id + " " + diff);
			check(f && !f.new_best, "a failed run never becomes a best");
			step(game, 0.3);
		}
	}

	// silent run with survival off: reaches the end with a D and zero points
	game.goto("select"); step(game, 0.1);
	press(game, "diff-easy");
	game.select.choose(manifest.tracks[0].id, false);
	game.settings.fail_enabled = false;
	press(game, "play");
	const d = await playRun(game, false);
	check(d && !d.failed && d.grade === "D" && d.score === 0 && d.accuracy === 0, "silent normal-mode run ends with a D and 0 points");
	check(d && d.miss > 0 && d.max_combo === 0, "silent run records misses and no combo");
	step(game, 0.3);
	press(game, "SONG LIST");
	check(game.screen === "select", "SONG LIST leaves the results");
	press(game, "back");
	check(game.screen === "menu", "back from the list reaches the menu");

	// bests persisted and shown
	const saved = JSON.parse(store["dancyfingers.save"]);
	const keys = Object.keys(saved.best);
	check(keys.length === DIFFS.length * manifest.tracks.length + 1, "one best per chart persisted, plus the normal-mode one (" + keys.length + ")");
	check(keys.every((k) => k.split("|").length === 3), "best keys use the app's id|difficulty|mode format");
	check(saved.best[manifest.tracks[0].id + "|easy|normal"] && saved.best[manifest.tracks[0].id + "|easy|survival"], "survival and normal-mode bests are kept apart");
	press(game, "HIGH SCORES");
	step(game, 0.3);
	game.wheel(300); game.wheel(-300);
	game.pointerDown(2, 180, 400); game.pointerMove(180, 300, 2); game.pointerUp(2, 180, 300);
	press(game, "back");

	// a fresh game on the same storage sees the same bests
	const again = DF.create(stubCanvas(DF.WIDTH, DF.HEIGHT), { audio, storage, loadChart, tracks: manifest.tracks });
	check(Object.keys(again.settings.best).length === keys.length, "bests survive a reload");

	// judge table sanity, straight from judge.gd
	const J = DF.Judge;
	check(J.classify(0.045) === "perfect" && J.classify(-0.046) === "great" && J.classify(0.09) === "great" && J.classify(0.091) === "good" && J.classify(0.15) === "good" && J.classify(0.151) === "", "timing windows");
	check(J.gradeFor(0.99, false) === "SSS" && J.gradeFor(0.9899, false) === "SS" && J.gradeFor(0.97, false) === "SS" && J.gradeFor(0.94, false) === "S" && J.gradeFor(0.88, false) === "A" && J.gradeFor(0.8, false) === "B" && J.gradeFor(0.7, false) === "C" && J.gradeFor(0.69, false) === "D" && J.gradeFor(1, true) === "F", "grade thresholds");
	check(J.scoreFor(0.75, 1) === 750000 && J.scoreFor(1, 0) === 0, "score formula");
	check(DF.formatScore(1000000) === "1,000,000" && DF.formatScore(999) === "999", "score formatting");

	console.log(summary.join("\n"));
	console.log("frames " + frames + ", draw calls: " + JSON.stringify(calls) + ", audio calls: " + JSON.stringify(audioLog));
	console.log(failures === 0 ? "OK" : failures + " failure(s)");
	process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
