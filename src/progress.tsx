import type { FC } from 'react';
import { Box, Text, render } from 'ink';
import { formatBytes } from './utility.js';

const PROGRESS_BAR_WIDTH = 24;

type ProgressUnit = 'bytes' | 'items';

interface ProgressViewProps {
  label: string;
  loaded: number;
  total: number;
  unit: ProgressUnit;
}

const formatProgressValue = (value: number, unit: ProgressUnit) =>
  unit === 'bytes' ? formatBytes(value) : `${value}`;

const ProgressView: FC<ProgressViewProps> = ({
  label,
  loaded,
  total,
  unit
}) => {
  const ratio = total > 0 ? Math.min(loaded / total, 1) : 0;
  const filledWidth = Math.round(ratio * PROGRESS_BAR_WIDTH);
  const progressBar = `${'█'.repeat(filledWidth)}${'░'.repeat(PROGRESS_BAR_WIDTH - filledWidth)}`;
  const progressText =
    total > 0
      ? `${Math.round(ratio * 100)}% ${formatProgressValue(loaded, unit)}/${formatProgressValue(total, unit)}`
      : formatProgressValue(loaded, unit);

  return (
    <Box flexDirection="column">
      <Text>{label}</Text>
      <Text color="cyan">
        [{progressBar}] {progressText}
      </Text>
    </Box>
  );
};

export class ProgressRenderer {
  private loaded = 0;
  private total = 0;
  private readonly inkApplication;

  constructor(
    private readonly label: string,
    private readonly unit: ProgressUnit = 'bytes'
  ) {
    this.inkApplication =
      process.stderr.isTTY && !process.env.CI
        ? render(
            <ProgressView
              label={label}
              loaded={this.loaded}
              total={this.total}
              unit={unit}
            />,
            {
              stdout: process.stderr,
              stderr: process.stderr,
              patchConsole: false
            }
          )
        : null;
  }

  update(loaded: number, total = this.total) {
    this.loaded = loaded;
    this.total = total;
    this.rerender();
  }

  close() {
    this.rerender();
    this.inkApplication?.unmount();
  }

  private rerender() {
    this.inkApplication?.rerender(
      <ProgressView
        label={this.label}
        loaded={this.loaded}
        total={this.total}
        unit={this.unit}
      />
    );
  }
}
