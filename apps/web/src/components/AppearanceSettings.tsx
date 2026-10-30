import { useUIStore } from '../stores/ui.store';
import { ACCENT_PRESETS, accentById, type Theme } from '../lib/theme';

const THEME_OPTIONS: { value: Theme; label: string; hint: string }[] = [
  { value: 'system', label: 'System', hint: 'Follow your OS setting' },
  { value: 'light', label: 'Light', hint: 'Always light' },
  { value: 'dark', label: 'Dark', hint: 'Always dark' },
];

export function AppearanceSettings() {
  const theme = useUIStore((s) => s.theme);
  const setTheme = useUIStore((s) => s.setTheme);
  const accent = useUIStore((s) => s.accent);
  const setAccent = useUIStore((s) => s.setAccent);

  return (
    <div className="space-y-6" data-testid="appearance-settings">
      <section className="rounded-lg border border-slate-200 bg-white p-5">
        <h3 className="text-sm font-semibold text-slate-800">Theme</h3>
        <p className="mt-1 text-xs text-slate-500">
          Choose how Nyx looks. System follows your operating system and updates live.
        </p>
        <div role="radiogroup" aria-label="Theme" className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-3">
          {THEME_OPTIONS.map((opt) => {
            const selected = theme === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                role="radio"
                aria-checked={selected}
                data-testid={`theme-${opt.value}`}
                onClick={() => setTheme(opt.value)}
                className={`rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                  selected
                    ? 'border-blue-600 bg-blue-50 text-blue-700'
                    : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                }`}
              >
                <span className="block font-medium">{opt.label}</span>
                <span className="block text-xs text-slate-500">{opt.hint}</span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-5">
        <h3 className="text-sm font-semibold text-slate-800">Accent color</h3>
        <p className="mt-1 text-xs text-slate-500">
          Applies to buttons, links and highlights in both light and dark mode. Current: {accentById(accent).label}.
        </p>
        <div role="radiogroup" aria-label="Accent color" className="mt-4 flex flex-wrap gap-3">
          {ACCENT_PRESETS.map((preset) => {
            const selected = preset.id === accent;
            return (
              <button
                key={preset.id}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-label={preset.label}
                title={preset.label}
                data-testid={`accent-${preset.id}`}
                onClick={() => setAccent(preset.id)}
                style={{ backgroundColor: `oklch(53% 0.2 ${preset.hue})` }}
                className={`h-8 w-8 rounded-full ring-offset-2 ring-offset-white transition-shadow ${
                  selected ? 'ring-2 ring-slate-900' : 'hover:ring-2 hover:ring-slate-300'
                }`}
              />
            );
          })}
        </div>
      </section>

      <p className="text-xs text-slate-500">
        Animations are reduced automatically when your system requests reduced motion.
      </p>
    </div>
  );
}
