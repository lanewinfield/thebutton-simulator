// Local shim so the original reddit.js + thebutton.css run without a live server.
// Replaces window.WebSocket BEFORE reddit-init.js / reddit.js execute, so
// r.WebSocket._connect()'s `new WebSocket(url)` gets our fake.
//
// Also stubs google.visualization in case https://www.google.com/jsapi fails
// to load the charts module (Google deprecated that loader).

(function () {
  var START_SECONDS = 60;
  var FAKE_PARTICIPANTS = 0;

  function pad(n, w) { var s = String(n); while (s.length < w) s = "0" + s; return s; }

  function nowStr() {
    // mimic the reddit "now_str" format: ISO-ish UTC
    var d = new Date();
    return d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1, 2) + "-" + pad(d.getUTCDate(), 2)
      + "T" + pad(d.getUTCHours(), 2) + ":" + pad(d.getUTCMinutes(), 2) + ":" + pad(d.getUTCSeconds(), 2);
  }

  // Track timer state across reconnects / button presses.
  // Starts at 60 (just-pressed) — historical playback fires the first press
  // immediately on data load.
  var state = {
    secondsLeft: START_SECONDS,
    lastSyncAt: Date.now(),
    participants: FAKE_PARTICIPANTS,
  };

  function currentSecondsLeft() {
    var elapsed = (Date.now() - state.lastSyncAt) / 1000;
    var s = state.secondsLeft - elapsed;
    if (s < 0) s = 0;
    return s;
  }

  // Expose a small API for recording controls
  window.thebuttonLocal = {
    press: function () {
      state.secondsLeft = START_SECONDS;
      state.lastSyncAt = Date.now();
      state.participants += 1;
      // immediately push a fresh tick to all open fake-sockets
      FakeSocket._broadcastTicking();
    },
    setSeconds: function (s) {
      state.secondsLeft = Math.max(0, Math.min(START_SECONDS, s));
      state.lastSyncAt = Date.now();
      FakeSocket._broadcastTicking();
    },
    expire: function () {
      state.secondsLeft = 0;
      state.lastSyncAt = Date.now();
      FakeSocket._broadcastJustExpired();
    },
    state: state,
  };

  var openSockets = [];

  function FakeSocket(url) {
    this.url = url;
    this.readyState = 0; // CONNECTING
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    var self = this;
    setTimeout(function () {
      self.readyState = 1;
      openSockets.push(self);
      if (typeof self.onopen === "function") self.onopen({});
      // Single sync on connect — the original reddit.js will run a smooth local
      // 10ms-interval countdown from this point. We only push more "ticking"
      // messages on state changes (press / setSeconds / expire). Re-syncing
      // every second causes visible jumps because setInterval drifts vs. wall
      // clock.
      self._sendTicking();
    }, 50);
  }
  FakeSocket.CONNECTING = 0;
  FakeSocket.OPEN = 1;
  FakeSocket.CLOSING = 2;
  FakeSocket.CLOSED = 3;
  FakeSocket.prototype.send = function () { /* no-op */ };
  FakeSocket.prototype.close = function () {
    this.readyState = 3;
    var i = openSockets.indexOf(this);
    if (i >= 0) openSockets.splice(i, 1);
    if (typeof this.onclose === "function") this.onclose({ wasClean: true });
  };
  FakeSocket.prototype._sendTicking = function () {
    if (this.readyState !== 1 || typeof this.onmessage !== "function") return;
    // Round to nearest 10ms so reddit.js's pie-redraw guard (e%100===0) eventually
    // matches as the local interval decrements _msLeft by 10. Without rounding,
    // a fractional seconds_left makes _msLeft a non-multiple-of-100 forever and
    // the pie never draws.
    var s = Math.round(currentSecondsLeft() * 100) / 100;
    var payload = {
      seconds_left: s,
      now_str: nowStr(),
      tick_mac: "local",
      participants_text: state.participants.toLocaleString(),
    };
    this.onmessage({ data: JSON.stringify({ type: "ticking", payload: payload }) });
  };
  FakeSocket.prototype._sendJustExpired = function () {
    if (this.readyState !== 1 || typeof this.onmessage !== "function") return;
    this.onmessage({ data: JSON.stringify({ type: "just_expired", payload: { seconds_elapsed: 0 } }) });
  };
  FakeSocket._broadcastTicking = function () {
    for (var i = 0; i < openSockets.length; i++) openSockets[i]._sendTicking();
  };
  FakeSocket._broadcastJustExpired = function () {
    for (var i = 0; i < openSockets.length; i++) openSockets[i]._sendJustExpired();
  };

  // Replace global WebSocket
  window.WebSocket = FakeSocket;

  // Real implementation of google.visualization.PieChart (just enough for thebutton)
  // Matches reddit.js: arrayToDataTable([["",""],["gone",elapsed],["remaining",left]])
  // and draw(data, { slices: {0:{color:"#C8C8C8"}, 1:{color:"#4A4A4A"}} })
  function ensureGoogleStub() {
    if (window.google && window.google.visualization && window.google.visualization.PieChart && window.google.visualization.PieChart.__local) return;

    function arrayToDataTable(arr) {
      // arr = [header, [label, value], [label, value]]
      return {
        rows: arr.slice(1).map(function (r) { return { label: r[0], value: r[1] }; })
      };
    }

    function PieChart(container) {
      this.container = container;
      // Build SVG once
      var svgNS = "http://www.w3.org/2000/svg";
      var svg = document.createElementNS(svgNS, "svg");
      svg.setAttribute("width", "70");
      svg.setAttribute("height", "70");
      svg.setAttribute("viewBox", "-1 -1 2 2");
      // Rotate so slices start at 12 o'clock (Google Charts default)
      svg.style.transform = "rotate(-90deg)";
      svg.style.display = "block";
      svg.style.margin = "0 auto";
      this._svg = svg;
      // Two paths
      this._p0 = document.createElementNS(svgNS, "path");
      this._p1 = document.createElementNS(svgNS, "path");
      svg.appendChild(this._p1); // remaining drawn first (background), gone drawn on top
      svg.appendChild(this._p0);
      // Clear any prior content in the container then attach
      while (container.firstChild) container.removeChild(container.firstChild);
      container.appendChild(svg);
    }
    PieChart.__local = true;

    function arcPath(startFrac, endFrac) {
      // Build an SVG arc path from a circle of radius 1 centered at 0,0
      // Fractions are 0..1 of full revolution (0 = 12 o'clock after our -90deg rotate => 3 o'clock pre-rotate)
      // We rotate the SVG by -90deg so 0 is top.
      if (endFrac <= startFrac) return "";
      if (endFrac - startFrac >= 0.999999) {
        // Full circle — draw two arcs
        return "M 1 0 A 1 1 0 1 1 -1 0 A 1 1 0 1 1 1 0 Z";
      }
      var sx = Math.cos(2 * Math.PI * startFrac);
      var sy = Math.sin(2 * Math.PI * startFrac);
      var ex = Math.cos(2 * Math.PI * endFrac);
      var ey = Math.sin(2 * Math.PI * endFrac);
      var largeArc = (endFrac - startFrac) > 0.5 ? 1 : 0;
      return "M 0 0 L " + sx + " " + sy + " A 1 1 0 " + largeArc + " 1 " + ex + " " + ey + " Z";
    }

    PieChart.prototype.draw = function (data, opts) {
      var rows = data.rows || [];
      var total = rows.reduce(function (a, r) { return a + (r.value || 0); }, 0);
      if (total <= 0) total = 1;
      var goneFrac = (rows[0] ? rows[0].value : 0) / total;
      var slices = (opts && opts.slices) || {};
      var c0 = (slices[0] && slices[0].color) || "#C8C8C8";
      var c1 = (slices[1] && slices[1].color) || "#4A4A4A";

      // Path 0: "gone" (light gray) — first slice
      this._p0.setAttribute("d", arcPath(0, goneFrac));
      this._p0.setAttribute("fill", c0);
      // Path 1: "remaining" (dark gray) — second slice
      this._p1.setAttribute("d", arcPath(goneFrac, 1));
      this._p1.setAttribute("fill", c1);
    };

    window.google = window.google || {};
    window.google.visualization = {
      PieChart: PieChart,
      arrayToDataTable: arrayToDataTable,
    };
  }
  // Run once now and again on DOM ready, in case the real charts loader is mid-flight.
  ensureGoogleStub();
  document.addEventListener("DOMContentLoaded", ensureGoogleStub);

  // Hook a global click handler on #thebutton to update local state when the user
  // presses. We do NOT broadcast a ticking message here — reddit.js's own click
  // handler does the visual reset. We just need state.secondsLeft to mirror so
  // the auto-press simulation and future broadcasts see the correct value.
  document.addEventListener("DOMContentLoaded", function () {
    var btn = document.getElementById("thebutton");
    if (!btn) return;
    btn.addEventListener("click", function () {
      if (playback.userPressed || playback.expired) return;
      // Capture the historic timer value at the moment of press — this is the
      // user's "flair". Freeze playback until they reset with B.
      var flairSeconds = state.secondsLeft;
      state.lastSyncAt = Date.now();
      state.participants += 1;
      playback.userPressed = true;
      // After reddit.js's own click handler runs (it calls _setTimer(60000) and
      // clears the local decrement interval), override the displayed value to
      // the user's actual flair so the digits + pie show what they pressed at.
      setTimeout(function () {
        if (window.r && window.r.thebutton && window.r.thebutton._setTimer) {
          var ms = Math.max(0, Math.min(60000, Math.round(flairSeconds * 1000 / 100) * 100));
          window.r.thebutton._msLeft = ms;
          window.r.thebutton._setTimer(ms);
        }
      }, 0);
    }, true);
  });

  // ---- Historical playback ----
  // Loads assets/presses.bin (uint32 LE deltas-in-ms-from-previous-press) and
  // replays the actual /r/thebutton press timeline in real time, scheduling
  // window.thebuttonLocal.press() at each historic press moment.
  //
  // Playback speed is configurable via window.thebuttonLocal.setSpeed(x).
  // Default 1.0x = real time. Scrub or jump with setHistoricMs(ms).
  var playback = {
    deltas: null,           // Uint32Array of ms-deltas
    cumulative: null,       // Float64Array of cumulative ms-since-start (uint32 overflows for 65d)
    totalMs: 0,             // duration of the dataset = cumulative[last]
    cursor: 0,              // index of next press to fire
    nextHistoricMs: 0,      // cumulative ms-since-start of presses[cursor]
    startedAt: 0,           // performance.now() when playback started
    historicOriginMs: 0,    // historic-ms corresponding to startedAt (allows jump)
    speed: 1.0,
    rafId: null,
    meta: null,
    expired: false,         // true once the dataset is exhausted and final timer hit 0
    paused: false,
    userPressed: false,     // true after the user clicks the button — freezes display at their flair
  };

  // Throttle broadcasts/UI updates to ~100Hz max. At very high speeds, the
  // per-frame press loop can fire hundreds of presses per frame, and pushing
  // a ticking message + jQuery DOM updates 60+ times a second on top of that
  // will pin the main thread. We always advance the cursor (so the timeline
  // stays accurate), but only re-render at 100Hz max.
  var lastBroadcastAt = 0;
  var BROADCAST_MIN_MS = 10;

  function tickPlayback() {
    if (!playback.deltas) {
      playback.rafId = requestAnimationFrame(tickPlayback);
      return;
    }
    if (playback.expired) {
      // Halt — user can rewind via scrubber / keys to resume.
      playback.rafId = null;
      return;
    }
    if (playback.userPressed) {
      // The user clicked — freeze everything at their press moment. The B key
      // (resetToPressable) clears this so playback can resume.
      playback.rafId = requestAnimationFrame(tickPlayback);
      return;
    }
    var realNow = performance.now();
    var historicNow;
    if (playback.paused) {
      // historicOriginMs is the snapshot taken at the moment of pause
      historicNow = playback.historicOriginMs;
    } else {
      var realElapsed = realNow - playback.startedAt;
      historicNow = playback.historicOriginMs + realElapsed * playback.speed;
    }
    // Cap so historicNow doesn't run away past the dataset's "expiry" point
    // (last press + 60s).
    var endMs = playback.totalMs + 60000;
    if (historicNow > endMs) historicNow = endMs;
    var n = playback.deltas.length;

    // Advance through historic presses up to historicNow (skipped while paused).
    if (!playback.paused) {
      while (playback.cursor < n && playback.nextHistoricMs <= historicNow) {
        state.participants += 1;
        playback.cursor += 1;
        if (playback.cursor < n) {
          playback.nextHistoricMs += playback.deltas[playback.cursor];
        }
      }
    }

    if (realNow - lastBroadcastAt >= BROADCAST_MIN_MS) {
      lastBroadcastAt = realNow;

      var lastPressHistoricMs = playback.cursor > 0
        ? playback.cumulative[playback.cursor - 1]
        : -Infinity;
      var secondsLeft;
      if (lastPressHistoricMs === -Infinity) {
        secondsLeft = START_SECONDS;
      } else {
        var sinceLastMs = historicNow - lastPressHistoricMs;
        secondsLeft = Math.max(0, START_SECONDS - sinceLastMs / 1000);
      }
      state.secondsLeft = secondsLeft;
      state.lastSyncAt = Date.now();

      var rounded = Math.round(secondsLeft * 100) / 100;
      var participantsText = state.participants.toLocaleString();
      var msg = JSON.stringify({
        type: "ticking",
        payload: {
          seconds_left: rounded,
          now_str: nowStr(),
          tick_mac: "local",
          participants_text: participantsText,
        }
      });
      for (var i = 0; i < openSockets.length; i++) {
        var sock = openSockets[i];
        if (sock.readyState !== 1 || typeof sock.onmessage !== "function") continue;
        sock.onmessage({ data: msg });
      }

      updateSidebarCounts();

      // While paused, kill reddit.js's local 10ms decrement interval. _onTicking
      // above recreates it each broadcast; clearing here keeps the displayed
      // digits frozen at the broadcast value.
      if (playback.paused && window.r && window.r.thebutton && window.r.thebutton._countdownInterval) {
        window.r.thebutton._countdownInterval = clearInterval(window.r.thebutton._countdownInterval);
      }

      // End-of-dataset: trigger the canonical "experiment is over" state once
      // the last historic press has finished its 60-second timer.
      if (playback.cursor >= n && secondsLeft <= 0) {
        playback.expired = true;
        var expMsg = JSON.stringify({ type: "just_expired", payload: { seconds_elapsed: 0 } });
        for (var j = 0; j < openSockets.length; j++) {
          var s2 = openSockets[j];
          if (s2.readyState !== 1 || typeof s2.onmessage !== "function") continue;
          s2.onmessage({ data: expMsg });
        }
        playback.rafId = null;
        return;
      }
    }

    playback.rafId = requestAnimationFrame(tickPlayback);
  }

  // Find the largest index i such that cumulative[i] <= targetMs. Returns -1 if none.
  function findPressIndexAt(targetMs) {
    var cum = playback.cumulative;
    if (!cum || cum.length === 0) return -1;
    var lo = 0, hi = cum.length - 1, result = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >>> 1;
      if (cum[mid] <= targetMs) { result = mid; lo = mid + 1; }
      else { hi = mid - 1; }
    }
    return result;
  }

  function jumpToHistoricMs(historicMs) {
    if (!playback.cumulative) return;
    historicMs = Math.max(0, Math.min(historicMs, playback.totalMs));

    var lastFired = findPressIndexAt(historicMs);
    var cum = playback.cumulative;

    if (lastFired >= 0) {
      state.participants = lastFired + 1;
      var sinceLast = historicMs - cum[lastFired];
      state.secondsLeft = Math.max(0, START_SECONDS - sinceLast / 1000);
    } else {
      state.participants = 0;
      state.secondsLeft = START_SECONDS;
    }
    state.lastSyncAt = Date.now();

    playback.cursor = lastFired + 1;
    playback.nextHistoricMs = playback.cursor < cum.length ? cum[playback.cursor] : Infinity;
    playback.startedAt = performance.now();
    playback.historicOriginMs = historicMs;

    // Coming back from the expired end-state? Clear it and restore active classes.
    if (playback.expired || (state.secondsLeft > 0 && document.querySelector(".thebutton-wrap.complete"))) {
      playback.expired = false;
      resetToPressableSilent();
    }

    FakeSocket._broadcastTicking();

    if (playback.rafId) cancelAnimationFrame(playback.rafId);
    playback.rafId = requestAnimationFrame(tickPlayback);
  }

  // Restores active classes without showing the "button reset" toast
  // (used when scrubbing back from the expired end-state).
  function resetToPressableSilent() {
    var btn = document.getElementById("thebutton");
    if (!btn) return;
    var container = btn.parentElement;
    var wrap = document.querySelector(".thebutton-wrap");
    if (wrap) { wrap.classList.remove("complete"); wrap.classList.add("active"); }
    if (container) {
      container.classList.remove("denied", "has-expired", "pressed", "unlocked", "unlocking",
                                  "logged-out", "too-new", "not-active", "login-required");
      container.classList.add("active", "locked");
    }
    if (window.r && window.r.thebutton) window.r.thebutton._started = false;
    playback.userPressed = false;
  }

  function jumpToFraction(f) {
    // f=0 → start; f=1 → 1 minute before the end of the dataset.
    if (!playback.cumulative) return;
    var target = f * Math.max(0, playback.totalMs - 60000);
    jumpToHistoricMs(target);
  }

  // Expose playback controls
  window.thebuttonLocal.setSpeed = function (x) {
    if (!playback.deltas) { playback.speed = x; return; }
    var realElapsed = performance.now() - playback.startedAt;
    var historicNow = playback.historicOriginMs + realElapsed * playback.speed;
    playback.startedAt = performance.now();
    playback.historicOriginMs = historicNow;
    playback.speed = x;
  };
  window.thebuttonLocal.jumpToHistoricMs = jumpToHistoricMs;
  window.thebuttonLocal.jumpToFraction = jumpToFraction;
  window.thebuttonLocal.playback = playback;

  function parseIsoToEpochMs(iso) {
    // "2015-04-01T16:10:04.468000" — assume UTC, trim microseconds to ms
    var m = iso.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d+)?$/);
    if (!m) return Date.parse(iso);
    var ms = m[2] ? "." + m[2].slice(1, 4) : "";
    return Date.parse(m[1] + ms + "Z");
  }

  function currentHistoricMs() {
    if (!playback.deltas) return 0;
    var ms = playback.paused
      ? playback.historicOriginMs
      : playback.historicOriginMs + (performance.now() - playback.startedAt) * playback.speed;
    if (playback.totalMs > 0) ms = Math.min(ms, playback.totalMs);
    return Math.max(0, ms);
  }

  function formatHistoricTime(historicMs) {
    if (!playback.startMsAbs) return "";
    var d = new Date(playback.startMsAbs + historicMs);
    return d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1, 2) + "-" + pad(d.getUTCDate(), 2)
      + " " + pad(d.getUTCHours(), 2) + ":" + pad(d.getUTCMinutes(), 2) + ":" + pad(d.getUTCSeconds(), 2)
      + " UTC";
  }

  window.thebuttonLocal.currentHistoricMs = currentHistoricMs;
  window.thebuttonLocal.formatHistoricTime = formatHistoricTime;

  // Per-tier cumulative count arrays. Built from flairs.bin.
  // tier values: 1..6 = press-1..press-6, 7 = no-press, 8 = cheater (cant-press), 0 = unknown
  var TIER_CLASS = {
    1: "flair-press-1", 2: "flair-press-2", 3: "flair-press-3",
    4: "flair-press-4", 5: "flair-press-5", 6: "flair-press-6",
    7: "flair-no-press", 8: "flair-cant-press",
  };
  var tierCumulative = null;       // Object<className, Uint32Array of length n>
  var sidebarSpans = null;         // Object<className, HTMLSpanElement>

  function buildTierCumulatives(flairs) {
    tierCumulative = {};
    var n = flairs.length;
    for (var t = 1; t <= 8; t++) tierCumulative[TIER_CLASS[t]] = new Uint32Array(n);
    var counts = [0, 0, 0, 0, 0, 0, 0, 0, 0]; // index 0 unused conceptually
    for (var i = 0; i < n; i++) {
      var t2 = flairs[i];
      if (t2 >= 1 && t2 <= 8) counts[t2] += 1;
      for (var t3 = 1; t3 <= 8; t3++) tierCumulative[TIER_CLASS[t3]][i] = counts[t3];
    }
  }

  function findSidebarSpans() {
    sidebarSpans = {};
    var nodes = document.querySelectorAll(".local-flair-count");
    for (var i = 0; i < nodes.length; i++) {
      var cls = nodes[i].getAttribute("data-flair");
      if (cls) sidebarSpans[cls] = nodes[i];
    }
  }

  function updateSidebarCounts() {
    if (!tierCumulative || !sidebarSpans) return;
    var i = playback.cursor - 1;
    for (var cls in TIER_CLASS) { /* noop */ }
    for (var t = 1; t <= 8; t++) {
      var cls2 = TIER_CLASS[t];
      var span = sidebarSpans[cls2];
      if (!span) continue;
      var arr = tierCumulative[cls2];
      var v = (i >= 0 && arr) ? arr[i] : 0;
      span.textContent = v.toLocaleString();
    }
  }

  fetch("assets/presses.bin")
    .then(function (r) { return r.arrayBuffer(); })
    .then(function (buf) {
      playback.deltas = new Uint32Array(buf);
      var n = playback.deltas.length;
      var cum = new Float64Array(n);
      var acc = 0;
      for (var i = 0; i < n; i++) { acc += playback.deltas[i]; cum[i] = acc; }
      playback.cumulative = cum;
      playback.totalMs = acc;
      return fetch("assets/flairs.bin");
    })
    .then(function (r) { return r.arrayBuffer(); })
    .then(function (buf) {
      var flairs = new Uint8Array(buf);
      buildTierCumulatives(flairs);
      return fetch("assets/presses.meta.json").then(function (r) { return r.json(); });
    })
    .then(function (meta) {
      playback.meta = meta;
      playback.startMsAbs = parseIsoToEpochMs(meta.start_iso);
      console.log("[thebutton] loaded historical timeline:", meta.count, "presses",
                  "from", meta.start_iso, "to", meta.end_iso,
                  "(" + (playback.totalMs / 86400000).toFixed(2) + " days)");
      findSidebarSpans();
      jumpToHistoricMs(0);
      buildUIIfNeeded();
    })
    .catch(function (e) {
      console.warn("[thebutton] historical data unavailable, button will idle:", e);
    });

  // ---------------- UI: toast, scrubber, help overlay ----------------

  var uiReady = false;
  var ui = {};

  function buildUIIfNeeded() {
    if (uiReady || !document.body) return;
    if (!playback.startMsAbs) return; // wait for data to load
    uiReady = true;

    var style = document.createElement("style");
    style.textContent =
      "#historic-toast{position:fixed;left:50%;bottom:30px;transform:translateX(-50%);"
      + "background:rgba(0,0,0,0.78);color:#fff;padding:9px 18px;border-radius:20px;"
      + "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px;"
      + "pointer-events:none;opacity:0;transition:opacity 0.25s;z-index:10001;"
      + "font-variant-numeric:tabular-nums;white-space:nowrap}"
      + "#historic-toast.visible{opacity:1}"
      + "#scrubber-bar{position:fixed;left:0;right:0;bottom:0;background:rgba(0,0,0,0.88);"
      + "padding:38px 30px 18px;z-index:10000;transform:translateY(110%);"
      + "transition:transform 0.25s ease;font-family:-apple-system,BlinkMacSystemFont,sans-serif;"
      + "box-shadow:0 -4px 20px rgba(0,0,0,0.4)}"
      + "#scrubber-bar.visible{transform:translateY(0)}"
      + "#scrubber-track{position:relative;height:8px;background:#3a3a3a;border-radius:4px;cursor:pointer;user-select:none}"
      + "#scrubber-fill{position:absolute;left:0;top:0;bottom:0;background:#ff4500;border-radius:4px;pointer-events:none}"
      + "#scrubber-handle{position:absolute;top:50%;left:0;width:16px;height:16px;background:#fff;"
      + "border-radius:50%;transform:translate(-50%,-50%);box-shadow:0 2px 6px rgba(0,0,0,0.5);pointer-events:none}"
      + "#scrubber-label{position:absolute;bottom:22px;left:0;transform:translateX(-50%);color:#fff;"
      + "font-size:13px;background:rgba(0,0,0,0.7);padding:5px 10px;border-radius:5px;white-space:nowrap;"
      + "font-variant-numeric:tabular-nums;pointer-events:none}"
      + "#scrubber-label:after{content:'';position:absolute;left:50%;bottom:-5px;transform:translateX(-50%);"
      + "border:5px solid transparent;border-top-color:rgba(0,0,0,0.7);border-bottom:0}"
      + "#scrubber-endpoints{display:flex;justify-content:space-between;color:#aaa;font-size:11px;margin-top:8px;"
      + "font-variant-numeric:tabular-nums}"
      + "#help-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:10002;display:none;"
      + "align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,sans-serif}"
      + "#help-overlay.visible{display:flex}"
      + "#help-card{background:#fff;color:#222;padding:24px 30px;border-radius:8px;max-width:480px;"
      + "box-shadow:0 12px 40px rgba(0,0,0,0.45);position:relative}"
      + "#help-card h2{margin:0 0 14px;font-size:18px}"
      + "#help-card ul{margin:0;padding:0;list-style:none}"
      + "#help-card li{padding:5px 0;font-size:13px;line-height:1.5}"
      + "#help-card kbd{background:#f3f3f3;border:1px solid #c8c8c8;border-bottom-width:2px;border-radius:3px;"
      + "padding:1px 6px;font-family:Consolas,monospace;font-size:11px;color:#333}"
      + "#help-close{position:absolute;top:8px;right:10px;background:none;border:0;font-size:22px;"
      + "color:#888;cursor:pointer;line-height:1;padding:4px 8px}"
      + "#help-close:hover{color:#222}"
      // Final "experiment is over" state today doesn't toggle on hover —
      // the message is always visible, no lock icon. The selector chain has
      // higher specificity than the base .thebutton-container.denied:before/:after
      // and the .denied:hover variants, so no !important is needed.
      + ".thebutton-container.denied.has-expired:before,"
      + ".thebutton-container.denied.has-expired:hover:before{opacity:0;display:none;cursor:default}"
      + ".thebutton-container.denied.has-expired:after,"
      + ".thebutton-container.denied.has-expired:hover:after{opacity:1;cursor:default}"
      + ".thebutton-container.denied.has-expired,"
      + ".thebutton-container.denied.has-expired #thebutton{cursor:default}";
    document.head.appendChild(style);

    ui.toast = document.createElement("div");
    ui.toast.id = "historic-toast";
    document.body.appendChild(ui.toast);

    ui.bar = document.createElement("div");
    ui.bar.id = "scrubber-bar";
    ui.bar.innerHTML =
      "<div id='scrubber-track'>"
      + "<div id='scrubber-fill'></div>"
      + "<div id='scrubber-handle'></div>"
      + "<div id='scrubber-label'>--</div>"
      + "</div>"
      + "<div id='scrubber-endpoints'><span id='scrubber-start'></span><span id='scrubber-end'></span></div>";
    document.body.appendChild(ui.bar);
    ui.track = ui.bar.querySelector("#scrubber-track");
    ui.fill = ui.bar.querySelector("#scrubber-fill");
    ui.handle = ui.bar.querySelector("#scrubber-handle");
    ui.label = ui.bar.querySelector("#scrubber-label");
    ui.startLabel = ui.bar.querySelector("#scrubber-start");
    ui.endLabel = ui.bar.querySelector("#scrubber-end");
    ui.startLabel.textContent = formatHistoricTime(0);
    ui.endLabel.textContent = formatHistoricTime(playback.totalMs);

    ui.help = document.createElement("div");
    ui.help.id = "help-overlay";
    ui.help.innerHTML =
      "<div id='help-card'>"
      + "<button id='help-close' aria-label='close'>&times;</button>"
      + "<h2>Controls</h2>"
      + "<ul>"
      + "<li><kbd>1</kbd>&ndash;<kbd>9</kbd>, <kbd>0</kbd> &mdash; scrub timeline (1=start, 0=end&minus;1min)</li>"
      + "<li><kbd>&larr;</kbd> / <kbd>&rarr;</kbd> &mdash; jump back / forward 1 hour</li>"
      + "<li><kbd>L</kbd> &mdash; 80s before lowest historical timer value</li>"
      + "<li><kbd>T</kbd> &mdash; show/hide scrubber bar</li>"
      + "<li><kbd>,</kbd> / <kbd>.</kbd> &mdash; slow down / speed up playback (1&times; to 200,000&times;)</li>"
      + "<li><kbd>M</kbd> &mdash; reset playback speed to 1&times;</li>"
      + "<li><kbd>Space</kbd> &mdash; pause / play</li>"
      + "<li><kbd>B</kbd> &mdash; reset the button to pressable (after expire)</li>"
      + "<li><kbd>E</kbd> &mdash; force expire</li>"
      + "<li><kbd>/</kbd> or <kbd>?</kbd> &mdash; show/hide this help</li>"
      + "<li><kbd>Esc</kbd> &mdash; close overlays</li>"
      + "</ul></div>";
    document.body.appendChild(ui.help);
    ui.help.addEventListener("click", function (e) {
      if (e.target === ui.help) hideHelp();
    });
    ui.help.querySelector("#help-close").addEventListener("click", hideHelp);

    // Track interactions
    var dragging = false;
    function trackXToHistoricMs(clientX) {
      var rect = ui.track.getBoundingClientRect();
      var f = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      return f * playback.totalMs;
    }
    function onMove(ev) {
      var x = ev.touches ? ev.touches[0].clientX : ev.clientX;
      var ms = trackXToHistoricMs(x);
      jumpToHistoricMs(ms);
    }
    ui.track.addEventListener("mousedown", function (e) {
      dragging = true;
      onMove(e);
      e.preventDefault();
    });
    ui.track.addEventListener("touchstart", function (e) {
      dragging = true;
      onMove(e);
      e.preventDefault();
    }, { passive: false });
    document.addEventListener("mousemove", function (e) { if (dragging) onMove(e); });
    document.addEventListener("touchmove", function (e) { if (dragging) onMove(e); }, { passive: false });
    document.addEventListener("mouseup", function () { dragging = false; });
    document.addEventListener("touchend", function () { dragging = false; });

    requestAnimationFrame(function uiTick() {
      var scrubberOpen = ui.bar.classList.contains("visible");
      // Lift the toast above the scrubber bar when it's open.
      ui.toast.style.bottom = scrubberOpen ? "120px" : "30px";

      if (scrubberOpen) {
        var ms = currentHistoricMs();
        var f = playback.totalMs > 0 ? ms / playback.totalMs : 0;
        f = Math.max(0, Math.min(1, f));
        ui.fill.style.width = (f * 100) + "%";
        ui.handle.style.left = (f * 100) + "%";

        ui.label.textContent = formatHistoricTime(ms);

        // Keep the floating time label fully on-screen at the edges by
        // shifting its translate to clamp the rendered box inside the
        // viewport instead of letting it extend past the left or right.
        var trackRect = ui.track.getBoundingClientRect();
        var labelW = ui.label.offsetWidth;
        var pxFromTrackLeft = f * trackRect.width;
        var pxAbs = trackRect.left + pxFromTrackLeft;
        var minAbs = labelW / 2 + 8;                          // 8px viewport margin
        var maxAbs = window.innerWidth - labelW / 2 - 8;
        var clampedAbs = Math.max(minAbs, Math.min(maxAbs, pxAbs));
        var deltaPx = clampedAbs - pxAbs; // shift needed to keep label on-screen
        ui.label.style.left = (f * 100) + "%";
        // Compensate the standard -50% translate by the clamp delta
        ui.label.style.transform = "translateX(calc(-50% + " + deltaPx + "px))";
      }
      requestAnimationFrame(uiTick);
    });
  }

  document.addEventListener("DOMContentLoaded", buildUIIfNeeded);
  // Also try immediately in case DOM is already ready
  if (document.readyState !== "loading") buildUIIfNeeded();

  var toastTimer = null;
  function showToast(text) {
    if (!ui.toast) return;
    ui.toast.textContent = text;
    ui.toast.classList.add("visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { ui.toast.classList.remove("visible"); }, 2000);
  }
  function showToastAtCurrent() {
    showToast(formatHistoricTime(currentHistoricMs()));
  }
  function toggleScrubber() {
    if (!ui.bar) return;
    ui.bar.classList.toggle("visible");
  }
  function showHelp()   { if (ui.help) ui.help.classList.add("visible"); }
  function hideHelp()   { if (ui.help) ui.help.classList.remove("visible"); }
  function toggleHelp() { if (ui.help) ui.help.classList.toggle("visible"); }

  function resetToPressable() {
    var btn = document.getElementById("thebutton");
    if (!btn) return;
    var container = btn.parentElement;
    var wrap = document.querySelector(".thebutton-wrap");
    if (wrap) {
      wrap.classList.remove("complete");
      wrap.classList.add("active");
    }
    if (container) {
      container.classList.remove("denied", "has-expired", "pressed", "unlocked", "unlocking",
                                  "logged-out", "too-new", "not-active", "login-required");
      container.classList.add("active", "locked");
    }
    if (window.r && window.r.thebutton) window.r.thebutton._started = false;
    playback.userPressed = false;
    state.secondsLeft = START_SECONDS;
    state.lastSyncAt = Date.now();
    FakeSocket._broadcastTicking();
    if (!playback.rafId && !playback.expired) playback.rafId = requestAnimationFrame(tickPlayback);
  }
  window.thebuttonLocal.resetToPressable = resetToPressable;

  // ---------------- Keyboard ----------------
  document.addEventListener("keydown", function (e) {
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
    var k = e.key;

    // Help: / or ?
    if (k === "/" || k === "?") {
      toggleHelp();
      e.preventDefault();
      return;
    }
    // Esc: close overlays
    if (k === "Escape") {
      hideHelp();
      if (ui.bar && ui.bar.classList.contains("visible")) ui.bar.classList.remove("visible");
      return;
    }

    // 1-9, 0: jump to fraction of timeline
    if (k >= "0" && k <= "9") {
      var idx = k === "0" ? 9 : (parseInt(k, 10) - 1);
      jumpToFraction(idx / 9);
      showToastAtCurrent();
      e.preventDefault();
      return;
    }

    // Arrow keys: ±1 hour
    if (k === "ArrowLeft") {
      jumpToHistoricMs(currentHistoricMs() - 3600000);
      showToastAtCurrent();
      e.preventDefault();
      return;
    }
    if (k === "ArrowRight") {
      jumpToHistoricMs(currentHistoricMs() + 3600000);
      showToastAtCurrent();
      e.preventDefault();
      return;
    }

    if (k === "t" || k === "T") {
      toggleScrubber();
      return;
    }

    if (k === " ") {
      if (!playback.paused) {
        // Pausing — snapshot the historic position so the display freezes here
        playback.historicOriginMs = currentHistoricMs();
        playback.paused = true;
        if (window.r && window.r.thebutton && window.r.thebutton._countdownInterval) {
          window.r.thebutton._countdownInterval = clearInterval(window.r.thebutton._countdownInterval);
        }
      } else {
        playback.paused = false;
        playback.startedAt = performance.now();
      }
      showToast(playback.paused ? "paused" : "playing");
      if (!playback.rafId && !playback.expired) playback.rafId = requestAnimationFrame(tickPlayback);
      e.preventDefault();
      return;
    }

    if (k === "m" || k === "M") {
      window.thebuttonLocal.setSpeed(1);
      showToast("playback speed: 1×");
      return;
    }

    if (k === "," || k === ".") {
      // Top step (200000×) covers the full 65-day dataset in ~28s of real time.
      var STEPS = [1, 2, 5, 10, 25, 50, 100, 500, 2500, 10000, 50000, 200000];
      var cur = playback.speed;
      // Find current step (closest), then move
      var idx = 0;
      var bestDiff = Infinity;
      for (var i = 0; i < STEPS.length; i++) {
        var diff = Math.abs(STEPS[i] - cur);
        if (diff < bestDiff) { bestDiff = diff; idx = i; }
      }
      idx = k === "," ? Math.max(0, idx - 1) : Math.min(STEPS.length - 1, idx + 1);
      window.thebuttonLocal.setSpeed(STEPS[idx]);
      showToast("playback speed: " + STEPS[idx] + "×");
      return;
    }

    if (k === "b" || k === "B") {
      resetToPressable();
      showToast("button reset to pressable");
      return;
    }

    if (k === "e" || k === "E") {
      window.thebuttonLocal.expire();
      showToast("button expired");
      return;
    }

    if (k === "l" || k === "L") {
      if (!playback.cumulative || !playback.meta || !playback.meta.min_flair) return;
      var pressMs = playback.cumulative[playback.meta.min_flair.index];
      jumpToHistoricMs(Math.max(0, pressMs - 80000));
      showToast("80s before lowest (" + playback.meta.min_flair.seconds + "s flair) — "
                + formatHistoricTime(currentHistoricMs()));
      return;
    }
  });
})();
