import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from './config.mjs';

// launchd keeps these descriptors open. Rename alone would keep writing to an
// old inode: retain bounded archives, then truncate the same open file. All
// operations are synchronous so this process cannot interleave JS log writes.
export function rotateDaemonLogs({ directory = path.join(STATE_DIR, 'logs'), maxBytes = 5 * 1024 * 1024, archives = 3 } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(archives) || archives < 1 || archives > 10) throw new Error('Invalid log retention limits');
  const rotated = [];
  for (const name of ['daemon.err.log', 'daemon.out.log', 'guardian.err.log', 'guardian.out.log']) {
    const file = path.join(directory, name);
    let stat;
    try { stat = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!stat.isFile() || stat.size < maxBytes) continue;
    const fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
    const temporary = `${file}.rotating`;
    try {
      try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const tail = Buffer.alloc(Math.min(maxBytes, stat.size));
      const bytes = fs.readSync(fd, tail, 0, tail.length, stat.size - tail.length);
      fs.writeFileSync(temporary, tail.subarray(0, bytes), { mode: 0o600, flag: 'wx' });
      for (let index = archives - 1; index >= 1; index--) {
        try { fs.renameSync(`${file}.${index}`, `${file}.${index + 1}`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      fs.renameSync(temporary, `${file}.1`);
      fs.ftruncateSync(fd, 0);
      rotated.push({ name, previous_bytes: stat.size, archived_bytes: bytes });
    } finally {
      fs.closeSync(fd);
      try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  return rotated;
}

export function startLogMaintenance(options = {}) {
  const run = () => {
    try { rotateDaemonLogs(options); }
    catch (error) { process.stderr.write(`[proxy-mate] log retention failed: ${error.message}\n`); }
  };
  run();
  const timer = setInterval(run, 30_000);
  timer.unref();
  return () => clearInterval(timer);
}
