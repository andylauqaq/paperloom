import { spawn } from 'node:child_process'

// 回归测试通过真实标准输入输出传输与 MCP 服务通信。
export function mcpClient(command, args, environment = {}) {
  const child = spawn(command, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, ...environment },
  })
  const pending = new Map()
  let buffer = ''
  let nextId = 1
  let stderr = ''
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString()
  })
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString()
    let boundary
    while ((boundary = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 1)
      if (!line.trim()) continue
      let value
      try {
        value = JSON.parse(line)
      } catch {
        continue
      }
      const callback = pending.get(value.id)
      if (callback) {
        pending.delete(value.id)
        callback.resolve(value)
      }
    }
  })
  child.on('error', (error) => {
    for (const callback of pending.values()) callback.reject(error)
  })
  child.on('exit', (code) => {
    for (const callback of pending.values())
      callback.reject(new Error(`MCP 进程退出 ${code} ${stderr}`))
  })
  return {
    child,
    request(method, params = {}) {
      const id = nextId++
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`MCP 请求超时 ${method} ${stderr}`))
        }, 20000)
        pending.set(id, {
          resolve: (value) => {
            clearTimeout(timeout)
            resolve(value)
          },
          reject: (error) => {
            clearTimeout(timeout)
            reject(error)
          },
        })
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      })
    },
    notification(method) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`)
    },
    close() {
      child.stdin.end()
      child.kill()
    },
  }
}
