import { useCallback, useState } from "react";
import { audioEngine } from "../lib/audio";

/**
 * Estado y controladores de LOOP / BEAT JUMP de un deck nativo.
 *
 * Todo el comportamiento vive en el motor de audio (cuantización exacta a la
 * rejilla en tiempo de fuente, fase continua, SYNC conservado); aquí solo se
 * mantiene el estado visual (pad activo iluminado) sincronizado con el motor.
 *
 *   · AUTO LOOP: loop de N beats desde el beat actual; pulsar el pad activo
 *     lo libera sin desfasar.
 *   · LOOP IN/OUT: punto IN cuantizado al beat actual; OUT cierra el loop en
 *     el beat siguiente y lo arma al instante.
 *   · EXIT: libera el loop (fase continua, sin saltos).
 *   · BEAT JUMP: salto de N beats exactos sobre la grilla (múltiplo entero
 *     del periodo → la fase no cambia y el SYNC se conserva).
 */
export function useDeckLoopControls(
  name: "A" | "B",
  el: HTMLAudioElement | null,
  trackBpm: number | null,
  onActivate: (() => void) | undefined,
  trackKey: string | number | null,
) {
  const [loopBeats, setLoopBeats] = useState<number | null>(null);
  const [loopInPending, setLoopInPending] = useState(false);

  // Al cambiar de track: reset del estado visual de loop, ajustado durante
  // el render (patrón "previous prop") — el motor ya fue limpiado por el
  // efecto de cambio de track del Deck.
  const [prevTrackKey, setPrevTrackKey] = useState(trackKey);
  if (prevTrackKey !== trackKey) {
    setPrevTrackKey(trackKey);
    setLoopBeats(null);
    setLoopInPending(false);
  }

  /** AUTO LOOP: cuantizado EXACTO a la grilla (N beats, tiempo de fuente). */
  const handleAutoLoop = useCallback(
    (beats: number) => {
      if (!el || !trackBpm) return;
      onActivate?.();
      const cur = audioEngine.getLoop(name);
      if (cur && !cur.roll && cur.beats === beats) {
        audioEngine.exitLoop(name);
        setLoopBeats(null);
        return;
      }
      const l = audioEngine.setAutoLoop(name, beats);
      if (l) {
        setLoopBeats(l.beats);
        setLoopInPending(false);
      }
    },
    [el, trackBpm, name, onActivate]
  );

  /** LOOP IN manual: fija el inicio en el beat actual de la grilla. */
  const handleLoopIn = useCallback(() => {
    if (!el || !trackBpm) return;
    onActivate?.();
    setLoopInPending(audioEngine.setLoopIn(name) !== null);
  }, [el, trackBpm, name, onActivate]);

  /** LOOP OUT manual: cierra el loop en el beat actual y lo arma al instante. */
  const handleLoopOut = useCallback(() => {
    if (!el || !trackBpm) return;
    onActivate?.();
    const l = audioEngine.setLoopOut(name);
    if (l) {
      setLoopBeats(l.beats);
      setLoopInPending(false);
    }
  }, [el, trackBpm, name, onActivate]);

  /** EXIT: libera el loop sin desfasar el track (fase continua). */
  const handleExitLoop = useCallback(() => {
    if (!el) return;
    audioEngine.exitLoop(name);
    setLoopBeats(null);
    setLoopInPending(false);
  }, [el, name]);

  /** BEAT JUMP: salto cuantizado exacto (múltiplo entero de beats → fase
   *  intacta, SYNC Hard Lock conservado). */
  const handleBeatJump = useCallback(
    (beats: number) => {
      if (!el || !trackBpm) return;
      onActivate?.();
      audioEngine.beatJump(name, beats);
    },
    [el, trackBpm, name, onActivate]
  );

  return {
    loopBeats,
    loopInPending,
    handleAutoLoop,
    handleLoopIn,
    handleLoopOut,
    handleExitLoop,
    handleBeatJump,
  };
}
