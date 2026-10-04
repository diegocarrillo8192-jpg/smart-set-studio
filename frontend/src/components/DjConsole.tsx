import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Track } from "../types";
import type { WaveformPoint } from "../mixi/types";
import { api } from "../api";
import { audioEngine } from "../lib/audio";
import { MixiEngine } from "../mixi/audio/MixiEngine";
import { useMixiStore } from "../mixi/store/mixiStore";
import { DeckSection } from "../mixi/components/deck/DeckSection";
import { MixerSection } from "../mixi/components/mixer/MixerSection";
import { MixiTopBar } from "../mixi/components/console/MixiTopBar";
import { TopWaveforms } from "../mixi/components/console/TopWaveforms";
import { TrackOverview } from "../mixi/components/console/TrackOverview";
import { DeckTracksContext } from "../mixi/components/console/deckTracks";
import { COLOR_DECK_A, COLOR_DECK_B } from "../mixi/theme";

interface Props {
  deckATrack: Track | null;
  deckBTrack: Track | null;
  onDropTrack: (name: "A" | "B", track: Track) => void;
  /** Notifica si cada deck está reproduciendo (para resaltar en las tablas). */
  onDeckPlayingChange?: (name: "A" | "B", playing: boolean) => void;
}

const POINTS_PER_SECOND = 100;
/** Altura natural de diseño de la consola MIXI (se escala para caber).
 *  Compactada desde 1080: elimina el aire sobrante sobre los platos y bajo la
 *  franja de pads, de modo que el contenido llene el bloque sin huecos. */
const NATURAL_HEIGHT = 840;

/** MIME a partir de la extensión (para el Blob del deck). */
function guessMime(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "mp3":
      return "audio/mpeg";
    case "wav":
      return "audio/wav";
    case "flac":
      return "audio/flac";
    case "m4a":
    case "mp4":
    case "aac":
      return "audio/mp4";
    case "ogg":
    case "oga":
    case "opus":
      return "audio/ogg";
    case "aif":
    case "aiff":
      return "audio/aiff";
    default:
      return "audio/mpeg";
  }
}

/** WaveformPoint[] a 100 puntos/s a partir de las barras RGB del análisis. */
function resampleBars(
  bars: { t: number; lo: number; mid: number; hi: number }[],
  duration: number
): WaveformPoint[] {
  const n = Math.max(1, Math.ceil(duration * POINTS_PER_SECOND));
  const out: WaveformPoint[] = new Array(n);
  for (let i = 0; i < n; i++) out[i] = { low: 0, mid: 0, high: 0 };
  for (const b of bars) {
    const idx = Math.min(n - 1, Math.max(0, Math.round(b.t * POINTS_PER_SECOND)));
    out[idx] = { low: b.lo, mid: b.mid, high: b.hi };
  }
  let prev = out[0];
  for (let i = 0; i < n; i++) {
    if (out[i].low || out[i].mid || out[i].high) prev = out[i];
    else out[i] = prev;
  }
  return out;
}

/**
 * Picos reales de frecuencia (multibanda) del audio decodificado, a 100 pts/s:
 * separa graves / medios / agudos con filtros one-pole y toma el pico de cada
 * banda por punto. Reproduce los picos y valles reales (estilo Rekordbox RGB).
 * Normaliza por la suma máxima para que las bandas apiladas no se recorten.
 */
function bandsFromBuffer(buffer: AudioBuffer): WaveformPoint[] {
  const sr = buffer.sampleRate;
  const ch = buffer.getChannelData(0);
  const n = Math.max(1, Math.ceil(buffer.duration * POINTS_PER_SECOND));
  const per = ch.length / n;
  const aLow = Math.exp((-2 * Math.PI * 200) / sr); // lowpass 200 Hz
  const aHigh = Math.exp((-2 * Math.PI * 4000) / sr); // lowpass 4 kHz
  const out: WaveformPoint[] = new Array(n);
  let lpLow = 0;
  let lpHigh = 0;
  let i = 0;
  let maxTotal = 1e-6;
  for (let p = 0; p < n; p++) {
    const end = Math.min(ch.length, Math.floor((p + 1) * per));
    let lo = 0;
    let mid = 0;
    let hi = 0;
    for (; i < end; i++) {
      const x = ch[i];
      lpLow = lpLow * aLow + (1 - aLow) * x;
      lpHigh = lpHigh * aHigh + (1 - aHigh) * x;
      const low = lpLow;
      const m = lpHigh - lpLow;
      const high = x - lpHigh;
      const aL = Math.abs(low);
      const aM = Math.abs(m);
      const aH = Math.abs(high);
      if (aL > lo) lo = aL;
      if (aM > mid) mid = aM;
      if (aH > hi) hi = aH;
    }
    out[p] = { low: lo, mid, high: hi };
    const t = lo + mid + hi;
    if (t > maxTotal) maxTotal = t;
  }
  for (let p = 0; p < n; p++) {
    out[p] = { low: out[p].low / maxTotal, mid: out[p].mid / maxTotal, high: out[p].high / maxTotal };
  }
  return out;
}

