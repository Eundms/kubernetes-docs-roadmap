/**
 * 모든 노드의 url 이 실제로 살아 있는지 확인한다.
 *
 *   npx tsx scripts/check-links.ts
 *
 * 외부 네트워크에 의존하므로 PR 마다 돌리지 않는다.
 * 일시적 장애로 PR 이 막히면 기여자만 괴롭다. 주 1회 스케줄로 돌리고
 * 실패하면 이슈를 열어 메인테이너가 처리한다.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const CONCURRENCY = 6; // kubernetes.io 에 부담을 주지 않는 선
const TIMEOUT_MS = 15_000;

const nodes = readdirSync("data/nodes")
  .filter((f) => f.endsWith(".yaml"))
  .map((f) => parse(readFileSync(join("data/nodes", f), "utf8")) as { id: string; url: string })
  .sort((a, b) => a.id.localeCompare(b.id));

type Result = { id: string; url: string; status: number | string; redirect?: string };
const bad: Result[] = [];

async function check(n: { id: string; url: string }): Promise<void> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    // HEAD 를 막는 CDN 이 있어 GET 을 쓰되 본문은 읽지 않는다
    const res = await fetch(n.url, { redirect: "follow", signal: ctl.signal });
    if (!res.ok) {
      bad.push({ id: n.id, url: n.url, status: res.status });
      return;
    }
    // 리다이렉트되었다면 문서가 이동한 것이다. 에러는 아니지만 url 을 갱신해야 한다.
    const final = res.url.replace(/\/$/, "");
    if (final !== n.url.replace(/\/$/, "")) {
      bad.push({ id: n.id, url: n.url, status: "moved", redirect: res.url });
    }
  } catch (e) {
    bad.push({ id: n.id, url: n.url, status: (e as Error).name });
  } finally {
    clearTimeout(timer);
  }
}

const queue = [...nodes];
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) await check(queue.shift()!);
  })
);

if (bad.length === 0) {
  console.log(`✓ ${nodes.length}개 URL 모두 정상`);
  process.exit(0);
}

console.error(`\n✗ 확인이 필요한 URL ${bad.length}개:\n`);
for (const b of bad.sort((x, y) => x.id.localeCompare(y.id))) {
  console.error(`  ${b.id}  [${b.status}]  ${b.url}`);
  if (b.redirect) console.error(`      → ${b.redirect}`);
}
console.error(`\n"moved" 는 문서가 이동한 것이므로 data/nodes/<id>.yaml 의 url 을 갱신하세요.\n`);
process.exit(1);
