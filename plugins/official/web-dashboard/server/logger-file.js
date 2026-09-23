/**
 * server/logger-file.js — 读取 structured logger(core/logger.js)落盘的 monitor.log 文件日志。
 *
 * 背景：dashboard「日志页」的数据库源(ops_log)只覆盖认证/WS/进程启停打点；而
 * core/logger.js(PR #132)把所有命名 logger(app/ws/...)的 info/warn/error 落盘到
 * monitor.log(text 或 json 每行一条)。本模块把该文件日志解析成结构化条目供
 * /api/dashboard/logger 路由使用，让日志页能"更详细"地看到完整文件日志。
 *
 * 路径解析规则与 core/logger.js 的 resolveDir() 完全一致（单一来源语义——若 logger
 * 落盘路径规则变动，需同步这里）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 本模块位于 <repo>/plugins/official/web-dashboard/server → 上溯 4 层回到仓库根
const REPO_ROOT = path.join(__dirname, '../../../../');

/**
 * 解析 monitor.log 的存放目录（与 core/logger.js resolveDir() 一致）：
 *   1. VRC_MONITOR_LOGGER_DIR 显式指定；2. VRC_MONITOR_DIR/logs；3. <仓库根>/logs。
 * @param {Record<string,string|undefined>} [env] 环境（默认 process.env），便于测试注入
 * @param {string} [repoRoot] 仓库根（默认自动探测），便于测试注入
 */
export function resolveLoggerDir(env = process.env, repoRoot = REPO_ROOT) {
  if (env && env.VRC_MONITOR_LOGGER_DIR) return path.resolve(env.VRC_MONITOR_LOGGER_DIR);
  if (env && env.VRC_MONITOR_DIR) return path.resolve(env.VRC_MONITOR_DIR, 'logs');
  return path.join(repoRoot, 'logs');
}

const LEVEL_MAP = { DEBUG: 'debug', INFO: 'info', WARN: 'warn', ERROR: 'error' };
// text 格式行：`<ISO ts> <LEVEL(右补到5)> [<name>] <msg>`
const TEXT_LINE_RE = /^(\S+)\s+(DEBUG|INFO|WARN|ERROR)\s+\[([^\]]*)\]\s*(.*)$/;

/**
 * 解析 monitor.log 的一行（text 或 json 格式均可）。
 * @param {string} line 不含末尾换行的单行
 * @returns {{ts:string, level:string, name:string, message:string}|null} 无法解析返回 null
 */
export function parseLoggerLine(line) {
  if (typeof line !== 'string') return null;
  const s = line.trim();
  if (!s) return null;

  // json：`{"ts":"...","level":"info","name":"ws","msg":"...",...}`
  if (s[0] === '{') {
    try {
      const o = JSON.parse(s);
      if (o && typeof o === 'object' && 'msg' in o && 'ts' in o) {
        return {
          ts: String(o.ts ?? ''),
          level: String(o.level ?? 'info').toLowerCase(),
          name: String(o.name ?? 'app'),
          message: String(o.msg ?? ''),
        };
      }
    } catch { /* 不是 JSON，落到 text 解析 */ }
  }

  const m = TEXT_LINE_RE.exec(s);
  if (!m) return null;
  return {
    ts: m[1],
    level: LEVEL_MAP[m[2]] ?? String(m[2]).toLowerCase(),
    name: m[3] || 'app',
    message: m[4],
  };
}

// 级别过滤门槛（debug=10,info=20,warn=30,error=40）
const LEVEL_VAL = { debug: 10, info: 20, warn: 30, error: 40 };
function levelAtLeast(a, b) {
  if (!b) return true;
  return (LEVEL_VAL[a] ?? 0) >= (LEVEL_VAL[b] ?? 0);
}

/**
 * 读取 monitor.log 尾部条目（倒序：最新在前）。
 * @param {object} opts
 * @param {string} [opts.dir] logger 目录（默认 resolveLoggerDir()）
 * @param {number} [opts.limit] 返回条数上限（默认 200）
 * @param {string} [opts.level] 最低级别过滤 info/warn/error
 * @param {string} [opts.name] 按 logger 标签精确过滤（ws/app/...）
 * @param {string} [opts.q] 关键词子串过滤（大小写不敏感）
 * @param {number} [opts.window] 尾部行读取窗口（默认 limit*4，保证过滤后仍够）
 * @returns {{items:Array, filePath:string, exists:boolean}}
 */
