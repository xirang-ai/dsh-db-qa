/**
 * 可选 SSH 跳板：只在数据源启用跳板时建立，一次调用结束即拆除。
 *
 * 实现走系统 OpenSSH（不新增依赖）：
 * - 本地随机端口 `-L 127.0.0.1:<port>:<target>`；
 * - 私钥认证用 `-i`，口令认证用 `SSH_ASKPASS` 辅助脚本（口令只经环境变量传递）；
 * - 主机指纹可选钉住：给了指纹就先 `ssh-keyscan` 再比对 `ssh-keygen -lf`，
 *   不一致直接拒绝；没给指纹时按 `accept-new` 做 TOFU。
 *
 * 失败一律映射成稳定错误码，消息里只有主机、端口和原因分类。
 *
 * @module
 */
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmodSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { createConnection, createServer } from 'node:net'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { DbqaError } from '../errors.ts'
import type { SshConfig } from '../db/fields.ts'

/** 一条已建立的隧道。 */
export interface SshTunnel {
  readonly localHost: string
  readonly localPort: number
  /** 幂等关闭：杀掉 ssh 子进程并清理临时文件。 */
  close(): Promise<void>
}

/** 建立隧道需要的上下文。 */
export interface TunnelRequest {
  readonly ssh: SshConfig
  readonly targetHost: string
  readonly targetPort: number
  /** 插件数据目录，用来放 known_hosts 与临时 askpass 脚本。 */
  readonly dataDir: string
  readonly signal: AbortSignal
}

const CONNECT_POLL_MS = 100
const STDERR_LIMIT = 4_096

/** 找一个本地空闲端口。 */
async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  await new Promise<void>((resolve) => server.close(() => resolve()))
  if (port === 0) throw new DbqaError('DBQA_INTERNAL', 'dbqa: could not allocate a local port for the SSH tunnel')
  return port
}

/** 试连一次本地转发端口。 */
function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    const done = (ok: boolean): void => {
      socket.destroy()
      resolve(ok)
    }
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
    socket.setTimeout(500, () => done(false))
  })
}

/** 把 ssh 的 stderr 归到稳定错误码；消息只保留分类。 */
function classifySshFailure(stderr: string): DbqaError {
  const text = stderr.toLowerCase()
  if (text.includes('permission denied') || text.includes('no supported authentication methods')) {
    return new DbqaError('DBQA_SSH_AUTH', 'dbqa: SSH authentication failed')
  }
  if (text.includes('host key verification failed') || text.includes('remote host identification has changed')) {
    return new DbqaError('DBQA_SSH_HOSTKEY', 'dbqa: SSH host key verification failed')
  }
  if (text.includes('timed out') || text.includes('timeout')) {
    return new DbqaError('DBQA_TIMEOUT', 'dbqa: SSH connection timed out')
  }
  if (
    text.includes('connection refused') ||
    text.includes('could not resolve hostname') ||
    text.includes('network is unreachable') ||
    text.includes('no route to host')
  ) {
    return new DbqaError('DBQA_HOST_UNREACHABLE', 'dbqa: SSH host is unreachable')
  }
  return new DbqaError('DBQA_INTERNAL', 'dbqa: SSH tunnel could not be established')
}

