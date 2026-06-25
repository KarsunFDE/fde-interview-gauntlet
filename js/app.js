// app.js — flow + state for the FDE Interview Gauntlet.
// Screens: gate -> lobby -> interview -> results -> leaderboard.
// Pure vanilla JS. Relies on window.API (api.js) and window.STT (stt.js).

(function () {
  "use strict";

  // ---- State --------------------------------------------------------------
  var state = {
    name: null,
    passcode: null,
    tier: null,
    session: null, // last /session payload
    interviewId: null,
    questions: [],
    qIndex: 0,
    // Per-question accumulated record across the 10 questions. Keyed by index;
    // each entry: { questionId, prompt, type, topic, transcript, words, delivery, feedback }
    perQuestion: [],
    answers: {},   // questionId -> learner transcript (for results + download)
    ttsOn: true,
    recorder: null,
    recording: false
  };

  // ---- Answer length governor --------------------------------------------
  var MAX_CHARS = 2200;        // hard cap on the edit textarea (maxlength)
  var WORD_CEILING = 300;      // recording auto-stop ceiling (rare under 2-min cap)
  var WORD_CEILING_HINT = 270; // "approaching length limit" hint while recording
  var TARGET_WORDS = 210;      // informational target on the edit counter
  var AMBER_WORDS = 245;       // edit counter turns amber past this (informational only)

  // ---- Recording timer --------------------------------------------------
  var MAX_RECORD_MS = 120000;  // 2:00 hard cap — the primary, visible bound
  var AMBER_AT_MS = 30000;     // countdown amber at <= 30s remaining
  var RED_AT_MS = 10000;       // countdown red at <= 10s remaining

  function fmtClock(ms) {
    var total = Math.max(0, Math.ceil(ms / 1000));
    var m = Math.floor(total / 60);
    var s = total % 60;
    return m + ":" + (s < 10 ? "0" : "") + s;
  }

  function countWords(s) {
    s = (s || "").trim();
    if (!s) return 0;
    return s.split(/\s+/).length;
  }

  // Conservative filler detection. Word-boundary, case-insensitive.
  // Single tokens + a few multi-word fillers. "like" only when space-bounded.
  var FILLER_SINGLE = ["um", "uh", "uhh", "er", "erm", "ah", "like"];
  var FILLER_PHRASES = ["you know", "kind of", "sort of", "i mean"];
  function countFillers(s) {
    s = " " + (s || "").toLowerCase() + " ";
    var n = 0;
    FILLER_SINGLE.forEach(function (w) {
      var re = new RegExp("(^|[^a-z])" + w + "([^a-z]|$)", "g");
      var m;
      // count non-overlapping by walking lastIndex back one (boundaries shared)
      var idx = 0;
      while ((m = re.exec(s)) !== null) {
        n++;
        re.lastIndex = m.index + 1;
      }
      void idx;
    });
    FILLER_PHRASES.forEach(function (p) {
      var re = new RegExp("(^|[^a-z])" + p.replace(/ /g, "\\s+") + "([^a-z]|$)", "g");
      var m;
      while ((m = re.exec(s)) !== null) {
        n++;
        re.lastIndex = m.index + 1;
      }
    });
    return n;
  }

  // Build the delivery object sent to /judge.
  // mode "speech" if they recorded this answer at all; durationMs null if typed-only.
  function buildDelivery(transcript, startMs, stopMs, recorded) {
    var words = countWords(transcript);
    var durationMs = (recorded && startMs && stopMs && stopMs > startMs) ? (stopMs - startMs) : null;
    var mode = recorded ? "speech" : "typed";
    var wpm = (durationMs && mode === "speech") ? Math.round(words / (durationMs / 60000)) : null;
    var fillerCount = countFillers(transcript);
    var fillerRate = Math.round(fillerCount / Math.max(words, 1) * 100);
    return {
      durationMs: durationMs,
      words: words,
      wpm: wpm,
      fillerCount: fillerCount,
      fillerRate: fillerRate,
      mode: mode
    };
  }

  // ---- DOM helpers --------------------------------------------------------
  function $(sel, root) {
    return (root || document).querySelector(sel);
  }
  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === "class") node.className = attrs[k];
        else if (k === "text") node.textContent = attrs[k];
        else if (k === "html") node.innerHTML = attrs[k];
        else node.setAttribute(k, attrs[k]);
      });
    }
    (children || []).forEach(function (c) {
      if (c == null) return;
      node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return node;
  }
  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  var app = function () { return $("#app"); };

  // ---- Toasts -------------------------------------------------------------
  window.showToast = function (msg, kind) {
    var wrap = $("#toasts");
    if (!wrap) return;
    var t = el("div", { class: "toast toast--" + (kind || "error") }, [String(msg)]);
    wrap.appendChild(t);
    setTimeout(function () { t.classList.add("toast--in"); }, 10);
    setTimeout(function () {
      t.classList.remove("toast--in");
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 300);
    }, 4500);
  };

  // ---- Session persistence ------------------------------------------------
  function saveCreds() {
    try {
      sessionStorage.setItem("fde_name", state.name || "");
      sessionStorage.setItem("fde_passcode", state.passcode || "");
    } catch (e) { /* sessionStorage may be unavailable */ }
  }
  function loadCreds() {
    try {
      state.name = sessionStorage.getItem("fde_name") || null;
      state.passcode = sessionStorage.getItem("fde_passcode") || null;
    } catch (e) { /* no-op */ }
  }

  function isPractice() {
    return state.name === "Practice (no leaderboard)";
  }

  // ---- Header / TTS toggle ------------------------------------------------
  function renderHeader() {
    var head = $("#appHeader");
    clear(head);
    var brand = el("div", { class: "brand" }, [
      el("span", { class: "brand__bolt", text: "⚡" }),
      el("span", { class: "brand__name", text: "FDE Interview Gauntlet" })
    ]);

    var right = el("div", { class: "head-right" });

    if (state.name) {
      var ttsBtn = el("button", {
        class: "tts-toggle" + (state.ttsOn ? " is-on" : ""),
        type: "button",
        title: "Read questions aloud"
      }, [state.ttsOn ? "🔊 TTS on" : "🔇 TTS off"]);
      ttsBtn.addEventListener("click", function () {
        state.ttsOn = !state.ttsOn;
        if (!state.ttsOn) window.STT.tts.cancel();
        renderHeader();
      });
      right.appendChild(ttsBtn);

      var who = el("div", { class: "whoami" }, [
        el("span", { class: "whoami__name", text: state.name }),
        state.tier ? el("span", { class: "tier-pill", text: state.tier }) : null
      ]);
      right.appendChild(who);
    }

    head.appendChild(brand);
    head.appendChild(right);
  }

  // ===========================================================================
  // SCREEN: Gate
  // ===========================================================================
  function renderGate() {
    window.STT.tts.cancel();
    renderHeader();
    var root = app();
    clear(root);

    var roster = (window.CONFIG && window.CONFIG.ROSTER) || [];
    var select = el("select", { class: "field", id: "nameSelect" });
    select.appendChild(el("option", { value: "", text: "Select your name…" }));
    roster.forEach(function (n) {
      select.appendChild(el("option", { value: n, text: n }));
    });
    if (state.name) select.value = state.name;

    var pass = el("input", {
      class: "field",
      id: "passInput",
      type: "password",
      placeholder: "Shared passcode",
      autocomplete: "off"
    });

    var btn = el("button", { class: "btn btn--primary btn--lg", id: "enterBtn", type: "submit" }, ["Enter the Gauntlet"]);

    var form = el("form", { class: "gate-form" }, [
      el("label", { class: "field-label", text: "Who's running it?" }),
      select,
      el("label", { class: "field-label", text: "Passcode" }),
      pass,
      btn
    ]);

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var name = select.value;
      var passcode = pass.value;
      if (!name) { window.showToast("Pick your name first.", "warn"); return; }
      if (!passcode) { window.showToast("Enter the passcode.", "warn"); return; }
      btn.disabled = true;
      btn.textContent = "Checking…";
      window.API.session(name, passcode)
        .then(function (data) {
          if (data && data.ok) {
            state.name = name;
            state.passcode = passcode;
            state.tier = data.tier || null;
            state.session = data;
            saveCreds();
            renderModeSelect();
          } else {
            btn.disabled = false;
            btn.textContent = "Enter the Gauntlet";
            if (data && data.error === "bad_passcode") window.showToast("Wrong passcode.", "error");
            else window.showToast("Could not sign in.", "error");
          }
        })
        .catch(function () {
          btn.disabled = false;
          btn.textContent = "Enter the Gauntlet";
        });
    });

    var card = el("div", { class: "card gate-card screen-in" }, [
      el("h1", { class: "gate-title", text: "The Gauntlet" }),
      el("p", { class: "gate-sub", text: "Speak your answers. An AI judge scores them. Top scorer banks the daily prize." }),
      form
    ]);

    root.appendChild(el("div", { class: "screen screen--center" }, [card]));
  }

  // ===========================================================================
  // SCREEN: Mode select (hub) — Interview vs System Design + boards + trainer
  // ===========================================================================
  function creds() {
    return { name: state.name, passcode: state.passcode, tier: state.tier };
  }

  function renderModeSelect() {
    window.STT.tts.cancel();
    renderHeader();
    var root = app();
    clear(root);

    function modeCard(title, blurb, eg, onClick) {
      var c = el("button", { class: "card sd-track-card", type: "button" }, [
        el("h2", { class: "sd-track-title", text: title }),
        el("p", { class: "sd-track-blurb", text: blurb }),
        el("p", { class: "sd-track-eg", text: eg })
      ]);
      c.addEventListener("click", onClick);
      return c;
    }

    var interviewCard = modeCard(
      "Interview Gauntlet",
      "10 spoken interview questions. An AI judge scores substance, mindset, and delivery. Daily prize for the top scorer.",
      "behavioral · scenario · technical",
      function () { renderLobby(); }
    );
    var designCard = modeCard(
      "System Design Simulator",
      "Scope a loose client brief, design it on a live canvas, defend the WHY, then adapt when constraints change. Two AI critics score it.",
      "full-stack · AI / agentic · ~20-min sessions",
      function () { openTrackModal(); }
    );

    var boardsBtn = el("button", { class: "btn btn--primary", type: "button", text: "🏆 Leaderboards" });
    boardsBtn.addEventListener("click", function () { window.DESIGN.boards(creds(), renderModeSelect); });
    var historyBtn = el("button", { class: "btn", type: "button", text: "My past designs" });
    historyBtn.addEventListener("click", function () { window.DESIGN.history(creds(), renderModeSelect); });
    var trainerBtn = el("button", { class: "btn btn--ghost", type: "button", text: "Trainer reports" });
    trainerBtn.addEventListener("click", function () { window.TRAINER.open(renderModeSelect); });

    root.appendChild(el("div", { class: "screen" }, [
      el("div", { class: "sd-head" }, [
        el("h1", { class: "lobby-greet" }, [
          "Welcome, ",
          el("span", { class: "accent", text: (state.name || "").split(" ")[0] }),
          state.tier ? el("span", { class: "tier-pill tier-pill--inline", text: state.tier }) : null
        ])
      ]),
      el("p", { class: "sd-sub", text: "Pick your arena." }),
      el("div", { class: "sd-track-grid" }, [interviewCard, designCard]),
      el("div", { class: "mode-actions" }, [boardsBtn, historyBtn, trainerBtn])
    ]));
  }

  // Track picker — a modal over the hub, so System Design is one click + one
  // choice instead of two full-page jumps.
  function openTrackModal() {
    var overlay = el("div", { class: "sd-modal-overlay" });
    function trackBtn(track, title, blurb, eg) {
      var b = el("button", { class: "card sd-track-card", type: "button" }, [
        el("h2", { class: "sd-track-title", text: title }),
        el("p", { class: "sd-track-blurb", text: blurb }),
        el("p", { class: "sd-track-eg", text: eg })
      ]);
      b.addEventListener("click", function () {
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        window.DESIGN.openTrack(creds(), track, renderModeSelect);
      });
      return b;
    }
    var close = el("button", { class: "btn btn--ghost sd-modal-close", type: "button", text: "✕" });
    close.addEventListener("click", function () { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); });
    overlay.addEventListener("click", function (e) { if (e.target === overlay) overlay.parentNode.removeChild(overlay); });
    overlay.appendChild(el("div", { class: "sd-modal sd-track-modal" }, [
      el("div", { class: "sd-modal-head" }, [
        el("h2", { class: "panel-title", text: "Choose a track" }), close
      ]),
      el("div", { class: "sd-modal-body" }, [
        el("div", { class: "sd-track-grid" }, [
          trackBtn("fullstack", "Full-Stack System Design",
            "Classic services & data systems: APIs, schemas, scale, consistency, failure modes.",
            "rate limiter · multi-tenant schema · grants intake · payment flow"),
          trackBtn("agentic", "AI / Agentic System Design",
            "LLM-native systems: RAG pipelines, agents, HITL, evals, retrieval at scale.",
            "ingestion pipeline · multi-tenant RAG · agentic HITL · fine-tune vs RAG")
        ])
      ])
    ]));
    document.body.appendChild(overlay);
  }

  // ===========================================================================
  // SCREEN: Lobby
  // ===========================================================================
  function renderLobby() {
    window.STT.tts.cancel();
    renderHeader();
    var root = app();
    clear(root);
    var s = state.session || {};

    var used = typeof s.attemptsUsed === "number" ? s.attemptsUsed : 0;
    var maxPer = typeof s.maxPerDay === "number" ? s.maxPerDay : 0;
    var remaining = typeof s.attemptsRemaining === "number" ? s.attemptsRemaining : Math.max(0, maxPer - used);
    var capped = remaining <= 0 && maxPer > 0;

    var startBtn = el("button", {
      class: "btn btn--primary btn--lg",
      id: "startBtn",
      type: "button"
    }, ["Start Interview"]);
    if (capped) startBtn.disabled = true;
    startBtn.addEventListener("click", beginInterview);

    var attemptsLine = el("p", { class: "attempts" }, [
      "Interviews today: ",
      el("strong", { text: String(used) }),
      " of ",
      el("strong", { text: String(maxPer || "∞") }),
      " used — ",
      el("strong", { class: remaining > 0 ? "ok" : "warn", text: String(remaining) }),
      " remaining"
    ]);

    var capNote = capped
      ? el("p", { class: "cap-note", text: "You've used all of today's interviews. Come back tomorrow — the board resets daily (US Eastern)." })
      : null;

    var micNote = el("p", { class: "mic-note" }, [
      window.STT.supported()
        ? "🎙 Mic ready — press Record, speak for up to 2 minutes, then review and edit your transcript before submitting."
        : "⚠ Speech capture isn't supported in this browser. You can still type your answers. (Chrome / Edge recommended.)"
    ]);

    var how = el("div", { class: "how" }, [
      el("h3", { text: "How it works" }),
      el("ol", { class: "how-list" }, [
        el("li", { text: "10 questions, one interview. Each is read aloud." }),
        el("li", { text: "Press Record and speak — you get up to 2 minutes. The countdown shows the time left." }),
        el("li", { text: "On stop or time-out, your full transcript appears for you to edit — no rush, editing isn't timed." }),
        el("li", { text: "Submit each answer — it's scored privately. No feedback shown mid-interview." }),
        el("li", { text: "After all 10, you'll see your full score + feedback. Finish to post your best to today's leaderboard." })
      ])
    ]);

    var lobbyCard = el("div", { class: "card lobby-card screen-in" }, [
      el("h1", { class: "lobby-greet" }, [
        "Welcome, ",
        el("span", { class: "accent", text: (state.name || "").split(" ")[0] }),
        state.tier ? el("span", { class: "tier-pill tier-pill--inline", text: state.tier }) : null
      ]),
      attemptsLine,
      capNote,
      el("div", { class: "lobby-actions" }, [startBtn]),
      micNote,
      how
    ]);

    var tabs = renderTabs("lobby");

    root.appendChild(el("div", { class: "screen" }, [tabs, lobbyCard]));
  }

  function renderTabs(active) {
    var tabs = el("div", { class: "tabs" });
    var modesTab = el("button", { class: "tab", type: "button", text: "← Modes" });
    modesTab.addEventListener("click", function () { renderModeSelect(); });
    tabs.appendChild(modesTab);
    var lobbyTab = el("button", { class: "tab" + (active === "lobby" ? " is-active" : ""), type: "button", text: "Lobby" });
    lobbyTab.addEventListener("click", function () { if (active !== "lobby") renderLobby(); });
    var boardTab = el("button", { class: "tab" + (active === "board" ? " is-active" : ""), type: "button", text: "Leaderboard" });
    boardTab.addEventListener("click", function () { if (active !== "board") renderLeaderboard("lobby"); });
    tabs.appendChild(lobbyTab);
    tabs.appendChild(boardTab);
    return tabs;
  }

  // ===========================================================================
  // SCREEN: Interview
  // ===========================================================================
  function beginInterview() {
    var btn = $("#startBtn");
    if (btn) { btn.disabled = true; btn.textContent = "Starting…"; }
    window.API.startInterview(state.name, state.passcode)
      .then(function (data) {
        if (data && data.ok) {
          state.interviewId = data.interviewId;
          state.questions = data.questions || [];
          state.qIndex = 0;
          state.perQuestion = [];
          state.answers = {};
          state.pending = [];                 // per-question judge records
          state.judgeQueue = Promise.resolve(); // sequential background scoring chain
          state.finishProgress = null;
          renderQuestion();
        } else {
          if (btn) { btn.disabled = false; btn.textContent = "Start Interview"; }
          if (data && data.error === "cap_reached") {
            window.showToast("Daily interview cap reached.", "warn");
            // refresh lobby to reflect cap
            if (state.session) { state.session.attemptsRemaining = 0; }
            renderLobby();
          } else {
            window.showToast("Could not start the interview.", "error");
          }
        }
      })
      .catch(function () {
        if (btn) { btn.disabled = false; btn.textContent = "Start Interview"; }
      });
  }

  function stopRecorder() {
    if (state.recorder) {
      try { state.recorder.stop(); } catch (e) { /* no-op */ }
    }
    state.recording = false;
  }

  // The per-question flow has four states: ready -> recording -> review -> submit.
  // The TIMER runs ONLY in the recording state. The transcript is captured into an
  // internal STT buffer while recording (no editable field shown), then rendered
  // into an editable textarea for an UNTIMED review/edit pass before submit.
  function renderQuestion() {
    window.STT.tts.cancel();
    renderHeader();
    stopRecorder();
    var root = app();
    clear(root);

    var total = state.questions.length || 10;
    var q = state.questions[state.qIndex];
    if (!q) { finishInterview(); return; }

    var pct = Math.round((state.qIndex / total) * 100);

    var progress = el("div", { class: "q-progress" }, [
      el("div", { class: "q-progress__label" }, [
        "Question ",
        el("strong", { text: String(state.qIndex + 1) }),
        " / " + total
      ]),
      el("div", { class: "bar" }, [el("div", { class: "bar__fill", style: "width:" + pct + "%" })])
    ]);

    var meta = el("div", { class: "q-meta" }, [
      q.topic ? el("span", { class: "chip", text: q.topic }) : null,
      q.type ? el("span", { class: "chip chip--ghost", text: q.type }) : null
    ]);

    var prompt = el("h2", { class: "q-prompt", text: q.prompt });

    // Mount the question shell once; each state re-renders into #qStage below it.
    var stage = el("div", { class: "q-stage", id: "qStage" });

    var card = el("div", { class: "card q-card screen-in" }, [
      progress,
      meta,
      prompt,
      stage
    ]);
    root.appendChild(el("div", { class: "screen" }, [card]));

    var supported = window.STT.supported();

    // ---- Per-answer delivery tracking (survives re-record) ----
    var recordStartMs = null; // start of the FINAL recording attempt
    var recordStopMs = null;  // stop of the FINAL recording attempt
    var recordedThisAnswer = false; // true if speech captured at least once

    // Timer handles for the recording state.
    var tickTimer = null;
    var hardStopTimer = null;

    function clearTimers() {
      if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
      if (hardStopTimer) { clearTimeout(hardStopTimer); hardStopTimer = null; }
    }

    // Read the question aloud after paint (Ready state only triggers this).
    function speakPrompt() {
      if (state.ttsOn) {
        setTimeout(function () { window.STT.tts.speak(q.prompt, state.ttsOn); }, 250);
      }
    }

    // ====================================================================
    // STATE 1: READY — no timer running.
    // ====================================================================
    function renderReady() {
      clearTimers();
      stopRecorder();
      clear(stage);

      var recBtn = el("button", { class: "btn btn--primary btn--lg", id: "recBtn", type: "button" }, [
        "🎙 Record answer"
      ]);
      recBtn.addEventListener("click", function () { renderRecording(); });

      var guidance = el("p", { class: "answer-guidance answer-guidance--ready", text:
        "You have up to 2 minutes. The timer starts when you press Record — you'll review and edit the transcript afterward."
      });

      var typeInstead = el("button", { class: "btn btn--ghost type-instead", type: "button", text: "Type instead" });
      typeInstead.addEventListener("click", function () {
        renderReview({ mode: "typed", transcript: "", reason: null });
      });

      stage.appendChild(el("div", { class: "ready-block" }, [
        recBtn,
        guidance,
        typeInstead
      ]));

      maybeAddSkip(stage);
      speakPrompt();
    }

    // ====================================================================
    // STATE 2: RECORDING — the ONLY state where the timer runs.
    // ====================================================================
    function renderRecording() {
      window.STT.tts.cancel();
      clear(stage);

      // Mic unsupported should never reach here, but guard anyway.
      if (!supported) { renderReview({ mode: "typed", transcript: "", reason: null }); return; }

      var countdown = el("div", { class: "rec-countdown", text: fmtClock(MAX_RECORD_MS) });
      var pulse = el("div", { class: "rec-status" }, [
        el("span", { class: "rec-pulse-dot" }),
        el("span", { class: "rec-status__label", text: "Recording…" })
      ]);
      var wordHint = el("span", { class: "rec-wordhint", text: "~0 words" });
      var ceilingHint = el("p", { class: "len-nudge", text: "Approaching the length limit — wrap up soon." });
      ceilingHint.style.display = "none";

      var stopBtn = el("button", { class: "btn btn--primary", id: "stopBtn", type: "button", text: "⏹ Stop & review" });

      var liveWords = 0; // word count of the internal buffer (committed + interim)

      // ---- stopAndReview centralizes every exit from recording ----
      var stopped = false;
      function stopAndReview(reason) {
        if (stopped) return;
        stopped = true;
        clearTimers();
        recordStopMs = Date.now();
        var finalText = (state.recorder && state.recorder.getTranscript) ? state.recorder.getTranscript() : "";
        stopRecorder();
        renderReview({ mode: "speech", transcript: finalText, reason: reason });
      }

      stopBtn.addEventListener("click", function () { stopAndReview("manual"); });

      state.recorder = window.STT.createRecorder({
        onStart: function () {
          state.recording = true;
        },
        onUpdate: function (text) {
          liveWords = countWords(text);
          wordHint.textContent = "~" + liveWords + " words";
          if (liveWords >= WORD_CEILING_HINT) ceilingHint.style.display = "";
          if (liveWords >= WORD_CEILING) stopAndReview("word_ceiling");
        },
        onError: function (e) {
          var code = e && e.error;
          if (code === "not-allowed" || code === "service-not-allowed") {
            // Mic denied — fall back to typed review.
            window.showToast("Microphone permission denied. Type your answer instead.", "error");
            stopped = true;
            clearTimers();
            stopRecorder();
            renderReview({ mode: "typed", transcript: "", reason: null });
          } else if (code === "no-speech") {
            // benign; ignore (recorder auto-restarts)
          } else if (code !== "aborted") {
            window.showToast("Speech recognition error" + (code ? " (" + code + ")" : "") + ".", "warn");
          }
        },
        onEnd: function () {
          state.recording = false;
        }
      });

      stage.appendChild(el("div", { class: "recording-block" }, [
        countdown,
        pulse,
        el("div", { class: "rec-hintrow" }, [wordHint]),
        ceilingHint,
        el("div", { class: "q-actions" }, [stopBtn])
      ]));

      // Start recording + the timer NOW (and only now).
      recordedThisAnswer = true;
      recordStartMs = Date.now();
      recordStopMs = null;
      state.recorder.start();

      // Countdown tick — updates the visible clock + amber/red bands.
      tickTimer = setInterval(function () {
        var remaining = MAX_RECORD_MS - (Date.now() - recordStartMs);
        if (remaining < 0) remaining = 0;
        countdown.textContent = fmtClock(remaining);
        countdown.classList.remove("is-amber", "is-red");
        if (remaining <= RED_AT_MS) countdown.classList.add("is-red");
        else if (remaining <= AMBER_AT_MS) countdown.classList.add("is-amber");
      }, 250);

      // Hard 2-minute auto-stop — the primary, clearly-announced bound.
      hardStopTimer = setTimeout(function () { stopAndReview("timeout"); }, MAX_RECORD_MS);
    }

    // ====================================================================
    // STATE 3: REVIEW / EDIT — untimed. Reached on ANY stop (or typed path).
    // ====================================================================
    function renderReview(o) {
      clearTimers();
      stopRecorder();
      window.STT.tts.cancel();
      clear(stage);

      var mode = o.mode;                 // "speech" | "typed"
      var reason = o.reason;             // "manual" | "timeout" | "word_ceiling" | null
      var initial = (o.transcript || "").slice(0, MAX_CHARS);

      // Stop-reason banner (omitted for typed path).
      var banner = null;
      if (mode === "speech") {
        var msg = "You stopped recording.";
        if (reason === "timeout") msg = "Time's up (2 minutes).";
        else if (reason === "word_ceiling") msg = "Reached the length limit.";
        banner = el("div", { class: "stop-banner" }, [
          el("span", { class: "stop-banner__icon", text: "✓" }),
          el("span", { class: "stop-banner__text", text: msg })
        ]);
      }

      var ta = el("textarea", {
        class: "transcript",
        id: "transcriptBox",
        rows: "8",
        maxlength: String(MAX_CHARS),
        placeholder: mode === "typed"
          ? "Type your answer here…"
          : "Your transcript appears here — edit it freely, then submit."
      });
      ta.value = initial;

      var counter = el("span", { class: "wordcount" });
      var nudge = el("p", { class: "len-nudge", text: "A bit long — interviewers tune out after ~90s. Trim if you can." });
      nudge.style.display = "none";

      function updateCounter() {
        var w = countWords(ta.value);
        counter.textContent = w + " words (target ~" + TARGET_WORDS + ")";
        counter.classList.remove("is-amber", "is-red");
        if (w > WORD_CEILING) counter.classList.add("is-red");
        else if (w > AMBER_WORDS) counter.classList.add("is-amber");
        nudge.style.display = w > AMBER_WORDS ? "" : "none";
      }
      ta.addEventListener("input", updateCounter);
      updateCounter();

      // Speech transcripts: remind learners to FIX, not POLISH.
      var editNote = (mode === "speech")
        ? el("p", { class: "edit-note" }, [
            el("strong", { text: "Edit only to fix transcription errors" }),
            " — wrong words, spelling, garbled tech terms. Don't rewrite or polish your answer; keep it honest."
          ])
        : null;

      var submitBtn = el("button", { class: "btn btn--primary", id: "submitBtn", type: "button" }, ["Submit Answer"]);
      submitBtn.addEventListener("click", function () {
        var text = (ta.value || "").trim();
        var delivery = buildDelivery(
          text,
          mode === "speech" ? recordStartMs : null,
          mode === "speech" ? recordStopMs : null,
          mode === "speech" && recordedThisAnswer
        );
        submitAnswer(q, text, submitBtn, delivery);
      });

      // Re-record (speech) / Clear (typed) — discard and go back fresh.
      var reBtn = el("button", { class: "btn btn--ghost", type: "button" }, [
        mode === "typed" ? "Clear" : "↺ Re-record"
      ]);
      reBtn.addEventListener("click", function () {
        recordStartMs = null;
        recordStopMs = null;
        recordedThisAnswer = false;
        if (mode === "typed") {
          ta.value = "";
          updateCounter();
          ta.focus();
        } else if (supported) {
          if (window.confirm("Re-record discards this ENTIRE answer and records your whole response again from scratch — it isn't for fixing individual sentences. Continue?")) {
            renderReady();
          }
        } else {
          ta.value = "";
          updateCounter();
        }
      });

      var typedNote = (mode === "typed" && !supported)
        ? el("p", { class: "no-stt", text: "Speech isn't supported in this browser — type your answer (Chrome / Edge recommended)." })
        : null;

      var qActions = el("div", { class: "q-actions" }, [submitBtn, reBtn]);

      stage.appendChild(el("div", { class: "review-block" }, [
        banner,
        typedNote,
        el("div", { class: "answer-block" }, [
          el("label", { class: "field-label", text: "Your answer" }),
          ta,
          editNote,
          el("div", { class: "answer-foot" }, [counter]),
          nudge
        ]),
        qActions
      ]));

      maybeAddSkip(stage);
      if (mode === "typed") ta.focus();
    }

    // Practice-only "Skip to results" — appended to whichever state is showing.
    function maybeAddSkip(mountStage) {
      if (!isPractice()) return;
      var skipBtn = el("button", { class: "btn btn--ghost skip-results", type: "button" }, ["Skip to results →"]);
      skipBtn.addEventListener("click", function () {
        clearTimers();
        stopRecorder();
        window.STT.tts.cancel();
        finishInterview();
      });
      mountStage.appendChild(el("div", { class: "skip-row" }, [skipBtn]));
    }

    // ---- Entry point: pick the starting state ----
    if (!supported) {
      // STT unsupported: skip Ready/Recording entirely.
      renderReview({ mode: "typed", transcript: "", reason: null });
    } else {
      renderReady();
    }
  }

  function submitAnswer(q, transcript, btn, delivery) {
    transcript = (transcript || "").trim();
    if (!transcript) {
      window.showToast("Say or type something before submitting.", "warn");
      return;
    }
    if (transcript.split(/\s+/).length < 12) {
      if (!window.confirm("That answer looks very short. Submit anyway?")) return;
    }
    btn.disabled = true; // guard against a double-fire before re-render
    stopRecorder();
    window.STT.tts.cancel();

    // Keep the learner's own transcript client-side (the API doesn't echo it back).
    state.answers[q.id] = transcript;

    // Per-question judge record; scored in the BACKGROUND so we can advance now.
    var rec = {
      questionId: q.id, idx: state.qIndex,
      prompt: q.prompt, type: q.type || null, topic: q.topic || null,
      transcript: transcript,
      words: (delivery && delivery.words) || countWords(transcript),
      status: "queued", score: null, delivery: null, feedback: null
    };
    state.pending.push(rec);

    // Sequential background queue: lets the learner move on immediately while
    // each answer is scored in order — sequential writes avoid racing the
    // shared interview record on the server.
    state.judgeQueue = state.judgeQueue.then(function () {
      rec.status = "scoring";
      return window.API.judge(state.interviewId, rec.questionId, rec.transcript, delivery)
        .then(function (data) {
          if (data && data.ok) {
            rec.status = "done";
            rec.score = data.score;
            rec.delivery = data.delivery || null;
            rec.feedback = data;
            state.perQuestion.push({
              questionId: rec.questionId, idx: rec.idx, prompt: rec.prompt,
              type: rec.type, topic: rec.topic, score: data.score,
              transcript: rec.transcript, words: rec.words,
              delivery: data.delivery || null, feedback: data
            });
          } else {
            rec.status = "failed";
          }
        })
        .catch(function () { rec.status = "failed"; })
        .then(function () { if (typeof state.finishProgress === "function") state.finishProgress(); });
    });

    window.showToast("Answer recorded ✓ — scoring in the background.", "ok");

    // Advance immediately — no waiting on the judge.
    state.qIndex++;
    if (state.qIndex >= state.questions.length) finishInterview();
    else renderQuestion();
  }

  // NOTE: mid-interview feedback rendering was removed by design — feedback now
  // appears ONLY on the results screen after /interview/finish.

  function countUp(node, target, dur) {
    target = Math.max(0, Math.round(target));
    var start = null;
    function step(ts) {
      if (start == null) start = ts;
      var p = Math.min(1, (ts - start) / dur);
      var eased = 1 - Math.pow(1 - p, 3);
      node.textContent = String(Math.round(eased * target));
      if (p < 1) requestAnimationFrame(step);
      else node.textContent = String(target);
    }
    requestAnimationFrame(step);
  }

  // ===========================================================================
  // SCREEN: Results
  // ===========================================================================
  function finishInterview() {
    window.STT.tts.cancel();
    stopRecorder();
    renderHeader();

    var answered = state.pending.length;
    var ui = renderFinishing(answered);

    function scoredCount() {
      return state.pending.filter(function (p) {
        return p.status === "done" || p.status === "failed";
      }).length;
    }

    // Stage 1 → 2: wait for the background scoring queue to drain (it may
    // already be done). Live-update the count as each answer settles.
    state.finishProgress = function () { ui.setScoring(scoredCount(), answered); };
    ui.setScoring(scoredCount(), answered);

    Promise.resolve(state.judgeQueue)
      .then(function () {
        state.finishProgress = null;
        ui.doneScoring();
        ui.activateSynthesis();           // Stage 3: server-side overall synthesis
        return window.API.finishInterview(state.interviewId);
      })
      .then(function (data) {
        if (data && data.ok) {
          ui.doneSynthesis();
          ui.activateResults();           // Stage 4: render
          setTimeout(function () { renderResults(data); }, 450);
        } else {
          window.showToast("Could not finalize results.", "error");
          renderLobby();
        }
      })
      .catch(function () {
        window.showToast("Could not finalize results.", "error");
        renderLobby();
      });
  }

  // Staged "finishing" screen: a checklist that advances as scoring → synthesis
  // → results complete, instead of one undifferentiated spinner.
  function renderFinishing(answered) {
    var root = app();
    clear(root);

    function mkRow(label) {
      var icon = el("span", { class: "fin-icon" });
      var sub = el("span", { class: "fin-sub" });
      var r = el("div", { class: "fin-step is-pending" }, [
        icon, el("span", { class: "fin-label", text: label }), sub
      ]);
      r._icon = icon; r._sub = sub;
      return r;
    }
    function setState(r, st) {
      r.classList.remove("is-pending", "is-active", "is-done");
      r.classList.add("is-" + st);
      clear(r._icon);
      if (st === "active") r._icon.appendChild(el("span", { class: "fin-spinner" }));
      else r._icon.textContent = st === "done" ? "✓" : "○";
    }

    var s1 = mkRow("Answers submitted");
    var s2 = mkRow("Scoring your answers");
    var s3 = mkRow("Synthesizing overall feedback");
    var s4 = mkRow("Preparing your results");

    setState(s1, "done"); s1._sub.textContent = answered + " captured";
    setState(s2, "active"); s2._sub.textContent = "0 / " + answered;

    root.appendChild(el("div", { class: "screen screen--center" }, [
      el("div", { class: "card finishing-card screen-in" }, [
        el("h2", { class: "finishing-title", text: "Scoring your interview" }),
        el("p", { class: "finishing-hint", text: "Hang tight — this takes a few seconds." }),
        el("div", { class: "fin-steps" }, [s1, s2, s3, s4])
      ])
    ]));

    return {
      setScoring: function (done, total) { s2._sub.textContent = done + " / " + total; },
      doneScoring: function () { setState(s2, "done"); s2._sub.textContent = answered + " / " + answered; },
      activateSynthesis: function () { setState(s3, "active"); },
      doneSynthesis: function () { setState(s3, "done"); },
      activateResults: function () { setState(s4, "active"); }
    };
  }

  // Merge the API perQuestion (source of truth for scores/feedback) with the
  // client-side transcripts/delivery we accumulated, keyed by questionId.
  function mergedPerQuestion(data) {
    var apiPq = (data && data.perQuestion) || [];
    var localById = {};
    (state.perQuestion || []).forEach(function (r) { localById[r.questionId] = r; });

    if (apiPq.length) {
      return apiPq.map(function (item, i) {
        var local = localById[item.questionId] || {};
        return {
          questionId: item.questionId,
          idx: typeof item.idx === "number" ? item.idx : i,
          prompt: item.prompt || local.prompt || "",
          type: item.type || local.type || null,
          topic: item.topic || local.topic || null,
          score: typeof item.score === "number" ? item.score : (local.score || 0),
          strengths: item.strengths || (local.feedback && local.feedback.strengths) || [],
          improvements: item.improvements || (local.feedback && local.feedback.improvements) || [],
          delivery: item.delivery || (local.feedback && local.feedback.delivery) || null,
          answer: state.answers[item.questionId] || local.transcript || ""
        };
      });
    }
    // Fall back to purely client-side records.
    return (state.perQuestion || []).map(function (r, i) {
      return {
        questionId: r.questionId,
        idx: typeof r.idx === "number" ? r.idx : i,
        prompt: r.prompt || "",
        type: r.type || null,
        topic: r.topic || null,
        score: r.score || 0,
        strengths: (r.feedback && r.feedback.strengths) || [],
        improvements: (r.feedback && r.feedback.improvements) || [],
        delivery: (r.feedback && r.feedback.delivery) || null,
        answer: state.answers[r.questionId] || r.transcript || ""
      };
    });
  }

  function bulletBlock(title, items, cls) {
    if (!items || !items.length) return null;
    return el("div", { class: "ov-block" }, [
      el("h4", { class: "ov-h " + (cls || ""), text: title }),
      el("ul", { class: "fb-list" }, items.map(function (it) { return el("li", { text: String(it) }); }))
    ]);
  }

  function renderResults(data) {
    var root = app();
    clear(root);

    var pq = mergedPerQuestion(data);

    // ---- Hero: big score + badge + rank ----
    var scoreNum = el("span", { class: "score-num score-num--xl", text: "0" });
    var badge = data.personalBestToday
      ? el("div", { class: "best-badge", text: "⭐ Personal best today!" })
      : null;
    var rank = typeof data.rankToday === "number"
      ? el("p", { class: "rank-line" }, ["Today's rank: ", el("strong", { text: "#" + data.rankToday })])
      : null;
    var practiceNote = isPractice()
      ? el("p", { class: "mic-note", text: "Practice mode — this run isn't posted to the leaderboard." })
      : null;

    var hero = el("div", { class: "card results-card screen-in" }, [
      el("h1", { class: "results-title", text: "Interview complete" }),
      el("div", { class: "results-score" }, [
        scoreNum,
        el("span", { class: "score-den score-den--xl", text: "/100" })
      ]),
      badge,
      rank,
      practiceNote
    ]);

    // ---- Overall Feedback panel ----
    var ov = data.overall || {};
    var overallChildren = [el("h2", { class: "panel-title", text: "Overall Feedback" })];
    if (ov.summary) overallChildren.push(el("p", { class: "ov-summary", text: String(ov.summary) }));
    var topStrengths = bulletBlock("Top strengths", ov.topStrengths, "is-good");
    var focusAreas = bulletBlock("Focus areas", ov.focusAreas, "is-warn");
    if (topStrengths) overallChildren.push(topStrengths);
    if (focusAreas) overallChildren.push(focusAreas);
    if (ov.softSkills) {
      overallChildren.push(el("div", { class: "ov-soft" }, [
        el("h4", { class: "ov-h" }, [el("span", { class: "fb-delivery__icon", text: "🎙" }), " Delivery / Soft skills"]),
        el("p", { class: "ov-soft__text", text: String(ov.softSkills) })
      ]));
    }
    var overallPanel = (overallChildren.length > 1)
      ? el("div", { class: "card overall-panel" }, overallChildren)
      : null;

    // ---- Per-question breakdown ----
    var breakdownCards = pq.map(function (item, i) {
      var n = (typeof item.idx === "number" ? item.idx : i) + 1;
      var v = typeof item.score === "number" ? item.score : 0;

      var qDetails = el("details", { class: "pq-collapsible" });
      qDetails.appendChild(el("summary", { text: "Q" + n + " — question text" }));
      qDetails.appendChild(el("p", { class: "pq-prompt", text: item.prompt || "(question unavailable)" }));

      var ansDetails = el("details", { class: "pq-collapsible" });
      ansDetails.appendChild(el("summary", { text: "Your answer" }));
      ansDetails.appendChild(el("p", { class: "pq-answer", text: item.answer || "(no answer captured)" }));

      var strengths = bulletBlock("Strengths", item.strengths, "is-good");
      var improvements = bulletBlock("Improve", item.improvements, "is-warn");

      var deliveryLine = item.delivery
        ? el("div", { class: "fb-delivery" }, [
            el("span", { class: "fb-delivery__icon", text: "🎙" }),
            el("span", { class: "fb-delivery__label", text: "Delivery" }),
            el("span", { class: "fb-delivery__text", text: String(item.delivery) })
          ])
        : null;

      return el("div", { class: "pq-card" }, [
        el("div", { class: "pq-head" }, [
          el("span", { class: "pq-ring", text: String(v) }),
          el("div", { class: "pq-head__meta" }, [
            el("span", { class: "pq-n", text: "Question " + n }),
            item.topic ? el("span", { class: "chip", text: item.topic }) : null
          ])
        ]),
        qDetails,
        ansDetails,
        el("div", { class: "pq-fb" }, [strengths, improvements]),
        deliveryLine
      ]);
    });

    var breakdown = breakdownCards.length
      ? el("div", { class: "card breakdown-panel" }, [
          el("h2", { class: "panel-title", text: "Per-question breakdown" })
        ].concat(breakdownCards))
      : null;

    // ---- "Not saved" warning banner (must sit above Download) ----
    var savedWarning = el("div", { class: "not-saved-banner" }, [
      el("span", { class: "not-saved-banner__icon", text: "⚠️" }),
      el("div", { class: "not-saved-banner__body" }, [
        el("strong", { text: "Your feedback isn't saved anywhere." }),
        " Download it now (below) — once you leave this page it's gone."
      ])
    ]);

    // ---- Actions: Download / Lobby / Leaderboard ----
    var dlBtn = el("button", { class: "btn btn--primary", type: "button", text: "⬇ Download PDF" });
    dlBtn.addEventListener("click", function () { downloadReport(data, pq); });
    var toLobby = el("button", { class: "btn", type: "button", text: "Back to Lobby" });
    toLobby.addEventListener("click", refreshSessionThenLobby);
    var toBoard = el("button", { class: "btn btn--primary", type: "button", text: "View Leaderboard" });
    toBoard.addEventListener("click", function () { renderLeaderboard("results"); });

    var actions = el("div", { class: "results-actions" }, [dlBtn, toLobby, toBoard]);

    // Side rail: warning + actions stay reachable while scrolling the breakdown.
    var rail = el("aside", { class: "results-rail" }, [savedWarning, actions]);
    var main = el("div", { class: "results-main" }, [hero, overallPanel, breakdown]);

    root.appendChild(el("div", { class: "screen screen--wide" }, [
      el("div", { class: "results-layout" }, [main, rail])
    ]));

    countUp(scoreNum, typeof data.interviewScore === "number" ? data.interviewScore : 0, 1100);
  }

  // ---- PDF report (via browser print engine) ------------------------------
  // Builds a clean, self-contained printable HTML report and opens it in a new
  // tab, then calls print() so the user can "Save as PDF". Popup-blocked? Falls
  // back to a downloadable .html the user can open + print.
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function buildReportHtml(data, pq, name, dateStr) {
    var ov = data.overall || {};
    var title = "FDE Interview — " + name + " — " + dateStr;

    function list(items) {
      if (!items || !items.length) return "";
      return "<ul>" + items.map(function (it) { return "<li>" + esc(it) + "</li>"; }).join("") + "</ul>";
    }

    var metaBits = [];
    metaBits.push("<span><strong>Name:</strong> " + esc(name) + "</span>");
    metaBits.push("<span><strong>Date:</strong> " + esc(dateStr) + "</span>");
    metaBits.push("<span><strong>Score:</strong> " +
      (typeof data.interviewScore === "number" ? data.interviewScore : "—") + " / 100</span>");
    if (typeof data.rankToday === "number") metaBits.push("<span><strong>Today's rank:</strong> #" + data.rankToday + "</span>");
    if (data.personalBestToday) metaBits.push("<span><strong>★ Personal best today</strong></span>");

    var overallHtml = "";
    if (ov.summary || (ov.topStrengths && ov.topStrengths.length) || (ov.focusAreas && ov.focusAreas.length) || ov.softSkills) {
      overallHtml += "<section class='block'><h2>Overall Feedback</h2>";
      if (ov.summary) overallHtml += "<p class='summary'>" + esc(ov.summary) + "</p>";
      if (ov.topStrengths && ov.topStrengths.length) overallHtml += "<h3 class='good'>Top strengths</h3>" + list(ov.topStrengths);
      if (ov.focusAreas && ov.focusAreas.length) overallHtml += "<h3 class='warn'>Focus areas</h3>" + list(ov.focusAreas);
      if (ov.softSkills) overallHtml += "<h3>Delivery / Soft skills</h3><p>" + esc(ov.softSkills) + "</p>";
      overallHtml += "</section>";
    }

    var qHtml = (pq || []).map(function (item, i) {
      var n = (typeof item.idx === "number" ? item.idx : i) + 1;
      var score = typeof item.score === "number" ? item.score : "—";
      var s = "<section class='q'>";
      s += "<div class='q-head'><span class='q-score'>" + esc(score) + "</span>";
      s += "<h3>Question " + n + (item.topic ? " <span class='topic'>" + esc(item.topic) + "</span>" : "") + "</h3></div>";
      s += "<p class='qtext'>" + esc(item.prompt || "(question unavailable)") + "</p>";
      s += "<blockquote>" + esc(item.answer || "(no answer captured)") + "</blockquote>";
      if (item.strengths && item.strengths.length) s += "<h4 class='good'>Strengths</h4>" + list(item.strengths);
      if (item.improvements && item.improvements.length) s += "<h4 class='warn'>Improvements</h4>" + list(item.improvements);
      if (item.delivery) s += "<p class='delivery'><strong>Delivery:</strong> " + esc(item.delivery) + "</p>";
      s += "</section>";
      return s;
    }).join("");

    var css =
      "*{box-sizing:border-box}" +
      "body{font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1a1f2e;background:#fff;margin:0;padding:32px;line-height:1.55;}" +
      ".report{max-width:760px;margin:0 auto;}" +
      "h1{font-size:1.6rem;margin:0 0 4px;letter-spacing:-.01em;}" +
      ".brandline{color:#0d9488;font-weight:700;font-size:.85rem;text-transform:uppercase;letter-spacing:.06em;margin:0 0 10px;}" +
      ".meta{display:flex;flex-wrap:wrap;gap:6px 18px;font-size:.92rem;color:#374151;border-bottom:2px solid #e5e7eb;padding-bottom:14px;margin-bottom:20px;}" +
      "h2{font-size:1.2rem;margin:24px 0 8px;border-bottom:1px solid #e5e7eb;padding-bottom:4px;}" +
      "h3{font-size:1rem;margin:14px 0 4px;}h4{font-size:.9rem;margin:10px 0 4px;}" +
      ".good{color:#15803d;}.warn{color:#b45309;}" +
      "ul{margin:4px 0 8px;padding-left:20px;}li{margin:2px 0;}" +
      ".summary{font-size:1rem;}" +
      ".block{page-break-inside:avoid;}" +
      ".q{border:1px solid #e5e7eb;border-radius:10px;padding:14px 16px;margin:14px 0;page-break-inside:avoid;}" +
      ".q-head{display:flex;align-items:center;gap:12px;}" +
      ".q-score{flex:0 0 auto;width:42px;height:42px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:800;color:#0d9488;border:2px solid #0d9488;font-size:.95rem;}" +
      ".q-head h3{margin:0;}" +
      ".topic{font-size:.72rem;font-weight:600;background:#ccfbf1;color:#0f766e;padding:2px 8px;border-radius:999px;vertical-align:middle;}" +
      ".qtext{font-weight:600;margin:8px 0;}" +
      "blockquote{margin:8px 0;padding:8px 14px;border-left:3px solid #0d9488;background:#f8fafc;color:#374151;white-space:pre-wrap;}" +
      ".delivery{font-size:.9rem;color:#4b5563;}" +
      "@media print{body{padding:0;}a{display:none;}}";

    return "<!DOCTYPE html><html><head><meta charset='utf-8'/>" +
      "<title>" + esc(title) + "</title><style>" + css + "</style></head>" +
      "<body><div class='report'>" +
      "<p class='brandline'>⚡ FDE Interview Gauntlet</p>" +
      "<h1>Interview Feedback</h1>" +
      "<div class='meta'>" + metaBits.join("") + "</div>" +
      overallHtml +
      "<h2>Per-question breakdown</h2>" + qHtml +
      "</div></body></html>";
  }

  function downloadReport(data, pq) {
    var name = state.name || "Practice";
    var d = new Date();
    var pad = function (x) { return String(x).padStart(2, "0"); };
    var dateStr = d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());

    var html = buildReportHtml(data, pq, name, dateStr);
    var safeName = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "practice";

    var win = null;
    try { win = window.open("", "_blank"); } catch (e) { win = null; }

    if (win && win.document) {
      try {
        win.document.open();
        win.document.write(html);
        win.document.close();
        // Give the new doc a beat to lay out before invoking print.
        setTimeout(function () {
          try { win.focus(); win.print(); } catch (e) { /* user can print manually */ }
        }, 300);
        return;
      } catch (e) {
        try { win.close(); } catch (e2) { /* no-op */ }
      }
    }

    // Popup-blocker fallback: download a printable .html file instead.
    try {
      var blob = new Blob([html], { type: "text/html;charset=utf-8" });
      var url = URL.createObjectURL(blob);
      var a = el("a", { href: url, download: "fde-interview-" + safeName + "-" + dateStr + ".html" });
      document.body.appendChild(a);
      a.click();
      setTimeout(function () {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 0);
      window.showToast("Allow popups to save as PDF, or open the downloaded file and print.", "warn");
    } catch (e) {
      window.showToast("Could not generate the download.", "error");
    }
  }

  function refreshSessionThenLobby() {
    // re-pull session to update attempts used after a completed interview
    window.API.session(state.name, state.passcode)
      .then(function (data) {
        if (data && data.ok) { state.session = data; state.tier = data.tier || state.tier; }
        renderLobby();
      })
      .catch(function () { renderLobby(); });
  }

  // ===========================================================================
  // SCREEN: Leaderboard
  // ===========================================================================
  function renderLeaderboard(from) {
    window.STT.tts.cancel();
    renderHeader();
    var root = app();
    clear(root);

    var backBtn = el("button", { class: "btn", type: "button" }, [
      from === "results" ? "Back to Lobby" : "← Lobby"
    ]);
    backBtn.addEventListener("click", function () { renderLobby(); });

    var refreshBtn = el("button", { class: "btn btn--ghost", type: "button", text: "↻ Refresh" });

    var mount = el("div", { id: "boardMount" }, [el("div", { class: "loading", text: "Loading leaderboard…" })]);

    var head = el("div", { class: "board-head" }, [
      el("h1", { class: "board-title", text: "Daily Leaderboard" }),
      el("div", { class: "board-head__actions" }, [refreshBtn, backBtn])
    ]);

    root.appendChild(el("div", { class: "screen" }, [head, mount]));

    function load() {
      mount.innerHTML = "";
      mount.appendChild(el("div", { class: "loading", text: "Loading leaderboard…" }));
      refreshBtn.disabled = true;
      window.API.leaderboard()
        .then(function (data) {
          refreshBtn.disabled = false;
          if (data && data.ok) drawBoard(mount, data);
          else { mount.innerHTML = ""; mount.appendChild(el("p", { class: "loading", text: "Leaderboard unavailable." })); }
        })
        .catch(function () {
          refreshBtn.disabled = false;
          mount.innerHTML = "";
          mount.appendChild(el("p", { class: "loading", text: "Could not load leaderboard. Try Refresh." }));
        });
    }
    refreshBtn.addEventListener("click", load);
    load();
  }

  function drawBoard(mount, data) {
    clear(mount);

    if (data.yesterdayWinner) {
      mount.appendChild(el("div", { class: "yesterday" }, [
        "🏆 Yesterday's winner: ",
        el("strong", { text: String(data.yesterdayWinner) })
      ]));
    }

    if (data.date) {
      mount.appendChild(el("p", { class: "board-date", text: "Standings for " + data.date + " (resets daily, US Eastern)" }));
    }

    // Ranking table
    var board = data.board || [];
    if (!board.length) {
      mount.appendChild(el("p", { class: "empty", text: "No interviews logged yet today. Be the first." }));
    } else {
      var table = el("table", { class: "board-table" });
      table.appendChild(el("thead", {}, [
        el("tr", {}, [
          el("th", { text: "#" }),
          el("th", { text: "Name" }),
          el("th", { text: "Tier" }),
          el("th", { class: "num", text: "Best" }),
          el("th", { class: "num", text: "Interviews" })
        ])
      ]));
      var tbody = el("tbody");
      board.forEach(function (row, i) {
        var isMe = row.name === state.name;
        var tr = el("tr", { class: (i === 0 ? "is-leader " : "") + (isMe ? "is-me" : "") }, [
          el("td", { class: "rank-cell", text: String(i + 1) }),
          el("td", { text: String(row.name) }),
          el("td", {}, [row.tier ? el("span", { class: "tier-pill", text: row.tier }) : document.createTextNode("—")]),
          el("td", { class: "num strong", text: String(row.bestScore) }),
          el("td", { class: "num", text: String(row.interviews) })
        ]);
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      mount.appendChild(table);
    }

    // Prize pool panel
    var pools = data.pools || [];
    var panel = el("div", { class: "pool-panel" }, [
      el("h3", { class: "pool-title", text: "💰 Prize Pool" }),
      el("p", { class: "pool-rule", text: "Top scorer each day banks $10 → Amazon gift card at the end. Board resets daily (US Eastern)." })
    ]);
    if (pools.length) {
      var grid = el("div", { class: "pool-grid" });
      pools.forEach(function (p) {
        grid.appendChild(el("div", { class: "pool-cell" }, [
          el("div", { class: "pool-name", text: String(p.name) }),
          el("div", { class: "pool-total", text: "$" + String(p.total) }),
          el("div", { class: "pool-days", text: (p.daysWon || 0) + " day" + ((p.daysWon === 1) ? "" : "s") + " won" })
        ]));
      });
      panel.appendChild(grid);
    } else {
      panel.appendChild(el("p", { class: "empty", text: "No pool entries yet." }));
    }
    mount.appendChild(panel);
  }

  // ===========================================================================
  // Boot
  // ===========================================================================
  function boot() {
    loadCreds();
    if (!window.CONFIG || !window.CONFIG.WORKER_URL || window.CONFIG.WORKER_URL === "REPLACE_WITH_WORKER_URL") {
      window.showToast("Backend not configured yet (config.js WORKER_URL).", "warn");
    }
    // Always start at the gate; creds are prefilled if present.
    renderGate();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
