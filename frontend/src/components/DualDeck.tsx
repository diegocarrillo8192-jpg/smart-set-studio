import { useEffect, useRef, useState } from "react";
import { Radio } from "lucide-react";
import type { Track } from "../types";
import { audioEngine } from "../lib/audio";
import { api, markWebCacheUnhealthy } from "../api";
import Deck from "./Deck";
import Crossfader, { CrossfaderHeader } from "./Crossfader";

interface Props {
  deckATrack: Track | null;
  deckBTrack: Track | null;
  onDropTrack: (name: "A" | "B", track: Track) => void;
  /** El deck que acaba de interactuar el usuario (PLAY/CUE). */
  onActivateDeck?: (name: "A" | "B") => void;
  /** Deck activo (destacado con glow neón suave). */
  activeDeck?: "A" | "B" | null;
  /** Notifica si cada deck está reproduciendo (para resaltar en las tablas). */
  onDeckPlayingChange?: (name: "A" | "B", playing: boolean) => void;
}

function parseTrack(json: string): Track | null {
  try {
    const t = JSON.parse(json);
    if (t && typeof t.id === "number" && typeof t.title === "string") return t as Track;
  } catch {
    /* no es un track */
  }
  return null;
}

function DropOverlay({ deck, accent }: { deck: string; accent: string }) {
  return (
    <div
      className="pointer-events-none absolute inset-0 z-10 grid place-items-center rounded-xl border-2 border-dashed"
      style={{ borderColor: accent, background: "rgba(2,6,23,0.6)" }}
    >
      <span className="rounded-full px-3 py-1 text-xs font-black uppercase tracking-widest text-black" style={{ background: accent }}>
        Suelta en Deck {deck}
      </span>
    </div>
  );
}

/**
 * Reproductor compacto (Dual Pre-listener): DECK A | CROSSFADER | DECK B.
 * Controles directos por plato (SYNC/FILTER) y crossfader con curva de mute.
 */
export default function DualDeck({ deckATrack, deckBTrack, onDropTrack, onActivateDeck, activeDeck, onDeckPlayingChange }: Props) {
  const audioARef = useRef<HTMLAudioElement>(null);
  const audioBRef = useRef<HTMLAudioElement>(null);
  const boundRef = useRef(false);
  const [dragOver, setDragOver] = useState<"A" | "B" | null>(null);

  // Vincular los <audio> al grafo Web Audio (idempotente, seguro con StrictMode)
  useEffect(() => {
    if (boundRef.current || !audioARef.current || !audioBRef.current) return;
    try {
      const a = audioEngine.bindDeck("A", audioARef.current);
      const b = audioEngine.bindDeck("B", audioBRef.current);
      if (!a || !b) return;
      boundRef.current = true;
    } catch (err) {
      console.error("[DualDeck] Error al inicializar el motor de audio", err);
    }
  }, []);

  // Cargar tracks desde el backend (streaming por servidor, nunca rutas locales).
  // Al cambiar de track: pausar y rebobinar el deck anterior para liberar la
  // decodificación en curso y optimizar memoria con bibliotecas grandes.
  // En web, si el stream por path falla (variación de ruta/viejo caché del
  // navegador), se reintenta automáticamente con el stream por ID de track.
  useEffect(() => {
    if (!deckATrack || !boundRef.current) return;
    const el = audioEngine.deckA!.el;
    el.pause();
    el.currentTime = 0;
    const tryPath = () => {
      el.onerror = () => {
        el.onerror = null;
        el.onerror = () => {
          // El stream falla por ruta Y por ID: caché web rota. Se marca para
          // que el próximo arranque en navegador haga el reseteo automático.
          markWebCacheUnhealthy();
        };
        el.src = api.audioUrlById(deckATrack!.id);
        el.load();
      };
      el.src = api.audioUrl(deckATrack);
      el.load();
    };
    tryPath();
  }, [deckATrack]);

  useEffect(() => {
    if (!deckBTrack || !boundRef.current) return;
    const el = audioEngine.deckB!.el;
    el.pause();
    el.currentTime = 0;
    const tryPath = () => {
      el.onerror = () => {
        el.onerror = null;
        el.onerror = () => {
          // El stream falla por ruta Y por ID: caché web rota. Se marca para
          // que el próximo arranque en navegador haga el reseteo automático.
          markWebCacheUnhealthy();
        };
        el.src = api.audioUrlById(deckBTrack!.id);
        el.load();
      };
      el.src = api.audioUrl(deckBTrack);
      el.load();
    };
    tryPath();
  }, [deckBTrack]);

  const dropZone = (name: "A" | "B") => ({
    onDragOver: (e: React.DragEvent) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      setDragOver(name);
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node)) {
        setDragOver((v) => (v === name ? null : v));
      }
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(null);
      const t = parseTrack(e.dataTransfer.getData("application/json"));
      if (t) onDropTrack(name, t);
    },
  });

  return (
    <div className="flex h-full min-h-0 flex-col gap-1.5 p-2">
      {/* Audio elements ocultos — crossOrigin es OBLIGATORIO para que Web Audio
          (MediaElementSource) reciba el audio por CORS en vez de silencio. */}
      <audio ref={audioARef} crossOrigin="anonymous" preload="auto" className="hidden" />
      <audio ref={audioBRef} crossOrigin="anonymous" preload="auto" className="hidden" />

      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-slate-300">
          <Radio size={13} className="text-cyan-400" /> Reproductor
        </h2>
      </div>

      {/* DECK A | CROSSFADER | DECK B */}
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_200px_minmax(0,1fr)] gap-2">
        <div {...dropZone("A")} className={`relative min-h-0 rounded-xl ${dragOver === "A" ? "ring-2 ring-cyan-400/80" : ""}`}>
          <Deck
            name="A"
            track={deckATrack}
            handle={audioEngine.deckA}
            accent="#06b6d4"
            otherBpm={deckBTrack?.bpm ?? null}
            active={activeDeck === "A"}
            onActivate={() => onActivateDeck?.("A")}
            onPlayingChange={(playing) => onDeckPlayingChange?.("A", playing)}
          />
          {dragOver === "A" && <DropOverlay deck="A" accent="#06b6d4" />}
        </div>

        {/* Crossfader único, aislado en el centro */}
        <div className="flex min-h-0 flex-col items-center justify-center gap-2 rounded-xl border border-slate-800/60 bg-white/[0.03] p-3 shadow-lg shadow-black/40 backdrop-blur-md">
          <CrossfaderHeader />
          <Crossfader
            position={audioEngine.getCrossfader()}
            onChange={(pos) => audioEngine.setCrossfader(pos)}
          />
        </div>

        <div {...dropZone("B")} className={`relative min-h-0 rounded-xl ${dragOver === "B" ? "ring-2 ring-violet-400/80" : ""}`}>
          <Deck
            name="B"
            track={deckBTrack}
            handle={audioEngine.deckB}
            accent="#8b5cf6"
            otherBpm={deckATrack?.bpm ?? null}
            active={activeDeck === "B"}
            onActivate={() => onActivateDeck?.("B")}
            onPlayingChange={(playing) => onDeckPlayingChange?.("B", playing)}
          />
          {dragOver === "B" && <DropOverlay deck="B" accent="#8b5cf6" />}
        </div>
      </div>
    </div>
  );
}
