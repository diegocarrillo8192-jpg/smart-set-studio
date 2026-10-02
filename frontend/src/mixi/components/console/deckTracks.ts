import { createContext, useContext } from "react";
import type { Track } from "../../../types";

/** Tracks de la biblioteca inyectados en la consola MIXI (por deck). */
export interface DeckTracks {
  A: Track | null;
  B: Track | null;
}

export const DeckTracksContext = createContext<DeckTracks>({ A: null, B: null });

export const useDeckTracks = (): DeckTracks => useContext(DeckTracksContext);
