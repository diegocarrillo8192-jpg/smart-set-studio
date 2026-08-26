import { useEffect, useRef, useState } from "react";
import { MoveRight, RefreshCw, Sparkles } from "lucide-react";
import type { Recommendation, Track } from "../types";
import { api } from "../api";
import { fmtBpm } from "../lib/format";
import { hexRgba } from "../lib/color";
import Artwork from "./Artwork";

interface Props {
  /** Track semilla cargado en el Deck A (null = no mostrar). */
  seed: Track | null;
  onLoadToDeckB: (track: Track) => void;
}

const REL_CLASS: Record<string, string> = {
  same: "text-emerald-300",
  mode: "text-sky-300",
  neighbor: "text-violet-300",
  boost: "text-amber-300",
};

function relColor(rel: string): string {
  return (
    { same: "#34d399", mode: "#38bdf8", neighbor: "#a78bfa", boost: "#fbbf24" }[rel] ??
    "#fb7185"
  );
}

/**
 * Recomendador dinámico en vivo: al cargar un tema en el Deck A, muestra los
 * 5 tracks de la biblioteca con mayor compatibilidad armónica (Rueda Camelot)
 * y BPM similar, con su relación calculada por el backend.
 */
export default function RecommendationsPanel({ seed, onLoadToDeckB }: Props) {
  const [recs, setRecs] = useState<Recommendation[]>([]);
  const [loading, setLoading] = useState(false);
  const cacheRef = useRef<Map<number, Recommendation[]>>(new Map());

  useEffect(() => {
    if (!seed) {
      setRecs([]);
      return;
    }
    const cached = cacheRef.current.get(seed.id);
    if (cached) {
      setRecs(cached);
      return;
    }
    let cancelled = false;
    setLoading(true);
    api
      .getRecommendations(seed.id)
      .then((res) => {
        if (cancelled) return;
        cacheRef.current.set(seed.id, res.recommendations);
        setRecs(res.recommendations);
      })
      .catch(() => {
        if (!cancelled) setRecs([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [seed]);

  if (!seed) return null;

  return (
    <div className="flex shrink-0 flex-col gap-1.5 border-y border-slate-800/80 bg-panel-2/60 px-3 py-2 backdrop-blur">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <Sparkles size={12} className="text-violet-400" />
          <span className="text-[10px] font-black uppercase tracking-widest text-slate-300">
            Tracks Recomendados
          </span>
          <span className="hidden text-[10px] text-slate-500 sm:inline">
            en vivo · {seed.title} · {seed.camelot_key ?? "-"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {loading && <RefreshCw size={11} className="animate-spin text-slate-500" />}
          <span className="text-[10px] tabular-nums text-slate-500">
            {recs.length > 0 ? `${recs.length} matches armónicos` : "sin matches"}
          </span>
        </div>
      </div>

      {recs.length === 0 && !loading && (
        <p className="py-1 text-[10px] text-slate-500">
          Ningún tema de la biblioteca alcanza la compatibilidad armónica y de BPM. Prueba a
          escanear más pistas analizadas.
        </p>
      )}

      <div className="flex gap-2 overflow-x-auto pb-0.5">
        {recs.map((r) => {
          const rel = r.relation || "fallback";
          return (
            <button
              key={r.track.id}
              onClick={() => onLoadToDeckB(r.track)}
              title={`Cargar en Deck B · ${r.relation_label}`}
              className="group flex min-w-0 shrink-0 items-center gap-2 rounded-lg border border-slate-700/60 bg-slate-900/70 px-2 py-1.5 text-left transition hover:border-slate-500 hover:bg-slate-800/90"
              style={{ maxWidth: 270 }}
            >
              <Artwork track={r.track} accent={relColor(rel)} size={30} remountKey={`rec-${r.track.id}`} />
              <div className="min-w-0">
                <p className="truncate text-[11px] font-bold leading-tight text-zinc-100">
                  {r.track.title}
                </p>
                <p className="truncate text-[9px] leading-tight text-slate-400">{r.track.artist}</p>
              </div>
              <span
                className={`shrink-0 rounded px-1 py-0.5 font-mono text-[9px] font-black ${
                  r.track.camelot_key?.endsWith("B")
                    ? "bg-violet-500/25 text-violet-200"
                    : "bg-cyan-500/25 text-cyan-200"
                }`}
              >
                {r.track.camelot_key ?? "-"}
              </span>
              <span className="shrink-0 font-mono text-[9px] font-bold text-cyan-300">
                {fmtBpm(r.track.bpm)}
              </span>
              <span
                className={`shrink-0 rounded px-1 py-0.5 text-[8px] font-bold ${REL_CLASS[rel] ?? "text-rose-300"}`}
                style={{ background: hexRgba(relColor(rel), 0.12) }}
              >
                {r.relation_label ?? "Cruce"}
              </span>
              <span
                className="shrink-0 font-mono text-[9px] font-black"
                style={{ color: relColor(rel) }}
              >
                {r.score.toFixed(0)}
              </span>
              <MoveRight
                size={12}
                className="shrink-0 text-slate-500 transition group-hover:translate-x-0.5 group-hover:text-emerald-300"
              />
            </button>
          );
        })}
      </div>
    </div>
  );
}