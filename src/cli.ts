#!/usr/bin/env node

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import open from 'open';
import sirv from 'sirv';
import { acquirePidfile, getRunningPid } from './pidfile';

interface PackageMetadata {
  readonly ariangVersion: string;
  readonly name: string;
  readonly version: string;
}

const PACKAGE_METADATA = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as PackageMetadata;
const VERSION = `${PACKAGE_METADATA.name} ${PACKAGE_METADATA.version} (AriaNg ${PACKAGE_METADATA.ariangVersion})`;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = '6801';
const ARIANG_DIRECTORY = fileURLToPath(new URL('../vendor/ariang/', import.meta.url));
const HELP = `Usage:
  aria-ng [options]
  aria-ng start [options]
  aria-ng stop

Options:
  -p, --port <port>  HTTP port (default: 6801)
      --host <host>  HTTP host (default: 127.0.0.1)
      --daemon       run in the background
      --open         open AriaNg in the default browser
  -h, --help         show help
  -v, --version      show wrapper and AriaNg versions
`;

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (process.send) {
    process.send({ message, type: 'error' });
    process.disconnect?.();
  } else {
    process.stderr.write(`${message}\n`);
  }
  process.exitCode = 1;
}

interface StartedServer {
  readonly pid: number;
  readonly url: string;
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      daemon: { type: 'boolean' },
      help: { short: 'h', type: 'boolean' },
      host: { type: 'string' },
      'internal-daemon-child': { type: 'boolean' },
      open: { type: 'boolean' },
      port: { short: 'p', type: 'string' },
      version: { short: 'v', type: 'boolean' },
    },
    strict: true,
  });

  if (values.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (values.help) {
    process.stdout.write(HELP);
    return;
  }

  const command = positionals[0] ?? 'start';
  const unexpectedArgument = positionals[1];
  if (unexpectedArgument) {
    throw new Error(`Unexpected argument: ${unexpectedArgument}`);
  }
  if (command === 'stop') {
    const invalidStopOption = ['daemon', 'host', 'open', 'port'].find(
      (option) => values[option as 'daemon' | 'host' | 'open' | 'port'] !== undefined,
    );
    if (invalidStopOption) {
      throw new Error(`Option --${invalidStopOption} cannot be used with stop`);
    }
    await stopServer();
    return;
  }
  if (command !== 'start') {
    throw new Error(`Unknown command: ${command}`);
  }

  const host = values.host ?? DEFAULT_HOST;
  const port = Number(values.port ?? DEFAULT_PORT);
  if (values['internal-daemon-child']) {
    if (!process.send) {
      throw new Error('Internal daemon mode requires an IPC channel');
    }
    await startServer(host, port, (started) => {
      process.send?.({ ...started, type: 'ready' });
      process.disconnect?.();
    });
    return;
  }
  if (values.daemon) {
    const started = await startDaemon(host, port);
    announce(started);
    if (values.open) {
      await openBrowser(started.url);
    }
    return;
  }

  await startServer(host, port, (started) => {
    announce(started);
    if (values.open) {
      void openBrowser(started.url);
    }
  });
}

async function stopServer(): Promise<void> {
  const pid = await getRunningPid();
  if (pid === undefined) {
    process.stdout.write('AriaNg is not running\n');
    return;
  }

  process.kill(pid, 'SIGTERM');
  if (await waitUntilStopped(Date.now() + 5_000)) {
    process.stdout.write(`AriaNg stopped (pid ${String(pid)})\n`);
    return;
  }

  throw new Error(`Timed out waiting for AriaNg to stop (pid ${String(pid)})`);
}

async function waitUntilStopped(deadline: number): Promise<boolean> {
  if ((await getRunningPid()) === undefined) {
    return true;
  }
  if (Date.now() >= deadline) {
    return false;
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  return waitUntilStopped(deadline);
}

async function startDaemon(host: string, port: number): Promise<StartedServer> {
  const entry = process.argv[1];
  if (!entry) {
    throw new Error('Cannot determine the CLI entry point');
  }

  const child = spawn(
    process.execPath,
    [
      ...process.execArgv,
      entry,
      'start',
      '--internal-daemon-child',
      '--host',
      host,
      '--port',
      String(port),
    ],
    {
      detached: true,
      env: process.env,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    },
  );

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('Timed out waiting for the AriaNg daemon to start'));
    }, 5_000);

    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      reject(
        new Error(`AriaNg daemon exited before listening (${signal ?? `code ${String(code)}`})`),
      );
    });
    child.on('message', (message: unknown) => {
      if (!isDaemonMessage(message)) {
        return;
      }
      clearTimeout(timeout);
      if (message.type === 'error') {
        reject(new Error(message.message));
        return;
      }
      child.unref();
      resolve({ pid: message.pid, url: message.url });
    });
  });
}

async function startServer(
  host: string,
  port: number,
  onReady: (started: StartedServer) => void,
): Promise<void> {
  const pidfile = await acquirePidfile();
  const server = createServer(sirv(ARIANG_DIRECTORY));

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (error) {
    await pidfile.release();
    throw error;
  }

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('HTTP server did not expose a TCP address');
  }

  const urlHost = host.includes(':') ? `[${host}]` : host;
  onReady({
    pid: process.pid,
    url: `http://${urlHost}:${String(address.port)}`,
  });

  const close = (): void => {
    server.close();
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);

  await new Promise<void>((resolve) => server.once('close', resolve));
  await pidfile.release();
}

function announce(started: StartedServer): void {
  process.stdout.write(`AriaNg listening at ${started.url} (pid ${String(started.pid)})\n`);
}

async function openBrowser(url: string): Promise<void> {
  try {
    await open(url);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Failed to open browser: ${message}\n`);
  }
}

function isDaemonMessage(
  message: unknown,
): message is { message: string; type: 'error' } | { pid: number; type: 'ready'; url: string } {
  if (typeof message !== 'object' || message === null || !('type' in message)) {
    return false;
  }
  if (message.type === 'error') {
    return 'message' in message && typeof message.message === 'string';
  }
  return (
    message.type === 'ready' &&
    'pid' in message &&
    typeof message.pid === 'number' &&
    'url' in message &&
    typeof message.url === 'string'
  );
}
