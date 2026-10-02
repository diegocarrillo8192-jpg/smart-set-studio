import { useCallback, useState, type FC } from "react";
import { audioEngine, EQ_MAX_DB, EQ_MIN_DB, type EqBand } from "../../lib/audio";
import { DragKnob } from "./DragKnob";
import { DragFader } from "./DragFader";
import { VuMeter } from "./VuMeter";
import { COLOR_DECK_A, COLOR_DECK_B, COLOR_MASTER } from "./theme";

/**
 * Sección Mixer estilo MIXI (inspirada en components/mixer/MixerSection.tsx,
 * github.com/fabriziosalmi/mixi · PolyForm Noncommercial 1.0.0), reescrita
 * nativa sobre el motor Web Audio de Smart Set Studio.
 *
 * Canal: GAIN + EQ 3 bandas (HI/MID/LOW, kill con doble clic) + FADER + VU.
 * Centro: CROSSFADER + MASTER (gain + VU master).
 */

/** Orden visual (arriba→abajo) y su banda del motor (0=LOW, 1=MID, 2=HIGH). */
const EQ_BANDS: { label: string; band: EqBand }[] = [
  { label: "HI", band: 2 },
  { label: "MID", band: 1 },
  { label: "LOW", band: 0 },
];

const ChannelStrip: FC<{
  name: "A" | "B";
  color: string;
  gain: number;
  eq: [number, number, number];
  fader: number;
  onGain: (v: number) => void;
  onEq: (band: EqBand, v: number) => void;
  onFader: (v: number) => void;
}> = ({ name, color, gain, eq, fader, onGain, onEq, onFader }) => (
  <div className="flex min-h-0 flex-col items-center gap-1.5 rounded-xl border border-slate-800/60 bg-white/[0.03] px-2 py-2">
    <span className="text-[9px] font-black tracking-widest" style={{ color }}>
      DECK {name}
    </span>
    <div className="flex items-stretch gap-2">
      <div className="flex flex-col items-center justify-between gap-1">
        <DragKnob
          value={gain}
          min={0}
          max={1.6}
          defaultValue={1}
          color={color}
          label="GAIN"
          showValue
          onChange={onGain}
        />
        {EQ_BANDS.map(({ label, band }) => (
          <DragKnob
            key={label}
            value={eq[band]}
            min={EQ_MIN_DB}
            max={EQ_MAX_DB}
            center={0}
            bipolar
            color={color}
            label={label}
            showValue
            onChange={(v) => onEq(band, v)}
          />
        ))}
      </div>
      <VuMeter name={name} height={150} />
      <DragFader
        value={fader}
        min={0}
        max={1}
        color={color}
        label="VOL"
        length={150}
        onChange={onFader}
      />
    </div>
  </div>
);

export const MixiMixer: FC = () => {
  const [gainA, setGainA] = useState(1);
  const [gainB, setGainB] = useState(1);
  const [eqA, setEqA] = useState<[number, number, number]>([0, 0, 0]);
  const [eqB, setEqB] = useState<[number, number, number]>([0, 0, 0]);
  const [faderA, setFaderA] = useState(1);
  const [faderB, setFaderB] = useState(1);
  const [cross, setCross] = useState(0);
  const [master, setMaster] = useState(0.9);

  const changeGain = useCallback((name: "A" | "B", v: number) => {
    if (name === "A") setGainA(v);
    else setGainB(v);
    audioEngine.setGain(name, v);
  }, []);

  const changeEq = useCallback((name: "A" | "B", band: EqBand, v: number) => {
    const set = name === "A" ? setEqA : setEqB;
    set((prev) => {
      const next = [...prev] as [number, number, number];
      next[band] = v;
      return next;
    });
    audioEngine.setEq(name, band, v);
  }, []);

  const changeFader = useCallback((name: "A" | "B", v: number) => {
    if (name === "A") setFaderA(v);
    else setFaderB(v);
    audioEngine.setChannelFader(name, v);
  }, []);

  const changeCross = useCallback((v: number) => {
    setCross(v);
    audioEngine.setCrossfader(v);
  }, []);

  const changeMaster = useCallback((v: number) => {
    setMaster(v);
    audioEngine.setMasterGain(v);
  }, []);

  return (
    <div className="flex min-h-0 flex-col items-center justify-center gap-2 p-1">
      <ChannelStrip
        name="A"
        color={COLOR_DECK_A}
        gain={gainA}
        eq={eqA}
        fader={faderA}
        onGain={(v) => changeGain("A", v)}
        onEq={(b, v) => changeEq("A", b, v)}
        onFader={(v) => changeFader("A", v)}
      />

      <div className="flex w-full items-center gap-2 rounded-lg border border-slate-800/60 bg-white/[0.03] px-2 py-1.5">
        <VuMeter name="A" master height={54} />
        <div className="flex min-w-0 flex-1 flex-col items-center gap-1">
          <span className="text-[9px] font-black uppercase tracking-widest text-slate-400">X-Fader</span>
          <DragFader
            value={cross}
            min={0}
            max={1}
            orientation="horizontal"
            length={140}
            centerDetent
            color={COLOR_MASTER}
            onChange={changeCross}
          />
        </div>
        <div className="flex flex-col items-center gap-1">
          <DragKnob
            value={master}
            min={0}
            max={1.2}
            defaultValue={0.9}
            color={COLOR_MASTER}
            label="MASTER"
            showValue
            onChange={changeMaster}
          />
        </div>
      </div>

      <ChannelStrip
        name="B"
        color={COLOR_DECK_B}
        gain={gainB}
        eq={eqB}
        fader={faderB}
        onGain={(v) => changeGain("B", v)}
        onEq={(b, v) => changeEq("B", b, v)}
        onFader={(v) => changeFader("B", v)}
      />
    </div>
  );
};
