import { parentPort } from 'node:worker_threads';
import { processCapturedBody } from './body-worker-processing.mjs';

parentPort.on('message', async (job) => {
  try {
    const result = await processCapturedBody(job);
    parentPort.postMessage({ result });
  } catch {
    // Do not return exception strings which may include sensitive payloads.
    parentPort.postMessage({ failed: true });
  }
});