export function readLoggerEntries(opts = {}) {
  const {
    dir, limit = 200, level = '', name = '', q = '',
    window: windowLines,
  } = opts;
  const logDir = dir || resolveLoggerDir();
  const filePath = path.join(logDir, 'monitor.log');
  let exists = false;
  try { exists = fs.existsSync(filePath); } catch { exists = false; }
  if (!exists) return { items: [], filePath, exists: false };

  // 尾部读取窗口：只看尾部足够多的行，避免整读大文件（文件每次轮询全读 10MB 不划算）
  const win = windowLines || Math.max(limit * 4, 300);
  const rawLines = readTailLines(filePath, win);

  const wantLevel = String(level).trim().toLowerCase();
  const wantName = String(name).trim();
  const wantQ = String(q).trim().toLowerCase();

  const items = [];
  for (const line of rawLines) {
    const parsed = parseLoggerLine(line);
    if (!parsed) continue;
    if (wantLevel && !levelAtLeast(parsed.level, wantLevel)) continue;
    if (wantName && parsed.name !== wantName) continue;
    if (wantQ && !parsed.message.toLowerCase().includes(wantQ)) continue;
    items.push(parsed);
    if (items.length >= limit) break;
  }
  return { items, filePath, exists: true };
}

/**
 * 读文件尾部若干行，返回倒序（最新在前）。
 * 大文件不整读：从文件末尾向前读一块窗口，按 \n 切行。若窗口行数仍不够 wanted 行，
 * 且文件整体更大，则扩大窗口重试（最多扩 3 次）。
 * @param {string} filePath 目标文件
 * @param {number} wanted 想要的行数
 * @param {number} [startBytes] 起始窗口字节（内部递归用），每次重试倍增（4MB→8MB→16MB 封顶）
 */
export function readTailLines(filePath, wanted, startBytes = 4 * 1024 * 1024) {
  let fileSize = 0;
  try { fileSize = fs.statSync(filePath).size; } catch { return []; }
  if (fileSize <= 0) return [];

  const windowBytes = Math.min(startBytes, fileSize);
  let attempt = 0;
  while (attempt < 3) {
    const sizeThis = Math.min(windowBytes * Math.pow(2, attempt), fileSize);
    const data = readTailChunk(filePath, fileSize, sizeThis);
    const startPos = Math.max(0, fileSize - sizeThis);
    let lines = data.split('\n');
    // 起点非 0 时首段是切在行中的半行，必须丢弃；起点为 0（整个文件都在窗口内）时首行完整，保留
    if (startPos > 0) lines.shift();
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    if (lines.length >= wanted || sizeThis >= fileSize) {
      return lines.slice(-wanted).reverse();
    }
    attempt++;
  }
  return [];
}

function readTailChunk(filePath, fileSize, size) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const start = Math.max(0, fileSize - size);
    if (size > 8 * 1024 * 1024) {
      // 超大窗口：分段读避免一次性分配巨 buffer
      const buf = Buffer.alloc(size);
      let offset = 0;
      let pos = start;
      const block = 256 * 1024;
      while (pos < fileSize && offset < size) {
        const n = fs.readSync(fd, buf, offset, Math.min(size - offset, block), pos);
        if (n <= 0) break;
        pos += n;
        offset += n;
      }
      return buf.toString('utf8', 0, offset);
    }
    const buf = Buffer.alloc(size);
    const got = fs.readSync(fd, buf, 0, size, start);
    return buf.toString('utf8', 0, got);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * 日志文件是否存在（供前端提示来源为空/未落盘）。
 */
export function loggerFileInfo(env = process.env, repoRoot = REPO_ROOT) {
  const filePath = path.join(resolveLoggerDir(env, repoRoot), 'monitor.log');
  let exists = false;
  try { exists = fs.existsSync(filePath); } catch { exists = false; }
  return { filePath, exists };
}
