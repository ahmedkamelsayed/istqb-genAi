/* ============================================================
   ISTQB CT-GenAI  —  Interactive Exam Engine
   Vanilla JS, no dependencies, works from file:// (double-click).
   An exam HTML page defines window.EXAM = {...} then loads this file.
   ============================================================ */
(function () {
  "use strict";

  var EXAM = window.EXAM;
  if (!EXAM) { document.body.innerHTML = "<p style='padding:2rem;color:#b00'>No EXAM data found on this page.</p>"; return; }

  // ---- derived config ----------------------------------------------------
  var QS = EXAM.questions;
  var TOTAL_POINTS = QS.reduce(function (s, q) { return s + q.points; }, 0);
  var PASS_PERCENT = EXAM.passPercent || 65;
  var PASS_POINTS = Math.ceil((PASS_PERCENT / 100) * TOTAL_POINTS);
  var DURATION = (EXAM.durationMinutes || 60) * 60; // seconds
  var STORAGE_KEY = "ctgenai_" + (EXAM.id || EXAM.title || "exam").replace(/\W+/g, "_");

  // ---- state --------------------------------------------------------------
  var state = {
    current: 0,
    answers: {},      // qIndex -> [optionKeys]
    marked: {},       // qIndex -> true
    visited: {},      // qIndex -> true
    order: {},        // qIndex -> permutation of original option indices (when shuffleOptions)
    started: false,
    finished: false,
    remaining: DURATION
  };
  var timerHandle = null;
  var paused = false;
  var firedWarnings = {};

  // ---- persistence --------------------------------------------------------
  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        answers: state.answers, marked: state.marked, visited: state.visited,
        order: state.order, current: state.current, remaining: state.remaining,
        started: state.started, finished: state.finished
      }));
    } catch (e) {}
  }
  function load() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) { return null; }
  }
  function clearSave() { try { localStorage.removeItem(STORAGE_KEY); } catch (e) {} }

  // ---- optional option shuffling (per attempt) ----------------------------
  // Each option keeps its own text/why/correct flag; only the display order and
  // the a/b/c/d label change, so correctness is preserved and answer positions
  // are randomized (avoids position bias and memorization).
  function shuffledIdx(n) {
    var a = []; for (var i = 0; i < n; i++) a.push(i);
    for (var k = n - 1; k > 0; k--) { var j = Math.floor(Math.random() * (k + 1)); var t = a[k]; a[k] = a[j]; a[j] = t; }
    return a;
  }
  function buildOrder() {
    state.order = {};
    EXAM.questions.forEach(function (q, qi) { state.order[qi] = shuffledIdx(q.options.length); });
  }
  function applyOrder() {
    QS = EXAM.questions.map(function (q, qi) {
      var ord = state.order && state.order[qi];
      if (!ord) return q;
      var opts = ord.map(function (origIdx, pos) {
        var o = q.options[origIdx];
        return { k: String.fromCharCode(97 + pos), html: o.html, correct: !!o.correct, why: o.why };
      });
      var nq = Object.assign({}, q); nq.options = opts; return nq;
    });
  }

  // ---- helpers ------------------------------------------------------------
  function el(tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }
  function fmtTime(sec) {
    var m = Math.floor(sec / 60), s = sec % 60;
    return (m < 10 ? "0" : "") + m + ":" + (s < 10 ? "0" : "") + s;
  }
  function correctKeys(q) {
    return q.options.filter(function (o) { return o.correct; }).map(function (o) { return o.k; });
  }
  function selectedKeys(i) { return state.answers[i] || []; }
  function isAnswered(i) { return (state.answers[i] || []).length > 0; }
  function isCorrect(i) {
    var sel = (state.answers[i] || []).slice().sort();
    var cor = correctKeys(QS[i]).slice().sort();
    return sel.length === cor.length && sel.every(function (v, idx) { return v === cor[idx]; });
  }
  function requiredCount(q) {
    return q.selectCount || (q.type === "multi" ? correctKeys(q).length : 1);
  }

  // ---- root containers ----------------------------------------------------
  var root = document.getElementById("exam-root") || document.body;
  root.innerHTML = "";

  // =========================================================================
  //  START SCREEN
  // =========================================================================
  function renderStart() {
    root.innerHTML = "";
    var wrap = el("div", "start-screen");
    wrap.appendChild(el("div", "badge", "ISTQB® Specialist · Testing with Generative AI"));
    wrap.appendChild(el("h1", null, EXAM.title));
    if (EXAM.source) wrap.appendChild(el("p", "source", EXAM.source));

    var grid = el("div", "facts");
    [
      ["Questions", QS.length],
      ["Total points", TOTAL_POINTS],
      ["Pass mark", PASS_PERCENT + "% (≥ " + PASS_POINTS + " pts)"],
      ["Time limit", (EXAM.durationMinutes || 60) + " min"]
    ].forEach(function (f) {
      var c = el("div", "fact");
      c.appendChild(el("div", "fact-val", f[1]));
      c.appendChild(el("div", "fact-lbl", f[0]));
      grid.appendChild(c);
    });
    wrap.appendChild(grid);

    var rules = el("div", "rules");
    rules.innerHTML =
      "<h3>How it works</h3><ul>" +
      "<li>Pick your answer(s). Questions asking for <b>TWO</b> options need exactly two selected.</li>" +
      "<li>Use <b>Flag for review</b> 🚩 to revisit a question later.</li>" +
      "<li>You may <b>skip</b> any question and come back via the navigator grid.</li>" +
      "<li>The <b>timer</b> auto-submits when it reaches 00:00.</li>" +
      "<li>On <b>Finish</b> you'll see your score and a full breakdown: ✔ correct, ✗ incorrect, ➖ skipped, 🚩 flagged — each with the reason every option is right or wrong.</li>" +
      "<li>Progress is auto-saved in this browser, so you can resume if you close the tab.</li>" +
      "</ul>";
    wrap.appendChild(rules);

    var btnRow = el("div", "btn-row");
    var startBtn = el("button", "btn btn-primary", "Start exam ▶");
    startBtn.onclick = function () { beginExam(false); };
    btnRow.appendChild(startBtn);

    var saved = load();
    if (saved && saved.started && !saved.finished) {
      var resumeBtn = el("button", "btn btn-ghost", "Resume saved attempt ↻");
      resumeBtn.onclick = function () { beginExam(true); };
      btnRow.appendChild(resumeBtn);
    }
    if (saved && saved.finished) {
      var reviewBtn = el("button", "btn btn-ghost", "View last results");
      reviewBtn.onclick = function () {
        Object.assign(state, saved); state.finished = true;
        if (EXAM.shuffleOptions) applyOrder();
        renderResults();
      };
      btnRow.appendChild(reviewBtn);
    }
    wrap.appendChild(btnRow);
    root.appendChild(wrap);
  }

  function beginExam(resume) {
    if (resume) {
      var saved = load();
      if (saved) Object.assign(state, saved);
      if (EXAM.shuffleOptions) applyOrder();
    } else {
      clearSave();
      state.answers = {}; state.marked = {}; state.visited = {};
      state.order = {};
      state.current = 0; state.remaining = DURATION; state.finished = false;
      if (EXAM.shuffleOptions) { buildOrder(); applyOrder(); }
    }
    state.started = true;
    paused = false;
    save();
    startTimer();
    renderExam();
  }

  // =========================================================================
  //  TIMER
  // =========================================================================
  // warnings already passed (given the current remaining) should not fire
  function initWarnings() {
    firedWarnings = {};
    [600, 300, 60].forEach(function (s) { if (state.remaining <= s) firedWarnings[s] = true; });
  }
  function notifyThresholds() {
    [[600, "⏰ 10 minutes remaining"], [300, "⏰ 5 minutes remaining"], [60, "⏰ 1 minute remaining — finish up!"]]
      .forEach(function (w) {
        if (state.remaining <= w[0] && !firedWarnings[w[0]]) {
          firedWarnings[w[0]] = true;
          toast(w[1], w[0] <= 60 ? "danger" : "warn");
        }
      });
  }
  function startTimer() {
    if (timerHandle) clearInterval(timerHandle);
    initWarnings();
    timerHandle = setInterval(function () {
      if (state.finished) { clearInterval(timerHandle); return; }
      if (paused) return;                 // clock is frozen while paused
      state.remaining--;
      updateTimerDisplay();
      notifyThresholds();
      if (state.remaining % 5 === 0) save();
      if (state.remaining <= 0) {
        clearInterval(timerHandle);
        finishExam(true);
      }
    }, 1000);
  }
  function updateTimerDisplay() {
    var t = document.getElementById("timer");
    if (!t) return;
    t.textContent = fmtTime(Math.max(0, state.remaining));
    t.classList.toggle("warn", state.remaining <= 300 && state.remaining > 60);
    t.classList.toggle("danger", state.remaining <= 60);
  }

  // ---- toast notifications ------------------------------------------------
  function toast(msg, kind) {
    var t = el("div", "exam-toast " + (kind || ""), msg);
    document.body.appendChild(t);
    requestAnimationFrame(function () { t.classList.add("show"); });
    setTimeout(function () {
      t.classList.remove("show");
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 400);
    }, 4500);
  }

  // ---- pause / resume -----------------------------------------------------
  function togglePause() {
    if (state.finished) return;
    paused = !paused;
    var layout = document.querySelector(".layout");
    var btn = document.querySelector(".btn-pause");
    var timer = document.getElementById("timer");
    if (paused) {
      if (layout) layout.classList.add("blurred");
      if (timer) timer.classList.add("paused");
      if (btn) { btn.innerHTML = "▶ Resume"; btn.classList.add("resuming"); }
      showPauseOverlay();
      save();
    } else {
      if (layout) layout.classList.remove("blurred");
      if (timer) timer.classList.remove("paused");
      if (btn) { btn.innerHTML = "⏸ Pause"; btn.classList.remove("resuming"); }
      hidePauseOverlay();
    }
  }
  function showPauseOverlay() {
    if (document.getElementById("pause-overlay")) return;
    var ov = el("div", "pause-overlay"); ov.id = "pause-overlay";
    var card = el("div", "pause-card");
    card.appendChild(el("div", "pause-ico", "⏸"));
    card.appendChild(el("h2", null, "Exam paused"));
    card.appendChild(el("p", null, "The timer is stopped and the question is hidden. Take a breather."));
    card.appendChild(el("div", "pause-time", "Time remaining: " + fmtTime(Math.max(0, state.remaining))));
    var rb = el("button", "btn btn-primary", "▶ Resume exam");
    rb.onclick = function () { togglePause(); };
    card.appendChild(rb);
    ov.appendChild(card);
    root.appendChild(ov);
  }
  function hidePauseOverlay() {
    var o = document.getElementById("pause-overlay");
    if (o && o.parentNode) o.parentNode.removeChild(o);
  }

  // =========================================================================
  //  EXAM SCREEN
  // =========================================================================
  function renderExam() {
    root.innerHTML = "";
    var bar = el("div", "topbar");
    bar.appendChild(el("div", "topbar-title", EXAM.title));
    var right = el("div", "topbar-right");
    var timer = el("div", "timer", fmtTime(state.remaining)); timer.id = "timer";
    right.appendChild(timer);
    var pauseBtn = el("button", "btn btn-pause", paused ? "▶ Resume" : "⏸ Pause");
    pauseBtn.onclick = function () { togglePause(); };
    right.appendChild(pauseBtn);
    var finishBtn = el("button", "btn btn-finish", "Finish exam");
    finishBtn.onclick = function () { confirmFinish(); };
    right.appendChild(finishBtn);
    bar.appendChild(right);
    root.appendChild(bar);

    var layout = el("div", "layout");
    var main = el("div", "main"); main.id = "main";
    var side = el("div", "sidebar"); side.id = "sidebar";
    layout.appendChild(main);
    layout.appendChild(side);
    root.appendChild(layout);

    renderQuestion();
    renderNavigator();
    updateTimerDisplay();
  }

  function renderQuestion() {
    var i = state.current, q = QS[i];
    state.visited[i] = true;
    var main = document.getElementById("main");
    main.innerHTML = "";

    var head = el("div", "q-head");
    head.appendChild(el("span", "q-num", "Question " + q.n + " of " + QS.length));
    head.appendChild(el("span", "q-pts", q.points + (q.points > 1 ? " points" : " point")));
    var flag = el("button", "flag-btn" + (state.marked[i] ? " on" : ""), (state.marked[i] ? "🚩 Flagged" : "🏳 Flag for review"));
    flag.onclick = function () {
      state.marked[i] = !state.marked[i];
      flag.className = "flag-btn" + (state.marked[i] ? " on" : "");
      flag.innerHTML = state.marked[i] ? "🚩 Flagged" : "🏳 Flag for review";
      renderNavigator(); save();
    };
    head.appendChild(flag);
    main.appendChild(head);

    main.appendChild(el("div", "q-stem", q.stem));

    var need = requiredCount(q);
    var instr = need > 1 ? "Select " + (need === 2 ? "TWO" : need) + " options." : "Select ONE option.";
    main.appendChild(el("div", "q-instr", instr));

    var opts = el("div", "options");
    var multi = need > 1;
    q.options.forEach(function (o) {
      var chosen = selectedKeys(i).indexOf(o.k) >= 0;
      var row = el("label", "opt" + (chosen ? " chosen" : ""));
      var input = document.createElement("input");
      input.type = multi ? "checkbox" : "radio";
      input.name = "q" + i;
      input.checked = chosen;
      input.onchange = function () { toggleAnswer(i, o.k, multi, need); };
      row.appendChild(input);
      var body = el("div", "opt-body");
      body.appendChild(el("span", "opt-key", o.k + ")"));
      body.appendChild(el("span", "opt-text", o.html));
      row.appendChild(body);
      opts.appendChild(row);
    });
    main.appendChild(opts);

    var nav = el("div", "q-nav");
    var prev = el("button", "btn btn-ghost", "◀ Previous");
    prev.disabled = i === 0;
    prev.onclick = function () { goTo(i - 1); };
    var clear = el("button", "btn btn-ghost", "Clear answer");
    clear.onclick = function () { state.answers[i] = []; save(); renderQuestion(); renderNavigator(); };
    var next = el("button", "btn btn-primary", i === QS.length - 1 ? "Review ▶" : "Next ▶");
    next.onclick = function () { if (i === QS.length - 1) confirmFinish(); else goTo(i + 1); };
    nav.appendChild(prev); nav.appendChild(clear); nav.appendChild(next);
    main.appendChild(nav);
  }

  function toggleAnswer(i, key, multi, need) {
    var cur = state.answers[i] ? state.answers[i].slice() : [];
    if (!multi) {
      cur = [key];
    } else {
      var idx = cur.indexOf(key);
      if (idx >= 0) cur.splice(idx, 1);
      else {
        if (cur.length >= need) cur.shift(); // keep only the most recent N
        cur.push(key);
      }
    }
    state.answers[i] = cur;
    save();
    renderQuestion();
    renderNavigator();
  }

  function goTo(i) {
    if (i < 0 || i >= QS.length) return;
    state.current = i; save();
    renderQuestion(); renderNavigator();
  }

  function renderNavigator() {
    var side = document.getElementById("sidebar");
    if (!side) return;
    side.innerHTML = "";
    side.appendChild(el("h3", "nav-title", "Questions"));

    var answered = QS.filter(function (q, i) { return isAnswered(i); }).length;
    var flagged = Object.keys(state.marked).filter(function (k) { return state.marked[k]; }).length;
    var prog = el("div", "nav-prog");
    prog.innerHTML = "<b>" + answered + "</b>/" + QS.length + " answered · <b>" + flagged + "</b> flagged";
    side.appendChild(prog);

    var grid = el("div", "nav-grid");
    QS.forEach(function (q, i) {
      var cls = "nav-cell";
      if (i === state.current) cls += " current";
      if (isAnswered(i)) cls += " answered";
      else if (state.visited[i]) cls += " seen";
      if (state.marked[i]) cls += " flagged";
      var cell = el("button", cls, String(q.n));
      cell.onclick = function () { goTo(i); };
      grid.appendChild(cell);
    });
    side.appendChild(grid);

    var legend = el("div", "nav-legend");
    legend.innerHTML =
      "<span><i class='lg answered'></i>Answered</span>" +
      "<span><i class='lg seen'></i>Seen, blank</span>" +
      "<span><i class='lg flagged'></i>Flagged</span>";
    side.appendChild(legend);
  }

  // =========================================================================
  //  FINISH
  // =========================================================================
  function confirmFinish() {
    var unanswered = QS.filter(function (q, i) { return !isAnswered(i); }).length;
    var msg = "Submit and finish the exam?";
    if (unanswered > 0) msg = unanswered + " question(s) are still unanswered (they'll be marked as skipped).\n\n" + msg;
    if (window.confirm(msg)) finishExam(false);
  }

  function finishExam(auto) {
    state.finished = true;
    paused = false;
    hidePauseOverlay();
    if (timerHandle) clearInterval(timerHandle);
    save();
    renderResults(auto);
    window.scrollTo(0, 0);
  }

  // =========================================================================
  //  RESULTS
  // =========================================================================
  function renderResults(auto) {
    root.innerHTML = "";

    var earned = 0;
    QS.forEach(function (q, i) { if (isAnswered(i) && isCorrect(i)) earned += q.points; });
    var pct = Math.round((earned / TOTAL_POINTS) * 100);
    var passed = earned >= PASS_POINTS;

    var nCorrect = 0, nIncorrect = 0, nSkipped = 0;
    QS.forEach(function (q, i) {
      if (!isAnswered(i)) nSkipped++;
      else if (isCorrect(i)) nCorrect++;
      else nIncorrect++;
    });
    var nFlagged = Object.keys(state.marked).filter(function (k) { return state.marked[k]; }).length;

    var head = el("div", "results-head " + (passed ? "pass" : "fail"));
    head.appendChild(el("div", "result-verdict", passed ? "PASS ✅" : "NOT YET ❌"));
    head.appendChild(el("div", "result-score", earned + " / " + TOTAL_POINTS + " points · " + pct + "%"));
    head.appendChild(el("div", "result-sub", "Pass mark: " + PASS_PERCENT + "% (" + PASS_POINTS + " points)" + (auto ? " · ⏱ time expired" : "")));
    root.appendChild(head);

    var tiles = el("div", "result-tiles");
    [["✔", nCorrect, "Correct", "t-correct"],
     ["✗", nIncorrect, "Incorrect", "t-incorrect"],
     ["➖", nSkipped, "Skipped", "t-skipped"],
     ["🚩", nFlagged, "Flagged", "t-flagged"]].forEach(function (t) {
      var c = el("div", "rtile " + t[3]);
      c.appendChild(el("div", "rtile-icon", t[0]));
      c.appendChild(el("div", "rtile-num", t[1]));
      c.appendChild(el("div", "rtile-lbl", t[2]));
      tiles.appendChild(c);
    });
    root.appendChild(tiles);

    // chapter breakdown
    var byCh = {};
    QS.forEach(function (q, i) {
      var ch = q.lo ? q.lo.replace("GenAI-", "").charAt(0) : "?";
      if (!byCh[ch]) byCh[ch] = { e: 0, t: 0 };
      byCh[ch].t += q.points;
      if (isAnswered(i) && isCorrect(i)) byCh[ch].e += q.points;
    });
    var chWrap = el("div", "chapter-breakdown");
    chWrap.appendChild(el("h3", null, "Score by chapter"));
    var CHN = { "1": "1 · Foundations", "2": "2 · Prompt Engineering", "3": "3 · Managing Risks", "4": "4 · Test Infrastructure", "5": "5 · Deployment" };
    Object.keys(byCh).sort().forEach(function (ch) {
      var b = byCh[ch];
      var p = Math.round((b.e / b.t) * 100);
      var row = el("div", "ch-row");
      row.appendChild(el("div", "ch-name", CHN[ch] || ("Ch " + ch)));
      var barWrap = el("div", "ch-bar");
      var fill = el("div", "ch-fill" + (p >= PASS_PERCENT ? " ok" : " low")); fill.style.width = p + "%";
      barWrap.appendChild(fill);
      row.appendChild(barWrap);
      row.appendChild(el("div", "ch-pct", b.e + "/" + b.t));
      chWrap.appendChild(row);
    });
    root.appendChild(chWrap);

    // controls
    var ctl = el("div", "review-controls");
    ctl.appendChild(el("span", "rc-label", "Show:"));
    var filters = [["all", "All"], ["incorrect", "Incorrect"], ["skipped", "Skipped"], ["flagged", "Flagged"], ["correct", "Correct"]];
    filters.forEach(function (f, idx) {
      var b = el("button", "chip" + (idx === 0 ? " active" : ""), f[1]);
      b.dataset.filter = f[0];
      b.onclick = function () {
        ctl.querySelectorAll(".chip").forEach(function (x) { x.classList.remove("active"); });
        b.classList.add("active");
        applyFilter(f[0]);
      };
      ctl.appendChild(b);
    });
    var retry = el("button", "btn btn-primary rc-retry", "↻ Retake exam");
    retry.onclick = function () { clearSave(); state.finished = false; renderStart(); window.scrollTo(0, 0); };
    ctl.appendChild(retry);
    root.appendChild(ctl);

    var list = el("div", "review-list"); list.id = "review-list";
    root.appendChild(list);
    buildReview();
    applyFilter("all");
  }

  function buildReview() {
    var list = document.getElementById("review-list");
    list.innerHTML = "";
    QS.forEach(function (q, i) {
      var sel = selectedKeys(i);
      var cor = correctKeys(q);
      var answered = sel.length > 0;
      var ok = answered && isCorrect(i);
      var status = !answered ? "skipped" : (ok ? "correct" : "incorrect");

      var card = el("div", "rev-card " + status);
      card.dataset.status = status;
      card.dataset.flagged = state.marked[i] ? "1" : "0";

      var rh = el("div", "rev-head");
      var icon = !answered ? "➖" : (ok ? "✔" : "✗");
      rh.appendChild(el("span", "rev-icon", icon));
      rh.appendChild(el("span", "rev-qn", "Q" + q.n));
      rh.appendChild(el("span", "rev-meta", (q.lo || "") + " · " + (q.k || "") + " · " + q.points + "pt"));
      if (state.marked[i]) rh.appendChild(el("span", "rev-flag", "🚩 flagged"));
      card.appendChild(rh);

      card.appendChild(el("div", "rev-stem", q.stem));

      var ans = el("div", "rev-ans");
      ans.innerHTML =
        "<div class='ya'><b>Your answer:</b> " + (answered ? sel.join(", ").toUpperCase() : "<i>— skipped —</i>") + "</div>" +
        "<div class='ca'><b>Correct answer:</b> " + cor.join(", ").toUpperCase() + "</div>";
      card.appendChild(ans);

      var opts = el("div", "rev-options");
      q.options.forEach(function (o) {
        var isCor = o.correct;
        var isSel = sel.indexOf(o.k) >= 0;
        var cls = "rev-opt";
        if (isCor) cls += " correct";
        if (isSel && !isCor) cls += " wrong-pick";
        var tag = isCor ? "✔ correct" : (isSel ? "✗ your pick" : "");
        var row = el("div", cls);
        row.innerHTML =
          "<div class='ro-head'><span class='ro-key'>" + o.k + ")</span> <span class='ro-text'>" + o.html + "</span>" +
          (tag ? " <span class='ro-tag'>" + tag + "</span>" : "") + "</div>" +
          (o.why ? "<div class='ro-why'>" + o.why + "</div>" : "");
        opts.appendChild(row);
      });
      card.appendChild(opts);

      if (q.note) card.appendChild(el("div", "rev-note", "💡 " + q.note));
      list.appendChild(card);
    });
  }

  function applyFilter(f) {
    document.querySelectorAll(".rev-card").forEach(function (c) {
      var show = f === "all" ? true :
        f === "flagged" ? c.dataset.flagged === "1" :
        c.dataset.status === f;
      c.style.display = show ? "" : "none";
    });
    var any = Array.prototype.some.call(document.querySelectorAll(".rev-card"), function (c) { return c.style.display !== "none"; });
    var empty = document.getElementById("rev-empty");
    if (!any) {
      if (!empty) { empty = el("div", "rev-empty", "Nothing here — great! 🎉"); empty.id = "rev-empty"; document.getElementById("review-list").appendChild(empty); }
      empty.style.display = "";
    } else if (empty) { empty.style.display = "none"; }
  }

  // ---- boot ---------------------------------------------------------------
  renderStart();
})();
