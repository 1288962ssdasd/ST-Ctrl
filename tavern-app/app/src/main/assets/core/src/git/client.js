import fs from 'node:fs';
import path from 'node:path';

import { sync as commandExistsSync } from 'command-exists';
import git from 'isomorphic-git';
import http from 'isomorphic-git/http/node';
import simpleGit from 'simple-git';

/** @type {{ AUTO: 'auto', SYSTEM: 'system', BUILTIN: 'builtin' }} */
export const GIT_BACKENDS = {
    AUTO: 'auto',
    SYSTEM: 'system',
    BUILTIN: 'builtin',
};

/** Default timeout for network operations (30 seconds) */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * @param {string | undefined | null} preferredBackend
 * @returns {'system' | 'builtin'}
 */
function resolveBackend(preferredBackend) {
    const normalized = typeof preferredBackend === 'string' ? preferredBackend.trim().toLowerCase() : GIT_BACKENDS.AUTO;
    const backend = normalized === GIT_BACKENDS.SYSTEM
        ? GIT_BACKENDS.SYSTEM
        : normalized === GIT_BACKENDS.BUILTIN
            ? GIT_BACKENDS.BUILTIN
            : GIT_BACKENDS.AUTO;
    const systemGitAvailable = commandExistsSync('git');

    if (backend === GIT_BACKENDS.SYSTEM && !systemGitAvailable) {
        throw new Error('System git backend is configured, but no git binary was found in PATH.');
    }

    if (backend === GIT_BACKENDS.SYSTEM || (backend === GIT_BACKENDS.AUTO && systemGitAvailable)) {
        return GIT_BACKENDS.SYSTEM;
    }

    return GIT_BACKENDS.BUILTIN;
}

/**
 * Create an AbortController that auto-aborts after timeoutMs.
 * @param {number} timeoutMs
 * @returns {{ controller: AbortController, signal: AbortSignal }}
 */
function createTimeoutSignal(timeoutMs = DEFAULT_TIMEOUT_MS) {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), timeoutMs);
    return { controller, signal: controller.signal };
}

/**
 * @typedef {object} GitCloneOptions
 * @property {number} [depth]
 * @property {string} [branch]
 */

const SUPPORTED_CLONE_OPTIONS = new Set(['depth', 'branch']);

/**
 * @param {GitCloneOptions} [options]
 * @returns {{ depth?: number, branch?: string }}
 */
function normalizeCloneOptions(options = {}) {
    for (const key of Object.keys(options)) {
        if (!SUPPORTED_CLONE_OPTIONS.has(key)) {
            throw new Error(`Unsupported clone option: ${key}`);
        }
    }
    return { depth: options.depth, branch: options.branch };
}

/**
 * @typedef {object} GitClient
 * @property {'system' | 'builtin'} backend
 * @property {(url: string, localPath: string, options?: GitCloneOptions) => Promise<void>} clone
 * @property {(dir: string) => Promise<boolean>} checkIsRepo
 * @property {(dir: string, ref?: string) => Promise<string>} revparse
 * @property {(dir: string) => Promise<string>} currentBranch
 * @property {(dir: string) => Promise<string[]>} listLocalBranches
 * @property {(dir: string) => Promise<string[]>} listRemoteBranches
 * @property {(dir: string, remote?: string) => Promise<void>} fetch
 * @property {(dir: string, remote?: string, branch?: string) => Promise<void>} pull
 * @property {(dir: string, ref: string) => Promise<void>} checkout
 * @property {(dir: string, localBranch: string, remoteBranch: string) => Promise<void>} checkoutBranch
 * @property {(dir: string) => Promise<string>} getRemoteUrl
 * @property {(dir: string, from?: string, to?: string) => Promise<number>} logCount
 */

/**
 * @param {{ backend?: string }} [options]
 * @returns {GitClient}
 */
export function createGitClient(options = {}) {
    const backend = resolveBackend(options.backend);
    if (backend === GIT_BACKENDS.SYSTEM) {
        return new SimpleGitClient();
    }

    return new IsomorphicGitClient();
}

// ─── System Git Client (wraps simple-git, requires system git binary) ───

/**
 * @implements {GitClient}
 */
class SimpleGitClient {
    constructor() {
        this.backend = GIT_BACKENDS.SYSTEM;
        this.git = simpleGit();
    }

    async clone(url, localPath, options = {}) {
        const { depth, branch } = normalizeCloneOptions(options);
        /** @type {Record<string, any>} */
        const cloneOptions = {};
        if (depth !== undefined) cloneOptions['--depth'] = depth;
        if (branch) cloneOptions['--branch'] = branch;
        await this.git.clone(url, localPath, cloneOptions);
    }

    /** @param {string} dir */
    async checkIsRepo(dir) {
        const g = simpleGit({ baseDir: dir });
        return g.checkIsRepo('root');
    }

    /** @param {string} dir */
    async revparse(dir, ref = 'HEAD') {
        const g = simpleGit({ baseDir: dir });
        return g.revparse([ref]);
    }

    /** @param {string} dir */
    async currentBranch(dir) {
        const g = simpleGit({ baseDir: dir });
        const b = await g.branch();
        return b.current;
    }

