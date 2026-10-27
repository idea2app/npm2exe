import assert from 'node:assert/strict';
import { test } from 'node:test';

import { logStep } from '../src/utility.ts';

test('uses the instance and method parameters to generate a step title', async () => {
  let title = '';

  class Example {
    constructor(private readonly name: string) {}

    @logStep(
      ({ name }: Example, suffix: string) => (title = `${name}-${suffix}`)
    )
    async run(suffix: string) {
      return suffix;
    }
  }
  assert.equal(await new Example('build').run('app'), 'app');
  assert.equal(title, 'build-app');
});
