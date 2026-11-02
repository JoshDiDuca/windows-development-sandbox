// The sbx-<name> helpers (sbx-steam, sbx-fivem, sbx-unity, sbx-android): `tool.js <name> <args...>` runs that helper.
import { errMsg } from '../../core/util/errors.js';
import { DEVTOOLS, devToolByName } from '../devtools/registry.js';

const [name, ...args] = process.argv.slice(2);
const tool = name ? devToolByName(name) : undefined;
if (!tool) {
  console.error('Usage: sbx-<' + DEVTOOLS.map((t) => t.name).join('|') + '> <command> ...');
  process.exitCode = 2;
} else {
  tool.run(args).then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      console.error('sbx-' + tool.name + ': ' + errMsg(e));
      process.exitCode = 1;
    },
  );
}
