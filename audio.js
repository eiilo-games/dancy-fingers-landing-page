/* Dancy Fingers, browser edition: the Web Audio layer.
 *
 * game.js never touches audio itself. It calls the adapter created here:
 *
 *   unlock()                   first user gesture: create / resume the context
 *   setVolumes(music, sound)   the two switches (booleans)
 *   loadTrack(track)           fetch + decode a song; resolves when playable
 *   play(track, offset)        start the song `offset` seconds in
 *   pause() / resume() / stop()
 *   fadeOut(seconds)           duck the song (a survival fail)
 *   position()                 seconds into the song, latency-corrected
 *   playing()                  true while the clock above can be trusted
 *   preview(track, offset)     song-select preview, fades in; the menu loop
 *                              fades out and returns once the preview ends
 *   stopPreview()
 *   menuMusic(on, fast)        the looping menu track
 *   menuMusicTime()            seconds into the loop, or null
 *   sfx(name, db)              one of the clips in sfx/
 *
 * Songs ship as OGG Vorbis with an AAC (.m4a) copy for Safari, which cannot
 * decode Vorbis. Every sound effect is a small WAV, decodable everywhere.
 */
(function (root) {
	"use strict";

	const SFX = ["tap", "perfect", "miss", "menu", "click", "combo", "fanfare"];
	const SFX_VOLUME = 0.8;          // Settings.sfx_volume default
	const MENU_DB = -7, PREVIEW_DB = -6;
	const MENU_LOOP_BPM = 126;
	const db = (v) => Math.pow(10, v / 20);

	function create(opts) {
		opts = opts || {};
		const base = opts.base || "";
		const AC = root.AudioContext || root.webkitAudioContext;
		let ctx = null, musicGain = null, sfxGain = null;
		let musicOn = true, soundOn = true;
		const raw = {};       // url -> Promise<ArrayBuffer>
		const buffers = {};   // url -> Promise<AudioBuffer>

		const oggOk = (function () {
			try { return !!document.createElement("audio").canPlayType('audio/ogg; codecs="vorbis"'); } catch (e) { return false; }
		})();
		const songUrl = (track, forceM4a) => base + "tracks/" + track.id + (oggOk && !forceM4a ? ".ogg" : ".m4a");
		const menuUrl = (forceM4a) => base + "music/menu_loop" + (oggOk && !forceM4a ? ".ogg" : ".m4a");

		function ensureCtx() {
			if (ctx || !AC) return ctx;
			ctx = new AC({ latencyHint: "interactive" });
			musicGain = ctx.createGain(); musicGain.connect(ctx.destination);
			sfxGain = ctx.createGain(); sfxGain.connect(ctx.destination);
			applyVolumes();
			return ctx;
		}
		function applyVolumes() {
			if (!ctx) return;
			musicGain.gain.value = musicOn ? 1 : 0;
			sfxGain.gain.value = soundOn ? SFX_VOLUME : 0;
		}
		function fetchRaw(url) {
			if (!raw[url]) raw[url] = fetch(url).then((r) => {
				if (!r.ok) throw new Error("HTTP " + r.status + " for " + url);
				return r.arrayBuffer();
			});
			return raw[url];
		}
		function decode(url) {
			if (!buffers[url]) {
				buffers[url] = fetchRaw(url).then((ab) => {
					const c = ensureCtx();
					if (!c) throw new Error("Web Audio is not available");
					return new Promise((res, rej) => {
						// Safari's decodeAudioData is callback-only
						const p = c.decodeAudioData(ab.slice(0), res, rej);
						if (p && p.then) p.then(res, rej);
					});
				});
				buffers[url].catch(() => { delete buffers[url]; });
			}
			return buffers[url];
		}
		// the song: try the preferred container, fall back to AAC
		function loadSong(track) {
			return decode(songUrl(track)).catch((err) => {
				if (!oggOk) throw err;
				return decode(songUrl(track, true));
			});
		}
		function loadMenu() {
			return decode(menuUrl()).catch((err) => { if (!oggOk) throw err; return decode(menuUrl(true)); });
		}
		// warm the effects up front; they decode once a context exists
		SFX.forEach((n) => fetchRaw(base + "sfx/" + n + ".wav").catch(() => {}));

		const latency = () => (ctx ? (ctx.outputLatency || ctx.baseLatency || 0) : 0);

		// ------------------------------------------------------- the song ---
		let song = null;   // { source, gain, startAt (ctx time at offset 0), buffer, stopped }
		let songPausedAt = null, songBuffer = null, songTrack = null;
		function startSource(buffer, offset, gainNode, loop) {
			const src = ctx.createBufferSource();
			src.buffer = buffer;
			src.loop = !!loop;
			src.connect(gainNode);
			src.start(0, Math.max(0, offset));
			return src;
		}
		function killSong() {
			if (!song) return;
			song.stopped = true;
			try { song.source.stop(); } catch (e) { /* already stopped */ }
			song.source.disconnect();
			song.gain.disconnect();
			song = null;
		}
		function playFrom(offset) {
			if (!ctx || !songBuffer) return;
			killSong();
			const g = ctx.createGain();
			g.connect(musicGain);
			const src = startSource(songBuffer, offset, g, false);
			const entry = { source: src, gain: g, startAt: ctx.currentTime - offset, stopped: false };
			src.onended = () => { if (!entry.stopped) entry.ended = true; };
			song = entry;
			songPausedAt = null;
		}

		// ---------------------------------------------------- the preview ---
		let preview = null, previewSeq = 0;
		function stopPreview(fadeSec) {
			previewSeq++;
			if (!preview) return;
			const p = preview; preview = null;
			const now = ctx.currentTime;
			p.gain.gain.cancelScheduledValues(now);
			p.gain.gain.setValueAtTime(p.gain.gain.value, now);
			p.gain.gain.linearRampToValueAtTime(0.0001, now + (fadeSec || 0.25));
			try { p.source.stop(now + (fadeSec || 0.25) + 0.05); } catch (e) { /* ignore */ }
		}

		// ------------------------------------------------------- the menu ---
		let menu = null, menuWanted = false, menuBuffer = null;
		function menuStart() {
			if (!ctx || !menuBuffer || menu) return;
			const g = ctx.createGain();
			g.connect(musicGain);
			g.gain.value = db(-30);
			g.gain.linearRampToValueAtTime(db(MENU_DB), ctx.currentTime + 0.8);
			const src = startSource(menuBuffer, 0, g, true);
			menu = { source: src, gain: g, startAt: ctx.currentTime };
		}
		function menuStop(fast) {
			if (!menu) return;
			const m = menu; menu = null;
			const now = ctx.currentTime, dur = fast ? 0.12 : 0.6;
			m.gain.gain.cancelScheduledValues(now);
			m.gain.gain.setValueAtTime(m.gain.gain.value, now);
			m.gain.gain.linearRampToValueAtTime(0.0001, now + dur);
			try { m.source.stop(now + dur + 0.05); } catch (e) { /* ignore */ }
		}

		const adapter = {
			get context() { return ctx; },
			unlock() {
				const c = ensureCtx();
				if (c && c.state === "suspended") c.resume().catch(() => {});
				if (c && menuWanted && !menu) loadMenu().then((b) => { menuBuffer = b; if (menuWanted) menuStart(); }).catch(() => {});
			},
			setVolumes(m, s) { musicOn = !!m; soundOn = !!s; applyVolumes(); },
			loadTrack(track) {
				return loadSong(track).then((b) => { songBuffer = b; songTrack = track; });
			},
			play(track, offset) {
				if (!ctx) return;
				if (songTrack !== track || !songBuffer) return;
				playFrom(offset || 0);
			},
			pause() {
				if (!song) return;
				songPausedAt = adapter.position();
				killSong();
			},
			resume() {
				if (songPausedAt === null || !songBuffer) return;
				playFrom(songPausedAt);
			},
			stop() { killSong(); songPausedAt = null; },
			fadeOut(sec) {
				if (!song) return;
				const now = ctx.currentTime;
				song.gain.gain.setValueAtTime(song.gain.gain.value, now);
				song.gain.gain.linearRampToValueAtTime(db(-30), now + (sec || 1));
			},
			position() {
				if (!song) return songPausedAt;
				return ctx.currentTime - song.startAt - latency();
			},
			playing() { return !!song && !song.ended && ctx.state === "running"; },
			preview(track, offset) {
				if (!ctx) ensureCtx();
				if (!ctx) return;
				stopPreview(0.25);
				const seq = ++previewSeq;
				loadSong(track).then((b) => {
					if (seq !== previewSeq || !ctx) return;
					// like song_select.gd: the menu loop makes way for the preview
					menuStop(false);
					const g = ctx.createGain();
					g.connect(musicGain);
					g.gain.value = 0.0001;
					g.gain.linearRampToValueAtTime(db(PREVIEW_DB), ctx.currentTime + 0.6);
					const src = startSource(b, offset || 0, g, false);
					preview = { source: src, gain: g };
					src.onended = () => {
						if (!preview || preview.source !== src) return;   // replaced or stopped
						preview = null;
						g.disconnect();
						if (menuWanted && !menu && menuBuffer) menuStart();   // ...and comes back after
					};
				}).catch(() => {});
			},
			stopPreview() { stopPreview(0.25); },
			menuMusic(on, fast) {
				menuWanted = !!on;
				if (!on) { menuStop(fast); return; }
				if (!ctx) return;   // starts on unlock()
				if (menu) return;
				if (menuBuffer) menuStart();
				else loadMenu().then((b) => { menuBuffer = b; if (menuWanted && !menu) menuStart(); }).catch(() => {});
			},
			menuMusicTime() {
				if (!menu || !ctx || ctx.state !== "running") return null;
				return (ctx.currentTime - menu.startAt - latency()) % menuBuffer.duration;
			},
			sfx(name, gainDb) {
				if (!ctx || !soundOn || ctx.state !== "running") return;
				decode(base + "sfx/" + name + ".wav").then((b) => {
					if (!ctx) return;
					const g = ctx.createGain();
					g.gain.value = db(gainDb || 0);
					g.connect(sfxGain);
					const src = ctx.createBufferSource();
					src.buffer = b; src.connect(g); src.start();
					src.onended = () => { src.disconnect(); g.disconnect(); };
				}).catch(() => {});
			},
			MENU_LOOP_BPM,
		};
		return adapter;
	}

	root.DancyAudio = { create };
})(typeof self !== "undefined" ? self : this);
