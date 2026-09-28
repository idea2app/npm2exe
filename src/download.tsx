import { request } from 'koajax';
import { createElement } from 'react';
import { fs } from 'zx';
import { formatBytes } from './utility.js';

const PROGRESS_BAR_WIDTH = 24;

type InkModule = Pick<typeof import('ink'), 'Box' | 'Text' | 'render'>;

interface DownloadProgressViewProperties {
  label: string;
  loaded: number;
  total: number;
}

const createDownloadProgressView = (
  { Box, Text }: InkModule,
  { label, loaded, total }: DownloadProgressViewProperties
) => {
  const ratio = total > 0 ? Math.min(loaded / total, 1) : 0;
  const filledWidth = Math.round(ratio * PROGRESS_BAR_WIDTH);
  const progressBar = `${'█'.repeat(filledWidth)}${'░'.repeat(PROGRESS_BAR_WIDTH - filledWidth)}`;
  const progressText =
    total > 0
      ? `${Math.round(ratio * 100)}% ${formatBytes(loaded)}/${formatBytes(total)}`
      : formatBytes(loaded);

  return createElement(
    Box,
    { flexDirection: 'column' },
    createElement(Text, null, label),
    createElement(Text, { color: 'cyan' }, `[${progressBar}] ${progressText}`)
  );
};

export class DownloadService {
  async downloadFile(url: string, targetPath: string, label = url) {
    const { response, download } = request<ArrayBuffer>({
      method: 'GET',
      path: new URL(url),
      responseType: 'arraybuffer'
    });
    const ink =
      process.stderr.isTTY && !process.env.CI ? await import('ink') : null;
    const inkApplication = ink
      ? ink.render(
          createDownloadProgressView(ink, { label, loaded: 0, total: 0 }),
          {
            stdout: process.stderr,
            stderr: process.stderr,
            patchConsole: false
          }
        )
      : null;
    let loaded = 0;
    let total = 0;

    try {
      for await (const progress of download) {
        loaded = progress.loaded || loaded;
        total = progress.total || total;

        if (ink && inkApplication)
          inkApplication.rerender(
            createDownloadProgressView(ink, { label, loaded, total })
          );
      }

      const { status, body } = await response;

      if (status < 200 || status >= 300)
        throw new Error(`Download failed: ${url} (${status})`);

      if (!(body instanceof ArrayBuffer))
        throw new Error(`Download failed: ${url}`);

      await fs.outputFile(targetPath, Buffer.from(body));

      if (ink && inkApplication)
        inkApplication.rerender(
          createDownloadProgressView(ink, {
            label,
            loaded: total || loaded,
            total: total || loaded
          })
        );
    } finally {
      inkApplication?.unmount();
    }
  }
}
