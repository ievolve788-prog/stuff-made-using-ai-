// textutil.js — small text helpers shared by the service worker, the side panel and
// the Google-page script (each loads its own copy).
(function (g) {
  const TK = (g.TK = g.TK || {});

  // Always applied: line endings, non-breaking spaces, trailing spaces, blank lines at both ends.
  TK.baseClean = function (t) {
    return String(t == null ? "" : t)
      .replace(/\r\n?/g, "\n")
      .replace(/ /g, " ")
      .replace(/[ \t]+$/gm, "")
      .replace(/^\n+|\n+$/g, "");
  };

  // Optional tidy-up (settings: fCleanup / fJoinLines). Never touches the text when both are off.
  TK.tidy = function (text, opts) {
    let t = TK.baseClean(text);
    if (opts && opts.cleanup) {
      t = t
        .replace(/[​-‍⁠﻿]/g, "") // zero-width characters
        .replace(/([A-Za-zÀ-ɏ]{2})-\n([a-zß-ɏ])/g, "$1$2") // "exam-\nple" -> "example"
        .replace(/\n{3,}/g, "\n\n"); // leading indentation is kept on purpose (code, lists)
    }
    if (opts && opts.join) t = t.replace(/\s*\n\s*/g, " ").trim(); // everything on one line
    return t;
  };

  // For comparing a result with an expectation (self-test): case/space-insensitive.
  TK.norm = (t) => String(t || "").toLowerCase().replace(/\s+/g, " ").trim();

  // 0..1 (1 = identical), from the edit distance. For the self-test.
  TK.similarity = function (a, b) {
    a = String(a || "");
    b = String(b || "");
    if (!a.length && !b.length) return 1;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return 1 - prev[b.length] / Math.max(a.length, b.length);
  };

  TK.isNoText = (t) => /^NO TEXT FOUND\.?$/i.test(String(t || "").trim());

  TK.shorten = (t, n) => {
    const s = String(t || "").replace(/\s+/g, " ").trim();
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
  };
})(globalThis);
