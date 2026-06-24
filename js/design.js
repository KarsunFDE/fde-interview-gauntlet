// design.js — System Design Simulator flow for the FDE Gauntlet.
// Self-contained IIFE. Reuses window.API (api.js), window.STT (stt.js),
// window.showToast, window.CONFIG. Excalidraw + React load from CDN (see
// index.html); this module mounts/reads the canvas.
//
// Flow: track-select -> scenario-pick -> workspace (draw + clarify-chat, 20min)
//   -> spoken explanation -> dual-critic scoring -> results + 2 re-think
//   follow-ups (spoken) -> finalize -> leaderboards.
//
// Exposes window.DESIGN.open(creds, onExit) and window.DESIGN.boards(creds, onExit).

(function () {
  "use strict";

  // ---- local state ----
  var S = {
    name: null, passcode: null, tier: null,
    onExit: null,
    track: null,
    scenario: null,
    sessionId: null,
    deadlineAt: 0,
    clarify: [],            // {role, text}
    exApi: null,            // Excalidraw imperative API
    exRoot: null,           // React root (to unmount)
    snapTimer: null,
    countdownTimer: null,
    lastSnapLen: 0,
    submitResult: null,     // /design/submit payload
    explanation: "",
    explanationDelivery: null,
    followAnswers: []       // [{question, transcript, delivery}]
  };

  // ---- DOM helpers (mirror app.js) ----
  function $(sel, root) { return (root || document).querySelector(sel); }
  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === "class") n.className = attrs[k];
      else if (k === "text") n.textContent = attrs[k];
      else if (k === "html") n.innerHTML = attrs[k];
      else n.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) {
      if (c == null) return;
      n.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return n;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function appRoot() { return $("#app"); }
  function toast(m, k) { if (window.showToast) window.showToast(m, k || "error"); }

  function countWords(s) { s = (s || "").trim(); return s ? s.split(/\s+/).length : 0; }
  function fmtClock(ms) {
    var t = Math.max(0, Math.ceil(ms / 1000));
    var m = Math.floor(t / 60), s = t % 60;
    return m + ":" + (s < 10 ? "0" : "") + s;
  }
  var FILLERS = ["um", "uh", "uhh", "er", "erm", "ah", "like", "you know", "kind of", "sort of", "i mean"];
  function countFillers(s) {
    s = " " + (s || "").toLowerCase() + " "; var n = 0;
    FILLERS.forEach(function (w) {
      var re = new RegExp("(^|[^a-z])" + w.replace(/ /g, "\\s+") + "([^a-z]|$)", "g"), m;
      while ((m = re.exec(s)) !== null) { n++; re.lastIndex = m.index + 1; }
    });
    return n;
  }
  function buildDelivery(transcript, startMs, stopMs, recorded) {
    var words = countWords(transcript);
    var durationMs = (recorded && startMs && stopMs && stopMs > startMs) ? (stopMs - startMs) : null;
    var mode = recorded ? "speech" : "typed";
    var wpm = (durationMs && mode === "speech") ? Math.round(words / (durationMs / 60000)) : null;
    var fc = countFillers(transcript);
    return { durationMs: durationMs, words: words, wpm: wpm, fillerCount: fc, mode: mode };
  }

  function cleanup() {
    if (S.snapTimer) { clearInterval(S.snapTimer); S.snapTimer = null; }
    if (S.countdownTimer) { clearInterval(S.countdownTimer); S.countdownTimer = null; }
    if (window.STT && window.STT.tts) window.STT.tts.cancel();
    unmountExcalidraw();
  }

  function exit() {
    cleanup();
    var cb = S.onExit;
    // reset transient session state but keep creds
    S.scenario = null; S.sessionId = null; S.clarify = []; S.submitResult = null;
    S.explanation = ""; S.followAnswers = [];
    if (typeof cb === "function") cb();
  }

  // =====================================================================
  // Excalidraw mount / read
  // =====================================================================
  function excalidrawReady() {
    return !!(window.ExcalidrawLib && window.React && window.ReactDOM && window.ExcalidrawLib.Excalidraw);
  }

  function mountExcalidraw(container, initialData) {
    if (!excalidrawReady()) return false;
    var React = window.React, ReactDOM = window.ReactDOM, Lib = window.ExcalidrawLib;
    var element = React.createElement(Lib.Excalidraw, {
      initialData: initialData || { appState: { viewBackgroundColor: "#fbfbfd" } },
      excalidrawAPI: function (api) { S.exApi = api; },
      UIOptions: { canvasActions: { loadScene: false, saveToActiveFile: false, export: false, saveAsImage: false } }
    });
    try {
      if (ReactDOM.createRoot) {
        S.exRoot = ReactDOM.createRoot(container);
        S.exRoot.render(element);
      } else {
        ReactDOM.render(element, container); // React 17 fallback
        S.exRoot = { _legacy: container };
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  function unmountExcalidraw() {
    try {
      if (S.exRoot && S.exRoot.unmount) S.exRoot.unmount();
      else if (S.exRoot && S.exRoot._legacy && window.ReactDOM && window.ReactDOM.unmountComponentAtNode)
        window.ReactDOM.unmountComponentAtNode(S.exRoot._legacy);
    } catch (e) { /* no-op */ }
    S.exRoot = null; S.exApi = null;
  }

  function getSceneJson() {
    if (!S.exApi) return null;
    try {
      var elements = S.exApi.getSceneElements() || [];
      var appState = S.exApi.getAppState ? S.exApi.getAppState() : {};
      var files = S.exApi.getFiles ? S.exApi.getFiles() : {};
      // Strip volatile/huge appState fields; keep scene shape.
      var slim = { viewBackgroundColor: appState.viewBackgroundColor || "#ffffff" };
      return JSON.stringify({ type: "excalidraw", version: 2, elements: elements, appState: slim, files: files });
    } catch (e) { return null; }
  }

  function exportPngDataUrl() {
    if (!S.exApi || !window.ExcalidrawLib || !window.ExcalidrawLib.exportToBlob) return Promise.resolve(null);
    try {
      var elements = S.exApi.getSceneElements() || [];
      if (!elements.length) return Promise.resolve(null);
      var appState = S.exApi.getAppState ? S.exApi.getAppState() : {};
      var files = S.exApi.getFiles ? S.exApi.getFiles() : {};
      return window.ExcalidrawLib.exportToBlob({
        elements: elements,
        appState: { exportBackground: true, viewBackgroundColor: "#ffffff", exportWithDarkMode: false },
        files: files,
        mimeType: "image/png",
        quality: 0.8,
        getDimensions: function (w, h) {
          // cap the longest side ~1400px to keep the payload small
          var max = 1400, scale = Math.min(1, max / Math.max(w, h));
          return { width: Math.round(w * scale), height: Math.round(h * scale), scale: scale };
        }
      }).then(function (blob) {
        return new Promise(function (res) {
          var r = new FileReader();
          r.onloadend = function () { res(r.result); };
          r.onerror = function () { res(null); };
          r.readAsDataURL(blob);
        });
      }).catch(function () { return null; });
    } catch (e) { return Promise.resolve(null); }
  }

  // =====================================================================
  // SCREEN: track select
  // =====================================================================
  function renderTrackSelect() {
    cleanup();
    var root = appRoot();
    clear(root);

    function card(track, title, blurb, examples) {
      var c = el("button", { class: "card sd-track-card", type: "button" }, [
        el("h2", { class: "sd-track-title", text: title }),
        el("p", { class: "sd-track-blurb", text: blurb }),
        el("p", { class: "sd-track-eg", text: examples })
      ]);
      c.addEventListener("click", function () { loadScenarios(track); });
      return c;
    }

    var back = el("button", { class: "btn btn--ghost", type: "button", text: "← Back" });
    back.addEventListener("click", exit);

    root.appendChild(el("div", { class: "screen" }, [
      el("div", { class: "sd-head" }, [
        el("div", {}, [
          el("h1", { class: "board-title", text: "System Design Simulator" }),
          el("p", { class: "sd-sub", text: "Scope the problem first. Design it. Defend the WHY. Then adapt when the ground shifts." })
        ]),
        back
      ]),
      el("div", { class: "sd-track-grid" }, [
        card("fullstack", "Full-Stack System Design",
          "Classic services & data systems: APIs, schemas, scale, consistency, failure modes.",
          "e.g. rate limiter · multi-tenant schema · grants intake · payment flow"),
        card("agentic", "AI / Agentic System Design",
          "LLM-native systems: RAG pipelines, agents, HITL, evals, retrieval at scale.",
          "e.g. ingestion pipeline · multi-tenant RAG · agentic HITL · fine-tune vs RAG")
      ]),
      el("p", { class: "sd-note", text: "You'll get a loose client brief. Ask the client clarifying questions in the side chat before you design — scoping is graded." })
    ]));
  }

  function loadScenarios(track) {
    S.track = track;
    var root = appRoot();
    clear(root);
    root.appendChild(el("div", { class: "screen screen--center" }, [
      el("div", { class: "loading", text: "Loading scenarios…" })
    ]));
    window.API.designScenarios(S.name, S.passcode, track)
      .then(function (data) {
        if (data && data.ok) renderScenarioPicker(data);
        else toast("Could not load scenarios.");
      })
      .catch(function () { /* toast already shown */ });
  }

  // =====================================================================
  // SCREEN: scenario picker
  // =====================================================================
  function renderScenarioPicker(data) {
    cleanup();
    var root = appRoot();
    clear(root);

    var completed = {};
    (data.completed || []).forEach(function (id) { completed[id] = true; });

    var back = el("button", { class: "btn btn--ghost", type: "button", text: "← Tracks" });
    back.addEventListener("click", renderTrackSelect);

    var cards = (data.scenarios || []).map(function (sc) {
      var done = !!completed[sc.id];
      var startBtn = el("button", { class: "btn btn--primary", type: "button", text: done ? "Practice again" : "Start (20 min)" });
      startBtn.addEventListener("click", function () { startSession(sc); });
      return el("div", { class: "card sd-scenario-card" }, [
        el("div", { class: "sd-scenario-top" }, [
          el("h3", { class: "sd-scenario-title", text: sc.title }),
          done ? el("span", { class: "sd-done-badge", text: "✓ done" }) : null
        ]),
        sc.tier && sc.tier !== "both" ? el("span", { class: "tier-pill", text: sc.tier + " focus" }) : null,
        el("p", { class: "sd-brief", text: sc.clientBrief }),
        el("p", { class: "sd-live" }, [
          el("span", { class: "sd-live__label", text: "Grounded in: " }),
          sc.sourceUrl
            ? el("a", { class: "sd-live__link", href: sc.sourceUrl, target: "_blank", rel: "noopener", text: sc.liveSystem })
            : el("span", { text: sc.liveSystem || "" })
        ]),
        el("div", { class: "sd-scenario-actions" }, [startBtn])
      ]);
    });

    if (!cards.length) cards.push(el("p", { class: "empty", text: "No scenarios available for your track yet." }));

    root.appendChild(el("div", { class: "screen" }, [
      el("div", { class: "sd-head" }, [
        el("h1", { class: "board-title", text: (S.track === "agentic" ? "AI / Agentic" : "Full-Stack") + " Scenarios" }),
        back
      ]),
      el("p", { class: "sd-note", text: "Pick one. Unlimited practice — only your best each day counts on the board. Completed ones can be redone." }),
      el("div", { class: "sd-scenario-grid" }, cards)
    ]));
  }

  function startSession(sc) {
    var root = appRoot();
    clear(root);
    root.appendChild(el("div", { class: "screen screen--center" }, [el("div", { class: "loading", text: "Opening session…" })]));
    window.API.designStart(S.name, S.passcode, sc.id)
      .then(function (data) {
        if (data && data.ok) {
          S.sessionId = data.sessionId;
          S.deadlineAt = data.deadlineAt;
          S.scenario = data.scenario;
          S.clarify = [];
          S.submitResult = null;
          S.explanation = "";
          S.followAnswers = [];
          renderWorkspace();
        } else {
          toast("Could not start the session.");
          renderTrackSelect();
        }
      })
      .catch(function () { renderTrackSelect(); });
  }

  // =====================================================================
  // SCREEN: workspace (Excalidraw + clarify chat + countdown)
  // =====================================================================
  function renderWorkspace() {
    var root = appRoot();
    clear(root);
    var sc = S.scenario;

    // --- countdown ---
    var countdown = el("span", { class: "sd-countdown", text: fmtClock(S.deadlineAt - Date.now()) });

    var doneBtn = el("button", { class: "btn btn--primary", type: "button", text: "Done → Explain & submit" });
    doneBtn.addEventListener("click", function () { goExplain(); });

    var exitBtn = el("button", { class: "btn btn--ghost", type: "button", text: "Abandon" });
    exitBtn.addEventListener("click", function () {
      if (window.confirm("Abandon this design session? Your work won't be scored.")) exit();
    });

    var topbar = el("div", { class: "sd-topbar" }, [
      el("div", { class: "sd-topbar__title" }, [
        el("span", { class: "sd-topbar__name", text: sc.title }),
        el("span", { class: "sd-chip", text: S.track === "agentic" ? "AI / Agentic" : "Full-Stack" })
      ]),
      el("div", { class: "sd-topbar__right" }, [
        el("span", { class: "sd-countdown-label", text: "Time left" }),
        countdown, doneBtn, exitBtn
      ])
    ]);

    // --- brief (collapsible, stays visible) ---
    var brief = el("details", { class: "sd-brief-box", open: "open" }, [
      el("summary", { text: "Client brief" }),
      el("p", { class: "sd-brief-text", text: sc.clientBrief }),
      el("p", { class: "sd-brief-hint", text: "This is deliberately vague. Ask the client questions on the right to uncover data, volume, latency, security, and success criteria before you design." })
    ]);

    // --- canvas ---
    var canvasMount = el("div", { class: "sd-canvas", id: "sdCanvas" });

    // --- clarify chat ---
    var chatLog = el("div", { class: "sd-chat-log", id: "sdChatLog" }, [
      el("div", { class: "sd-chat-sys", text: "Ask the client anything to scope the problem. They answer only what you ask — they won't volunteer or design it for you." })
    ]);
    var chatInput = el("textarea", { class: "sd-chat-input", id: "sdChatInput", rows: "2", placeholder: "Ask a clarifying question… (e.g. What's the expected query volume?)" });
    var micBtn = el("button", { class: "btn btn--ghost sd-mic", type: "button", title: "Speak your question", text: "🎙" });
    var sendBtn = el("button", { class: "btn btn--primary sd-send", type: "button", text: "Ask" });

    var chat = el("div", { class: "sd-chat" }, [
      el("div", { class: "sd-chat-head", text: "Clarify with the client" }),
      chatLog,
      el("div", { class: "sd-chat-row" }, [chatInput, el("div", { class: "sd-chat-btns" }, [micBtn, sendBtn])])
    ]);

    var workspace = el("div", { class: "sd-workspace" }, [
      el("div", { class: "sd-canvas-col" }, [brief, canvasMount]),
      chat
    ]);

    root.appendChild(el("div", { class: "screen screen--wide" }, [topbar, workspace]));

    // mount Excalidraw
    var ok = mountExcalidraw(canvasMount, sc.starterScene ? safeParse(sc.starterScene) : null);
    if (!ok) {
      clear(canvasMount);
      canvasMount.appendChild(el("div", { class: "sd-canvas-fallback" }, [
        el("p", { text: "⚠ The diagram canvas failed to load (Excalidraw/CDN). You can still scope via chat and describe your design in the explanation step, but drawing is unavailable. Try a hard refresh on Chrome/Edge." })
      ]));
    }

    // wire chat
    function pushTurn(role, text) {
      S.clarify.push({ role: role, text: text });
      chatLog.appendChild(el("div", { class: "sd-chat-turn sd-chat-turn--" + role }, [
        el("span", { class: "sd-chat-role", text: role === "client" ? "Client" : "You" }),
        el("span", { class: "sd-chat-text", text: text })
      ]));
      chatLog.scrollTop = chatLog.scrollHeight;
    }

    var asking = false, recMode = "typed", recorder = null, recording = false;
    function sendQuestion() {
      var q = (chatInput.value || "").trim();
      if (!q) { toast("Type or speak a question first.", "warn"); return; }
      if (Date.now() > S.deadlineAt) { toast("Time's up — move to your explanation.", "warn"); return; }
      asking = true; sendBtn.disabled = true; sendBtn.textContent = "…";
      pushTurn("learner", q);
      chatInput.value = "";
      var thinking = el("div", { class: "sd-chat-turn sd-chat-turn--client is-thinking" }, [
        el("span", { class: "sd-chat-role", text: "Client" }),
        el("span", { class: "sd-chat-text", text: "…" })
      ]);
      chatLog.appendChild(thinking); chatLog.scrollTop = chatLog.scrollHeight;
      window.API.designClarify(S.sessionId, q, recMode)
        .then(function (data) {
          if (thinking.parentNode) thinking.parentNode.removeChild(thinking);
          asking = false; sendBtn.disabled = false; sendBtn.textContent = "Ask";
          recMode = "typed";
          if (data && data.ok) pushTurn("client", data.answer);
          else if (data && data.error === "time_expired") { toast("Time's up — move to your explanation.", "warn"); goExplain(); }
          else toast("The client didn't respond. Try again.", "warn");
        })
        .catch(function () {
          if (thinking.parentNode) thinking.parentNode.removeChild(thinking);
          asking = false; sendBtn.disabled = false; sendBtn.textContent = "Ask";
        });
    }
    sendBtn.addEventListener("click", sendQuestion);
    chatInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendQuestion(); }
    });

    // mic for the clarify question (fills the input; learner reviews then sends)
    micBtn.addEventListener("click", function () {
      if (!window.STT || !window.STT.supported()) { toast("Speech not supported here — type instead.", "warn"); return; }
      if (recording) {
        try { recorder.stop(); } catch (e) {} recording = false; micBtn.classList.remove("is-rec"); micBtn.textContent = "🎙";
        return;
      }
      recorder = window.STT.createRecorder({
        onStart: function () { recording = true; micBtn.classList.add("is-rec"); micBtn.textContent = "⏹"; },
        onUpdate: function (t) { chatInput.value = t; recMode = "speech"; },
        onError: function () { recording = false; micBtn.classList.remove("is-rec"); micBtn.textContent = "🎙"; },
        onEnd: function () { recording = false; micBtn.classList.remove("is-rec"); micBtn.textContent = "🎙"; }
      });
      recorder.start();
    });

    // countdown tick
    S.countdownTimer = setInterval(function () {
      var rem = S.deadlineAt - Date.now();
      countdown.textContent = fmtClock(rem);
      countdown.classList.toggle("is-amber", rem <= 5 * 60000 && rem > 60000);
      countdown.classList.toggle("is-red", rem <= 60000);
      if (rem <= 0) {
        clearInterval(S.countdownTimer); S.countdownTimer = null;
        toast("Time's up. Capture your explanation and submit.", "warn");
        goExplain();
      }
    }, 1000);

    // periodic scene snapshots (process timeline; skip if unchanged)
    S.lastSnapLen = 0;
    S.snapTimer = setInterval(function () {
      var sj = getSceneJson();
      if (!sj || sj.length === S.lastSnapLen) return;
      S.lastSnapLen = sj.length;
      window.API.designSnapshot(S.sessionId, sj);
    }, 25000);
  }

  function safeParse(s) { try { return typeof s === "string" ? JSON.parse(s) : s; } catch (e) { return null; } }

  // =====================================================================
  // SCREEN: spoken explanation (before submit)
  // =====================================================================
  function goExplain() {
    // capture final scene + png BEFORE tearing down Excalidraw
    var sceneJson = getSceneJson();
    exportPngDataUrl().then(function (png) {
      S._sceneJson = sceneJson;
      S._scenePng = png;
      if (S.snapTimer) { clearInterval(S.snapTimer); S.snapTimer = null; }
      if (S.countdownTimer) { clearInterval(S.countdownTimer); S.countdownTimer = null; }
      renderExplain();
    });
  }

  var EXPLAIN_MAX_MS = 150000; // 2:30 for the design narration
  function renderExplain() {
    unmountExcalidraw();
    if (window.STT && window.STT.tts) window.STT.tts.cancel();
    var root = appRoot();
    clear(root);

    var supported = window.STT && window.STT.supported();
    var stage = el("div", { class: "q-stage", id: "explainStage" });

    var card = el("div", { class: "card q-card screen-in" }, [
      el("h2", { class: "q-prompt", text: "Explain your design" }),
      el("p", { class: "sd-explain-hint", text: "Walk through your design out loud as if presenting to the client: what you built, WHY you made each major choice, the tradeoffs and alternatives, and how it holds up under failure — not just the happy path. This is graded for deliverability." }),
      S._scenePng ? el("img", { class: "sd-explain-thumb", src: S._scenePng, alt: "Your diagram" }) : el("p", { class: "sd-explain-nodiagram", text: "(No diagram captured — describe your design fully in words.)" }),
      stage
    ]);
    root.appendChild(el("div", { class: "screen" }, [card]));

    var recStartMs = null, recStopMs = null, recorded = false, recorder = null;
    function renderReady() {
      clear(stage);
      var recBtn = el("button", { class: "btn btn--primary btn--lg", type: "button", text: "🎙 Record explanation" });
      recBtn.addEventListener("click", renderRecording);
      var typeBtn = el("button", { class: "btn btn--ghost", type: "button", text: "Type instead" });
      typeBtn.addEventListener("click", function () { renderReview("", "typed"); });
      stage.appendChild(el("div", { class: "ready-block" }, [recBtn, el("p", { class: "answer-guidance", text: "Up to 2:30. You'll review the transcript before submitting." }), supported ? typeBtn : null]));
      if (!supported) renderReview("", "typed");
    }
    function renderRecording() {
      clear(stage);
      var countdown = el("div", { class: "rec-countdown", text: fmtClock(EXPLAIN_MAX_MS) });
      var stopBtn = el("button", { class: "btn btn--primary", type: "button", text: "⏹ Stop & review" });
      var wordHint = el("span", { class: "rec-wordhint", text: "~0 words" });
      var tick = null, hard = null, stopped = false;
      function stopAndReview() {
        if (stopped) return; stopped = true;
        if (tick) clearInterval(tick); if (hard) clearTimeout(hard);
        recStopMs = Date.now();
        var txt = (recorder && recorder.getTranscript) ? recorder.getTranscript() : "";
        try { recorder.stop(); } catch (e) {}
        renderReview(txt, "speech");
      }
      stopBtn.addEventListener("click", stopAndReview);
      recorder = window.STT.createRecorder({
        onStart: function () {},
        onUpdate: function (t) { wordHint.textContent = "~" + countWords(t) + " words"; },
        onError: function (e) { var c = e && e.error; if (c === "not-allowed" || c === "service-not-allowed") { toast("Mic denied — type instead.", "error"); renderReview("", "typed"); } },
        onEnd: function () {}
      });
      stage.appendChild(el("div", { class: "recording-block" }, [
        countdown, el("div", { class: "rec-status" }, [el("span", { class: "rec-pulse-dot" }), el("span", { text: "Recording…" })]),
        el("div", { class: "rec-hintrow" }, [wordHint]), el("div", { class: "q-actions" }, [stopBtn])
      ]));
      recorded = true; recStartMs = Date.now();
      recorder.start();
      tick = setInterval(function () {
        var rem = EXPLAIN_MAX_MS - (Date.now() - recStartMs); if (rem < 0) rem = 0;
        countdown.textContent = fmtClock(rem);
        countdown.classList.toggle("is-red", rem <= 10000);
        countdown.classList.toggle("is-amber", rem <= 30000 && rem > 10000);
      }, 250);
      hard = setTimeout(stopAndReview, EXPLAIN_MAX_MS);
    }
    function renderReview(transcript, mode) {
      clear(stage);
      var ta = el("textarea", { class: "transcript", rows: "7", maxlength: "3000", placeholder: "Your explanation…" });
      ta.value = transcript || "";
      var submitBtn = el("button", { class: "btn btn--primary", type: "button", text: "Submit design for review" });
      submitBtn.addEventListener("click", function () {
        var text = (ta.value || "").trim();
        if (!text) { if (!window.confirm("Submit with no explanation? Deliverability will score low.")) return; }
        S.explanation = text;
        S.explanationDelivery = buildDelivery(text, mode === "speech" ? recStartMs : null, mode === "speech" ? recStopMs : null, mode === "speech" && recorded);
        submitDesign(submitBtn);
      });
      var reBtn = el("button", { class: "btn btn--ghost", type: "button", text: mode === "typed" ? "Clear" : "↺ Re-record" });
      reBtn.addEventListener("click", function () {
        if (mode === "typed") { ta.value = ""; ta.focus(); }
        else if (window.confirm("Re-record the whole explanation?")) { recorded = false; renderReady(); }
      });
      stage.appendChild(el("div", { class: "review-block" }, [
        mode === "speech" ? el("p", { class: "edit-note" }, [el("strong", { text: "Fix transcription errors only" }), " — don't rewrite."]) : null,
        el("div", { class: "answer-block" }, [el("label", { class: "field-label", text: "Your explanation" }), ta]),
        el("div", { class: "q-actions" }, [submitBtn, reBtn])
      ]));
      if (mode === "typed") ta.focus();
    }
    if (supported) renderReady(); else renderReview("", "typed");
  }

  // =====================================================================
  // SCORING + results
  // =====================================================================
  function submitDesign(btn) {
    if (btn) { btn.disabled = true; btn.textContent = "Submitting…"; }
    renderScoring();
    window.API.designSubmit(S.sessionId, {
      sceneJson: S._sceneJson,
      scenePng: S._scenePng,
      explanation: S.explanation,
      delivery: S.explanationDelivery
    }).then(function (data) {
      if (data && data.ok) { S.submitResult = data; renderResults(data); }
      else { toast("Scoring failed."); renderTrackSelect(); }
    }).catch(function () { renderTrackSelect(); });
  }

  function renderScoring() {
    var root = appRoot();
    clear(root);
    function row(label) {
      return el("div", { class: "fin-step is-active" }, [el("span", { class: "fin-icon" }, [el("span", { class: "fin-spinner" })]), el("span", { class: "fin-label", text: label })]);
    }
    root.appendChild(el("div", { class: "screen screen--center" }, [
      el("div", { class: "card finishing-card screen-in" }, [
        el("h2", { class: "finishing-title", text: "Two experts are reviewing your design" }),
        el("p", { class: "finishing-hint", text: "A systems-design expert and a senior FDE are scoring in parallel, then writing your feedback." }),
        el("div", { class: "fin-steps" }, [row("Systems-design critic"), row("Senior-FDE critic"), row("Reconciling & preparing follow-ups")])
      ])
    ]));
  }

  function bullets(title, items, cls) {
    if (!items || !items.length) return null;
    return el("div", { class: "ov-block" }, [
      el("h4", { class: "ov-h " + (cls || ""), text: title }),
      el("ul", { class: "fb-list" }, items.map(function (it) { return el("li", { text: String(it) }); }))
    ]);
  }

  function dimBar(label, val) {
    var v = typeof val === "number" ? val : 0;
    return el("div", { class: "sd-dim" }, [
      el("div", { class: "sd-dim__top" }, [el("span", { class: "sd-dim__label", text: label }), el("span", { class: "sd-dim__val", text: String(v) })]),
      el("div", { class: "bar" }, [el("div", { class: "bar__fill", style: "width:" + v + "%" })])
    ]);
  }

  function renderResults(data) {
    cleanup();
    var root = appRoot();
    clear(root);
    var d = data.dims || {};

    var hero = el("div", { class: "card results-card screen-in" }, [
      el("h1", { class: "results-title", text: "Design reviewed" }),
      el("div", { class: "results-score" }, [
        el("span", { class: "score-num score-num--xl", text: String(typeof data.scorePre === "number" ? data.scorePre : 0) }),
        el("span", { class: "score-den score-den--xl", text: "/100" })
      ]),
      el("p", { class: "sd-prelim", text: "Preliminary — your final score includes the adaptability round below." })
    ]);

    var dims = el("div", { class: "card sd-dims-panel" }, [
      el("h2", { class: "panel-title", text: "Scores" }),
      dimBar("Completeness", d.completeness),
      dimBar("Design quality", d.design_quality),
      dimBar("Scoping (your clarifying questions)", d.scoping),
      dimBar("Deliverability (the WHY)", d.deliverability)
    ]);

    var fbChildren = [el("h2", { class: "panel-title", text: "Two-critic feedback" })];
    if (data.summary) fbChildren.push(el("p", { class: "ov-summary", text: data.summary }));
    var ts = bullets("What you did well", data.topStrengths, "is-good");
    var fa = bullets("Focus areas", data.focusAreas, "is-warn");
    var mq = bullets("Questions you should have asked", data.questionsYouShouldHaveAsked, "is-warn");
    var ai = bullets("Actionable next time", data.actionableItems, "is-good");
    [ts, fa, mq, ai].forEach(function (x) { if (x) fbChildren.push(x); });
    var fbPanel = el("div", { class: "card overall-panel" }, fbChildren);

    // ---- follow-ups (the re-think drill) ----
    var followups = data.followups || [];
    var fuPanel = el("div", { class: "card sd-followup-panel" }, [
      el("h2", { class: "panel-title", text: "Re-think your design (adaptability round)" }),
      el("p", { class: "sd-fu-hint", text: "The ground just shifted. Answer each out loud — rework your design live and narrate the tradeoff. This is scored for adaptability and folded into your final score." })
    ]);
    var fuStateEls = [];
    followups.forEach(function (fu, i) {
      var status = el("span", { class: "sd-fu-status", text: "Not answered" });
      var recBtn = el("button", { class: "btn btn--primary", type: "button", text: "🎙 Record answer" });
      var box = el("div", { class: "sd-fu-item" }, [
        el("div", { class: "sd-fu-q" }, [el("span", { class: "sd-fu-n", text: "#" + (i + 1) }), el("span", { text: fu.question })]),
        el("div", { class: "sd-fu-actions" }, [recBtn, status])
      ]);
      fuStateEls.push({ status: status, recBtn: recBtn, answered: false });
      recBtn.addEventListener("click", function () { recordFollowup(i, fu, fuStateEls[i]); });
      fuPanel.appendChild(box);
    });
    var finalizeBtn = el("button", { class: "btn btn--primary btn--lg", type: "button", text: "Submit follow-ups & see final score" });
    finalizeBtn.addEventListener("click", function () { finalizeFollowups(followups, finalizeBtn); });
    fuPanel.appendChild(el("div", { class: "sd-fu-finalize" }, [finalizeBtn]));

    S.followAnswers = followups.map(function (fu) { return { question: fu.question, transcript: "", delivery: null }; });

    var main = el("div", { class: "results-main" }, [hero, dims, fbPanel, fuPanel]);
    root.appendChild(el("div", { class: "screen screen--wide" }, [main]));
  }

  // record a single follow-up answer (modal-ish inline recorder)
  function recordFollowup(idx, fu, stEl) {
    if (!window.STT || !window.STT.supported()) {
      var typed = window.prompt("Speech not supported — type your reworked answer:", S.followAnswers[idx].transcript || "");
      if (typed != null) {
        S.followAnswers[idx].transcript = typed.trim();
        S.followAnswers[idx].delivery = buildDelivery(typed, null, null, false);
        markFollowAnswered(stEl, typed.trim());
      }
      return;
    }
    // overlay recorder
    var overlay = el("div", { class: "sd-rec-overlay" });
    var countdown = el("div", { class: "rec-countdown", text: fmtClock(120000) });
    var wordHint = el("span", { class: "rec-wordhint", text: "~0 words" });
    var stopBtn = el("button", { class: "btn btn--primary", type: "button", text: "⏹ Stop" });
    overlay.appendChild(el("div", { class: "sd-rec-card" }, [
      el("p", { class: "sd-rec-q", text: fu.question }),
      countdown, el("div", { class: "rec-status" }, [el("span", { class: "rec-pulse-dot" }), el("span", { text: "Recording…" })]),
      el("div", { class: "rec-hintrow" }, [wordHint]), el("div", { class: "q-actions" }, [stopBtn])
    ]));
    document.body.appendChild(overlay);

    var startMs = Date.now(), stopMs = null, stopped = false, tick = null, hard = null;
    var recorder = window.STT.createRecorder({
      onStart: function () {},
      onUpdate: function (t) { wordHint.textContent = "~" + countWords(t) + " words"; },
      onError: function () {},
      onEnd: function () {}
    });
    function done() {
      if (stopped) return; stopped = true;
      if (tick) clearInterval(tick); if (hard) clearTimeout(hard);
      stopMs = Date.now();
      var txt = (recorder.getTranscript ? recorder.getTranscript() : "").trim();
      try { recorder.stop(); } catch (e) {}
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      S.followAnswers[idx].transcript = txt;
      S.followAnswers[idx].delivery = buildDelivery(txt, startMs, stopMs, true);
      markFollowAnswered(stEl, txt);
    }
    stopBtn.addEventListener("click", done);
    recorder.start();
    tick = setInterval(function () {
      var rem = 120000 - (Date.now() - startMs); if (rem < 0) rem = 0;
      countdown.textContent = fmtClock(rem);
      countdown.classList.toggle("is-red", rem <= 10000);
    }, 250);
    hard = setTimeout(done, 120000);
  }

  function markFollowAnswered(stEl, txt) {
    stEl.answered = true;
    stEl.status.textContent = txt ? "✓ answered (" + countWords(txt) + " words)" : "answered";
    stEl.status.classList.add("is-good");
    stEl.recBtn.textContent = "↺ Re-record";
  }

  function finalizeFollowups(followups, btn) {
    var unanswered = S.followAnswers.filter(function (a) { return !a.transcript; }).length;
    if (unanswered && !window.confirm(unanswered + " follow-up(s) unanswered — adaptability will score low. Finalize anyway?")) return;
    if (btn) { btn.disabled = true; btn.textContent = "Scoring adaptability…"; }
    window.API.designFollowup(S.sessionId, S.followAnswers)
      .then(function (data) {
        if (data && data.ok) renderFinal(data);
        else { toast("Could not finalize."); if (btn) { btn.disabled = false; btn.textContent = "Submit follow-ups & see final score"; } }
      })
      .catch(function () { if (btn) { btn.disabled = false; btn.textContent = "Submit follow-ups & see final score"; } });
  }

  function renderFinal(data) {
    var root = appRoot();
    clear(root);
    var badge = data.personalBestToday ? el("div", { class: "best-badge", text: "⭐ Personal best today!" }) : null;
    var rank = typeof data.rankToday === "number" ? el("p", { class: "rank-line" }, ["Today's System Design rank: ", el("strong", { text: "#" + data.rankToday })]) : null;
    var practice = (S.tier === "practice") ? el("p", { class: "mic-note", text: "Practice mode — not posted to the board." }) : null;

    var toBoards = el("button", { class: "btn btn--primary", type: "button", text: "View leaderboards" });
    toBoards.addEventListener("click", function () { renderBoards(); });
    var again = el("button", { class: "btn", type: "button", text: "Another scenario" });
    again.addEventListener("click", renderTrackSelect);

    root.appendChild(el("div", { class: "screen screen--center" }, [
      el("div", { class: "card results-card screen-in" }, [
        el("h1", { class: "results-title", text: "Final score" }),
        el("div", { class: "results-score" }, [
          el("span", { class: "score-num score-num--xl", text: String(typeof data.finalScore === "number" ? data.finalScore : 0) }),
          el("span", { class: "score-den score-den--xl", text: "/100" })
        ]),
        badge, rank,
        el("div", { class: "sd-adapt" }, [
          el("span", { class: "sd-adapt__label", text: "Adaptability" }),
          el("span", { class: "sd-adapt__val", text: String(data.adaptability) + "/100" }),
          data.adaptabilityNote ? el("p", { class: "sd-adapt__note", text: data.adaptabilityNote }) : null
        ]),
        practice,
        el("div", { class: "results-actions" }, [toBoards, again])
      ])
    ]));
  }

  // =====================================================================
  // SCREEN: leaderboards (Overall / Interview / System Design) + peer view
  // =====================================================================
  function renderBoards() {
    cleanup();
    var root = appRoot();
    clear(root);
    var active = "overall";

    var back = el("button", { class: "btn btn--ghost", type: "button", text: "← Back" });
    back.addEventListener("click", exit);

    var tabsWrap = el("div", { class: "tabs" });
    var mount = el("div", { id: "boardsMount" }, [el("div", { class: "loading", text: "Loading…" })]);

    function tab(key, label) {
      var t = el("button", { class: "tab" + (active === key ? " is-active" : ""), type: "button", text: label });
      t.addEventListener("click", function () { active = key; redraw(); });
      return t;
    }
    function rebuildTabs() {
      clear(tabsWrap);
      tabsWrap.appendChild(tab("overall", "Overall"));
      tabsWrap.appendChild(tab("design", "System Design"));
      tabsWrap.appendChild(tab("interview", "Interview"));
    }

    var cache = { design: null, interview: null };

    function redraw() {
      rebuildTabs();
      clear(mount);
      mount.appendChild(el("div", { class: "loading", text: "Loading…" }));
      if (active === "interview") {
        window.API.leaderboard().then(function (d) { drawInterview(mount, d); }).catch(function () { fail(mount); });
      } else {
        window.API.designLeaderboard().then(function (d) {
          if (active === "overall") drawOverall(mount, d);
          else drawDesign(mount, d);
        }).catch(function () { fail(mount); });
      }
    }
    function fail(m) { clear(m); m.appendChild(el("p", { class: "loading", text: "Could not load. Try again." })); }

    root.appendChild(el("div", { class: "screen" }, [
      el("div", { class: "board-head" }, [el("h1", { class: "board-title", text: "Leaderboards" }), back]),
      tabsWrap, mount
    ]));
    redraw();
  }

  function drawOverall(mount, data) {
    clear(mount);
    var rows = (data && data.overall) || [];
    mount.appendChild(el("p", { class: "board-date", text: "Blended (interview + system design), " + (data.date || "") + " — resets daily, US Eastern" }));
    if (!rows.length) { mount.appendChild(el("p", { class: "empty", text: "No scores yet today." })); return; }
    var table = el("table", { class: "board-table" });
    table.appendChild(el("thead", {}, [el("tr", {}, [
      el("th", { text: "#" }), el("th", { text: "Name" }), el("th", { text: "Tier" }),
      el("th", { class: "num", text: "Overall" }), el("th", { class: "num", text: "Interview" }), el("th", { class: "num", text: "Design" })
    ])]));
    var tb = el("tbody");
    rows.forEach(function (r, i) {
      tb.appendChild(el("tr", { class: (i === 0 ? "is-leader " : "") + (r.name === S.name ? "is-me" : "") }, [
        el("td", { class: "rank-cell", text: String(i + 1) }),
        el("td", { text: r.name }),
        el("td", {}, [r.tier ? el("span", { class: "tier-pill", text: r.tier }) : document.createTextNode("—")]),
        el("td", { class: "num strong", text: r.blended == null ? "—" : String(r.blended) }),
        el("td", { class: "num", text: r.interview == null ? "—" : String(r.interview) }),
        el("td", { class: "num", text: r.systemDesign == null ? "—" : String(r.systemDesign) })
      ]));
    });
    table.appendChild(tb); mount.appendChild(table);
  }

  function drawDesign(mount, data) {
    clear(mount);
    var rows = (data && data.systemDesign) || [];
    mount.appendChild(el("p", { class: "board-date", text: "Best design today — click a row to view their diagram & explanation (after you've done that scenario)." }));
    if (!rows.length) { mount.appendChild(el("p", { class: "empty", text: "No designs finalized yet today." })); return; }
    var table = el("table", { class: "board-table sd-board-table" });
    table.appendChild(el("thead", {}, [el("tr", {}, [
      el("th", { text: "#" }), el("th", { text: "Name" }), el("th", { text: "Tier" }),
      el("th", { class: "num", text: "Best" }), el("th", { class: "num", text: "Sessions" }), el("th", { text: "Top scenario" })
    ])]));
    var tb = el("tbody");
    rows.forEach(function (r, i) {
      var tr = el("tr", { class: (i === 0 ? "is-leader " : "") + (r.name === S.name ? "is-me " : "") + "sd-board-row", title: "View this design" }, [
        el("td", { class: "rank-cell", text: String(i + 1) }),
        el("td", { text: r.name }),
        el("td", {}, [r.tier ? el("span", { class: "tier-pill", text: r.tier }) : document.createTextNode("—")]),
        el("td", { class: "num strong", text: String(r.bestScore) }),
        el("td", { class: "num", text: String(r.sessions) }),
        el("td", { class: "sd-scn-cell", text: r.scenarioTitle || "—" })
      ]);
      tr.addEventListener("click", function () { openPeerView(r.bestSessionId); });
      tb.appendChild(tr);
    });
    table.appendChild(tb); mount.appendChild(table);
  }

  function drawInterview(mount, data) {
    clear(mount);
    var board = (data && data.board) || [];
    mount.appendChild(el("p", { class: "board-date", text: "Interview Gauntlet — " + ((data && data.date) || "") }));
    if (!board.length) { mount.appendChild(el("p", { class: "empty", text: "No interviews logged yet today." })); return; }
    var table = el("table", { class: "board-table" });
    table.appendChild(el("thead", {}, [el("tr", {}, [
      el("th", { text: "#" }), el("th", { text: "Name" }), el("th", { text: "Tier" }),
      el("th", { class: "num", text: "Best" }), el("th", { class: "num", text: "Interviews" })
    ])]));
    var tb = el("tbody");
    board.forEach(function (r, i) {
      tb.appendChild(el("tr", { class: (i === 0 ? "is-leader " : "") + (r.name === S.name ? "is-me" : "") }, [
        el("td", { class: "rank-cell", text: String(i + 1) }),
        el("td", { text: r.name }),
        el("td", {}, [r.tier ? el("span", { class: "tier-pill", text: r.tier }) : document.createTextNode("—")]),
        el("td", { class: "num strong", text: String(r.bestScore) }),
        el("td", { class: "num", text: String(r.interviews) })
      ]));
    });
    table.appendChild(tb); mount.appendChild(table);
  }

  function openPeerView(sessionId) {
    if (!sessionId) return;
    var overlay = el("div", { class: "sd-modal-overlay" });
    var body = el("div", { class: "sd-modal-body" }, [el("div", { class: "loading", text: "Loading design…" })]);
    var closeBtn = el("button", { class: "btn btn--ghost sd-modal-close", type: "button", text: "✕ Close" });
    closeBtn.addEventListener("click", function () { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); });
    var modal = el("div", { class: "sd-modal" }, [el("div", { class: "sd-modal-head" }, [closeBtn]), body]);
    overlay.appendChild(modal);
    overlay.addEventListener("click", function (e) { if (e.target === overlay) overlay.parentNode.removeChild(overlay); });
    document.body.appendChild(overlay);

    window.API.designSessionView(S.name, S.passcode, sessionId).then(function (data) {
      clear(body);
      if (!data || !data.ok) { body.appendChild(el("p", { text: "Could not load." })); return; }
      if (data.locked) {
        body.appendChild(el("div", { class: "sd-locked" }, [
          el("h3", { text: "🔒 Locked" }),
          el("p", { text: "You can view " + (data.owner || "this") + "'s “" + (data.scenarioTitle || "design") + "” after you've completed that scenario yourself." })
        ]));
        return;
      }
      var dd = data.dims || {};
      body.appendChild(el("h2", { class: "panel-title", text: data.owner + " — " + data.scenarioTitle }));
      body.appendChild(el("div", { class: "sd-modal-score" }, [
        el("span", { class: "score-num", text: String(data.overall) }), el("span", { class: "score-den", text: "/100" }),
        data.tier ? el("span", { class: "tier-pill", text: data.tier }) : null
      ]));
      if (data.summary) body.appendChild(el("p", { class: "ov-summary", text: data.summary }));
      body.appendChild(el("div", { class: "sd-modal-dims" }, [
        dimBar("Completeness", dd.completeness), dimBar("Design quality", dd.design_quality),
        dimBar("Scoping", dd.scoping), dimBar("Deliverability", dd.deliverability),
        dimBar("Adaptability", dd.adaptability)
      ]));
      if (data.scenePng) body.appendChild(el("img", { class: "sd-modal-diagram", src: data.scenePng, alt: "diagram" }));
      else body.appendChild(el("p", { class: "empty", text: "(No diagram captured.)" }));
      if (data.explanation) {
        body.appendChild(el("h4", { class: "ov-h", text: "Their explanation" }));
        body.appendChild(el("blockquote", { class: "sd-modal-explain", text: data.explanation }));
      }
    }).catch(function () { clear(body); body.appendChild(el("p", { text: "Could not load." })); });
  }

  // =====================================================================
  // Public entry points
  // =====================================================================
  window.DESIGN = {
    open: function (creds, onExit) {
      S.name = creds.name; S.passcode = creds.passcode; S.tier = creds.tier || null;
      S.onExit = onExit || null;
      renderTrackSelect();
    },
    boards: function (creds, onExit) {
      S.name = creds.name; S.passcode = creds.passcode; S.tier = creds.tier || null;
      S.onExit = onExit || null;
      renderBoards();
    }
  };
})();
