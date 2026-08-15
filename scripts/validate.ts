/**
 * 로드맵 그래프 데이터 검증기.
 *
 *   npx tsx scripts/validate.ts            # 검증만
 *   npx tsx scripts/validate.ts --print    # 검증 + 위상 정렬 결과 출력
 *
 * 이 스크립트를 통과하지 못하면 PR은 머지되지 않는다.
 * 기여자가 로컬에서 먼저 돌릴 수 있도록 의존성을 최소로 유지한다.
 */
import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { parse } from "yaml";
import Ajv from "ajv/dist/2020.js"; // schema가 draft 2020-12이므로 기본 빌드가 아닌 2020 빌드를 쓴다
import addFormats from "ajv-formats";

const NODES_DIR = "data/nodes";
const SECTIONS_FILE = "data/sections.yaml";
const SCHEMA_FILE = "schema/node.schema.json";

type Node = {
  id: string;
  title: { ko: string; en: string };
  url: string;
  section: string;
  spine?: boolean;
  requires: string[];
  tags?: string[];
};

const errors: string[] = [];
const warns: string[] = [];
const fail = (file: string, msg: string) => errors.push(`${file}: ${msg}`);
const warn = (file: string, msg: string) => warns.push(`${file}: ${msg}`);

/* ---------- 1. 로드 + 스키마 검증 ---------- */
const schema = JSON.parse(readFileSync(SCHEMA_FILE, "utf8"));
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validateSchema = ajv.compile(schema);

const sections = parse(readFileSync(SECTIONS_FILE, "utf8")) as { id: string }[];
const sectionIds = new Set(sections.map((s) => s.id));
const sectionOrder = new Map(sections.map((s, i) => [s.id, i]));

const files = readdirSync(NODES_DIR).filter((f) => f.endsWith(".yaml")).sort();
const nodes = new Map<string, Node>();

for (const f of files) {
  const path = join(NODES_DIR, f);
  let doc: unknown;
  try {
    doc = parse(readFileSync(path, "utf8"));
  } catch (e) {
    fail(f, `YAML 파싱 실패 — ${(e as Error).message}`);
    continue;
  }

  if (!validateSchema(doc)) {
    for (const e of validateSchema.errors ?? []) {
      fail(f, `스키마 위반 ${e.instancePath || "/"} ${e.message}`);
    }
    continue;
  }

  const n = doc as Node;

  // 파일명 == id. 이게 깨지면 참조가 조용히 어긋난다.
  const expected = basename(f, ".yaml");
  if (n.id !== expected) {
    fail(f, `id가 "${n.id}"인데 파일명은 "${expected}.yaml" — 둘은 같아야 합니다`);
  }
  if (nodes.has(n.id)) {
    fail(f, `id "${n.id}" 중복`);
    continue;
  }
  if (!sectionIds.has(n.section)) {
    fail(f, `section "${n.section}"이 ${SECTIONS_FILE}에 정의되어 있지 않습니다`);
  }
  nodes.set(n.id, n);
}

/* ---------- 2. 참조 무결성 ---------- */
for (const n of nodes.values()) {
  for (const r of n.requires) {
    if (!nodes.has(r)) fail(`${n.id}.yaml`, `requires "${r}" — 해당 id의 노드가 없습니다`);
    if (r === n.id) fail(`${n.id}.yaml`, `자기 자신을 requires에 넣을 수 없습니다`);
  }
}
if (errors.length) report();

/* ---------- 3. 비순환(DAG) 검증 — Kahn's algorithm, O(V+E) ---------- */
const children = new Map<string, string[]>([...nodes.keys()].map((id) => [id, []]));
const indeg = new Map<string, number>([...nodes.keys()].map((id) => [id, 0]));
for (const n of nodes.values()) {
  for (const r of n.requires) {
    children.get(r)!.push(n.id);
    indeg.set(n.id, indeg.get(n.id)! + 1);
  }
}

