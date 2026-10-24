import { createContext, useContext } from "react";
import type { NokkerStore } from "./store.js";

export const StoreContext = createContext<NokkerStore | null>(null);

export function useStore(): NokkerStore {
  const s = useContext(StoreContext);
  if (!s) throw new Error("StoreContext manquant");
  return s;
}
