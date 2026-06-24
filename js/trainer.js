// trainer.js — trainer-only reporting view for the System Design Simulator.
// Gated by TRAINER_PASSCODE (sent to /trainer/report; never stored in the page).
// Exposes window.TRAINER.open(onExit).

(function () {
  "use strict";

  function $(sel, root) { return (root || document).querySelector(sel); }
  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === "class") n.className = attrs[k];
      else if (k === "text") n.textContent = attrs[k];
      else n.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c != null) n.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return n;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function appRoot() { return $("#app"); }

  var T = { passcode: null, onExit: null };

  function renderGate() {
    var root = appRoot();
    clear(root);
    var pass = el("input", { class: "field", type: "password", placeholder: "Trainer passcode", autocomplete: "off" });
    var btn = el("button", { class: "btn btn--primary btn--lg", type: "submit", text: "View reports" });
    var back = el("button", { class: "btn btn--ghost", type: "button", text: "← Back" });
    back.addEventListener("click", function () { if (T.onExit) T.onExit(); });
    var form = el("form", { class: "gate-form" }, [
      el("label", { class: "field-label", text: "Trainer access" }),
      pass, btn
    ]);
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var pc = pass.value;
      if (!pc) return;
      btn.disabled = true; btn.textContent = "Checking…";
      window.API.trainerReport(pc, { limit: 100 })
        .then(function (data) {
          if (data && data.ok) { T.passcode = pc; renderReport(data); }
          else { btn.disabled = false; btn.textContent = "View reports"; window.showToast("Wrong trainer passcode.", "error"); }
        })
        .catch(function () { btn.disabled = false; btn.textContent = "View reports"; });
    });
    root.appendChild(el("div", { class: "screen screen--center" }, [
      el("div", { class: "card gate-card screen-in" }, [
        el("h1", { class: "gate-title", text: "Trainer Reports" }),
        el("p", { class: "gate-sub", text: "System Design Simulator — usage, growth, scores, and actionable items per learner." }),
        form, back
      ])
    ]));
  }

  function num(v) { return v == null ? "—" : String(v); }

  function renderReport(data) {
    var root = appRoot();
    clear(root);

    var back = el("button", { class: "btn btn--ghost", type: "button", text: "← Exit" });
    back.addEventListener("click", function () { if (T.onExit) T.onExit(); });
    var refresh = el("button", { class: "btn", type: "button", text: "↻ Refresh" });
    refresh.addEventListener("click", function () {
      window.API.trainerReport(T.passcode, { limit: 100 }).then(function (d) { if (d && d.ok) renderReport(d); });
    });

    // ---- learner summary table ----
    var learners = data.learners || [];
    var summary = el("div", { class: "card trainer-panel" }, [el("h2", { class: "panel-title", text: "Per-learner summary" })]);
    if (!learners.length) {
      summary.appendChild(el("p", { class: "empty", text: "No finalized design sessions yet." }));
    } else {
      var t = el("table", { class: "board-table trainer-table" });
      t.appendChild(el("thead", {}, [el("tr", {}, [
        el("th", { text: "Learner" }), el("th", { text: "Tier" }), el("th", { class: "num", text: "Sessions" }),
        el("th", { class: "num", text: "Avg" }), el("th", { class: "num", text: "Best" }),
        el("th", { class: "num", text: "Scope" }), el("th", { class: "num", text: "Deliv" }),
        el("th", { class: "num", text: "Design" }), el("th", { class: "num", text: "Compl" }), el("th", { class: "num", text: "Adapt" }),
        el("th", { text: "Active" })
      ])]));
      var tb = el("tbody");
      learners.forEach(function (r) {
        tb.appendChild(el("tr", {}, [
          el("td", { text: r.name }),
          el("td", {}, [r.tier ? el("span", { class: "tier-pill", text: r.tier }) : document.createTextNode("—")]),
          el("td", { class: "num", text: num(r.finalized_sessions) }),
          el("td", { class: "num strong", text: num(r.avg_overall) }),
          el("td", { class: "num", text: num(r.best_overall) }),
          el("td", { class: "num", text: num(r.avg_scoping) }),
          el("td", { class: "num", text: num(r.avg_deliverability) }),
          el("td", { class: "num", text: num(r.avg_design_quality) }),
          el("td", { class: "num", text: num(r.avg_completeness) }),
          el("td", { class: "num", text: num(r.avg_adaptability) }),
          el("td", { class: "sd-scn-cell", text: (r.first_day || "?") + " → " + (r.last_day || "?") })
        ]));
      });
      t.appendChild(tb); summary.appendChild(t);
      summary.appendChild(el("p", { class: "trainer-key", text: "Scope = clarifying-question quality. Deliv = the WHY/tradeoffs. Adapt = live re-think round. These are the remediation targets — watch Scope and Deliv move." }));
    }

    // ---- daily usage ----
    var daily = data.daily || [];
    var usage = el("div", { class: "card trainer-panel" }, [el("h2", { class: "panel-title", text: "Daily usage & growth" })]);
    if (!daily.length) usage.appendChild(el("p", { class: "empty", text: "No daily data yet." }));
    else {
      var byName = {};
      daily.forEach(function (d) { (byName[d.name] = byName[d.name] || []).push(d); });
      Object.keys(byName).forEach(function (nm) {
        var days = byName[nm];
        var row = el("div", { class: "trainer-daily" }, [el("span", { class: "trainer-daily__name", text: nm })]);
        days.forEach(function (d) {
          row.appendChild(el("span", { class: "trainer-daily__cell", title: d.date + ": " + d.sessions + " sessions, best " + d.best_overall }, [
            el("span", { class: "trainer-daily__date", text: d.date.slice(5) }),
            el("span", { class: "trainer-daily__score", text: num(d.best_overall) })
          ]));
        });
        usage.appendChild(row);
      });
    }

    // ---- recent sessions w/ feedback + actionable items ----
    var sessions = data.sessions || [];
    var detail = el("div", { class: "card trainer-panel" }, [el("h2", { class: "panel-title", text: "Recent sessions — feedback & actionable items" })]);
    if (!sessions.length) detail.appendChild(el("p", { class: "empty", text: "No sessions." }));
    else {
      sessions.forEach(function (s) {
        var d = s.dims || {};
        var det = el("details", { class: "trainer-session" });
        det.appendChild(el("summary", {}, [
          el("span", { class: "trainer-sess__score", text: num(s.overall) }),
          el("span", { class: "trainer-sess__who", text: s.name }),
          el("span", { class: "trainer-sess__scn", text: s.scenarioTitle || "" }),
          el("span", { class: "trainer-sess__date", text: s.date + " · " + (s.track || "") })
        ]));
        det.appendChild(el("p", { class: "trainer-sess__dims", text:
          "scope " + num(d.scoping) + " · deliv " + num(d.deliverability) + " · design " + num(d.design_quality) +
          " · compl " + num(d.completeness) + " · adapt " + num(d.adaptability) + " · clarifying Qs asked: " + num(s.clarifyCount) }));
        if (s.summary) det.appendChild(el("p", { class: "ov-summary", text: s.summary }));
        function list(title, items, cls) {
          if (!items || !items.length) return;
          det.appendChild(el("h4", { class: "ov-h " + (cls || ""), text: title }));
          det.appendChild(el("ul", { class: "fb-list" }, items.map(function (it) { return el("li", { text: String(it) }); })));
        }
        list("Focus areas", s.focusAreas, "is-warn");
        list("Questions they missed", s.questionsMissed, "is-warn");
        list("Actionable items", s.actionableItems, "is-good");
        detail.appendChild(det);
      });
    }

    root.appendChild(el("div", { class: "screen screen--wide" }, [
      el("div", { class: "board-head" }, [el("h1", { class: "board-title", text: "Trainer Reports — System Design" }), el("div", { class: "board-head__actions" }, [refresh, back])]),
      summary, usage, detail
    ]));
  }

  window.TRAINER = {
    open: function (onExit) { T.onExit = onExit || null; renderGate(); }
  };
})();
