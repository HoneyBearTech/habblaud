#!/usr/bin/env node
// Old path of the permission hook. Up to 0.2.0, `npm run hooks:install` wrote this file into the settings.json
// of the accounts; the script moved to mod/habblaud-permissoes/hooks/permission-hook.mjs (the habblaud-permissoes
// plugin). This shortcut keeps those installs working after `git pull`, until `npm run mod:install` (which removes
// the old hook) or a new `npm run hooks:install` replaces them. Plain Node, no dependencies.
import { main } from '../mod/habblaud-permissoes/hooks/permission-hook.mjs';

main().catch(() => process.exit(0));
