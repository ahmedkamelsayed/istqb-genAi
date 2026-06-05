/* CT-GenAI — shared dark-mode toggle (used on every page).
   Include in <head> BEFORE the stylesheet so the theme applies with no flash.
   Preference is shared across all pages via localStorage. */
(function () {
  "use strict";
  var KEY = "ctgenai_theme";

  function apply(t) {
    if (t === "dark") document.documentElement.setAttribute("data-theme", "dark");
    else document.documentElement.removeAttribute("data-theme");
  }

  // resolve initial theme: saved choice → light (default)
  // Light is the default for first-time visitors; dark only applies if the
  // user has explicitly toggled it (stored in localStorage).
  var saved = null;
  try { saved = localStorage.getItem(KEY); } catch (e) {}
  if (saved !== "dark" && saved !== "light") {
    saved = "light";
  }
  apply(saved);

  function injectStyles() {
    if (document.getElementById("theme-toggle-style")) return;
    var s = document.createElement("style");
    s.id = "theme-toggle-style";
    s.textContent =
      "#theme-toggle{position:fixed;right:18px;bottom:18px;z-index:1001;width:46px;height:46px;" +
      "border-radius:50%;border:none;cursor:pointer;font-size:1.25rem;line-height:1;background:#0e7490;" +
      "color:#fff;box-shadow:0 6px 20px rgba(15,23,42,.30);transition:transform .1s,background .15s;" +
      "display:inline-flex;align-items:center;justify-content:center;padding:0}" +
      "#theme-toggle:hover{background:#0891b2;transform:translateY(-1px)}" +
      "#theme-toggle:active{transform:translateY(0)}" +
      "@media(max-width:880px){#theme-toggle{right:12px;bottom:12px;width:42px;height:42px}}" +
      "@media print{#theme-toggle{display:none}}";
    document.head.appendChild(s);
  }

  function makeBtn() {
    injectStyles();
    if (document.getElementById("theme-toggle")) return;
    var b = document.createElement("button");
    b.id = "theme-toggle";
    b.type = "button";
    b.setAttribute("aria-label", "Toggle dark mode");
    b.title = "Toggle dark / light mode";
    function render() {
      var dark = document.documentElement.getAttribute("data-theme") === "dark";
      b.textContent = dark ? "☀️" : "🌙";
    }
    render();
    b.addEventListener("click", function () {
      var dark = document.documentElement.getAttribute("data-theme") === "dark";
      var next = dark ? "light" : "dark";
      apply(next);
      try { localStorage.setItem(KEY, next); } catch (e) {}
      render();
    });
    document.body.appendChild(b);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", makeBtn);
  else makeBtn();
})();
