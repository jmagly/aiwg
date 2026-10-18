/**
 * ContainerManager — Docker lifecycle for daemon containerization.
 *
 * Manages building, starting, stopping, and monitoring the daemon
 * Docker container. The entire daemon runs inside the container with
 * the project directory mounted as a volume.
 *
 * @implements Plan: Daemon Starter — Docker Containerization
 */

import { execFileSync, spawn } from 'child_process';
import { importImpl } from '../_resolve-impl.mjs';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';

const { boundedExecFileSync } = await importImpl(import.meta.url, 'process/bounded-child-process.mjs');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTAINER_ID_FILE = '.aiwg/daemon/container-id';

/**
 * @typedef {Object} ContainerManagerOptions
 * @property {string} [projectDir] - Project directory to mount
 * @property {string} [imageName] - Docker image name
 * @property {string} [imageTag] - Docker image tag
 * @property {number} [webPort] - Web UI port
 * @property {Object} [dockerConfig] - Docker config from daemon.yaml
 */

export class ContainerManager {
  /** @type {string} */
  #projectDir;

  /** @type {string} */
  #imageName;

  /** @type {string} */
  #imageTag;

  /** @type {string} */
  #containerName;

  /** @type {number} */
  #webPort;

  /** @type {Object} */
  #dockerConfig;

