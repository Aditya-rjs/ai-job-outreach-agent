#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Railway Production Process Supervisor
 *
 * Runs BOTH the Next.js production server and the persistent Outreach Worker
 * inside the same Railway service/container sharing DATA_DIR (/data persistent volume).
 *
 * Capabilities:
 * - Listens on Railway's dynamic PORT (defaults to 3000)
 * - Ensures persistent DATA_DIR structure exists before startup
 * - Spawns Next.js production server and Outreach Worker as child processes
 * - Forwards SIGTERM / SIGINT for graceful shutdown (worker releases SQLite lease)
 * - Exits appropriately if either critical child process terminates unexpectedly
 * - Preserves OUTREACH_DRY_RUN and all safety gates
 */

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

function startSupervisor(options = {}) {
  // Production Live Outreach Mode: switch OUTREACH_DRY_RUN from true to false
  if (options.dryRun !== undefined) {
    process.env.OUTREACH_DRY_RUN = String(options.dryRun);
  } else {
    process.env.OUTREACH_DRY_RUN = 'false';
  }

  const port = options.port || process.env.PORT || '3000';
  const dataDir = options.dataDir || process.env.DATA_DIR || path.join(process.cwd(), 'data');
  const isDryRun = process.env.OUTREACH_DRY_RUN === 'true';

  console.log('======================================================================');
  console.log('[Supervisor] Starting AI Job Outreach Agent for Railway');
  console.log(`[Supervisor] Web Port: ${port}`);
  console.log(`[Supervisor] Persistent DATA_DIR: ${dataDir}`);
  console.log(`[Supervisor] Mode: ${isDryRun ? 'DRY-RUN (Simulated sends)' : 'LIVE (Safety gates armed)'}`);
  console.log('======================================================================');

  // 1. Ensure DATA_DIR and subdirectories exist
  const resumesDir = path.join(dataDir, 'resumes');
  const uploadsDir = path.join(dataDir, 'uploads');
  for (const dir of [dataDir, resumesDir, uploadsDir]) {
    if (!fs.existsSync(dir)) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        console.log(`[Supervisor] Created persistent directory: ${dir}`);
      } catch (err) {
        console.error(`[Supervisor] Failed to create directory ${dir}:`, err);
      }
    }
  }

  // 2. Resolve Next.js binary and TSX CLI paths
  let nextBin;
  try {
    nextBin = require.resolve('next/dist/bin/next');
  } catch {
    nextBin = path.join(process.cwd(), 'node_modules', 'next', 'dist', 'bin', 'next');
  }

  let tsxCli;
  try {
    tsxCli = require.resolve('tsx/cli');
  } catch {
    tsxCli = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  }

  const workerScript = path.join(process.cwd(), 'src', 'worker', 'outreach-worker.ts');

  // Check that worker script exists
  if (!fs.existsSync(workerScript)) {
    console.error(`[Supervisor] Fatal: Worker script not found at ${workerScript}`);
    process.exit(1);
  }

  // Check for Next.js build
  const nextBuildDir = path.join(process.cwd(), '.next');
  if (!fs.existsSync(nextBuildDir)) {
    console.warn('[Supervisor] Warning: .next build directory not found. Make sure `npm run build` was executed.');
  }

  let isShuttingDown = false;
  let webChild = null;
  let workerChild = null;

  function shutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`\n[Supervisor] Received ${signal}. Initiating graceful shutdown of web server and worker...`);

    // Force-kill timeout after 10 seconds if processes do not exit
    const forceKillTimer = setTimeout(() => {
      console.warn('[Supervisor] Processes did not exit in time. Forcing termination...');
      if (workerChild && !workerChild.killed) workerChild.kill('SIGKILL');
      if (webChild && !webChild.killed) webChild.kill('SIGKILL');
      process.exit(1);
    }, 10000);
    forceKillTimer.unref();

    // Send SIGTERM to worker first so it releases its SQLite lease cleanly
    if (workerChild && !workerChild.killed) {
      console.log('[Supervisor] Stopping worker process...');
      workerChild.kill('SIGTERM');
    }

    // Send SIGTERM to Next.js server
    if (webChild && !webChild.killed) {
      console.log('[Supervisor] Stopping web server...');
      webChild.kill('SIGTERM');
    }
  }

  // Listen for termination signals
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // 3. Spawn Next.js Production Web Server
  console.log(`[Supervisor] Spawning Next.js production web server on port ${port}...`);
  const webEnv = {
    ...process.env,
    PORT: String(port),
    DATA_DIR: dataDir,
    OUTREACH_DRY_RUN: process.env.OUTREACH_DRY_RUN,
  };

  webChild = spawn(process.execPath, [nextBin, 'start', '-p', String(port)], {
    env: webEnv,
    stdio: options.silent ? 'pipe' : 'inherit',
  });

  webChild.on('error', (err) => {
    console.error('[Supervisor] Web process spawn error:', err);
    shutdown('SPAWN_ERROR');
  });

  webChild.on('exit', (code, sig) => {
    console.log(`[Supervisor] Next.js web server exited with code ${code}, signal ${sig}`);
    if (!isShuttingDown) {
      console.error('[Supervisor] Web server stopped unexpectedly. Halting worker and exiting...');
      shutdown('WEB_EXIT');
      process.exit(code !== null ? code : 1);
    }
  });

  // 4. Spawn Persistent Outreach Worker
  console.log('[Supervisor] Spawning persistent Outreach Worker...');
  const workerEnv = {
    ...process.env,
    DATA_DIR: dataDir,
    OUTREACH_DRY_RUN: process.env.OUTREACH_DRY_RUN,
  };

  workerChild = spawn(process.execPath, [tsxCli, workerScript], {
    env: workerEnv,
    stdio: options.silent ? 'pipe' : 'inherit',
  });

  workerChild.on('error', (err) => {
    console.error('[Supervisor] Worker process spawn error:', err);
    shutdown('SPAWN_ERROR');
  });

  workerChild.on('exit', (code, sig) => {
    console.log(`[Supervisor] Outreach worker exited with code ${code}, signal ${sig}`);
    if (!isShuttingDown) {
      if (code !== 0) {
        console.error('[Supervisor] Worker process failed with non-zero exit code. Halting web server and exiting...');
        shutdown('WORKER_FAILURE');
        process.exit(code !== null ? code : 1);
      } else {
        console.log('[Supervisor] Worker exited cleanly (code 0).');
      }
    }
  });

  return {
    webChild,
    workerChild,
    shutdown,
  };
}

if (require.main === module) {
  startSupervisor();
}

module.exports = { startSupervisor };
