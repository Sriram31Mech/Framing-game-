import type { CapacitorConfig } from '@capacitor/cli';

// The API and WebSocket use relative /api URLs, so the app loads the hosted game (same origin)
// rather than the bundled dist/. Set BH_SERVER_URL at `cap sync` time, e.g. https://game.example.com.
const url = process.env.BH_SERVER_URL;

const config: CapacitorConfig = {
  appId: 'com.bharatharvest.game',
  appName: 'Bharat Harvest',
  webDir: 'dist',
  ...(url && { server: { url, cleartext: url.startsWith('http:') } }),
};

export default config;
