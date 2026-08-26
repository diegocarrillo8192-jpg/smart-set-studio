import { useEffect, useState } from "react";
import { Eraser, Loader2, Save, X } from "lucide-react";
import type { Settings } from "../types";
import { api, resetWebCache } from "../api";

interface Props {
  open: boolean;
  onClose: () => void;
}

/** Parsea el valor de un input numérico de forma segura: si el texto no es un
 *  número finito (campo vacío o parcial, p. ej. "-" o "e") devuelve 0 en vez
 *  de propagar NaN al estado. */
function parseNum(v: string): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export default function SettingsModal({ open, onClose }: Props) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  /** En la app de escritorio (Electron) el preload expone smartSet.isDesktop. */
  const isDesktop = typeof window !== "undefined" && !!window.smartSet?.isDesktop;

  const resetWeb = async () => {
    setConfirmReset(false);
    setResetting(true);
    try {
      await resetWebCache();
      window.location.reload();
    } catch (e) {
      console.error(e);
      setResetting(false);
    }
  };

  useEffect(() => {
    if (open) {
      api.getSettings().then(setSettings).catch(console.error);
      setSaved(false);
    }
  }, [open]);

  if (!open || !settings) return null;

  const update = (patch: Partial<Settings>) => setSettings((s) => (s ? { ...s, ...patch } : s));

  const save = async () => {
    setSaving(true);
    try {
      await api.updateSettings(settings);
      setSaved(true);
      setTimeout(onClose, 700);
    } catch (e) {
      console.error(e);
    } finally {
      setSaving(false);
    }
  };

  const row = "flex items-center justify-between gap-4 py-3";
  const label = "text-xs font-semibold text-slate-200";
  const desc = "text-[10px] text-slate-500";
  const input =
    "w-24 rounded border border-slate-700 bg-panel-3 px-2 py-1 text-right text-xs text-slate-200 focus:border-violet-500 focus:outline-none";

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Ajustes del Motor de Mezcla"
        className="w-full max-w-lg rounded-2xl border border-slate-700 bg-panel-2 p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-bold uppercase tracking-widest text-white">Ajustes del Motor de Mezcla</h2>
          <button onClick={onClose} aria-label="Cerrar ajustes" className="rounded p-1 text-slate-400 hover:text-white">
            <X size={16} />
          </button>
        </div>

        <div className="divide-y divide-slate-800">
          <div className={row}>
            <div>
              <p className={label}>Tolerancia de BPM</p>
              <p className={desc}>Variación máxima entre tracks consecutivos</p>
            </div>
            <input
              type="number"
              min={0.5}
              max={20}
              step={0.5}
              aria-label="Tolerancia de BPM"
              value={settings.max_bpm_variation_pct}
              onChange={(e) => update({ max_bpm_variation_pct: parseNum(e.target.value) })}
              className={input}
            />
          </div>
          <div className={row}>
            <div>
              <p className={label}>Salto de Energy Boost</p>
              <p className={desc}>Números Camelot que sube un salto +2 (ej: 9A → 11A)</p>
            </div>
            <input
              type="number"
              min={1}
              max={5}
              aria-label="Salto de Energy Boost"
              value={settings.energy_boost_jump}
              onChange={(e) => update({ energy_boost_jump: parseNum(e.target.value) })}
              className={input}
            />
          </div>
          <div className={row}>
            <div>
              <p className={label}>Radio armónico (vecinos)</p>
              <p className={desc}>Distancia en la Rueda Camelot para transiciones vecinas</p>
            </div>
            <input
              type="number"
              min={1}
              max={2}
              aria-label="Radio armónico (vecinos)"
              value={settings.harmonic_radius}
              onChange={(e) => update({ harmonic_radius: parseNum(e.target.value) })}
              className={input}
            />
          </div>
          <div className={row}>
            <div>
              <p className={label}>Permitir cambio de modo</p>
              <p className={desc}>XA ↔ XB (menor a mayor manteniendo número)</p>
            </div>
            <input
              type="checkbox"
              aria-label="Permitir cambio de modo"
              checked={settings.allow_mode_change}
              onChange={(e) => update({ allow_mode_change: e.target.checked })}
              className="h-4 w-4"
            />
          </div>

          <div className={row}>
            <div>
              <p className={label}>
                Escribir Key detectado en etiquetas ID3 de los archivos originales (Escritorio)
              </p>
              <p className={desc}>
                {isDesktop
                  ? "Guarda la tonalidad en TKEY / COMM del MP3 al analizarlo (sin tocar el audio)"
                  : "Solo disponible en la app de escritorio — en web los archivos del sistema nunca se modifican"}
              </p>
            </div>
            <input
              type="checkbox"
              aria-label="Escribir Key detectado en etiquetas ID3"
              checked={settings.write_id3_keys}
              disabled={!isDesktop}
              onChange={(e) => update({ write_id3_keys: e.target.checked })}
              className="h-4 w-4 disabled:opacity-30"
            />
          </div>

          {!isDesktop && (
            <div className={row}>
              <div>
                <p className={label}>Resetear caché web</p>
                <p className={desc}>
                  Borra LocalStorage, IndexedDB y Cache Storage del navegador (carátulas o
                  metadatos rotos). Nunca afecta a la base de datos ni a la app de escritorio.
                </p>
              </div>
              <button
                onClick={() => setConfirmReset(true)}
                disabled={resetting}
                className="flex items-center gap-1.5 rounded-lg border border-slate-700 bg-panel-3 px-3 py-1.5 text-xs font-semibold text-slate-200 transition hover:border-red-500/50 hover:text-red-300 disabled:opacity-40"
              >
                {resetting ? <Loader2 size={12} className="animate-spin" /> : <Eraser size={12} />}
                {resetting ? "Borrando…" : "Borrar caché"}
              </button>
            </div>
          )}
        </div>

        <div className="mt-5 flex items-center gap-3">
          <button
            onClick={save}
            disabled={saving}
            className="flex items-center gap-2 rounded-lg bg-violet-600 px-4 py-2 text-xs font-bold text-white transition hover:bg-violet-500 disabled:opacity-40"
          >
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
            Guardar ajustes
          </button>
          {saved && <span className="text-xs text-emerald-400">Guardado ✓</span>}
        </div>
      </div>

      {/* Diálogo sutil de confirmación: reset de caché (sin window.confirm) */}
      {confirmReset && (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-black/60 backdrop-blur-sm"
          onMouseDown={(e) => {
            e.stopPropagation();
            setConfirmReset(false);
          }}
        >
          <div
            className="w-80 rounded-xl border border-slate-700 bg-[#141a2b] p-4 shadow-2xl shadow-black/70"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <h3 className="text-sm font-bold text-slate-100">Resetear caché web</h3>
            <p className="mt-1.5 text-xs leading-relaxed text-slate-400">
              Se borrarán las cachés locales del NAVEGADOR (carátulas, metadatos y almacenamiento
              web). La biblioteca de la base de datos y la app de escritorio NO se ven afectadas.
              ¿Continuar?
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setConfirmReset(false);
                }}
                className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs font-semibold text-slate-300 transition hover:bg-panel-2"
              >
                Cancelar
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  void resetWeb();
                }}
                className="flex items-center gap-1.5 rounded-lg bg-red-500/90 px-3 py-1.5 text-xs font-bold text-white transition hover:bg-red-500"
              >
                <Eraser size={12} /> Borrar caché
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
