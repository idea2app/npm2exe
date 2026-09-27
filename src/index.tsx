#!/usr/bin/env node

import path from 'node:path';
import { Command } from 'commander-jsx';
import {
  name,
  version,
  description
} from '../package.json' with { type: 'json' };
import { packProject } from './workflow.js';

Command.execute(
  <Command
    {...{ name, version, description }}
    parameters="[projectFolder]"
    options={{
      arch: {
        parameters: '<arch>',
        description: 'Target architecture: x86|ia32|x64|arm|arm64'
      },
      platform: {
        parameters: '<platform>',
        description: 'Target platform: linux|darwin|win|win32'
      },
      'node-version': {
        parameters: '<version>',
        description: 'Node.js runtime version override'
      },
      output: {
        parameters: '<name>',
        description: 'Output file base name'
      },
      'compression-level': {
        parameters: '<0-9>',
        description: 'Compression level: 0 disables compression (default)'
      }
    }}
    executor={async (options, projectFolder = '.') => {
      const project = projectFolder?.toString() || '.';

      await packProject({
        projectFolder: path.resolve(project),
        arch: options.arch?.toString(),
        targetPlatform: options.platform?.toString(),
        nodeVersion: options['node-version']?.toString(),
        outputName: options.output?.toString(),
        compressionLevel:
          options['compression-level'] != null
            ? Number(options['compression-level'])
            : undefined
      });
    }}
  />,
  process.argv.slice(2)
);
