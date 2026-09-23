/**
 * test/test-logger-file.test.mjs — web-dashboard/server/logger-file.js 单元测试
 *
 * 覆盖：monitor.log 路径解析、text/json 行解析、尾部读取、level/name/q 过滤、
 *       文件不存在兜底。自包含：临时目录 + 环境变量注入，不碰真实日志。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, '..');
const MOD = await import(pathToFileURL(path.join(REPO, 'plugins', 'official', 'web-dashboard', 'server', 'logger-file.js')).href);
const { resolveLoggerDir, parseLoggerLine, readTailLines, readLoggerEntries, loggerFileInfo } = MOD;

const rundir = path.join(__dirname, 'logger-file-test-rundir');

function writeLog(lines) {
  const dir = path.join(rundir, 'dir');
  rmSync(rundir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const p = path.join(dir, 'monitor.log');
  writeFileSync(p, lines.join('\n') + '\n', 'utf8');
  return { dir, p };
}

test('resolveLoggerDir：三种规则 + 环境注入', () => {
  assert.equal(resolveLoggerDir({ VRC_MONITOR_LOGGER_DIR: '/a' }), path.resolve('/a'));
  assert.equal(resolveLoggerDir({ VRC_MONITOR_DIR: '/b' }), path.resolve('/b/logs'));
  assert.equal(resolveLoggerDir({}, '/fake-root'), path.join('/fake-root', 'logs'), '兜底用仓库根');
});

test('parseLoggerLine：text 格式 INFO/WARN/ERROR + name 标签', () => {
  const r = parseLoggerLine('2026-09-03T20:29:27.840Z INFO  [ws] 断开: code=1006, reason=');
  assert.deepEqual(r, { ts: '2026-09-03T20:29:27.840Z', level: 'info', name: 'ws', message: '断开: code=1006, reason=' });
  const w = parseLoggerLine('2026-09-04T00:00:00.000Z WARN  [app] 认证失败，冷却 120 秒');
  assert.equal(w.level, 'warn');
  assert.equal(w.name, 'app');
  const e = parseLoggerLine('2026-09-04T00:00:00.000Z ERROR [app] boom');
  assert.equal(e.level, 'error');
});

test('parseLoggerLine：json 格式每行一条', () => {
  const r = parseLoggerLine('{"ts":"2026-09-04T00:00:00.000Z","level":"info","name":"ws","msg":"connected","pid":123}');
  assert.deepEqual(r, { ts: '2026-09-04T00:00:00.000Z', level: 'info', name: 'ws', message: 'connected' });
});

test('parseLoggerLine：无效/空行返回 null', () => {
  assert.equal(parseLoggerLine(''), null);
  assert.equal(parseLoggerLine('   '), null);
  assert.equal(parseLoggerLine('garbage line'), null);
  assert.equal(parseLoggerLine(null), null);
});

test('readTailLines：小文件倒序读取（最新在前）', () => {
  const { p } = writeLog(['line1', 'line2', 'line3']);
  const out = readTailLines(p, 10);
  assert.deepEqual(out, ['line3', 'line2', 'line1']);
});

test('readLoggerEntries：limit + level/name/q 过滤 + 倒序', () => {
  const { dir } = writeLog([
    '2026-09-04T00:00:01.000Z INFO  [app] 启动完成',
    '2026-09-04T00:00:02.000Z WARN  [ws] 认证失败，冷却 120 秒',
    '2026-09-04T00:00:03.000Z ERROR [ws] 断开: code=1006',
    '2026-09-04T00:00:04.000Z INFO  [app] 通知已发送 3 条',
  ]);
  const all = readLoggerEntries({ dir });
  assert.equal(all.exists, true);
  assert.equal(all.items[0].message, '通知已发送 3 条', '最新在前');
  assert.equal(all.items.length, 4);

  // level=warn → 只留 warn/error（2 条）
  const warn = readLoggerEntries({ dir, level: 'warn' });
  assert.equal(warn.items.length, 2);
  assert.ok(warn.items.every(x => ['warn', 'error'].includes(x.level)));

  // name=ws → 2 条
  const ws = readLoggerEntries({ dir, name: 'ws' });
  assert.equal(ws.items.length, 2);
  assert.ok(ws.items.every(x => x.name === 'ws'));

  // q=冷却 → 1 条
  const q = readLoggerEntries({ dir, q: '冷却' });
  assert.equal(q.items.length, 1);
  assert.ok(q.items[0].message.includes('冷却'));

  // limit=2
  const lim = readLoggerEntries({ dir, limit: 2 });
  assert.equal(lim.items.length, 2);
  assert.equal(lim.items[0].message, '通知已发送 3 条');
});

test('readLoggerEntries：文件不存在时 exists=false 且 items 空', () => {
  const { dir } = writeLog([]);
  rmSync(dir, { recursive: true, force: true });
  const r = readLoggerEntries({ dir });
  assert.equal(r.exists, false);
  assert.deepEqual(r.items, []);
});

test('loggerFileInfo：存在性检测', () => {
  const { dir } = writeLog(['x']);
  const info = loggerFileInfo({ VRC_MONITOR_LOGGER_DIR: dir });
  assert.equal(info.exists, true);
  assert.equal(info.filePath, path.join(dir, 'monitor.log'));
});