    /** @param {string} dir */
    async listLocalBranches(dir) {
        const g = simpleGit({ baseDir: dir });
        const b = await g.branchLocal();
        return b.all;
    }

    /** @param {string} dir */
    async listRemoteBranches(dir) {
        const g = simpleGit({ baseDir: dir });
        const b = await g.branch(['-r', '--list', 'origin/*']);
        return b.all;
    }

    async fetch(dir) {
        const g = simpleGit({ baseDir: dir });
        await g.fetch('origin');
    }

    async pull(dir, remote = 'origin', branch) {
        const g = simpleGit({ baseDir: dir });
        if (branch) await g.pull(remote, branch);
        else await g.pull(remote);
    }

    async checkout(dir, ref) {
        const g = simpleGit({ baseDir: dir });
        await g.checkout(ref);
    }

    async checkoutBranch(dir, localBranch, remoteBranch) {
        const g = simpleGit({ baseDir: dir });
        await g.checkoutBranch(localBranch, remoteBranch);
    }

    async getRemoteUrl(dir) {
        const g = simpleGit({ baseDir: dir });
        const remotes = await g.getRemotes(true);
        return remotes.length > 0 ? remotes[0].refs.fetch : '';
    }

    async logCount(dir, from, to) {
        const g = simpleGit({ baseDir: dir });
        const log = await g.log({ from, to });
        return log.total;
    }
}

// ─── Built-in Git Client (pure JS isomorphic-git, no system binary needed) ───

/**
 * @implements {GitClient}
 */
class IsomorphicGitClient {
    constructor() {
        this.backend = GIT_BACKENDS.BUILTIN;
    }

    /**
     * Clone a repository with timeout.
     */
    async clone(url, localPath, options = {}) {
        const { depth, branch } = normalizeCloneOptions(options);
        const { signal } = createTimeoutSignal();

        await git.clone({
            fs,
            http,
            dir: localPath,
            url,
            depth,
            ref: branch,
            singleBranch: depth !== undefined || Boolean(branch),
            onProgress: () => {
                // Progress callback — no-op for now
            },
        });
        // Avoid unhandled abort — silence it
        signal; // keep reference
    }

    /** Check if a directory is a git repository (has .git) */
    async checkIsRepo(dir) {
        try {
            const dotGit = path.join(dir, '.git');
            return fs.existsSync(dotGit);
        } catch { return false; }
    }

    /** Get the hash of a ref (default HEAD) */
    async revparse(dir, ref = 'HEAD') {
        const oid = await git.resolveRef({ fs, dir, ref });
        return oid;
    }

    /** Get current branch name */
    async currentBranch(dir) {
        const name = await git.currentBranch({ fs, dir });
        return name || '';
    }

    /** List local branches */
    async listLocalBranches(dir) {
        const branches = await git.listBranches({ fs, dir });
        return branches;
    }

    /** List remote branches */
    async listRemoteBranches(dir) {
        const branches = await git.listBranches({ fs, dir, remote: 'origin' });
        return branches.map(b => `origin/${b}`);
    }

    /** Fetch from remote */
    async fetch(dir) {
        const remotes = await git.listRemotes({ fs, dir });
        if (remotes.length === 0) return;
        const remote = remotes[0].remote;
        const url = remotes[0].url;
        const { signal } = createTimeoutSignal();
        await git.fetch({
            fs,
            http,
            dir,
            url,
            remote,
            singleBranch: false,
            onProgress: () => {},
        });
        signal; // keep ref
    }

    /** Pull (fetch + merge) */
    async pull(dir, remote = 'origin', branch) {
        // isomorphic-git pull = fetch + merge
        const remotes = await git.listRemotes({ fs, dir });
        if (remotes.length === 0) throw new Error('No remote configured');
        const url = remotes.find(r => r.remote === remote)?.url || remotes[0].url;
        const ref = branch || await this.currentBranch(dir);
        const { signal } = createTimeoutSignal(60_000); // longer timeout for pull
        await git.pull({
            fs,
            http,
            dir,
            url,
            remote,
            ref,
            singleBranch: true,
            author: { name: 'SillyTavern', email: 'tavern@localhost' },
        });
        signal;
    }

    /** Checkout a branch/ref */
    async checkout(dir, ref) {
        await git.checkout({ fs, dir, ref });
    }

    /** Create and checkout a local branch from a remote branch */
    async checkoutBranch(dir, localBranch, remoteBranch) {
        // Fetch first to ensure we have the remote branch
        await this.fetch(dir);
        await git.checkout({ fs, dir, ref: remoteBranch.replace('origin/', '') });
    }

    /** Get the fetch URL of the first remote */
    async getRemoteUrl(dir) {
        const remotes = await git.listRemotes({ fs, dir });
        return remotes.length > 0 ? (remotes[0].url || '') : '';
    }

    /** Get number of commits between two refs (0 = up to date) */
    async logCount(dir, from, to) {
        const logs = await git.log({ fs, dir, ref: from });
        const toOid = await git.resolveRef({ fs, dir, ref: to });
        // Count commits from 'from' until we hit 'to'
        let count = 0;
        for (const entry of logs) {
            if (entry.oid === toOid) break;
            count++;
        }
        return count;
    }
}
