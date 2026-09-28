import path from 'node:path';
import { open } from 'node:fs/promises';
import { HTTPClient } from 'koajax';
import { fs } from 'zx';
import { formatBytes } from './utility.js';

const PROGRESS_BAR_WIDTH = 24;

type InkModule = Pick<typeof import('ink'), 'Box' | 'Text' | 'render'>;
const downloadClient = new HTTPClient({ responseType: 'arraybuffer' });

interface DownloadProgressViewProperties {
  Box: InkModule['Box'];
  Text: InkModule['Text'];
  label: string;
  loaded: number;
  total: number;
}

const DownloadProgressView = ({
  Box,
  Text,
  label,
  loaded,
  total
}: DownloadProgressViewProperties) => {
  const ratio = total > 0 ? Math.min(loaded / total, 1) : 0;
  const filledWidth = Math.round(ratio * PROGRESS_BAR_WIDTH);
  const progressBar = `${'█'.repeat(filledWidth)}${'░'.repeat(PROGRESS_BAR_WIDTH - filledWidth)}`;
  const progressText =
    total > 0
      ? `${Math.round(ratio * 100)}% ${formatBytes(loaded)}/${formatBytes(total)}`
      : formatBytes(loaded);

  return (
    <Box flexDirection="column">
      <Text>{label}</Text>
      <Text color="cyan">
        [{progressBar}] {progressText}
      </Text>
    </Box>
  );
};

export class DownloadService {
  async downloadFile(url: string, targetPath: string, label = url) {
    const ink =
      process.stderr.isTTY && !process.env.CI ? await import('ink') : null;
    const inkApplication = ink
      ? ink.render(
          <DownloadProgressView
            Box={ink.Box}
            Text={ink.Text}
            label={label}
            loaded={0}
            total={0}
          />,
          {
            stdout: process.stderr,
            stderr: process.stderr,
            patchConsole: false
          }
        )
      : null;
    let loaded = 0;
    let total = 0;
    const fileUrl = new URL(url);

    await fs.ensureDir(path.dirname(targetPath));

    const fileHandle = await open(targetPath, 'w');
    let position = 0;

    try {
      for await (const progress of downloadClient.download(fileUrl)) {
        loaded = progress.loaded || loaded;
        total = progress.total || total;
        const chunk = Buffer.from(progress.buffer);

        await fileHandle.write(chunk, 0, chunk.byteLength, position);
        position += chunk.byteLength;
        if (ink && inkApplication)
          inkApplication.rerender(
            <DownloadProgressView
              Box={ink.Box}
              Text={ink.Text}
              label={label}
              loaded={loaded}
              total={total}
            />
          );
      }

      if (ink && inkApplication)
        inkApplication.rerender(
          <DownloadProgressView
            Box={ink.Box}
            Text={ink.Text}
            label={label}
            loaded={total || loaded}
            total={total || loaded}
          />
        );
    } catch (error) {
      await fileHandle.close();
      await fs.remove(targetPath);

      throw error;
    } finally {
      await fileHandle.close().catch(() => {});
      inkApplication?.unmount();
    }
  }
}
