/**
 * 한국어 번역 상태를 kubernetes/website 저장소에서 직접 계산한다.
 *
 *   npx tsx scripts/fetch-l10n.ts
 *   npx tsx scripts/fetch-l10n.ts --repo /path/to/website   # 이미 받아둔 클론 재사용
 *
 * 출력: data/generated/l10n.json  (빌드 산출물이므로 커밋하지 않는다)
 *
 * 판정 규칙
 *   none  — content/ko 에 대응 파일이 없음
 *   stale — ko 가 en 보다 GRACE_DAYS 이상 뒤처짐
 *   done  — 그 외
 *
 * 유예 기간을 두는 이유: 영문 쪽 오타 수정 하나로도 커밋 시각이 갱신되므로
 * 격차 0일을 기준으로 삼으면 거의 전부가 stale 로 찍힌다. 실측 격차의
 * 중앙값이 289일이었으므로 30일 유예는 실제 신호를 흐리지 않으면서
 * 사소한 편집 잡음만 걸러낸다. lagDays 를 함께 기록하니 소비 측에서
 * 더 촘촘한 구간을 나눌 수도 있다.
 *
 * 이 규칙은 kubernetes.io 가 번역 페이지 상단에 띄우는
 * "원본 문서보다 오래되었다" 배너와 같은 신호를 재현한 것이다.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const UPSTREAM = "https://github.com/kubernetes/website.git";
const OUT_DIR = "data/generated";
const OUT_FILE = join(OUT_DIR, "l10n.json");

const argRepo = process.argv.indexOf("--repo");
const REPO = argRepo > -1 ? process.argv[argRepo + 1] : ".cache/website";

const git = (args: string[], cwd = REPO) =>
  execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 1 << 28 });

/* ---------- 1. blobless partial clone ----------
 * 파일 내용(blob)은 필요 없고 커밋 날짜와 경로만 필요하다.
 * --filter=blob:none 은 트리는 받고 blob 은 건너뛰므로 수백 MB를 아낀다.
 * --depth 는 쓸 수 없다. 파일별 마지막 커밋 날짜를 알려면 전체 이력이 필요하다. */
if (!existsSync(join(REPO, ".git"))) {
  mkdirSync(REPO, { recursive: true });
  console.log("kubernetes/website 를 받는 중 (blobless, 수 분 소요)...");
  execFileSync(
    "git",
    ["clone", "--filter=blob:none", "--no-tags", "--single-branch", UPSTREAM, REPO],
    { stdio: "inherit" }
  );
} else {
  console.log("기존 클론 갱신 중...");
  git(["fetch", "--filter=blob:none", "--no-tags", "origin"]);
  git(["reset", "--hard", "origin/HEAD"]);
}

/* ---------- 2. 파일별 마지막 커밋 시각 ----------
 * 파일마다 `git log -1 -- <path>` 를 돌리면 매번 이력을 처음부터 훑어
 * O(N x H) 가 된다. 전체 이력을 한 번만 순회하면서 --name-only 로
 * 경로를 수집하면 O(H + changes) 로 끝난다. N=50, H=5만 커밋에서 차이가 크다. */
console.log("커밋 이력 스캔 중...");
const raw = git([
  "log",
  "--pretty=format:@%ct",
  "--name-only",
  "--no-merges",
  "--",
  "content/en/docs",
  "content/ko/docs",
]);

const lastCommit = new Map<string, number>();
let ts = 0;
for (const line of raw.split("\n")) {
  if (!line) continue;
  if (line.startsWith("@")) {
    ts = Number(line.slice(1));
  } else if (!lastCommit.has(line)) {
    // git log 는 최신순이므로 처음 만난 것이 마지막 커밋이다
    lastCommit.set(line, ts);
  }
}
console.log(`  ${lastCommit.size}개 파일의 커밋 시각 수집`);

/* ---------- 3. URL -> 저장소 경로 매핑 ----------
 * Hugo 규칙상 한 URL 은 두 형태 중 하나로 존재한다.
 *   .../pods/  ->  content/<lang>/docs/.../pods.md
 *              또는 content/<lang>/docs/.../pods/_index.md */
const candidates = (lang: string, url: string): string[] => {
  const path = new URL(url).pathname.replace(/^\/|\/$/g, ""); // "docs/concepts/.../pods"
  return [`content/${lang}/${path}.md`, `content/${lang}/${path}/_index.md`];
};
const resolve = (lang: string, url: string): string | null =>
  candidates(lang, url).find((p) => lastCommit.has(p)) ?? null;

/* ---------- 4. 노드별 판정 ---------- */
const GRACE_DAYS = 30;

type Status = "done" | "stale" | "none";
type Entry = {
  status: Status;
  lagDays: number | null; // ko 가 en 보다 며칠 뒤처졌는가. 음수면 앞서 있다.
  koUrl: string | null;
  enPath: string | null;
  koPath: string | null;
};

const nodes = readdirSync("data/nodes")
  .filter((f) => f.endsWith(".yaml"))
  .map((f) => parse(readFileSync(join("data/nodes", f), "utf8")) as { id: string; url: string });

const out: Record<string, Entry> = {};
const unmatched: string[] = [];

for (const n of nodes.sort((a, b) => a.id.localeCompare(b.id))) {
  const enPath = resolve("en", n.url);
  const koPath = resolve("ko", n.url);

  if (!enPath) unmatched.push(`${n.id} — ${n.url}`);

  let status: Status = "none";
  let lagDays: number | null = null;
  if (koPath) {
    const enTs = enPath ? lastCommit.get(enPath)! : 0;
    lagDays = Math.round((enTs - lastCommit.get(koPath)!) / 86400);
    status = lagDays > GRACE_DAYS ? "stale" : "done";
  }

  out[n.id] = {
    status,
    lagDays,
    koUrl: koPath ? n.url.replace("kubernetes.io/docs", "kubernetes.io/ko/docs") : null,
    enPath,
    koPath,
  };
}

/* ---------- 5. 출력 ---------- */
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(
  OUT_FILE,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      upstreamCommit: git(["rev-parse", "HEAD"]).trim(),
      nodes: out,
    },
    null,
    2
  ) + "\n"
);

const tally = { done: 0, stale: 0, none: 0 };
for (const e of Object.values(out)) tally[e.status]++;
const total = nodes.length;

console.log(`\n${OUT_FILE} 생성`);
console.log(`  번역 완료  ${tally.done}/${total} (${Math.round((tally.done / total) * 100)}%)`);
const lags = Object.values(out).filter((e) => e.status === "stale").map((e) => e.lagDays!).sort((a, b) => a - b);
console.log(`  오래됨    ${tally.stale}` + (lags.length ? ` (격차 중앙값 ${lags[lags.length >> 1]}일, 최대 ${lags.at(-1)}일)` : ""));
console.log(`  미번역    ${tally.none}`);

if (unmatched.length) {
  // 영문 원본조차 못 찾았다면 URL 이 틀렸을 가능성이 높다. 빌드는 계속하되 눈에 띄게 알린다.
  console.warn(`\n⚠ 영문 원본을 찾지 못한 노드 ${unmatched.length}개 — URL 을 확인하세요:`);
  for (const u of unmatched) console.warn(`  ${u}`);
}
