/**
 * migrate-legacy-data.js — 旧数据迁移（issue #103）引导
 *
 * 背景：refactor(structure) 提交把三个运行时文件默认路径从仓库根目录挪到 data/ 子目录
 * （DB_PATH / COOKIE_FILE / BACKUP_DIR），但未建目录、未迁移旧数据。已有部署升级后
 * 启动即崩溃（无 data/ 目录），且根目录几十万条历史数据被晾在一边（「假丢失」）。
 *
 * 本模块提供一次性迁移引导：检测仓库根目录旧运行时文件（vrc-monitor.sqlite3[-wal|-shm]
 * / auth_cookie.txt / backups/），仅当 data/ 下对应目标尚不存在时才搬移，避免覆盖；幂等。
 *
 * 只依赖 node:fs / node:path，可被 start-monitor.js 与回归测试（test-migrate-data.mjs）复用。
 */
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import { getLogger } from './logger.js';

// 命名日志：migrate 组件标签，替代原裸 console.*（保留 [migrate] 语义由 [migrate] 标签承接）
const log = getLogger('migrate');

/**
 * 把根目录旧运行时文件迁移到 data/ 目录（尽量覆盖同名则跳过，避免覆盖 data/ 新数据）。
 * @param {string} rootDir 仓库根目录
 * @param {string} dataDir 目标 data/ 子目录
 * @returns {number} 实际搬移的文件/目录个数
 */
export function migrateLegacyData(rootDir, dataDir) {
  const legacyDb = path.join(rootDir, 'vrc-monitor.sqlite3');
  const dataDb = path.join(dataDir, 'vrc-monitor.sqlite3');
  const legacyCookie = path.join(rootDir, 'auth_cookie.txt');
  const dataCookie = path.join(dataDir, 'auth_cookie.txt');
  const legacyBackups = path.join(rootDir, 'backups');
  const dataBackups = path.join(dataDir, 'backups');

  const needsMove = [];

  // 主库 + WAL/SHM
  const dataDbExists = existsSync(dataDb) || existsSync(dataDb + '-wal') || existsSync(dataDb + '-shm');
  for (const ext of ['', '-wal', '-shm']) {
    const from = legacyDb + ext;
    const to = dataDb + ext;
    if (existsSync(from) && !dataDbExists) {
      needsMove.push({ from, to, label: path.relative(rootDir, from) });
    }
  }

  // Cookie
  if (existsSync(legacyCookie) && !existsSync(dataCookie)) {
    needsMove.push({ from: legacyCookie, to: dataCookie, label: 'auth_cookie.txt' });
  }

  // 备份目录
  if (existsSync(legacyBackups) && !existsSync(dataBackups)) {
    needsMove.push({ from: legacyBackups, to: dataBackups, label: 'backups/' });
  }

  // ⚠️ 静默跳过提示（issue #103）：根目录存在旧库主文件、但 data/ 已存在同名库时，
  // 旧库不会被搬移（可能是用户按临时 workaround 手动 mkdir -p data 启动过一次）。
  // 若无提示，用户会误以为历史数据仍在（假丢失），此处输出 warn 提醒可手动处理。
  if (existsSync(legacyDb) && dataDbExists) {
    log.warn(
      `检测到根目录旧库 ${path.relative(rootDir, legacyDb)}，但 data/ 已存在同名库，跳过迁移；` +
      '若需恢复旧数据请手动处理'
    );
  }

  if (needsMove.length === 0) return 0;

  mkdirSync(dataDir, { recursive: true });
  let moved = 0;
  for (const { from, to, label } of needsMove) {
    try {
      renameSync(from, to);
      log.info(`${label} -> ${path.relative(rootDir, to)}`);
      moved += 1;
    } catch (e) {
      log.warn(`移动失败 ${label}: ${e.message}`);
    }
  }
  return moved;
}