/**
 * Consola DJ profesional NATIVA montando las vistas REALES de MIXI
 * (github.com/fabriziosalmi/mixi · PolyForm Noncommercial 1.0.0):
 * DeckSection + MixerSection + PremiumJogWheel + WaveformDisplay +
 * PerformancePads + PitchStrip, sobre el motor de audio de Smart Set Studio
 * y el SYNC instantáneo (un solo disparo) de lib/mixi.ts.
 */
export default function DjConsole({ deckATrack, deckBTrack, onDropTrack, onDeckPlayingChange }: Props) {
  const dragOver = useRef<"A" | "B" | null>(null);
  const outerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  // Enlaza los decks al grafo Web Audio una sola vez.
  useEffect(() => {
    audioEngine.bindDeck("A");
    audioEngine.bindDeck("B");
  }, []);

  // Escala proporcional: la consola MIXI conserva su diseño y cabe en el alto
  // disponible (se recalcula al redimensionar la ventana).
  useEffect(() => {
    const el = outerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const update = () => {
      const h = el.clientHeight;
      // Sin suelo alto: si la ventana es baja (portátil/pantalla corta), la
      // consola se escala lo necesario para que TODO quepa. Un suelo mayor
      // (p. ej. 0.35) dejaba el contenido más alto que su contenedor y recortaba
      // los pads/loops de los decks y el crossfader bajo las cuchillas.
      setScale(Math.max(0.2, Math.min(1, h / NATURAL_HEIGHT)));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Atajo de teclado: C = CUE del deck activo (el que suena o Deck A).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.key === "c" || e.key === "C") {
        const store = useMixiStore.getState();
        const deck =
          store.decks.A.isPlaying && !store.decks.B.isPlaying
            ? "A"
            : store.decks.B.isPlaying && !store.decks.A.isPlaying
              ? "B"
              : "A";
        store.cueDeck(deck);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Notifica a App (resaltado de filas) los cambios de play/pause de cada deck.
  useEffect(() => {
    const unsubA = useMixiStore.subscribe(
      (s) => s.decks.A.isPlaying,
      (playing) => onDeckPlayingChange?.("A", playing)
    );
    const unsubB = useMixiStore.subscribe(
      (s) => s.decks.B.isPlaying,
      (playing) => onDeckPlayingChange?.("B", playing)
    );
    return () => {
      unsubA();
      unsubB();
    };
  }, [onDeckPlayingChange]);

  const loadDeck = useCallback(async (deck: "A" | "B", track: Track) => {
    const store = useMixiStore.getState();
    store.setDeckLoadingStage(deck, "Cargando…");
    store.setDeckTrackName(deck, track.title);
    store.setDeckAnalysis(deck, [], track.camelot_key ?? "");
    try {
      const url = api.audioUrl(track);
      // Descarga UNA vez. Se extraen DOS copias independientes del ArrayBuffer:
      //   · playbackBuf → Blob que reproduce el <audio> del deck.
      //   · decodeBuf   → decodeAudioData (algunos navegadores lo DETACHAN al
      //                   decodificar; por eso NUNCA se reutiliza el buffer de
      //                   reproducción ni se pasa un buffer "truncado").
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw = await res.arrayBuffer();
      const ct = res.headers.get("content-type") ?? "";
      const mime = ct && !ct.includes("octet-stream") ? ct : guessMime(track.file_path);
      const playbackBuf = raw.slice(0);
      const decodeBuf = raw.slice(0);
      const blob = new Blob([playbackBuf], { type: mime });
      await MixiEngine.getInstance().loadTrack(deck, blob);
      // La carga de un track nuevo libera el SYNC de este deck en el motor
      // (y disuelve la pareja en cascada si este era el MASTER): el store
      // espeja el estado real de ambos decks para que las etiquetas
      // MASTER/FOLLOW y el tempo del otro deck queden honestos tras la carga.
      store.syncFromEngine();
      audioEngine.setDeckMeta(deck, { originalBpm: track.bpm ?? 0 });
      if (track.bpm) store.setDeckBpm(deck, track.bpm, 0, 1);
      store.setDeckTrackLoaded(deck, true);

      // Forma de onda: picos REALES multibanda del audio decodificado.
      let duration = track.duration_sec ?? 0;
      let haveWave = false;
      try {
        const decoded = await audioEngine.ensureContext().decodeAudioData(decodeBuf);
        duration = decoded.duration || duration;
        store.setDeckWaveform(deck, bandsFromBuffer(decoded), duration);
        haveWave = true;
      } catch (err) {
        console.warn("[DjConsole] no se pudo decodificar la onda", deck, err);
      }

      // Respaldo: barras RGB del análisis estructural (si no hubo decodificación).
      if (!haveWave) {
        try {
          const analysis = await api.getAnalysis(track.file_path);
          if (analysis?.bpm && !track.bpm) {
            store.setDeckBpm(deck, analysis.bpm, 0, 1);
            audioEngine.setDeckMeta(deck, { originalBpm: analysis.bpm });
          }
          if (analysis?.bars?.length) {
            const dur = analysis.duration_sec || duration;
            store.setDeckWaveform(deck, resampleBars(analysis.bars, dur), dur);
          }
        } catch {
          /* sin análisis estructural */
        }
      }
    } catch (err) {
      console.error("[DjConsole] error cargando en deck", deck, err);
    } finally {
      store.setDeckLoadingStage(deck, null);
    }
  }, []);

  // Inyección desde la biblioteca: doble clic / drag & drop llegan por props.
  useEffect(() => {
    if (deckATrack) void loadDeck("A", deckATrack);
  }, [deckATrack, loadDeck]);
  useEffect(() => {
    if (deckBTrack) void loadDeck("B", deckBTrack);
  }, [deckBTrack, loadDeck]);

  // Zona de drop (drag & drop de biblioteca: payload JSON con el Track).
  const dropZone = (deck: "A" | "B") => ({
    onDragOver: (e: React.DragEvent) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      dragOver.current = deck;
    },
    onDragLeave: () => {
      if (dragOver.current === deck) dragOver.current = null;
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      dragOver.current = null;
      try {
        const t = JSON.parse(e.dataTransfer.getData("application/json")) as Track;
        if (t && typeof t.id === "number" && typeof t.title === "string") onDropTrack(deck, t);
      } catch {
        /* no es un track de la biblioteca */
      }
    },
  });

  // Valor del contexto memoizado: identidad estable mientras los tracks no
  // cambien — evita re-renderizar a todos los consumidores en cada render.
  const deckTracksValue = useMemo(
    () => ({ A: deckATrack, B: deckBTrack }),
    [deckATrack, deckBTrack]
  );

  return (
    <DeckTracksContext.Provider value={deckTracksValue}>
    <div ref={outerRef} className="relative h-full w-full overflow-hidden bg-[#0b0f19]">
      <div
        className="mixi-chassis flex flex-col gap-1 p-1"
        style={{
          width: `${100 / scale}%`,
          height: NATURAL_HEIGHT,
          transform: `scale(${scale})`,
          transformOrigin: "top left",
        }}
      >
        {/* Barra superior global estilo MIXI */}
        <MixiTopBar deckATrack={deckATrack} deckBTrack={deckBTrack} />

        {/* Onda completa del track (Overview): Deck A izquierda / Deck B derecha */}
        <TrackOverview colorA={COLOR_DECK_A} colorB={COLOR_DECK_B} height={24} />

        {/* Doble forma de onda alineada (Deck A arriba / Deck B abajo) */}
        <TopWaveforms colorA={COLOR_DECK_A} colorB={COLOR_DECK_B} height={36} />

        {/* Decks + Mixer */}
        <div className="flex min-h-0 flex-1 gap-1">
          <div {...dropZone("A")} className="min-h-0 min-w-0 flex-1">
            <DeckSection deckId="A" color={COLOR_DECK_A} />
          </div>

          {/* Mixer central: ocupa toda la altura de la fila. Así la base de las
              cuchillas (panel del canal) queda a la altura de la fila de pads y
              la base del mixer al ras con la base de los decks (franja inferior
              pareja, sin hueco flotante). */}
          <div className="flex min-h-0 w-[360px] shrink-0 flex-col">
            <MixerSection />
          </div>

          <div {...dropZone("B")} className="min-h-0 min-w-0 flex-1">
            <DeckSection deckId="B" color={COLOR_DECK_B} />
          </div>
        </div>
      </div>
    </div>
    </DeckTracksContext.Provider>
  );
}