  /**
   * @param {ContainerManagerOptions} [options]
   */
  constructor(options = {}) {
    this.#projectDir = options.projectDir || process.cwd();
    this.#imageName = options.imageName || options.dockerConfig?.image?.split(':')[0] || 'aiwg-daemon';
    this.#imageTag = options.imageTag || options.dockerConfig?.image?.split(':')[1] || 'latest';
    this.#webPort = options.webPort || 7474;
    this.#dockerConfig = options.dockerConfig || {};

    const hash = createHash('md5').update(this.#projectDir).digest('hex').slice(0, 8);
    this.#containerName = `aiwg-daemon-${hash}`;
  }

  /**
   * Check if Docker is available.
   *
   * @returns {boolean}
   */
  isDockerAvailable() {
    try {
      boundedExecFileSync('docker', ['info'], 'quick', { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Build the Docker image if not present or if Dockerfile changed.
   */
  ensureImage() {
    const dockerfile = path.join(__dirname, 'Dockerfile.daemon');
    if (!fs.existsSync(dockerfile)) {
      throw new Error(`Dockerfile not found: ${dockerfile}`);
    }

    const fullImage = `${this.#imageName}:${this.#imageTag}`;

    // Check if image exists
    try {
      boundedExecFileSync('docker', ['image', 'inspect', fullImage], 'quick', { stdio: 'ignore' });
      console.log(`[docker] Image ${fullImage} exists`);
      return;
    } catch {
      // Image doesn't exist, build it
    }

    console.log(`[docker] Building image ${fullImage}...`);
    const buildContext = this.#dockerConfig.buildContext || this.#projectDir;

    boundedExecFileSync(
      'docker', ['build', '-f', dockerfile, '-t', fullImage, buildContext],
      'long',
      { stdio: 'inherit' }
    );

    console.log(`[docker] Image ${fullImage} built successfully`);
  }

  /**
   * Start the daemon container.
   *
   * @returns {{ containerId: string, containerName: string }}
   */
  start() {
    if (!this.isDockerAvailable()) {
      throw new Error('Docker is not available. Install Docker or run without --docker.');
    }

    // Stop existing container if running
    this.#stopExisting();

    this.ensureImage();

    const fullImage = `${this.#imageName}:${this.#imageTag}`;
    const home = homedir();

    const args = [
      'run', '-d',
      '--name', this.#containerName,
      // Mount project directory
      '-v', `${this.#projectDir}:/workspace`,
      // Mount credentials read-only
      '-v', `${home}/.config:/root/.config:ro`,
      // Web UI port
      '-p', `${this.#webPort}:7474`,
      // Restart policy
      '--restart', this.#dockerConfig.restart_policy || 'unless-stopped',
    ];

    // Resource limits
    if (this.#dockerConfig.resources?.memory) {
      args.push('--memory', this.#dockerConfig.resources.memory);
    }
    if (this.#dockerConfig.resources?.cpus) {
      args.push('--cpus', this.#dockerConfig.resources.cpus);
    }

    // Extra environment from .env file
    if (this.#dockerConfig.env_file) {
      const envFile = path.resolve(this.#projectDir, this.#dockerConfig.env_file);
      if (fs.existsSync(envFile)) {
        args.push('--env-file', envFile);
      }
    }

    // Pass through API key env vars
    for (const envVar of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'AIWG_TELEGRAM_TOKEN', 'AIWG_DISCORD_TOKEN']) {
      if (process.env[envVar]) {
        args.push('-e', envVar);
      }
    }

    // Extra volumes
    if (Array.isArray(this.#dockerConfig.volumes)) {
      for (const vol of this.#dockerConfig.volumes) {
        if (vol.source && vol.target) {
          const src = path.resolve(this.#projectDir, vol.source);
          args.push('-v', `${src}:${vol.target}:${vol.mode || 'rw'}`);
        }
      }
    }

    args.push(fullImage);

    // `long`, not `quick` (#3062 finding 6): `docker run` can implicitly
    // pull the image if the local build cache was invalidated.
    const result = boundedExecFileSync('docker', args, 'long', { encoding: 'utf8' }).trim();
    const containerId = result.slice(0, 12);

    // Store container ID
    const idDir = path.dirname(CONTAINER_ID_FILE);
    if (!fs.existsSync(idDir)) {
      fs.mkdirSync(idDir, { recursive: true });
    }
    fs.writeFileSync(CONTAINER_ID_FILE, containerId);

    console.log(`[docker] Container started: ${this.#containerName} (${containerId})`);
    return { containerId, containerName: this.#containerName };
  }

  /**
   * Stop and remove the container.
   */
  stop() {
    try {
      execFileSync('docker', ['stop', this.#containerName], { stdio: 'ignore', timeout: 15000, killSignal: 'SIGKILL' });
    } catch {
      // Container may not be running
    }

    try {
      boundedExecFileSync('docker', ['rm', this.#containerName], 'quick', { stdio: 'ignore' });
    } catch {
      // Container may not exist
    }

    // Clean up container ID file
    if (fs.existsSync(CONTAINER_ID_FILE)) {
      fs.unlinkSync(CONTAINER_ID_FILE);
    }

    console.log(`[docker] Container stopped: ${this.#containerName}`);
  }

  /**
   * Get container status.
   *
   * @returns {{ running: boolean, containerId: string|null, health: string|null }}
   */
  status() {
    try {
      const output = boundedExecFileSync(
        'docker', ['inspect', '--format', '{{.State.Running}} {{.State.Health.Status}}', this.#containerName],
        'quick',
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }
      ).trim();

      const [running, health] = output.split(' ');
      return {
        running: running === 'true',
        containerId: this.#readContainerId(),
        health: health || null,
      };
    } catch {
      return { running: false, containerId: null, health: null };
    }
  }

  /**
   * Stream container logs.
   *
   * @param {boolean} [follow=false]
   * @param {number} [lines=50]
   * @returns {import('child_process').ChildProcess}
   */
  logs(follow = false, lines = 50) {
    const args = ['logs', '--tail', String(lines)];
    if (follow) args.push('-f');
    args.push(this.#containerName);

    return spawn('docker', args, { stdio: 'inherit' });
  }

  /**
   * Stop existing container if running.
   */
  #stopExisting() {
    try {
      const output = boundedExecFileSync(
        'docker', ['ps', '-q', '-f', `name=${this.#containerName}`],
        'quick',
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }
      ).trim();

      if (output) {
        console.log(`[docker] Stopping existing container: ${this.#containerName}`);
        this.stop();
      }
    } catch {
      // No existing container
    }
  }

  /**
   * Read stored container ID.
   *
   * @returns {string|null}
   */
  #readContainerId() {
    try {
      return fs.readFileSync(CONTAINER_ID_FILE, 'utf8').trim();
    } catch {
      return null;
    }
  }
}

export default ContainerManager;