const queue = [...indeg].filter(([, d]) => d === 0).map(([id]) => id).sort();
const topo: string[] = [];
const q = [...queue];
while (q.length) {
  const v = q.shift()!;
  topo.push(v);
  for (const c of children.get(v)!) {
    indeg.set(c, indeg.get(c)! - 1);
    if (indeg.get(c) === 0) q.push(c);
  }
}
if (topo.length !== nodes.size) {
  const stuck = [...nodes.keys()].filter((id) => !topo.includes(id));
  fail("graph", `순환 참조가 있습니다. 관련 노드: ${stuck.join(", ")}`);
  report();
}

/* ---------- 4. 중복 edge 검증 (transitive reduction) ---------- */
// r이 requires의 *다른* 항목을 통해 이미 도달 가능하면 그 edge는 불필요하다.
// DAG에서 transitive reduction은 유일하므로 기계적으로 판정된다.
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

for (const n of nodes.values()) {
  for (const r of n.requires) {
    const viaOthers = new Set<string>();
    for (const other of n.requires) {
      if (other === r) continue;
      viaOthers.add(other);
      for (const a of ancestorsOf(other)) viaOthers.add(a);
    }
    if (viaOthers.has(r)) {
      fail(
        `${n.id}.yaml`,
        `requires "${r}"는 다른 항목을 통해 이미 도달 가능하므로 중복입니다. 제거해 주세요.`
      );
    }
  }
}

/* ---------- 5. 배치 정합성 (에러 아님, 경고) ---------- */
const bySection = new Map<string, Node[]>();
for (const n of nodes.values()) {
  if (!bySection.has(n.section)) bySection.set(n.section, []);
  bySection.get(n.section)!.push(n);
}
for (const [sec, list] of bySection) {
  const spines = list.filter((n) => n.spine);
  if (spines.length === 0) warn(sec, `spine 노드가 없다 — 중앙 축에 놓을 대표 노드를 하나 지정해 주세요`);
  if (spines.length > 2) warn(sec, `spine 노드가 ${spines.length}개 — 2개 이하를 권장합니다`);
}

// 선수 지식이 자기보다 아래 섹션에 있으면 화살표가 위로 거슬러 올라간다.
for (const n of nodes.values()) {
  for (const r of n.requires) {
    const a = sectionOrder.get(nodes.get(r)!.section)!;
    const b = sectionOrder.get(n.section)!;
    if (a > b) {
      warn(
        `${n.id}.yaml`,
        `선수 지식 "${r}"이 더 아래 섹션(${nodes.get(r)!.section})에 있다 — 섹션 순서를 검토해 주세요`
      );
    }
  }
}

/* ---------- 6. URL 중복 ---------- */
const byUrl = new Map<string, string[]>();
for (const n of nodes.values()) {
  const u = n.url.replace(/\/$/, "");
  if (!byUrl.has(u)) byUrl.set(u, []);
  byUrl.get(u)!.push(n.id);
}
for (const [u, ids] of byUrl) {
  if (ids.length > 1) fail("graph", `같은 URL을 여러 노드가 사용합니다 (${ids.join(", ")}): ${u}`);
}

report();

/* ---------- 결과 ---------- */
function report(): never {
  if (process.argv.includes("--print") && !errors.length) {
    console.log("\n위상 정렬 결과 (읽기 순서):");
    topo.forEach((id, i) => {
      const n = nodes.get(id)!;
      console.log(`  ${String(i + 1).padStart(3)}. ${n.title.ko}  (${id})`);
    });
  }
  for (const w of warns) console.warn(`⚠  ${w}`);
  if (errors.length) {
    console.error(`\n✗ ${errors.length}개 문제:\n`);
    for (const e of errors) console.error(`  ${e}`);
    console.error(
      `\n기여 규칙은 CONTRIBUTING.md 를 참고해 주세요. 대부분의 오류는 requires 오타 또는 중복 edge입니다.\n`
    );
    process.exit(1);
  }
  console.log(`✓ 노드 ${nodes.size}개, edge ${[...nodes.values()].reduce((s, n) => s + n.requires.length, 0)}개 — DAG 정상`);
  process.exit(0);
}
