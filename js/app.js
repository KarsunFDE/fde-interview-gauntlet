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
  var MAX_CHARS = 2000;
  var SOFT_WORD_LIMIT = 275;
  var AMBER_WORDS = 245;
  var TARGET_WORDS = 210;

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
            renderLobby();
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
        ? "🎙 Mic ready — you'll speak your answers. You can edit the transcript before submitting."
        : "⚠ Speech capture isn't supported in this browser. You can still type your answers. (Chrome / Edge recommended.)"
    ]);

    var how = el("div", { class: "how" }, [
      el("h3", { text: "How it works" }),
      el("ol", { class: "how-list" }, [
        el("li", { text: "10 questions, one interview. Each is read aloud." }),
        el("li", { text: "Speak your answer — it transcribes live. Fix typos in the box if needed." }),
        el("li", { text: "Submit and an AI judge scores you /100 across 5 dimensions with feedback." }),
        el("li", { text: "Finish all 10 to post your best score to today's leaderboard." })
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

    var guidance = el("p", {
      class: "answer-guidance",
      text: "Aim for ~90 seconds (~210 words). Keep it concise — limit ~275 words."
    });

    // ---- Transcript box (always present; STT feeds it) ----
    var ta = el("textarea", {
      class: "transcript",
      id: "transcriptBox",
      rows: "6",
      maxlength: String(MAX_CHARS),
      placeholder: window.STT.supported()
        ? "Hit Record and start talking — your words appear here. Edit freely."
        : "Type your answer here…"
    });

    // ---- Live word counter + over-limit nudge ----
    var counter = el("span", { class: "wordcount", text: "0 / " + SOFT_WORD_LIMIT + " words" });
    var nudge = el("p", { class: "len-nudge", text: "A bit long — interviewers tune out after ~90s. Trim if you can." });
    nudge.style.display = "none";
    var limitNote = el("p", { class: "len-limit", text: "Length limit reached — wrap up your answer." });
    limitNote.style.display = "none";

    function atCharLimit() { return (ta.value || "").length >= MAX_CHARS; }
    function atWordLimit() { return countWords(ta.value) >= SOFT_WORD_LIMIT; }
    function atAnyLimit() { return atCharLimit() || atWordLimit(); }

    function updateCounter() {
      var w = countWords(ta.value);
      counter.textContent = w + " / " + SOFT_WORD_LIMIT + " words";
      counter.classList.remove("is-amber", "is-red");
      if (w > SOFT_WORD_LIMIT) counter.classList.add("is-red");
      else if (w > AMBER_WORDS) counter.classList.add("is-amber");
      nudge.style.display = w > SOFT_WORD_LIMIT ? "" : "none";
    }

    // ---- Delivery timing / mode tracking for this answer ----
    var recordStartMs = null; // first time recording started this answer
    var recordStopMs = null;  // last time recording stopped
    var recordedThisAnswer = false;

    var finalSoFar = ""; // committed transcript text
    function composed(interim) {
      return (finalSoFar + (interim ? " " + interim : "")).trim();
    }

    var controls = el("div", { class: "rec-controls" });

    var supported = window.STT.supported();
    var recBtn = null;
    var liveDot = null;

    if (supported) {
      liveDot = el("span", { class: "live-dot" });
      recBtn = el("button", { class: "btn btn--rec", id: "recBtn", type: "button" }, [
        liveDot,
        el("span", { class: "rec-label", text: "Record" })
      ]);

      state.recorder = window.STT.createRecorder({
        atLimit: atAnyLimit,
        onLimit: function () {
          recordStopMs = Date.now();
          limitNote.style.display = "";
        },
        onStart: function () {
          state.recording = true;
          recBtn.classList.add("is-recording");
          $(".rec-label", recBtn).textContent = "Stop";
        },
        onInterim: function (interim) {
          if (atAnyLimit()) return; // stop appending once capped
          ta.value = composed(interim);
          updateCounter();
        },
        onFinal: function (chunk) {
          if (atAnyLimit()) { updateCounter(); return; }
          finalSoFar = (finalSoFar + " " + chunk).trim();
          if (finalSoFar.length > MAX_CHARS) finalSoFar = finalSoFar.slice(0, MAX_CHARS);
          ta.value = finalSoFar;
          updateCounter();
        },
        onError: function (e) {
          var code = e && e.error;
          if (code === "not-allowed" || code === "service-not-allowed") {
            window.showToast("Microphone permission denied. Type your answer instead.", "error");
          } else if (code === "no-speech") {
            // benign; ignore
          } else if (code !== "aborted") {
            window.showToast("Speech recognition error" + (code ? " (" + code + ")" : "") + ".", "warn");
          }
        },
        onEnd: function () {
          state.recording = false;
          if (recordStartMs && !atAnyLimit()) recordStopMs = Date.now();
          recBtn.classList.remove("is-recording");
          $(".rec-label", recBtn).textContent = finalSoFar ? "Resume" : "Record";
        }
      });

      // If the user edits the textarea manually, treat it as the new committed base.
      ta.addEventListener("input", function () {
        if (!state.recording) finalSoFar = ta.value;
        updateCounter();
      });

      recBtn.addEventListener("click", function () {
        if (!state.recorder) return;
        if (state.recorder.isListening()) {
          state.recorder.stop();
          recordStopMs = Date.now();
        } else {
          if (atAnyLimit()) {
            limitNote.style.display = "";
            return;
          }
          // sync base with any manual edits before resuming
          finalSoFar = ta.value;
          recordedThisAnswer = true;
          if (recordStartMs == null) recordStartMs = Date.now();
          state.recorder.start();
        }
      });

      controls.appendChild(recBtn);
      controls.appendChild(el("span", { class: "rec-hint", text: "Speak naturally. Stop and edit anytime." }));
    } else {
      controls.appendChild(el("p", {
        class: "no-stt",
        text: "Speech not supported in this browser — type your answer (Chrome / Edge recommended)."
      }));
      ta.addEventListener("input", updateCounter);
    }

    var submitBtn = el("button", { class: "btn btn--primary", id: "submitBtn", type: "button" }, ["Submit Answer"]);
    submitBtn.addEventListener("click", function () {
      if (state.recording && state.recorder) {
        try { state.recorder.stop(); } catch (e) { /* no-op */ }
        recordStopMs = Date.now();
      } else if (recordStartMs && recordStopMs == null) {
        recordStopMs = Date.now();
      }
      var delivery = buildDelivery(ta.value, recordStartMs, recordStopMs, recordedThisAnswer);
      submitAnswer(q, ta.value, submitBtn, delivery);
    });

    var feedbackMount = el("div", { id: "feedbackMount" });

    var card = el("div", { class: "card q-card screen-in" }, [
      progress,
      meta,
      prompt,
      guidance,
      el("div", { class: "answer-block" }, [
        el("label", { class: "field-label", text: "Your answer" }),
        ta,
        el("div", { class: "answer-foot" }, [counter, limitNote]),
        nudge,
        controls
      ]),
      el("div", { class: "q-actions" }, [submitBtn]),
      feedbackMount
    ]);

    root.appendChild(el("div", { class: "screen" }, [card]));

    // Read the question aloud after paint.
    if (state.ttsOn) {
      setTimeout(function () { window.STT.tts.speak(q.prompt, state.ttsOn); }, 250);
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
    stopRecorder();
    window.STT.tts.cancel();
    btn.disabled = true;
    btn.textContent = "Judging…";
    btn.classList.add("is-loading");

    // Keep the learner's own transcript client-side (the API doesn't echo it back).
    state.answers[q.id] = transcript;

    window.API.judge(state.interviewId, q.id, transcript, delivery)
      .then(function (data) {
        if (data && data.ok) {
          state.perQuestion.push({
            questionId: q.id,
            idx: state.qIndex,
            prompt: q.prompt,
            type: q.type || null,
            topic: q.topic || null,
            score: data.score,
            transcript: transcript,
            words: (delivery && delivery.words) || countWords(transcript),
            delivery: data.delivery || null,
            feedback: data
          });
          renderFeedback(data);
        } else {
          btn.disabled = false;
          btn.textContent = "Submit Answer";
          btn.classList.remove("is-loading");
          window.showToast("Judge could not score that answer.", "error");
        }
      })
      .catch(function () {
        btn.disabled = false;
        btn.textContent = "Submit Answer";
        btn.classList.remove("is-loading");
      });
  }

  var DIM_LABELS = {
    structure: "Structure",
    mindset: "Mindset",
    technical: "Technical",
    communication: "Communication",
    specificity: "Specificity"
  };

  function renderFeedback(data) {
    var mount = $("#feedbackMount");
    if (!mount) return;
    clear(mount);

    // hide submit / record after scoring
    var actions = $(".q-actions");
    if (actions) actions.style.display = "none";
    var ans = $(".answer-block .rec-controls");
    if (ans) ans.style.display = "none";

    var scoreNum = el("span", { class: "score-num", text: "0" });
    var ring = el("div", { class: "score-ring" }, [
      scoreNum,
      el("span", { class: "score-den", text: "/100" })
    ]);

    var dims = el("div", { class: "dims" });
    var d = data.dims || {};
    Object.keys(DIM_LABELS).forEach(function (k) {
      var v = typeof d[k] === "number" ? d[k] : 0;
      var row = el("div", { class: "dim-row" }, [
        el("span", { class: "dim-label", text: DIM_LABELS[k] }),
        el("div", { class: "bar bar--sm" }, [
          el("div", { class: "bar__fill dim-fill", "data-v": String(v), style: "width:0%" })
        ]),
        el("span", { class: "dim-val", text: String(v) })
      ]);
      dims.appendChild(row);
    });

    function bulletList(title, items, cls) {
      if (!items || !items.length) return null;
      return el("div", { class: "fb-col" }, [
        el("h4", { class: "fb-h " + cls, text: title }),
        el("ul", { class: "fb-list" }, items.map(function (it) { return el("li", { text: String(it) }); }))
      ]);
    }

    var deliveryLine = data.delivery
      ? el("div", { class: "fb-delivery" }, [
          el("span", { class: "fb-delivery__icon", text: "🎙" }),
          el("span", { class: "fb-delivery__label", text: "Delivery" }),
          el("span", { class: "fb-delivery__text", text: String(data.delivery) })
        ])
      : null;

    var model = null;
    if (data.modelAnswer) {
      var details = el("details", { class: "model-answer" });
      details.appendChild(el("summary", { text: "What a strong answer hits" }));
      details.appendChild(el("p", { class: "model-body", text: String(data.modelAnswer) }));
      model = details;
    }

    var nextLabel = state.qIndex + 1 >= state.questions.length ? "See Results" : "Next Question";
    var nextBtn = el("button", { class: "btn btn--primary", type: "button" }, [nextLabel]);
    nextBtn.addEventListener("click", function () {
      state.qIndex++;
      if (state.qIndex >= state.questions.length) finishInterview();
      else renderQuestion();
    });

    var card = el("div", { class: "feedback-card reveal-in" }, [
      el("div", { class: "fb-top" }, [
        ring,
        el("div", { class: "fb-dims-wrap" }, [dims])
      ]),
      el("div", { class: "fb-cols" }, [
        bulletList("Strengths", data.strengths, "is-good"),
        bulletList("Improve", data.improvements, "is-warn")
      ]),
      deliveryLine,
      model,
      el("div", { class: "fb-actions" }, [nextBtn])
    ]);

    mount.appendChild(card);
    card.scrollIntoView({ behavior: "smooth", block: "start" });

    // animations: count-up + bar fills
    countUp(scoreNum, typeof data.score === "number" ? data.score : 0, 900);
    setTimeout(function () {
      var fills = mount.querySelectorAll(".dim-fill");
      Array.prototype.forEach.call(fills, function (f) {
        var v = parseInt(f.getAttribute("data-v"), 10) || 0;
        f.style.width = Math.max(0, Math.min(100, v)) + "%";
      });
    }, 120);
  }

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
    var root = app();
    clear(root);
    root.appendChild(el("div", { class: "screen screen--center" }, [
      el("div", { class: "card screen-in", text: "Summarizing…" })
    ]));

    window.API.finishInterview(state.interviewId)
      .then(function (data) {
        if (data && data.ok) renderResults(data);
        else window.showToast("Could not finalize results.", "error");
      })
      .catch(function () { renderLobby(); });
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

    // ---- Actions: Download / Lobby / Leaderboard ----
    var dlBtn = el("button", { class: "btn btn--primary", type: "button", text: "⬇ Download Feedback" });
    dlBtn.addEventListener("click", function () { downloadReport(data, pq); });
    var toLobby = el("button", { class: "btn", type: "button", text: "Back to Lobby" });
    toLobby.addEventListener("click", refreshSessionThenLobby);
    var toBoard = el("button", { class: "btn btn--primary", type: "button", text: "View Leaderboard" });
    toBoard.addEventListener("click", function () { renderLeaderboard("results"); });

    var actions = el("div", { class: "results-actions" }, [dlBtn, toLobby, toBoard]);

    root.appendChild(el("div", { class: "screen" }, [
      hero, overallPanel, breakdown, actions
    ]));

    countUp(scoreNum, typeof data.interviewScore === "number" ? data.interviewScore : 0, 1100);
  }

  // ---- Markdown report + download ----------------------------------------
  function downloadReport(data, pq) {
    var name = state.name || "Practice";
    var d = new Date();
    var pad = function (x) { return String(x).padStart(2, "0"); };
    var dateStr = d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());

    var ov = data.overall || {};
    var lines = [];
    lines.push("# FDE Interview Gauntlet — Feedback");
    lines.push("");
    lines.push("- Name: " + name);
    lines.push("- Date: " + dateStr);
    lines.push("- Interview score: " + (typeof data.interviewScore === "number" ? data.interviewScore : "—") + " / 100");
    if (typeof data.rankToday === "number") lines.push("- Today's rank: #" + data.rankToday);
    if (data.personalBestToday) lines.push("- Personal best today: yes");
    lines.push("");
    lines.push("## Overall Feedback");
    lines.push("");
    if (ov.summary) { lines.push(ov.summary); lines.push(""); }
    if (ov.topStrengths && ov.topStrengths.length) {
      lines.push("### Top strengths");
      ov.topStrengths.forEach(function (s) { lines.push("- " + s); });
      lines.push("");
    }
    if (ov.focusAreas && ov.focusAreas.length) {
      lines.push("### Focus areas");
      ov.focusAreas.forEach(function (s) { lines.push("- " + s); });
      lines.push("");
    }
    if (ov.softSkills) {
      lines.push("### Delivery / Soft skills");
      lines.push(ov.softSkills);
      lines.push("");
    }

    lines.push("## Per-question breakdown");
    lines.push("");
    (pq || []).forEach(function (item, i) {
      var n = (typeof item.idx === "number" ? item.idx : i) + 1;
      lines.push("### Q" + n + (item.topic ? " — " + item.topic : ""));
      lines.push("");
      lines.push("**Question:** " + (item.prompt || "(unavailable)"));
      lines.push("");
      lines.push("**Your answer:**");
      lines.push("");
      lines.push("> " + String(item.answer || "(no answer captured)").replace(/\n/g, "\n> "));
      lines.push("");
      lines.push("**Score:** " + (typeof item.score === "number" ? item.score : "—") + " / 100");
      lines.push("");
      if (item.strengths && item.strengths.length) {
        lines.push("**Strengths:**");
        item.strengths.forEach(function (s) { lines.push("- " + s); });
        lines.push("");
      }
      if (item.improvements && item.improvements.length) {
        lines.push("**Improvements:**");
        item.improvements.forEach(function (s) { lines.push("- " + s); });
        lines.push("");
      }
      if (item.delivery) {
        lines.push("**Delivery:** " + item.delivery);
        lines.push("");
      }
    });

    var md = lines.join("\n");
    var safeName = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "practice";
    var filename = "fde-interview-" + safeName + "-" + dateStr + ".md";

    try {
      var blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
      var url = URL.createObjectURL(blob);
      var a = el("a", { href: url, download: filename });
      document.body.appendChild(a);
      a.click();
      setTimeout(function () {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 0);
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
