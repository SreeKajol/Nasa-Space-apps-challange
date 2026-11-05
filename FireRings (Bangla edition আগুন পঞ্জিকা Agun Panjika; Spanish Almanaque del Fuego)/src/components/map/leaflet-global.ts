import L from "leaflet";

// Leaflet-Geoman patches the global `L`; expose it before Geoman is imported.
(window as unknown as { L: typeof L }).L = L;

export default L;
