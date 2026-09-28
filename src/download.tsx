import { Box, Text, render } from 'ink';
import { request } from 'koajax';
import { fs } from 'zx';
import { formatBytes } from './utility.js';

const PROGRESS_BAR_WIDTH = 24;

interface DownloadProgressViewProperties {
  label: string;
  loaded: number;
  total: number;
}

const DownloadProgressView = ({
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
    const { response, download } = request<ArrayBuffer>({
      method: 'GET',
      path: url,
      responseType: 'arraybuffer'
    });
    const inkApplication =
      process.stderr.isTTY && !process.env.CI
        ? render(<DownloadProgressView label={label} loaded={0} total={0} />, {
            stdout: process.stderr,
            stderr: process.stderr,
            patchConsole: false
          })
        : null;
    let loaded = 0;
    let total = 0;

    try {
      for await (const progress of download) {
        loaded = progress.loaded || loaded;
        total = progress.total || total;

        inkApplication?.rerender(
          <DownloadProgressView label={label} loaded={loaded} total={total} />
        );
      }

      const { body } = await response;

      if (!(body instanceof ArrayBuffer))
        throw new Error(`Download failed: ${url}`);

      await fs.outputFile(targetPath, Buffer.from(body));

      inkApplication?.rerender(
        <DownloadProgressView
          label={label}
          loaded={total || loaded}
          total={total || loaded}
        />
      );
    } finally {
      inkApplication?.unmount();
    }
  }
}
