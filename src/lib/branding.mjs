import { readFileSync } from 'node:fs';
import { SERVER_NAME, SERVER_VERSION } from './config.mjs';

export const PROXYFAN_ICON = readFileSync(new URL('../assets/proxyfan-32.png', import.meta.url));
export const MCP_SERVER_INFO = {
  name: SERVER_NAME,
  title: 'ProxyFan',
  version: SERVER_VERSION,
  icons: [{
    src: `data:image/png;base64,${PROXYFAN_ICON.toString('base64')}`,
    mimeType: 'image/png',
    sizes: ['32x32'],
  }],
};
