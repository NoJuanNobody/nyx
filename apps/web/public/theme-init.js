// Runs before first paint to avoid a flash of the wrong theme/accent.
// External (not inline) so it satisfies script-src 'self'. Keep in sync with src/lib/theme.ts.
(function () {
  try {
    var t = localStorage.getItem('nyx:theme');
    if (t !== 'light' && t !== 'dark') t = 'system';
    var dark = t === 'dark' || (t === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    var root = document.documentElement;
    if (dark) root.classList.add('dark');
    root.style.colorScheme = dark ? 'dark' : 'light';
    var hues = { purple: 287, indigo: 265, blue: 250, teal: 200, green: 150, rose: 5, orange: 50 };
    var a = localStorage.getItem('nyx:accent');
    if (a && Object.prototype.hasOwnProperty.call(hues, a)) root.style.setProperty('--accent-hue', String(hues[a]));
  } catch (e) {
    /* storage blocked: fall back to CSS defaults (light, purple) */
  }
})();
