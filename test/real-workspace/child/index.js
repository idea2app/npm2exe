#!/usr/bin/env node

import { parentMessage } from 'test-parent';
import ts from 'typescript';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (parentMessage !== 'parent')
  throw new Error('Parent package was not loaded');

console.log(`child: ${parentMessage}`);

const packageFolder = path.dirname(fileURLToPath(import.meta.url));
const modulesFolder = path.join(packageFolder, 'node_modules');

for (const name of ['test-parent', 'typescript']) {
  const resolved = fileURLToPath(import.meta.resolve(name));
  const relativePath = path.relative(modulesFolder, resolved);

  assert.ok(
    !path.isAbsolute(relativePath) && !relativePath.startsWith(`..${path.sep}`),
    `${name} must resolve inside the exported app: ${resolved}`
  );
}

const source = ts.createSourceFile(
  'fixture.ts',
  'const value: number = 42;',
  ts.ScriptTarget.Latest
);
assert.equal(source.statements.length, 1);
console.log(`typescript: ${ts.version}`);
