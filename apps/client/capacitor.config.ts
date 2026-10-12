import type { CapacitorConfig } from '@capacitor/cli';

// The API and WebSocket use relative /api URLs, so the app loads the game from the server
// (same origin) rather than the bundled dist/. Set BH_SERVER_URL at `cap sync` time:
// a hosted https URL, or http://<laptop-LAN-IP>:5173 for testing against `pnpm dev`.
const url = process.env.BH_SERVER_URL;

const config: CapacitorConfig = {
  appId: 'com.bharatharvest.game',
  appName: 'Bharat Harvest',
  webDir: 'dist',
  ...(url && { server: { url, cleartext: url.startsWith('http:') } }),
  // Android 15 draws apps edge-to-edge; keep the game clear of the status and nav bars.
  android: { adjustMarginsForEdgeToEdge: 'force' },
};

export default config;
