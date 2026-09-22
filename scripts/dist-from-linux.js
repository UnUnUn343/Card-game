#!/usr/bin/env node
'use strict';
/**
 * Builds the Windows installer from Linux/macOS without a working 32-bit Wine.
 * electron-builder normally runs the NSIS installer under Wine once, to extract the uninstaller;
 * on macOS it uses a pure-JS reader for that instead. This turns that reader on here too.
 * On Windows (and in the GitHub Action) just use `npm run dist`.
 */
const macosVersion = require('app-builder-lib/out/util/macosVersion');
macosVersion.isMacOsCatalina = () => true;
const { build, Platform, Arch } = require('electron-builder');
build({ targets: Platform.WINDOWS.createTarget(['nsis'], Arch.x64), publish: 'never' })
  .then(files => console.log('built:\n  ' + files.join('\n  ')))
  .catch(err => { console.error(err); process.exit(1); });
