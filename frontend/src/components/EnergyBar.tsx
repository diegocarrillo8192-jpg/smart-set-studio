interface Props {
  value: number | null;
}

/** Barra de energía 0-10 (10 segmentos) compartida entre la tabla de la
 *  librería y la vista del Smart Set Generator. */
export default function EnergyBar({ value }: Props) {
  if (!value) return <span className="text-slate-600">-</span>;
  return (
    <div className="flex shrink-0 items-center gap-0.5" title={`Energía ${value}/10`}>
      {Array.from({ length: 10 }, (_, i) => (
        <span
          key={i}
          className="h-2 w-1 rounded-sm"
          style={{
            background: i < value ? (value >= 7 ? "#f87171" : value >= 4 ? "#fbbf24" : "#34d399") : "#243046",
          }}
        />
      ))}
    </div>
  );
}
