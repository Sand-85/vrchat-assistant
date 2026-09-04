/**
 * test-monitor-friend-delete.test.mjs — monitor 层 friend-delete 移除好友回归测试（issue #127 补漏）
 *
 * 覆盖 _handleDelete 对 friend-delete 事件的正确行为：
 *   刷新在线/头像同步之外，friend-delete 应把好友从 friends 表移除（此前只存事件不移除 → 解友用户残留好友列表显示 '?'）。
 * 自包含：临时 SQLite + Storage + EventPipeline，不依赖真实 VRChat 凭据。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, '..');

const { Storage } = await import(pathToFileURL(path.join(REPO, 'core', 'storage.js')).href);
const { EventPipeline } = await import(pathToFileURL(path.join(REPO, 'core', 'event-pipeline.js')).href);

// ── 临时 DB + 运行时准备 ──
const tmpDb = path.join(__dirname, 'test-monitor-friend-delete.sqlite3');
for (const f of [tmpDb, tmpDb + '-wal', tmpDb + '-shm']) { try { rmSync(f, { force: true }); } catch {} }

const storage = new Storage();
await storage.init(tmpDb);
const pipe = new EventPipeline(storage, {});

test('friend-delete 移除好友 + 不影响他人 + 事件入 events 表 + 重新加好友可重建', async () => {
  const F1 = 'usr_test-delf-0000-000000000001';
  const F2 = 'usr_test-delf-0000-000000000002';
  storage.upsertFriend({ userId: F1, displayName: '好友甲', isOnline: 0 });
  storage.upsertFriend({ userId: F2, displayName: '好友乙', isOnline: 0 });

  let r = storage.query(`SELECT COUNT(*) c FROM friends WHERE user_id=$u`, { $u: F1 })[0];
  assert.equal(r.c, 1, '插入后 F1 应存在');
  r = storage.query(`SELECT COUNT(*) c FROM friends WHERE user_id=$u`, { $u: F2 })[0];
  assert.equal(r.c, 1, '插入后 F2 应存在');

  // 触发 friend-delete 事件（只删 F1，模拟「解除好友」）
  await pipe._handleDelete({ userId: F1, type: 'friend-delete', displayName: '好友甲', receivedAt: new Date().toISOString() });

  r = storage.query(`SELECT COUNT(*) c FROM friends WHERE user_id=$u`, { $u: F1 })[0];
  assert.equal(r.c, 0, 'friend-delete 后 F1 应被移除');
  r = storage.query(`SELECT COUNT(*) c FROM friends WHERE user_id=$u`, { $u: F2 })[0];
  assert.equal(r.c, 1, 'friend-delete 不应影响 F2');
  r = storage.query(`SELECT COUNT(*) c FROM events WHERE user_id=$u AND type='friend-delete'`, { $u: F1 })[0];
  assert.equal(r.c, 1, 'friend-delete 事件应记录到 events 表（历史保留）');

  // 重新加好友（friend-add 路径重建）→ 验证可恢复
  storage.upsertFriend({ userId: F1, displayName: '好友甲(重新加)', isOnline: 0 });
  r = storage.query(`SELECT COUNT(*) c, MAX(display_name) dn FROM friends WHERE user_id=$u`, { $u: F1 })[0];
  assert.equal(r.c, 1, '重新加好友后 F1 应重建');
  assert.equal(r.dn, '好友甲(重新加)', '重建后 display_name 应为新值');
});

// ── 清理 ──
after(() => {
  for (const f of [tmpDb, tmpDb + '-wal', tmpDb + '-shm']) { try { rmSync(f, { force: true }); } catch {} }
});
