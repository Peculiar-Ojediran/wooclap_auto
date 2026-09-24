import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createBridgeServer } from './http.js';

const tokenDirectory = new URL('../.local/', import.meta.url);
const tokenPath = new URL('bridge-token.txt', tokenDirectory);

async function pairingToken(): Promise<string> {
  if (process.env.BRIDGE_TOKEN?.trim()) return process.env.BRIDGE_TOKEN.trim();
  await mkdir(tokenDirectory, { recursive: true });
  try { return (await readFile(tokenPath, 'utf8')).trim(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const token = randomBytes(32).toString('hex');
  try { await writeFile(tokenPath, `${token}\n`, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return (await readFile(tokenPath, 'utf8')).trim();
  }
  return token;
}

try {
  const demo = process.argv.includes('--demo');
  const server = createBridgeServer({
    token: await pairingToken(), apiKey: process.env.OPENAI_API_KEY?.trim(),
    model: process.env.OPENAI_MODEL?.trim() || 'gpt-4.1-mini', demo,
  });
  server.on('error', (error: NodeJS.ErrnoException) => {
    console.error(error.code === 'EADDRINUSE' ? 'Port 4318 is already in use. Stop the other bridge before starting this one.' : 'The local bridge could not start.');
    process.exitCode = 1;
  });
  server.listen(4318, '127.0.0.1', () => {
    console.log(`Wooclap local bridge: http://127.0.0.1:4318 (${demo ? 'practice demo; no AI calls' : 'OpenAI mode'})`);
    console.log('Practice page: http://127.0.0.1:4318/practice');
    console.log(process.env.BRIDGE_TOKEN?.trim()
      ? 'Pair the extension using the BRIDGE_TOKEN value from your local .env file.'
      : `Pair the extension using the token in ${fileURLToPath(tokenPath)}`);
    if (!demo && !process.env.OPENAI_API_KEY?.trim()) console.log('OPENAI_API_KEY is missing. Add it to .env and restart, or use npm run demo.');
  });
  const stop = () => {
    server.close();
    server.closeAllConnections();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
} catch {
  console.error('The bridge could not load its pairing token. Check .local/bridge-token.txt or set BRIDGE_TOKEN to at least 32 characters.');
  process.exitCode = 1;
}
