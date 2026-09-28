import path from 'node:path';
import { open } from 'node:fs/promises';
import { HTTPClient } from 'koajax';
import { fs } from 'zx';
import { ProgressRenderer } from './progress.js';

const downloadClient = new HTTPClient({ responseType: 'arraybuffer' });

export async function downloadFile(
  url: string,
  targetPath: string,
  label = url
) {
  const progressRenderer = new ProgressRenderer(label);

  await fs.ensureDir(path.dirname(targetPath));

  const fileHandle = await open(targetPath, 'w');
  let loaded = 0;
  let total = 0;
  let position = 0;

  try {
    for await (const progress of downloadClient.download(url)) {
      loaded = progress.loaded || loaded;
      total = progress.total || total;
      const chunk = Buffer.from(progress.buffer);

      await fileHandle.write(chunk, 0, chunk.byteLength, position);
      position += chunk.byteLength;
      progressRenderer.update(loaded, total);
    }

    progressRenderer.update(total || loaded, total || loaded);
  } catch (error) {
    await fs.remove(targetPath);

    throw error;
  } finally {
    await fileHandle.close();
    progressRenderer.close();
  }
}
