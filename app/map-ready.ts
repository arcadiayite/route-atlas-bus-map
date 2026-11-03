import type { Map as MapLibreMap } from "maplibre-gl";

// A loaded style can temporarily report false while new source data is loading.
// That produces idle, but does not produce another style.load event.
export function whenMapStyleReady(map: MapLibreMap, update: () => void) {
  const cancel = () => {
    map.off("style.load", apply);
    map.off("idle", apply);
  };
  const apply = () => { cancel(); update(); };
  if (map.isStyleLoaded()) apply();
  else {
    map.once("style.load", apply);
    map.once("idle", apply);
  }
  return cancel;
}