/** 运行一个短命令并收集 stdout，用于 `ssh-keyscan` / `ssh-keygen`。 */
async function run(command: string, args: readonly string[], timeoutMs: number): Promise<string> {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8')
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8')
  })
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
  try {
    const [code] = (await once(child, 'close')) as [number | null]
    if (code !== 0) {
      const detail = stderr.trim().split('\n')[0] ?? ''
      throw new DbqaError(
        'DBQA_SSH_HOSTKEY',
        `dbqa: ${command} failed while checking the SSH host key${detail === '' ? '' : ` (${detail})`}`,
      )
    }
    return stdout
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 给了指纹时，先用 keyscan 取主机公钥并比对。
 * @returns 可写入 known_hosts 的条目。
 */
async function verifyFingerprint(ssh: SshConfig, timeoutMs: number): Promise<string> {
  const knownHost = ssh.port === 22 ? ssh.host ?? '' : `[${ssh.host ?? ''}]:${ssh.port ?? 22}`
  let scanned: string
  try {
    scanned = await run(
      'ssh-keyscan',
      ['-T', String(Math.max(1, Math.ceil(timeoutMs / 1000))), '-p', String(ssh.port ?? 22), ssh.host ?? ''],
      timeoutMs + 2_000,
    )
  } catch {
    throw new DbqaError('DBQA_HOST_UNREACHABLE', 'dbqa: SSH host did not answer the host-key scan')
  }
  const entries = scanned
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
  if (entries.length === 0) {
    throw new DbqaError('DBQA_SSH_HOSTKEY', 'dbqa: SSH host returned no host key')
  }
  const expected = (ssh.hostFingerprint ?? '').replace(/^SHA256:/i, '').trim()
  const checkFile = join(tmpdir(), `dbqa-keys-${process.pid}-${Date.now()}`)
  try {
    writeFileSync(checkFile, `${entries.join('\n')}\n`, { mode: 0o600 })
    const listing = await run('ssh-keygen', ['-lf', checkFile, '-E', 'sha256'], 5_000)
    const matched = listing
      .split('\n')
      .some((line) => line.replace(/SHA256:/i, '').includes(expected))
    if (!matched) {
      throw new DbqaError('DBQA_SSH_HOSTKEY', 'dbqa: SSH host key fingerprint does not match the pinned value')
    }
  } finally {
    rmSync(checkFile, { force: true })
  }
  const host = knownHost.split(' ')[0] ?? ''
  return entries.map((line) => `${host} ${line.split(' ').slice(1).join(' ')}`.trim()).join('\n')
}

/** 口令认证的 askpass 脚本：只从环境变量读口令。 */
function writeAskpass(dir: string): string {
  const file = join(dir, `askpass-${process.pid}-${Date.now()}.sh`)
  writeFileSync(file, '#!/bin/sh\nprintf \'%s\\n\' "$DBQA_SSH_PASSWORD"\n', { mode: 0o700 })
  chmodSync(file, 0o700)
  return file
}

/**
 * 建立隧道并等到本地端口可用。
 * @throws {DbqaError} SSH 认证、主机指纹、不可达、超时或内部错误。
 */
export async function openSshTunnel(request: TunnelRequest): Promise<SshTunnel> {
  const { ssh, signal } = request
  if (!ssh.useSsh) throw new DbqaError('DBQA_INVALID_CONFIG', 'dbqa: SSH tunnel requested without SSH settings')
  if (ssh.host === undefined || ssh.host === '') {
    throw new DbqaError('DBQA_INVALID_CONFIG', 'dbqa: SSH tunnel has no jump host')
  }
  if (ssh.user === undefined || ssh.user === '') {
    throw new DbqaError('DBQA_INVALID_CONFIG', 'dbqa: SSH tunnel has no jump user')
  }
  if (ssh.auth === 'privateKey' && (ssh.privateKeyPath === undefined || ssh.privateKeyPath === '')) {
    throw new DbqaError('DBQA_INVALID_CONFIG', 'dbqa: SSH private-key authentication needs a key file')
  }
  if (ssh.auth === 'password' && (ssh.password === undefined || ssh.password === '')) {
    throw new DbqaError('DBQA_SSH_AUTH', 'dbqa: SSH password is not available')
  }
  if (signal.aborted) throw new DbqaError('DBQA_TIMEOUT', 'dbqa: the call was cancelled before opening the SSH tunnel')

  const sshDir = join(request.dataDir, 'ssh')
  mkdirSync(sshDir, { recursive: true, mode: 0o700 })
  const knownHosts = join(sshDir, 'known_hosts')
  const localPort = await freePort()
  const timeoutMs = ssh.connectTimeoutMs > 0 ? ssh.connectTimeoutMs : 10_000

  let pinnedEntry: string | undefined
  if (ssh.hostFingerprint !== undefined && ssh.hostFingerprint !== '') {
    pinnedEntry = await verifyFingerprint(ssh, timeoutMs)
    writeFileSync(knownHosts, `${pinnedEntry}\n`, { mode: 0o600 })
  }

  const askpass = ssh.auth === 'password' ? writeAskpass(sshDir) : undefined
  const forward = `127.0.0.1:${localPort}:${request.targetHost}:${request.targetPort}`
  const args = [
    '-N',
    '-L',
    forward,
    '-p',
    String(ssh.port ?? 22),
    '-o',
    'ExitOnForwardFailure=yes',
    '-o',
    `ConnectTimeout=${Math.max(1, Math.ceil(timeoutMs / 1000))}`,
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=2',
    '-o',
    'LogLevel=ERROR',
    '-o',
    `UserKnownHostsFile=${knownHosts}`,
    '-o',
    pinnedEntry === undefined ? 'StrictHostKeyChecking=accept-new' : 'StrictHostKeyChecking=yes',
    ...(askpass === undefined ? ['-o', 'BatchMode=yes'] : []),
    ...(ssh.privateKeyPath === undefined || ssh.privateKeyPath === '' ? [] : ['-i', ssh.privateKeyPath]),
    `${ssh.user}@${ssh.host}`,
  ]

  const child = spawn(process.env['DBQA_SSH_BIN'] ?? 'ssh', args, {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      ...(askpass === undefined
        ? {}
        : { SSH_ASKPASS: askpass, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: ':0', DBQA_SSH_PASSWORD: ssh.password }),
    },
  })

  let stderr = ''
  child.stderr?.on('data', (chunk: Buffer) => {
    if (stderr.length < STDERR_LIMIT) stderr += chunk.toString('utf8').slice(0, STDERR_LIMIT - stderr.length)
  })

  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    if (child.exitCode === null && !child.killed) child.kill('SIGTERM')
    await Promise.race([once(child, 'close').catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 2_000))])
    if (child.exitCode === null) child.kill('SIGKILL')
    if (askpass !== undefined) rmSync(askpass, { force: true })
  }

  const deadline = Date.now() + timeoutMs
  try {
    for (;;) {
      if (signal.aborted) throw new DbqaError('DBQA_TIMEOUT', 'dbqa: the call was cancelled while opening the SSH tunnel')
      if (child.exitCode !== null || child.signalCode !== null) {
        throw classifySshFailure(stderr)
      }
      if (await canConnect(localPort)) break
      if (Date.now() >= deadline) {
        throw new DbqaError('DBQA_TIMEOUT', 'dbqa: SSH tunnel did not become ready in time')
      }
      await new Promise((resolve) => setTimeout(resolve, CONNECT_POLL_MS))
    }
  } catch (error) {
    await close()
    throw error
  }

  const onAbort = (): void => {
    void close()
  }
  signal.addEventListener('abort', onAbort, { once: true })
  child.once('close', () => {
    signal.removeEventListener('abort', onAbort)
  })

  return { localHost: '127.0.0.1', localPort, close }
}

/** 读取已保存的 known_hosts（测试与诊断用）。 */
export function readKnownHosts(dataDir: string): string {
  try {
    return readFileSync(join(dataDir, 'ssh', 'known_hosts'), 'utf8')
  } catch {
    return ''
  }
}
