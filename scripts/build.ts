/**
 * data/ 를 읽어 dist/index.html 한 개로 굽는다.
 *
 *   npx tsx scripts/build.ts
 *
 * 데이터를 HTML 안에 인라인하므로 산출물은 파일 하나다.
 * 정적 서버 없이 file:// 로 열어도 동작하고, GitHub Pages 에 그대로 올려도 된다.
 *
 * 좌표, 레벨, 연결선은 전부 여기서 계산한다. data/ 에는 저장하지 않는다.
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

type Node = {
  id: string;
  title: { ko: string; en: string };
  url: string;
  section: string;
  spine?: boolean;
  requires: string[];
  tags?: string[];
};
type Section = { id: string; title: { ko: string; en: string }; lede: string; accent: string };
type Status = "done" | "stale" | "none" | "unknown";

const sections = parse(readFileSync("data/sections.yaml", "utf8")) as Section[];
const nodes = new Map<string, Node>(
  readdirSync("data/nodes")
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => parse(readFileSync(join("data/nodes", f), "utf8")) as Node)
    .map((n) => [n.id, n])
);

/* ---------- 번역 상태 주입 ---------- */
const L10N_FILE = "data/generated/l10n.json";
let l10n: Record<string, { status: Status; lagDays: number | null; koUrl: string | null }> = {};
let l10nMeta: { generatedAt: string; upstreamCommit: string } | null = null;
if (existsSync(L10N_FILE)) {
  const j = JSON.parse(readFileSync(L10N_FILE, "utf8"));
  l10n = j.nodes;
  l10nMeta = { generatedAt: j.generatedAt, upstreamCommit: j.upstreamCommit };
} else {
  console.warn(`⚠ ${L10N_FILE} 없음 — 번역 상태를 unknown 으로 둡니다.`);
  console.warn(`  npx tsx scripts/fetch-l10n.ts 를 먼저 실행하세요.\n`);
}

/* ---------- 파생값 ---------- */
const children = new Map<string, string[]>([...nodes.keys()].map((id) => [id, []]));
for (const n of nodes.values()) for (const r of n.requires) children.get(r)?.push(n.id);

// longest-path layering. 화면 배치가 아니라 섹션 내부 정렬 순서로만 쓴다.
const depth = new Map<string, number>();
const rank = (id: string): number => {
  if (depth.has(id)) return depth.get(id)!;
  depth.set(id, 0); // 순환은 validate.ts 가 이미 막았다
  const d = nodes.get(id)!.requires.reduce((m, r) => Math.max(m, rank(r) + 1), 0);
  depth.set(id, d);
  return d;
};
for (const id of nodes.keys()) rank(id);

const ancestorsOf = (id: string): Set<string> => {
  const seen = new Set<string>();
  const stack = [...nodes.get(id)!.requires];
  while (stack.length) {
    const v = stack.pop()!;
    if (seen.has(v)) continue;
    seen.add(v);
    stack.push(...nodes.get(v)!.requires);
  }
  return seen;
};

/* ---------- 배치 계산 ----------
 * 섹션마다: spine 노드가 중앙 축을 이루고, 나머지는 "가장 가까운 spine 조상"에
 * 매달린 뒤 좌우로 번갈아 배치된다. 기여자는 spine 불리언 하나만 쓴다. */
type Row = { spine: string; left: string[]; right: string[] };
const layout = sections.map((sec) => {
  const inSec = [...nodes.values()]
    .filter((n) => n.section === sec.id)
    .sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));

  const spines = inSec.filter((n) => n.spine).map((n) => n.id);
  if (spines.length === 0 && inSec.length) spines.push(inSec[0].id);

  const rows = new Map<string, Row>(spines.map((s) => [s, { spine: s, left: [], right: [] }]));
  const spineRank = new Map(spines.map((s) => [s, rank(s)]));

  for (const n of inSec) {
    if (rows.has(n.id)) continue;
    const anc = ancestorsOf(n.id);
    // 조상 중 이 섹션의 spine 이면서 가장 깊은 것에 매단다
    let host = spines
      .filter((s) => anc.has(s))
      .sort((a, b) => spineRank.get(b)! - spineRank.get(a)!)[0];
    if (!host) host = spines.filter((s) => spineRank.get(s)! <= rank(n.id)).pop() ?? spines[0];
    const row = rows.get(host)!;
    (row.right.length <= row.left.length ? row.right : row.left).push(n.id);
  }
  return { section: sec, rows: spines.map((s) => rows.get(s)!) };
});

/* ---------- 커버리지 ---------- */
const tally: Record<Status, number> = { done: 0, stale: 0, none: 0, unknown: 0 };
for (const id of nodes.keys()) tally[l10n[id]?.status ?? "unknown"]++;

/* ---------- 직렬화 (키 정렬 → 결정적 diff) ---------- */
const graph = {
  generatedAt: new Date().toISOString(),
  l10nSource: l10nMeta,
  coverage: { total: nodes.size, ...tally },
  sections,
  layout: layout.map((s) => ({ section: s.section.id, rows: s.rows })),
  nodes: Object.fromEntries(
    [...nodes.keys()].sort().map((id) => {
      const n = nodes.get(id)!;
      return [
        id,
        {
          id,
          title: n.title,
          url: n.url,
          section: n.section,
          spine: !!n.spine,
          requires: [...n.requires].sort(),
          unlocks: [...children.get(id)!].sort(),
          tags: n.tags ?? [],
          l10n: l10n[id]?.status ?? "unknown",
          lagDays: l10n[id]?.lagDays ?? null,
          koUrl: l10n[id]?.koUrl ?? null,
        },
      ];
    })
  ),
};

const template = readFileSync("web/template.html", "utf8");
const html = template.replace(
  "/*__GRAPH__*/null",
  JSON.stringify(graph).replace(/</g, "\\u003c") // </script> 조기 종료 방지
);

mkdirSync("dist", { recursive: true });
writeFileSync("dist/index.html", html);
writeFileSync("dist/graph.json", JSON.stringify(graph, null, 2) + "\n");

const edges = [...nodes.values()].reduce((s, n) => s + n.requires.length, 0);
console.log(`✓ dist/index.html  (노드 ${nodes.size}, edge ${edges}, 섹션 ${sections.length})`);
console.log(
  `  번역 커버리지 ${Math.round((tally.done / nodes.size) * 100)}%  ` +
    `(완료 ${tally.done} / 오래됨 ${tally.stale} / 미번역 ${tally.none} / 미확인 ${tally.unknown})`
);
