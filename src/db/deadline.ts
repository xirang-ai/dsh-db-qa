/**
 * 调用级截止时间：把宿主 signal、语句超时与整次工具调用的预算折成可竞争的
 * AbortSignal。
 *
 * 工具层必须自己兜底：`defineTool({ timeoutMs })` 在 DSH 里只是声明（注册表
 * 不执行截止时间，见 dsh-tools README），所以每次等待驱动都要挂一个 timer，
 * 超时后先中止等待、再强制断链，避免挂起的查询把工具调用一起拖住。
 *
 * @module
 */
import { DbqaError } from '../errors.ts'
import { translateBilingual } from '../i18n.ts'

/** 一条语句超时的文案（中英并列，模型与用户都能看懂）。 */
export function statementTimeoutText(timeoutMs: number): string {
  return translateBilingual('dbqa.query.timeout', { seconds: secondsOf(timeoutMs) })
}

/** 整次工具调用超时的文案。 */
export function callTimeoutText(timeoutMs: number): string {
  return translateBilingual('dbqa.call.timeout', { seconds: secondsOf(timeoutMs) })
}

function secondsOf(timeoutMs: number): number {
  return Math.max(1, Math.round(timeoutMs / 1000))
}

/** 一次等待的截止时间句柄。 */
export interface Deadline {
  /** 交给驱动或下游的中止信号；外层取消与本层超时都会触发它。 */
  readonly signal: AbortSignal
  /** 是否由本层计时器触发（而不是外层取消）。 */
  readonly timedOut: () => boolean
  /** 释放计时器与监听；必须在 `finally` 里调用。 */
  dispose(): void
}

/**
 * 起一个截止时间：在 `parent` 取消或 `timeoutMs` 到期时中止。
 * @param parent - 宿主工具的中止信号。
 * @param timeoutMs - 本层允许的最长等待。
 * @param message - 超时时作为中止原因的错误文案。
 */
export function startDeadline(parent: AbortSignal, timeoutMs: number, message: string): Deadline {
  const controller = new AbortController()
  const relay = (): void => {
    controller.abort(parent.reason)
  }
  parent.addEventListener('abort', relay, { once: true })
  if (parent.aborted) controller.abort(parent.reason)

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort(new DbqaError('DBQA_TIMEOUT', message))
  }, Math.max(1, Math.round(timeoutMs)))
  // 计时器不该独自把宿主进程留在事件循环里。
  timer.unref?.()

  let disposed = false
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose() {
      if (disposed) return
      disposed = true
      clearTimeout(timer)
      parent.removeEventListener('abort', relay)
    },
  }
}

/** 把 Promise 与中止信号赛跑；用于让超时不必等驱动自己返回。 */
export function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('dbqa: aborted'))
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(signal.reason ?? new Error('dbqa: aborted'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

/**
 * 在有截止时间的信号下跑一段异步逻辑；超时抛 `DBQA_TIMEOUT`，外层取消则原样传递原因。
 * @param parent - 上层信号（工具 signal 或更外层的截止时间）。
 * @param timeoutMs - 本层允许的最长等待。
 * @param message - 超时文案。
 * @param run - 拿到本层信号后执行的逻辑。
 */
export async function withDeadline<T>(
  parent: AbortSignal,
  timeoutMs: number,
  message: string,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const deadline = startDeadline(parent, timeoutMs, message)
  try {
    return await raceAbort(run(deadline.signal), deadline.signal)
  } catch (error) {
    if (deadline.timedOut()) throw new DbqaError('DBQA_TIMEOUT', message)
    throw error
  } finally {
    deadline.dispose()
  }
}

/** 是否因超时/中止而放弃这次等待；用于决定关闭连接时是否强制断链。 */
export function isTimeoutFailure(error: unknown): boolean {
  return error instanceof DbqaError && error.code === 'DBQA_TIMEOUT'
}
