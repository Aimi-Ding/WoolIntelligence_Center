#!/usr/bin/env node
/**
 * 百度搜索资源平台「普通收录 → API 提交（主动推送）」
 *
 * 用法：
 *   BAIDU_PUSH_TOKEN=你的token node build/baidu-push.mjs
 *   node build/baidu-push.mjs --token <token> --dry-run
 *   node build/baidu-push.mjs --token <token> --urls https://wool.xiaoyanbao.com/,https://wool.xiaoyanbao.com/deal/zcode-glm-trial.html
 *
 * 参数：
 *   --site <url>   站点地址，默认取 BAIDU_PUSH_SITE 或 https://wool.xiaoyanbao.com
 *   --token <key>  准入密钥，默认取 BAIDU_PUSH_TOKEN
 *   --urls <list>  逗号分隔的 URL 或本地文件路径，默认读取 dist/sitemap.xml
 *   --batch <n>    单次推送条数，默认 10（百度按站点配额限流，批次越小越稳）
 *   --dry-run      只打印将要推送的 URL，不发请求
 *   --quiet        只输出最终汇总
 *
 * 退出码：0 全部推送成功；1 参数缺失或有批次失败。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
// 百度该接口只提供 HTTP 服务，走 HTTPS 会连接失败
const ENDPOINT = 'http://data.zz.baidu.com/urls';

const args = parseArgs(process.argv.slice(2));
const site = (args.site || process.env.BAIDU_PUSH_SITE || 'https://wool.xiaoyanbao.com').replace(/\/+$/, '');
const token = args.token || process.env.BAIDU_PUSH_TOKEN || '';
const batchSize = Math.max(1, Number(args.batch || 10));

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) continue;
    const name = key.slice(2);
    if (name === 'dry-run' || name === 'quiet') {
      out[name] = true;
      continue;
    }
    out[name] = argv[i + 1];
    i += 1;
  }
  return out;
}

/** 从 sitemap 或逗号分隔列表/文件里取出同站 URL */
function collectUrls(source) {
  let raw = '';
  if (!source) {
    const sitemap = path.join(ROOT, 'dist', 'sitemap.xml');
    if (!fs.existsSync(sitemap)) {
      throw new Error('未找到 dist/sitemap.xml，请先运行 node build/generate.mjs');
    }
    raw = [...fs.readFileSync(sitemap, 'utf8').matchAll(/<loc>([^<]+)<\/loc>/g)]
      .map((m) => m[1].trim())
      .join('\n');
  } else if (fs.existsSync(source)) {
    raw = fs.readFileSync(source, 'utf8');
  } else {
    raw = source;
  }

  const urls = [...new Set(
    raw.split(/[\s,]+/).map((s) => s.trim()).filter((s) => /^https?:\/\//.test(s)),
  )];

  const origin = new URL(site).origin;
  const sameSite = urls.filter((u) => {
    try { return new URL(u).origin === origin; } catch { return false; }
  });

  return { urls: sameSite, skipped: urls.length - sameSite.length };
}

/** 把百度返回的错误码翻译成可执行的提示 */
function explain(data, status) {
  const msg = String(data.message || data.error || '');
  if (/token/i.test(msg)) return '准入密钥无效，请到百度搜索资源平台 → 普通收录 → API 提交重新获取';
  if (/site init/i.test(msg)) return '站点未验证，或 token 与站点不匹配（site init fail）';
  if (/quota|over/i.test(msg)) return '今日主动推送配额已用完（over quota），次日再试';
  return `HTTP ${status}：${JSON.stringify(data).slice(0, 200)}`;
}

async function pushBatch(batch) {
  const body = batch.join('\n');
  const url = `${ENDPOINT}?site=${encodeURIComponent(site)}&token=${encodeURIComponent(token)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body,
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`返回非 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`);
  }
  if (!res.ok || data.error) {
    throw new Error(explain(data, res.status));
  }
  return data;
}

async function main() {
  const { urls, skipped } = collectUrls(args.urls);

  if (!urls.length) {
    console.log('没有可推送的同站 URL，已退出。');
    return 0;
  }

  if (!args.quiet) {
    console.log(`站点：${site}`);
    console.log(`待推送：${urls.length} 条${skipped ? `（忽略 ${skipped} 条非同站 URL）` : ''}`);
  }

  if (args['dry-run']) {
    urls.forEach((u, i) => console.log(`${String(i + 1).padStart(3)}. ${u}`));
    console.log('\n--dry-run：未发送请求。');
    return 0;
  }

  if (!token) {
    console.error('缺少 token：请设置 BAIDU_PUSH_TOKEN 环境变量或传 --token <准入密钥>。');
    console.error('获取方式：百度搜索资源平台 → 普通收录 → API 提交 → 准入密钥。');
    return 1;
  }

  let success = 0;
  let remain = null;
  const failed = [];

  for (let i = 0; i < urls.length; i += batchSize) {
    const batch = urls.slice(i, i + batchSize);
    const label = `第 ${i / batchSize + 1} 批（${batch.length} 条）`;
    try {
      const data = await pushBatch(batch);
      success += Number(data.success || 0);
      if (typeof data.remain === 'number') remain = data.remain;
      if (!args.quiet) {
        const extra = [
          data.not_same_site?.length ? `非同站 ${data.not_same_site.length}` : '',
          data.not_valid?.length ? `无效 ${data.not_valid.length}` : '',
        ].filter(Boolean).join('，');
        console.log(`${label}：成功 ${data.success ?? 0} 条${extra ? `，${extra}` : ''}`);
      }
      for (const bad of [...(data.not_same_site || []), ...(data.not_valid || [])]) {
        failed.push({ url: bad, reason: '百度判定非同站或无效' });
      }
    } catch (err) {
      console.error(`${label}：失败 · ${err.message}`);
      batch.forEach((u) => failed.push({ url: u, reason: err.message }));
      // token 无效或配额耗尽时继续请求没有意义
      if (/token|quota|配额|401|403/i.test(err.message)) break;
    }
  }

  console.log(`\n推送完成：成功 ${success} 条，失败 ${failed.length} 条${remain === null ? '' : `，今日剩余配额 ${remain}`}`);
  if (failed.length) {
    console.log('失败明细：');
    failed.slice(0, 20).forEach((f) => console.log(`- ${f.url}（${f.reason}）`));
    if (failed.length > 20) console.log(`- 其余 ${failed.length - 20} 条省略`);
    return 1;
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`执行失败：${err.message}`);
    process.exit(1);
  });
