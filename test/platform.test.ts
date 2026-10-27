import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { $, fs, os, path, usePowerShell } from 'zx';

import { PlatformPackager } from '../src/platform.ts';

if (process.platform === 'win32')
  if (typeof $.shell === 'string')
    $.quote = argument => `'${argument.replace(/'/g, `'\\''`)}'`;
  else {
    usePowerShell();
    $.prefix = '& ';
  }

test(
  'escapes the Windows SFX command and runs a nested install script containing spaces',
  { skip: process.platform !== 'win32' },
  async context => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'npm2exe-sfx-'));
    context.after(() => fs.remove(root));

    const appFolder = path.join(root, 'archive');
    const profile = path.join(root, 'profile');
    const installScript = path.join(
      'npm2exe-apps',
      'npm2exe with spaces',
      'install.cmd'
    );
    const outputFile = path.join(root, 'bundle.exe');

    await fs.ensureDir(profile);
    await fs.outputFile(
      path.join(appFolder, installScript),
      '@echo off\r\necho installed>"%USERPROFILE%\\installed.txt"\r\n'
    );
    await new PlatformPackager().packageWith7Zip({
      tempRoot: appFolder,
      outputFile,
      installScript
    });
    const bundle = await fs.readFile(outputFile);
    assert.equal(bundle.subarray(0, 2).toString(), 'MZ');

    const configuration = bundle.toString('utf8');
    const command = configuration.match(/^RunProgram=(.+)$/m);

    assert.ok(command);
    assert.equal(
      JSON.parse(command[1]),
      `cmd.exe /d /s /c ""%%T\\${installScript}""`
    );
    const installCommand = JSON.parse(command[1]) as string;
    const result = spawnSync(
      process.env.ComSpec || 'cmd.exe',
      [
        '/d',
        '/s',
        '/c',
        installCommand
          .slice('cmd.exe /d /s /c '.length)
          .replace('%%T', appFolder)
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, USERPROFILE: profile, HOME: profile },
        timeout: 30000,
        windowsVerbatimArguments: true
      }
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      await fs.readFile(path.join(profile, 'installed.txt'), 'utf8'),
      'installed\r\n'
    );
  }
);
