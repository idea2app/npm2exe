#!/usr/bin/env node

import { parentMessage } from 'test-parent';

if (parentMessage !== 'parent')
  throw new Error('Parent package was not loaded');

console.log(`child: ${parentMessage}`);
