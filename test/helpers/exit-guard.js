// Imported by the test files that start Chromes, viewers or sockets. Once a file's tests are done
// its process must exit on its own: node --test waits for it, so anything a test left open (a
// Chrome, a CDP socket, a timer) would hang the whole run with no word of why. After a grace
// period this names what is still open and fails the file instead. The timer is unref'd, so a
// file that exits cleanly never waits for it.
//
// (Not --test-force-exit: it exits as soon as the tests registered so far are done, silently
// dropping any a file registers after a top-level await, e.g. most of mcp.test.js.)
import { after } from 'node:test';

const GRACE_MS = Number(process.env.TERMBROWSE_TEST_EXIT_GRACE_MS) || 60_000;

after(() => {
  setTimeout(() => {
    process.stderr.write(`exit-guard: ${process.argv[1]} still running ${GRACE_MS} ms after its tests; open: ${JSON.stringify(process.getActiveResourcesInfo())}\n`);
    process.exit(1);
  }, GRACE_MS).unref();
});
